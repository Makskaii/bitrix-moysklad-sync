import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ControlledLiveTestAdmissionService } from '../src/controlled-live-test-admission.service';
import { DealOrderCreateOperationService } from '../src/deals-orders/deal-order-create-operation.service';
import { createControlledLiveTestPolicy } from '../src/controlled-live-test-policy';
import { assertControlledExternalRead, installControlledLiveFetchGuard, setControlledLiveTestWriteCheck } from '../src/external-write-guard';

test('controlled deal creation reads dependencies, creates one synthetic order, binds readback and persists exact pair', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue60-deal-create-'));
  const manifestPath = join(directory, 'manifest.json');
  const runId = 'LIVE-TEST-20261019T120000Z-deal01';
  const sourceName = `тест ${runId} deal`;
  const orderId = '10000000-0000-4000-8000-000000000001';
  const refs = {
    counterparty: '20000000-0000-4000-8000-000000000001', organization: '20000000-0000-4000-8000-000000000002',
    store: '20000000-0000-4000-8000-000000000003', employee: '20000000-0000-4000-8000-000000000004',
    currency: '20000000-0000-4000-8000-000000000005', state: '20000000-0000-4000-8000-000000000006',
  };
  const previous = Object.fromEntries(['CONTROLLED_LIVE_TEST_MODE', 'CONTROLLED_LIVE_TEST_INSTANCE', 'CONTROLLED_LIVE_TEST_MANIFEST', 'DATABASE_URL', 'SYNC_MODE', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN', 'BITRIX24_REST_BASE_URL'].map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const records = new Map<string, any>();
  const operationRows = new Map<string, any>();
  const pairs: any[] = [];
  const calls: Array<{ method: string; path: string; body: string }> = [];
  const guardErrors: string[] = [];
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
  process.env.CONTROLLED_LIVE_TEST_INSTANCE = 'isolated';
  process.env.CONTROLLED_LIVE_TEST_MANIFEST = manifestPath;
  process.env.DATABASE_URL = 'postgresql://postgres@127.0.0.1:58341/sync_issue60_test?schema=issue60_harness_test';
  process.env.SYNC_MODE = 'apply';
  process.env.MOYSKLAD_API_BASE_URL = 'https://controlled-ms.invalid/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'fake-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://controlled-b24.invalid/rest/';
  await writeFile(manifestPath, JSON.stringify({ runId, testDatabaseName: 'sync_issue60_test', testSchemaName: 'issue60_harness_test', records: [{
    entity: 'deal-order', direction: 'BITRIX24_TO_MOYSKLAD', name: sourceName, syntheticOnly: true,
    sourceSystem: 'BITRIX24', sourceNativeId: '17', targetSystem: 'MOYSKLAD', targetNativeId: null,
    createdAfterUtc: '2026-10-19T00:00:00.000Z', readOnlyDependencies: [
      { provider: 'MOYSKLAD', entity: 'client:COUNTERPARTY', nativeId: refs.counterparty },
      { provider: 'MOYSKLAD', entity: 'readonly:organization', nativeId: refs.organization },
      { provider: 'MOYSKLAD', entity: 'readonly:store', nativeId: refs.store },
      { provider: 'MOYSKLAD', entity: 'readonly:employee', nativeId: refs.employee },
      { provider: 'MOYSKLAD', entity: 'readonly:currency', nativeId: refs.currency },
      { provider: 'MOYSKLAD', entity: 'readonly:state', nativeId: refs.state },
    ],
  }] }), 'utf8');
  const database: any = {
    controlledTestAdmission: {
      findMany: async ({ where }: any) => [...records.values()].filter((row) => row.runId === where.runId && row.entity === where.entity),
      findUnique: async ({ where }: any) => records.get(where.eventId) ?? null,
      findFirst: async ({ where }: any) => [...records.values()].find((row) => row.runId === where.runId && row.targetSystem === where.targetSystem && row.targetNativeId === where.targetNativeId && row.eventId !== where.NOT.eventId) ?? null,
      upsert: async ({ where, create }: any) => { if (!records.has(where.eventId)) records.set(where.eventId, { ...create }); return records.get(where.eventId); },
      updateMany: async ({ where, data }: any) => { const row = records.get(where.eventId); if (!row || row.targetNativeId !== where.targetNativeId) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
    },
    dealOrderCreateOperation: {
      findUnique: async ({ where }: any) => operationRows.get(where.bitrix24DealId) ?? null,
      findUniqueOrThrow: async ({ where }: any) => { const row = operationRows.get(where.bitrix24DealId); if (!row) throw new Error('missing operation'); return row; },
      create: async ({ data }: any) => { const row = { ...data, attemptedAt: null, leaseToken: null, leaseUntil: null, moyskladOrderId: null }; operationRows.set(data.bitrix24DealId, row); return row; },
      update: async ({ where, data }: any) => { const row = operationRows.get(where.bitrix24DealId); Object.assign(row, data); return row; },
      updateMany: async ({ where, data }: any) => { const row = operationRows.get(where.bitrix24DealId); if (!row || (where.status && row.status !== where.status)) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
    },
    entityPair: {
      findFirst: async ({ where }: any) => pairs.find((row) => row.entityType === where.entityType && (where.bitrix24Id ? row.bitrix24Id === where.bitrix24Id : row.moyskladId === where.moyskladId)) ?? null,
      findMany: async () => [{ id: 'company-pair', entityType: 'COMPANY', bitrix24Id: '31', moyskladId: refs.counterparty }],
    },
    $transaction: async (action: any) => action({
      $queryRaw: async () => [],
      dealOrderCreateOperation: {
        findFirst: async ({ where }: any) => { const row = operationRows.get(where.bitrix24DealId); return row?.status === where.status && row?.leaseToken === where.leaseToken ? row : null; },
        findUniqueOrThrow: async ({ where }: any) => operationRows.get(where.bitrix24DealId),
        update: async ({ where, data }: any) => { const row = operationRows.get(where.bitrix24DealId); Object.assign(row, data); return row; },
      },
      entityPair: {
        findFirst: async ({ where }: any) => pairs.find((row) => row.entityType === where.entityType && (where.bitrix24Id ? row.bitrix24Id === where.bitrix24Id : row.moyskladId === where.moyskladId)) ?? null,
        create: async ({ data }: any) => { const pair = { id: 'pair-1', ...data }; pairs.push(pair); return pair; },
      },
      dealOrderPositionPair: { createMany: async () => ({ count: 0 }) },
      pairReviewCase: { updateMany: async () => ({ count: 0 }) },
    }),
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method;
    const body = await request.clone().text();
    calls.push({ method, path: url.pathname + url.search, body });
    const path = url.pathname.replace('/api/remap/1.2/', '');
    if (method === 'GET' && path.includes('/metadata/states/')) {
      return new Response(JSON.stringify({ id: refs.state, meta: { type: 'state' } }), { status: 200 });
    }
    if (method === 'GET' && path.startsWith('entity/') && !path.startsWith('entity/customerorder/')) {
      const type = path.split('/')[1];
      const id = path.split('/')[2];
      const expectedType = type === 'employee' ? 'employee' : type;
      return new Response(JSON.stringify({ id, meta: { type: expectedType } }), { status: 200 });
    }
    if (method === 'POST' && path === 'entity/customerorder') {
      return new Response(JSON.stringify({ id: orderId, meta: { type: 'customerorder' } }), { status: 200 });
    }
    if (method === 'GET' && path === `entity/customerorder/${orderId}`) {
      return new Response(JSON.stringify({ id: orderId, name: 'SO-1', description: sourceName, created: '2026-10-19 05:00:00', meta: { type: 'customerorder' }, positions: { rows: [] } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  try {
    const policy = createControlledLiveTestPolicy(JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8')), process.env.DATABASE_URL);
    setControlledLiveTestWriteCheck(policy);
    installControlledLiveFetchGuard();
    const guardedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      try { return await guardedFetch(input, init); }
      catch (error) { guardErrors.push(String(error)); throw error; }
    }) as typeof fetch;
    const admission = new ControlledLiveTestAdmissionService(database);
    const input = {
      bitrix24DealId: '17', bitrix24CompanyId: '31', eventId: 'deal-create-event', settingsVersion: 1,
      sourceProductIds: [], sourceRowIds: [], sourceRowValues: [], sourceMeasureCodes: [], unitMappings: [], confirmedCustomerPairIds: ['company-pair'],
      serviceCounterpartyId: refs.counterparty,
      payload: {
        agent: { meta: { type: 'counterparty', href: `https://controlled-ms.invalid/api/remap/1.2/entity/counterparty/${refs.counterparty}` } },
        organization: { meta: { type: 'organization', href: `https://controlled-ms.invalid/api/remap/1.2/entity/organization/${refs.organization}` } },
        store: { meta: { type: 'store', href: `https://controlled-ms.invalid/api/remap/1.2/entity/store/${refs.store}` } },
        state: { meta: { type: 'state', href: `https://controlled-ms.invalid/api/remap/1.2/entity/customerorder/metadata/states/${refs.state}` } },
        owner: { meta: { type: 'employee', href: `https://controlled-ms.invalid/api/remap/1.2/entity/employee/${refs.employee}` } },
        rate: { currency: { meta: { type: 'currency', href: `https://controlled-ms.invalid/api/remap/1.2/entity/currency/${refs.currency}` } } }, positions: [], description: sourceName,
      },
    } as any;
    await admission.withCurrentSourceRead('deal-create-event', 'BITRIX24', '17', 'deal-order', async () => {
      await admission.admit('deal-create-event', { entity: 'deal-order', sourceSystem: 'BITRIX24', sourceNativeId: '17', currentNativeId: '17', currentName: sourceName, sourceCreatedAt: new Date('2026-10-19T01:00:00Z') });
    });
    await admission.runForEvent('deal-create-event', async () => {
      assertControlledExternalRead('MOYSKLAD', refs.counterparty, 'client:COUNTERPARTY');
      assertControlledExternalRead('MOYSKLAD', refs.organization, 'readonly:organization');
      assertControlledExternalRead('MOYSKLAD', refs.store, 'readonly:store');
      assertControlledExternalRead('MOYSKLAD', refs.employee, 'readonly:employee');
      assertControlledExternalRead('MOYSKLAD', refs.currency, 'readonly:currency');
      assertControlledExternalRead('MOYSKLAD', refs.state, 'readonly:state');
      await assert.rejects(fetch('https://controlled-ms.invalid/api/remap/1.2/entity/customerorder', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'ordinary customer order' }),
      }), /CREATE_SYNTHETIC_MARKER_REQUIRED/);
    });
    const mode: any = { read: async () => ({ mode: 'on' }), isDirectionEnabled: async () => true, runDealOrderExternalWrite: async (_direction: string, assertLease: any, _pairs: any, mutation: any) => await assertLease() ? mutation() : false };
    const service = new DealOrderCreateOperationService(database, mode, admission);
    let result: unknown;
    try { result = await admission.runForEvent('deal-create-event', () => service.createAndPair(input)); }
    catch (error) { throw new Error(`${String(error)}; provider calls: ${JSON.stringify(calls)}; guard errors: ${JSON.stringify(guardErrors)}`); }
    assert.deepEqual(result, { status: 'CREATED', bitrix24DealId: '17', moyskladOrderId: orderId });
    assert.equal(records.get('deal-create-event')?.targetNativeId, orderId);
    assert.equal(pairs[0]?.bitrix24Id, '17');
    assert.equal(pairs[0]?.moyskladId, orderId);
    assert.equal(calls.filter((call) => call.method === 'POST' && call.path.endsWith('/entity/customerorder')).length, 1);
    assert.match(calls.find((call) => call.method === 'POST' && call.path.endsWith('/entity/customerorder'))?.body ?? '', new RegExp(sourceName));
  } finally {
    globalThis.fetch = originalFetch;
    setControlledLiveTestWriteCheck(null);
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});
