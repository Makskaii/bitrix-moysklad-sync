import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { before, after, test } from 'node:test';
import { createServer, Server } from 'node:http';
import { DatabaseService } from '../src/database.service';
import { MoyskladRequestScheduler, installMoyskladRequestScheduler } from '../src/moysklad-request-scheduler';
import { HttpClientSyncGateway } from '../src/clients/client-sync.gateway';
import { serviceModeBoundProvider, withServiceModeOn } from '../src/service-mode-transaction';
import { setDatabaseRecoveryReady } from '../src/external-write-guard';
import { ProviderFailure } from '../src/provider-failure';

let database: DatabaseService;
let server: Server;
let base: URL;
let starts: number[] = [];
let writes = 0;
let failWrite = false;
let releaseBody: (() => void) | undefined;
const originalFetch = globalThis.fetch;
const entityId = '11111111-1111-4111-8111-111111111111';

before(async () => {
  assert.equal(process.env.MS_SCHEDULER_TEST_ISOLATED, '1');
  const target = new URL(process.env.DATABASE_URL!);
  assert.match(target.hostname, /^(localhost|127\.0\.0\.1)$/);
  assert.match(target.pathname, /_test$/);
  assert.match(target.searchParams.get('schema') ?? '', /^root22_ms_/);
  process.env.SYNC_MODE = 'apply'; setDatabaseRecoveryReady(true);
  database = new DatabaseService();
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  server = createServer((request, response) => {
    starts.push(Date.now());
    if (request.method !== 'GET') writes++;
    if (request.url?.endsWith('/hang')) {
      response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders();
      releaseBody = () => response.end('{}'); return;
    }
    if (request.method === 'PUT' && failWrite) {
      failWrite = false;
      response.writeHead(429, { 'x-lognex-retry-after': '80' }); response.end('{"errors":[{"code":1049}]}'); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: entityId, meta: { type: 'counterparty' }, name: 'synthetic only' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  base = new URL(`http://127.0.0.1:${address.port}/api/remap/1.2/`);
  process.env.MOYSKLAD_API_BASE_URL = base.href;
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-only';
});
after(async () => {
  globalThis.fetch = originalFetch; releaseBody?.();
  await database?.$disconnect();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test('bootstrap installation covers independently constructed real gateways behind actual PG mode gates', async () => {
  starts = []; writes = 0;
  const transportStarts: number[] = [];
  globalThis.fetch = ((input, init) => { transportStarts.push(Date.now()); return originalFetch(input, init); }) as typeof fetch;
  installMoyskladRequestScheduler();
  try {
    const first = serviceModeBoundProvider(database, new HttpClientSyncGateway());
    const second = serviceModeBoundProvider(database, new HttpClientSyncGateway());
    const rows = await Promise.all([first.readMoysklad('counterparty', entityId, null), second.readMoysklad('counterparty', entityId, null)]);
    assert.deepEqual(rows.map((row) => row.id), [entityId, entityId]);
    assert.equal(starts.length, 2); assert.equal(transportStarts.length, 2);
    assert.ok(transportStarts[1]! - transportStarts[0]! >= 249); assert.equal(writes, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('a real PG PAUSE acknowledgement cannot be followed by an expired queued provider write', async () => {
  starts = []; writes = 0;
  const scheduler = new MoyskladRequestScheduler(originalFetch, base, { maxConcurrent: 1, intervalMs: 5, deadlineMs: 2_000 });
  const held = await scheduler.fetch(new URL('hang', base));
  let submitted!: () => void;
  const entered = new Promise<void>((resolve) => { submitted = resolve; });
  const queued = withServiceModeOn(database, () => {
    submitted();
    return scheduler.fetch(new URL('entity/counterparty/' + entityId, base), { method: 'PUT', body: '{}', signal: AbortSignal.timeout(80) });
  });
  const rejected = assert.rejects(queued, { name: 'TimeoutError' });
  await entered;
  let acknowledged = false;
  const pause = Promise.resolve(database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'pause' } })).then(() => { acknowledged = true; });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(acknowledged, false, 'PAUSE must wait for the actual bounded mode-gated request');
  await rejected; await pause;
  releaseBody!(); await held.json();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(writes, 0);
  assert.deepEqual(await withServiceModeOn(database, () => scheduler.fetch(new URL('entity/counterparty/' + entityId, base), { method: 'PUT', body: '{}' })), { enabled: false });
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
});

test('an actual gateway gets durable Retry-After and a subsequent read shares cooldown without a second PUT', async () => {
  starts = []; writes = 0; failWrite = true;
  const scheduler = new MoyskladRequestScheduler(originalFetch, base, { intervalMs: 5, deadlineMs: 2_000 });
  const gateway = serviceModeBoundProvider(database, new HttpClientSyncGateway(scheduler.fetch));
  await assert.rejects(gateway.updateMoysklad('counterparty', entityId, null, { name: 'synthetic only' }), (error: unknown) => {
    assert.ok(error instanceof ProviderFailure); assert.equal(error.status, 429); assert.ok(error.retryAfterAt); return true;
  });
  assert.equal((await gateway.readMoysklad('counterparty', entityId, null)).id, entityId);
  assert.equal(writes, 1); assert.equal(starts.length, 2); assert.ok(starts[1]! - starts[0]! >= 75);
});
