import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { before, after, test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { MoyskladRequestScheduler } from '../src/moysklad-request-scheduler';
import { installControlledLiveFetchGuard, setControlledLiveTestWriteCheck } from '../src/external-write-guard';

const base = new URL('https://api.moysklad.ru/api/remap/1.2/');
const url = new URL('entity/store/test', base);
let keepAlive: NodeJS.Timeout;
before(() => { keepAlive = setInterval(() => undefined, 1_000); });
after(() => { clearInterval(keepAlive); });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reply = (body: unknown = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('concurrent adapters share spaced starts and no more than two permits, held through body consumption', async () => {
  const starts: number[] = [];
  let active = 0; let maximum = 0;
  const native = (async () => {
    starts.push(Date.now()); active++; maximum = Math.max(maximum, active);
    return new Response(new ReadableStream({ async start(controller) {
      await sleep(25); controller.enqueue(new TextEncoder().encode('{}')); controller.close(); active--;
    } }));
  }) as typeof fetch;
  const scheduler = new MoyskladRequestScheduler(native, base, { intervalMs: 8, deadlineMs: 2_000 });
  await Promise.all(Array.from({ length: 20 }, async () => (await scheduler.fetch(url)).json()));
  assert.equal(starts.length, 20);
  assert.ok(maximum <= 2);
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index]! - starts[index - 1]! >= 7, JSON.stringify(starts));
});

test('429 shares native millisecond cooldown across reads/writes and never automatically repeats a POST', async () => {
  const sends: { time: number; method: string }[] = [];
  const native = (async (_input, init) => {
    sends.push({ time: Date.now(), method: init?.method ?? 'GET' });
    return sends.length === 1 ? new Response('{"errors":[{"code":1049}]}', { status: 429, headers: { 'x-lognex-retry-after': '60', 'retry-after': '0' } }) : reply();
  }) as typeof fetch;
  const scheduler = new MoyskladRequestScheduler(native, base, { intervalMs: 5, deadlineMs: 2_000 });
  const rejected = await scheduler.fetch(url, { method: 'POST', body: '{"name":"synthetic"}' });
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get('retry-after'), '1');
  assert.deepEqual(await rejected.json(), { errors: [{ code: 1049 }] });
  await Promise.all(Array.from({ length: 3 }, async () => (await scheduler.fetch(url)).json()));
  assert.equal(sends.filter((send) => send.method === 'POST').length, 1);
  assert.ok(sends[1]!.time - sends[0]!.time >= 55);
});

test('standard Retry-After, empty native headers and low remaining credits stop the shared queue', async () => {
  const starts: number[] = [];
  const native = (async () => {
    starts.push(Date.now());
    if (starts.length === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0.05', 'x-lognex-retry-after': '0' } });
    if (starts.length === 2) return new Response('{}', { headers: { 'x-ratelimit-limit': '45', 'x-ratelimit-remaining': '3', 'x-lognex-retry-timeinterval': '60', 'x-lognex-reset': '0' } });
    return reply();
  }) as typeof fetch;
  const scheduler = new MoyskladRequestScheduler(native, base, { intervalMs: 5 });
  for (let index = 0; index < 3; index++) await (await scheduler.fetch(url)).json();
  assert.ok(starts[1]! - starts[0]! >= 45);
  assert.ok(starts[2]! - starts[1]! >= 55);
});

test('a response with no retry headers gets bounded shared fallback, not an immediate storm', async () => {
  const starts: number[] = [];
  const scheduler = new MoyskladRequestScheduler((async () => {
    starts.push(Date.now()); return starts.length === 1 ? new Response('{}', { status: 429 }) : reply();
  }) as typeof fetch, base, { intervalMs: 5, fallbackCooldownMs: 40 });
  await (await scheduler.fetch(url)).json();
  await (await scheduler.fetch(url)).json();
  assert.ok(starts[1]! - starts[0]! >= 35);
});

test('abort and bounded queue deadline remove unsent writes; releasing old work never sends them later', async () => {
  let calls = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new MoyskladRequestScheduler((async () => {
    calls++; return new Response(new ReadableStream({ async start(controller) { await barrier; controller.close(); } }));
  }) as typeof fetch, base, { intervalMs: 1, maxConcurrent: 1, deadlineMs: 500 });
  const first = await scheduler.fetch(url);
  const cancelled = new AbortController();
  const waiting = scheduler.fetch(url, { method: 'POST', signal: cancelled.signal });
  cancelled.abort(new Error('synthetic-off-transition'));
  await assert.rejects(waiting, /synthetic-off-transition/);
  await assert.rejects(scheduler.fetch(url, { method: 'PUT', signal: AbortSignal.timeout(20) }), { name: 'TimeoutError' });
  release(); await first.text(); await sleep(10);
  assert.equal(calls, 1);
});

test('body cancellation and network rejection release capacity; request context and authorization survive queuing', async () => {
  const scope = new AsyncLocalStorage<string>();
  const observed: (string | undefined)[] = [];
  let calls = 0;
  const scheduler = new MoyskladRequestScheduler((async (_input, init) => {
    observed.push(scope.getStore()); calls++;
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-only');
    if (calls === 2) throw new Error('synthetic-network');
    return reply({ call: calls });
  }) as typeof fetch, base, { intervalMs: 5 });
  const first = await scope.run('one', () => scheduler.fetch(url, { headers: { authorization: 'Bearer synthetic-only' } }));
  await first.body!.cancel();
  const failed = scope.run('two', () => scheduler.fetch(url, { headers: { authorization: 'Bearer synthetic-only' } }));
  await assert.rejects(failed, /synthetic-network/);
  assert.deepEqual(await (await scope.run('three', () => scheduler.fetch(url, { headers: { authorization: 'Bearer synthetic-only' } }))).json(), { call: 3 });
  assert.deepEqual(observed, ['one', 'two', 'three']);
});

test('other origins and sibling API prefixes bypass pacing without changing their request', async () => {
  let calls = 0;
  const scheduler = new MoyskladRequestScheduler((async (_input, init) => { calls++; assert.equal(init?.method, 'POST'); return reply(); }) as typeof fetch, base);
  await Promise.all(['https://aerosystems.bitrix24.ru/rest/test', 'https://api.moysklad.ru/api/remap/1.20/entity/product'].map(async (target) => (await scheduler.fetch(target, { method: 'POST' })).json()));
  assert.equal(calls, 2);
});

test('empty-body 429 and a longer HTTP-date Retry-After are preserved without any hidden retry', async () => {
  let calls = 0;
  const future = new Date(Date.now() + 60_000).toUTCString();
  const scheduler = new MoyskladRequestScheduler((async () => { calls++; return new Response(null, { status: 429, headers: { 'retry-after': future } }); }) as typeof fetch, base);
  const response = await scheduler.fetch(url, { method: 'POST' });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), future);
  assert.equal(await response.text(), '');
  assert.equal(calls, 1);
});

test('a Request body and native acknowledgement status/URL are not rewritten', async () => {
  const request = new Request(url, { method: 'POST', headers: { authorization: 'Bearer synthetic-only' }, body: '{"syncId":"synthetic"}' });
  const scheduler = new MoyskladRequestScheduler((async (input, init) => {
    assert.equal(input, request);
    assert.equal(await request.clone().text(), '{"syncId":"synthetic"}');
    assert.ok(init?.signal);
    const response = new Response('{"id":"native-id"}', { status: 201 });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  }) as typeof fetch, base);
  const response = await scheduler.fetch(request);
  assert.equal(response.status, 201); assert.equal(response.url, url.href);
  assert.deepEqual(await response.json(), { id: 'native-id' });
});

test('already-aborted signals never consume a transport slot', async () => {
  let calls = 0;
  const scheduler = new MoyskladRequestScheduler((async () => { calls++; return reply(); }) as typeof fetch, base);
  await assert.rejects(scheduler.fetch(url, { signal: AbortSignal.abort(new Error('synthetic-aborted')) }), /synthetic-aborted/);
  assert.equal(calls, 0);
});

test('adapters that throw without reading error bodies cannot exhaust permits; bodies remain readable', async () => {
  let calls = 0;
  const scheduler = new MoyskladRequestScheduler((async () => { calls++; return new Response('{"errors":[{"code":1049}]}', { status: 429, headers: { 'x-lognex-retry-after': '1' } }); }) as typeof fetch, base, { intervalMs: 2, maxConcurrent: 1, deadlineMs: 300 });
  const responses: Response[] = [];
  for (let index = 0; index < 8; index++) responses.push(await scheduler.fetch(url));
  assert.equal(calls, 8);
  for (const response of responses) assert.deepEqual(await response.json(), { errors: [{ code: 1049 }] });
});

test('queued transport retains the event scope and the actual controlled guard still rejects unknown IDs before sending', async () => {
  const previousFetch = globalThis.fetch;
  const saved = new Map(['CONTROLLED_LIVE_TEST_MODE', 'MOYSKLAD_API_BASE_URL', 'BITRIX24_REST_BASE_URL'].map((key) => [key, process.env[key]]));
  const scope = new AsyncLocalStorage<string>();
  const own = '11111111-1111-4111-8111-111111111111';
  let sends = 0;
  try {
    process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
    process.env.MOYSKLAD_API_BASE_URL = base.href;
    process.env.BITRIX24_REST_BASE_URL = 'https://test.bitrix.example/rest/';
    globalThis.fetch = (async () => { sends++; assert.equal(scope.getStore(), own); return reply(); }) as typeof fetch;
    setControlledLiveTestWriteCheck((_provider, _operation, id) => {
      if (id !== own || scope.getStore() !== own) throw new Error('SYNTHETIC_UNKNOWN_ID_REJECTED');
    });
    installControlledLiveFetchGuard({ bitrix24PortalOrigin: 'https://test.bitrix.example', bitrix24UserId: '42', moyskladAccountId: own });
    const scheduler = new MoyskladRequestScheduler(globalThis.fetch, base, { intervalMs: 5, maxConcurrent: 1 });
    const accepted = [0, 1].map(() => scope.run(own, async () => (await scheduler.fetch(new URL('entity/product/' + own, base))).json()));
    const unknown = scope.run('unknown', () => scheduler.fetch(new URL('entity/product/22222222-2222-4222-8222-222222222222', base)));
    const rejected = assert.rejects(unknown, /SYNTHETIC_UNKNOWN_ID_REJECTED/);
    await Promise.all(accepted); await rejected;
    assert.equal(sends, 2);
  } finally {
    globalThis.fetch = previousFetch; setControlledLiveTestWriteCheck(null);
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('actual HTTP burst reproduces 429 unpaced and passes with the shared scheduler', async () => {
  let recent: number[] = []; let rejects = 0;
  const server = createServer((_request, response) => {
    const now = Date.now(); recent = recent.filter((time) => now - time < 40); recent.push(now);
    if (recent.length > 4) { rejects++; response.writeHead(429, { 'x-lognex-retry-after': '40' }); }
    else response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const target = new URL(`http://127.0.0.1:${address.port}/api/remap/1.2/`);
  try {
    await Promise.all(Array.from({ length: 16 }, async () => (await fetch(target)).json()));
    assert.ok(rejects > 0, 'feedback loop must reproduce real server 429 before the scheduler');
    await sleep(50); rejects = 0; recent = [];
    const scheduler = new MoyskladRequestScheduler(fetch, target, { intervalMs: 15, deadlineMs: 3_000 });
    const responses = await Promise.all(Array.from({ length: 16 }, async () => { const response = await scheduler.fetch(target); await response.json(); return response.status; }));
    assert.equal(rejects, 0);
    assert.deepEqual(responses, Array(16).fill(200));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
