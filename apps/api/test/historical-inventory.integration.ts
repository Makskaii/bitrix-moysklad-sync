import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AdminAccessGuard, LOCAL_ADMIN_PREVIEW_ACCESS } from '../src/admin/admin-access.guard';
import { HistoricalInventoryController } from '../src/admin/historical-inventory.controller';
import { DatabaseService } from '../src/database.service';
import { HISTORICAL_INVENTORY_FETCHER, HistoricalInventoryService } from '../src/historical-inventory.service';

type StoredRow = Record<string, any>;
type Fixture = ReturnType<typeof createFixture>;
const originalEnv = new Map<string, string | undefined>();
let app: INestApplication;
let apiUrl: string;

before(() => {
  for (const key of ['ADMIN_PREVIEW', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN']) originalEnv.set(key, process.env[key]);
  process.env.ADMIN_PREVIEW = '1';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.test/rest/1/hook/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.test/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-ms-token';
});

after(async () => {
  if (app) await app.close();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('an administrator can build an ID and candidate-only catalog from both systems', async () => {
  const fixture = createFixture(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/crm.deal.fields.json')) return json({ result: bitrixTitles() });
    if (url.pathname.endsWith('/crm.deal.list.json')) {
      const form = new URLSearchParams(String(init?.body ?? ''));
      assert.deepEqual(form.getAll('select[]'), ['ID', 'TITLE', 'UF_CRM_1719836973', 'UF_CRM_1729757435964', 'ORIGINATOR_ID', 'ORIGIN_ID', 'ORIGIN_VERSION', 'DATE_CREATE', 'DATE_MODIFY']);
      assert.equal(form.get('auth'), 'session-token');
      return json({ total: 1, result: [{ ID: 12, TITLE: 'Deal fixture', UF_CRM_1719836973: 'uuid-candidate', UF_CRM_1729757435964: '000041', ORIGINATOR_ID: 'external-system', ORIGIN_ID: 'external-id', ORIGIN_VERSION: 'v1', DATE_CREATE: '2026-01-02T03:04:05+00:00', DATE_MODIFY: '2026-02-03T04:05:06+00:00', COMMENTS: 'must never be stored' }] });
    }
    if (url.pathname.endsWith('/entity/customerorder/metadata')) return json({});
    if (url.pathname.endsWith('/entity/customerorder')) return json({ meta: { size: 1, limit: 500, offset: 0 }, rows: [{ id: 'ms-uuid-1', name: '000041', externalCode: 'unverified-external', created: '2026-01-02 03:04:05.000', updated: '2026-02-03 04:05:06.000', description: 'must never be stored' }] });
    throw new Error(`Unexpected fake HTTP request ${url.pathname}`);
  });
  await boot(fixture);

  const started = await post('/api/admin/historical-inventory/start', { accessToken: 'session-token', moyskladPageSize: 500, requestIntervalMs: 500 });
  assert.equal(started.status, 'running');
  const completed = await waitForStatus('complete');
  assert.equal(completed.bitrixProcessed, 1);
  assert.equal(completed.moyskladProcessed, 1);
  assert.equal(fixture.entries.size, 2);

  const bitrix = await get('/api/admin/historical-inventory/entries?source=BITRIX24');
  const deal = bitrix.entries[0];
  assert.equal(deal.label, 'Deal fixture');
  assert.equal(deal.fields.find((field: any) => field.code === 'UF_CRM_1719836973').title, 'Deal UUID');
  assert.equal(deal.fields.find((field: any) => field.code === 'UF_CRM_1719836973').verification, 'UNVERIFIED');
  assert.equal(deal.fields.find((field: any) => field.code === 'UF_CRM_1729757435964').verification, 'DISPLAY ONLY');
  assert.equal(deal.fields.find((field: any) => field.code === 'UF_CRM_1729757435964').value, '000041');
  assert.equal('COMMENTS' in fixture.entries.get('BITRIX24:12')!.fields, false);

  const moysklad = await get('/api/admin/historical-inventory/entries?source=MOYSKLAD');
  const order = moysklad.entries[0];
  assert.equal(order.label, '000041');
  assert.equal(order.fields.find((field: any) => field.code === 'externalCode').verification, 'UNVERIFIED');
  assert.equal(order.fields.find((field: any) => field.code === 'externalCode').title, 'недоступно в метаданных');
  assert.equal('description' in fixture.entries.get('MOYSKLAD:ms-uuid-1')!.fields, false);
  assert.equal(fixture.requests.some((request) => request.method === 'PUT' || request.method === 'PATCH'), false);
});

test('a pause and restart continue from the saved Bitrix24 cursor without duplicating IDs', async () => {
  let listCalls = 0;
  let releaseSecondPage!: () => void;
  let secondPageStarted!: () => void;
  const secondPage = new Promise<void>((resolve) => { secondPageStarted = resolve; });
  const secondPageGate = new Promise<void>((resolve) => { releaseSecondPage = resolve; });
  const fixture = createFixture(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/crm.deal.fields.json')) return json({ result: bitrixTitles() });
    if (url.pathname.endsWith('/crm.deal.list.json')) {
      const body = fixture.requests.at(-1)?.body ?? '';
      const offset = Number(new URLSearchParams(body).get('start') ?? 0);
      listCalls++;
      if (offset === 0) return json({ total: 51, next: 50, result: Array.from({ length: 50 }, (_, index) => ({ ID: index + 1, TITLE: `Deal ${index + 1}` })) });
      secondPageStarted();
      await secondPageGate;
      return json({ total: 51, result: [{ ID: 50, TITLE: 'Repeated boundary record' }] });
    }
    if (url.pathname.endsWith('/entity/customerorder/metadata')) return json({});
    if (url.pathname.endsWith('/entity/customerorder')) return json({ meta: { size: 0, limit: 500, offset: 0 }, rows: [] });
    throw new Error(`Unexpected fake HTTP request ${url.pathname}`);
  });
  await boot(fixture);
  await post('/api/admin/historical-inventory/start', { accessToken: 'session-token', requestIntervalMs: 500 });
  await secondPage;
  fixture.runtimeState.confirmedPair = { source: 'MANUAL', status: 'active', bitrix24Id: 'deal-50', moyskladId: 'ms-50' };
  fixture.runtimeState.baseline = { capturedBy: 'event-driven', revision: 9, value: 'newer-state' };
  const newerRuntimeState = structuredClone(fixture.runtimeState);
  const pauseResponse = await post('/api/admin/historical-inventory/pause', {});
  assert.equal(pauseResponse.status, 'running');
  releaseSecondPage();
  const paused = await waitForStatus('paused');
  assert.equal(paused.phase, 'MOYSKLAD');
  assert.equal(paused.bitrixStart, 0);

  const resumed = await post('/api/admin/historical-inventory/start', { accessToken: 'new-session-token', requestIntervalMs: 500 });
  assert.equal(resumed.status, 'running');
  const completed = await waitForStatus('complete');
  assert.equal(completed.bitrixProcessed, 51);
  assert.equal(fixture.entries.size, 50);
  assert.equal(listCalls, 2);
  assert.equal(fixture.requests.filter((request) => request.path.endsWith('/crm.deal.list.json')).length, 2);
  assert.deepEqual(fixture.runtimeState, newerRuntimeState);
});

test('a rate-limit response retries the same page and completes without advancing a failed checkpoint', async () => {
  let firstPageRequests = 0;
  const fixture = createFixture(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/crm.deal.fields.json')) return json({ result: bitrixTitles() });
    if (url.pathname.endsWith('/crm.deal.list.json')) {
      const body = fixture.requests.at(-1)?.body ?? '';
      assert.equal(new URLSearchParams(body).get('start'), '0');
      firstPageRequests++;
      if (firstPageRequests === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      return json({ total: 1, result: [{ ID: 'retry-deal', TITLE: 'Retry deal' }] });
    }
    if (url.pathname.endsWith('/entity/customerorder/metadata')) return json({});
    if (url.pathname.endsWith('/entity/customerorder')) return json({ meta: { size: 0, limit: 500, offset: 0 }, rows: [] });
    throw new Error(`Unexpected fake HTTP request ${url.pathname}`);
  });
  await boot(fixture);

  await post('/api/admin/historical-inventory/start', { accessToken: 'session-token', requestIntervalMs: 500 });
  const completed = await waitForStatus('complete');
  assert.equal(firstPageRequests, 2);
  assert.equal(completed.bitrixProcessed, 1);
  assert.equal(fixture.entries.size, 1);
});

test('a stale worker cannot advance a checkpoint after another owner takes its lease', async () => {
  const fixture = createFixture(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/crm.deal.fields.json')) return json({ result: bitrixTitles() });
    if (url.pathname.endsWith('/crm.deal.list.json')) {
      fixture.stealLease();
      return json({ total: 50, result: Array.from({ length: 50 }, (_, index) => ({ ID: `stale-${index + 1}`, TITLE: `Stale deal ${index + 1}` })) });
    }
    if (url.pathname.endsWith('/entity/customerorder/metadata')) return json({});
    if (url.pathname.endsWith('/entity/customerorder')) return json({ meta: { size: 0, limit: 500, offset: 0 }, rows: [] });
    throw new Error(`Unexpected fake HTTP request ${url.pathname}`);
  });
  await boot(fixture);
  await post('/api/admin/historical-inventory/start', { accessToken: 'session-token', requestIntervalMs: 500 });
  for (let attempt = 0; attempt < 200 && !fixture.leaseLossDetected; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fixture.leaseLossDetected, true, 'the worker must detect that it no longer owns its lease');
  assert.equal(fixture.job?.leaseOwner, 'lease-stolen-by-other-worker');
  assert.equal(fixture.job?.bitrixStart, 0, 'stale worker must not advance the saved page cursor');
  assert.equal(fixture.job?.bitrixProcessed, 0, 'stale worker must not commit progress for another owner');
  assert.equal(fixture.entries.size, 0, 'stale worker must not persist page records after losing its lease');
});

test('an empty Bitrix24 page with a next cursor fails without advancing the checkpoint', async () => {
  const fixture = createFixture(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/crm.deal.fields.json')) return json({ result: bitrixTitles() });
    if (url.pathname.endsWith('/crm.deal.list.json')) return json({ total: 100, next: 50, result: [] });
    throw new Error(`Unexpected fake HTTP request ${url.pathname}`);
  });
  await boot(fixture);

  await post('/api/admin/historical-inventory/start', { accessToken: 'session-token', requestIntervalMs: 500 });
  const failed = await waitForStatus('failed');

  assert.equal(failed.bitrixStart, 0, 'invalid empty page must retain its original cursor');
  assert.equal(failed.bitrixProcessed, 0);
  assert.equal(fixture.entries.size, 0);
});

test('an expired worker lease cannot advance the checkpoint even when the owner token still matches', async () => {
  const fixture = createFixture(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/crm.deal.fields.json')) return json({ result: bitrixTitles() });
    if (url.pathname.endsWith('/crm.deal.list.json')) {
      fixture.expireLease();
      return json({ total: 0, result: [] });
    }
    throw new Error(`Unexpected fake HTTP request ${url.pathname}`);
  });
  await boot(fixture);

  await post('/api/admin/historical-inventory/start', { accessToken: 'session-token', requestIntervalMs: 500 });
  for (let attempt = 0; attempt < 200 && !fixture.leaseLossDetected; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(fixture.leaseLossDetected, true, 'the worker must reject its expired lease');
  assert.equal(fixture.job?.bitrixStart, 0, 'expired lease must not advance the page cursor');
  assert.equal(fixture.job?.bitrixProcessed, 0);
  assert.equal(fixture.entries.size, 0);
});

function createFixture(fetcher: typeof fetch) {
  const entries = new Map<string, StoredRow>();
  const requests: Array<{ path: string; method: string; body: string }> = [];
  const runtimeState: { confirmedPair: StoredRow; baseline: StoredRow } = {
    confirmedPair: { source: 'MANUAL', status: 'active', bitrix24Id: 'deal-old', moyskladId: 'ms-old' },
    baseline: { capturedBy: 'event-driven', revision: 1, value: 'initial-state' },
  };
  let job: StoredRow | null = null;
  let leaseLossDetected = false;
  const stealLease = () => { if (job) { job.leaseOwner = 'lease-stolen-by-other-worker'; job.leaseUntil = new Date(Date.now() + 60_000); } };
  const expireLease = () => { if (job) { job.attempts = 4; job.leaseUntil = new Date(0); } };
  const database = {
    historicalInventoryJob: {
      upsert: async ({ create }: { create: StoredRow }) => job ??= ({ id: 'deal-order-history', runId: null, status: 'idle', phase: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, bitrixProcessed: 0, moyskladProcessed: 0, bitrixTotal: null, moyskladTotal: null, moyskladPageSize: 500, requestIntervalMs: 1000, attempts: 0, error: null, retryAfter: null, pauseRequested: false, leaseOwner: null, leaseUntil: null, checkpointAt: null, updatedAt: new Date(), ...create }),
      findUnique: async () => job,
      update: async ({ data }: { data: StoredRow }) => { job = applyData(job!, data); return job; },
      updateMany: async ({ where, data }: { where: StoredRow; data: StoredRow }) => {
        if (!job || (where.leaseOwner && where.leaseOwner !== job.leaseOwner)) { if (where.leaseOwner) leaseLossDetected = true; return { count: 0 }; }
        if (where.OR && job.leaseUntil && job.leaseUntil > new Date()) return { count: 0 };
        if (where.leaseUntil?.gt && (!job.leaseUntil || job.leaseUntil <= where.leaseUntil.gt)) { if (where.leaseOwner) leaseLossDetected = true; return { count: 0 }; }
        job = applyData(job, data); return { count: 1 };
      },
    },
    historicalInventoryEntry: {
      upsert: async ({ where, create, update }: { where: { source_externalId: { source: string; externalId: string } }; create: StoredRow; update: StoredRow }) => {
        const key = `${where.source_externalId.source}:${where.source_externalId.externalId}`;
        const existing = entries.get(key);
        const value = existing ? { ...existing, ...update } : { id: `row-${entries.size + 1}`, ...create };
        entries.set(key, value); return value;
      },
      findMany: async ({ where, take }: { where: { source: string; externalId?: { lt: string } }; take: number }) => [...entries.values()]
        .filter((row) => row.source === where.source && (!where.externalId || row.externalId < where.externalId.lt))
        .sort((a, b) => b.externalId.localeCompare(a.externalId)).slice(0, take),
    },
    $queryRawUnsafe: async () => [],
    $transaction: async (operation: (transaction: any) => Promise<unknown>) => operation(database),
  };
  const instrumentedFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : String(init?.body ?? '') });
    return fetcher(input, init);
  };
  return { database, entries, requests, runtimeState, fetcher: instrumentedFetch, stealLease, expireLease, get job() { return job; }, get leaseLossDetected() { return leaseLossDetected; } };
}

async function boot(fixture: Fixture) {
  if (app) await app.close();
  @Module({
    controllers: [HistoricalInventoryController],
    providers: [HistoricalInventoryService, AdminAccessGuard, { provide: DatabaseService, useValue: fixture.database }, { provide: LOCAL_ADMIN_PREVIEW_ACCESS, useValue: true }, { provide: HISTORICAL_INVENTORY_FETCHER, useValue: fixture.fetcher }],
  }) class HistoricalInventoryTestModule {}
  app = await NestFactory.create(HistoricalInventoryTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
}

async function get(path: string) {
  const response = await fetch(`${apiUrl}${path}`);
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${apiUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 201);
  return response.json() as Promise<any>;
}

async function waitForStatus(expected: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await get('/api/admin/historical-inventory');
    if (state.status === expected) return state;
    if (state.status === 'failed') throw new Error(`Historical inventory failed: ${state.error}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Historical inventory did not reach ${expected}`);
}

function applyData(current: StoredRow, data: StoredRow) {
  const next = { ...current };
  for (const [key, value] of Object.entries(data)) {
    next[key] = value && typeof value === 'object' && 'increment' in value ? Number(next[key]) + Number(value.increment) : value;
  }
  return next;
}

function bitrixTitles() {
  return Object.fromEntries(['ID', 'TITLE', 'UF_CRM_1719836973', 'UF_CRM_1729757435964', 'ORIGINATOR_ID', 'ORIGIN_ID', 'ORIGIN_VERSION', 'DATE_CREATE', 'DATE_MODIFY'].map((code) => [code, { title: code === 'UF_CRM_1719836973' ? 'Deal UUID' : code }]));
}

function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }
