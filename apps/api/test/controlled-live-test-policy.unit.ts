import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlledLiveTestPolicy, enterControlledLiveEventScope, registerControlledTargetReadback, withControlledLiveEventScope } from '../src/controlled-live-test-policy';
import { assertApplyExternalWrite, assertControlledExternalRead, installControlledLiveFetchGuard, setControlledLiveTestWriteCheck } from '../src/external-write-guard';
import { ControlledLiveTestAdmissionService } from '../src/controlled-live-test-admission.service';
import { HttpClientCandidateGateway } from '../src/clients/client-candidate.gateway';
import { HttpClientSyncGateway } from '../src/clients/client-sync.gateway';

const manifest = {
  runId: 'LIVE-TEST-20261019T120000Z-a1b2c3',
  testDatabaseName: 'sync_issue60_test',
  records: [{ entity: 'client:COMPANY', direction: 'BITRIX24_TO_MOYSKLAD', name: 'тест LIVE-TEST-20261019T120000Z-a1b2c3 client', syntheticOnly: true, sourceSystem: 'BITRIX24', sourceNativeId: 'b24-17', targetSystem: 'MOYSKLAD', targetNativeId: 'ms-29', createdAfterUtc: '2026-10-19T00:00:00Z' }],
};
const scope = {
  eventId: 'evt-1', runId: manifest.runId, entity: 'client:COMPANY', sourceSystem: 'BITRIX24' as const, sourceNativeId: 'b24-17',
  targetSystem: 'MOYSKLAD' as const, targetNativeId: 'ms-29', admittedSourceName: manifest.records[0].name, admittedSourceCreatedAt: '2026-10-19T01:00:00Z',
};

test('controlled writes require a dedicated database named exactly in the manifest', () => {
  assert.throws(() => createControlledLiveTestPolicy(manifest, 'postgres://localhost/business'), /DATABASE_IS_NOT_DEDICATED/);
  assert.throws(() => createControlledLiveTestPolicy({ ...manifest, testDatabaseName: 'other_test' }, 'postgres://localhost/sync_issue60_test'), /DATABASE_IS_NOT_DEDICATED/);
  assert.throws(() => createControlledLiveTestPolicy(manifest, 'postgres://db.example/sync_issue60_test'), /DATABASE_MUST_BE_LOCAL/);
  assert.throws(() => createControlledLiveTestPolicy(manifest, 'mysql://localhost/sync_issue60_test'), /DATABASE_URL_INVALID/);
});

test('malformed manifests, duplicate targets and omitted policy data fail closed', () => {
  assert.throws(() => createControlledLiveTestPolicy({ ...manifest, runId: 'run' }, 'postgres://localhost/sync_issue60_test'), /MANIFEST_INVALID/);
  assert.throws(() => createControlledLiveTestPolicy({ ...manifest, records: [...manifest.records, ...manifest.records] }, 'postgres://localhost/sync_issue60_test'), /DUPLICATE_RECORD/);
  assert.throws(() => createControlledLiveTestPolicy(manifest, undefined), /DATABASE_URL_REQUIRED/);
  assert.throws(() => createControlledLiveTestPolicy({ ...manifest, records: [{ ...manifest.records[0], name: 'тест invented-run client' }] }, 'postgres://localhost/sync_issue60_test'), /MANIFEST_RECORD_INVALID/);
  assert.throws(() => createControlledLiveTestPolicy({ ...manifest, records: [{ ...manifest.records[0], syntheticOnly: false }] }, 'postgres://localhost/sync_issue60_test'), /MANIFEST_RECORD_INVALID/);
});

test('a mutation is allowed only for the exact current run, source, entity, provider and target ID', () => {
  const assertWrite = createControlledLiveTestPolicy(manifest, 'postgres://localhost/sync_issue60_test');
  assert.throws(() => assertWrite('MOYSKLAD', 'CLIENT_UPDATE', 'ms-29', 'client:COMPANY'), /EVENT_SCOPE_REQUIRED/);
  withControlledLiveEventScope(scope, () => assert.doesNotThrow(() => assertWrite('MOYSKLAD', 'CLIENT_UPDATE', 'ms-29', 'client:COMPANY')));
  withControlledLiveEventScope(scope, () => assert.throws(() => assertWrite('MOYSKLAD', 'CLIENT_UPDATE', undefined, 'client:COMPANY'), /TARGET_NOT_IN_MANIFEST/));
  withControlledLiveEventScope({ ...scope, targetNativeId: 'shared-customer-1' }, () =>
    assert.throws(() => assertWrite('MOYSKLAD', 'CLIENT_UPDATE', 'ms-29', 'client:COMPANY'), /TARGET_NOT_IN_MANIFEST/));
  withControlledLiveEventScope({ ...scope, runId: 'LIVE-TEST-20261019T120000Z-xxxxxx' }, () =>
    assert.throws(() => assertWrite('MOYSKLAD', 'CLIENT_UPDATE', 'ms-29', 'client:COMPANY'), /RUN_ID_MISMATCH/));
  withControlledLiveEventScope(scope, () => assert.throws(() => assertWrite('BITRIX24', 'CLIENT_UPDATE', 'ms-29', 'client:COMPANY'), /TARGET_NOT_IN_MANIFEST/));
});

test('manifest-reserved creation can proceed only from the exact synthetic source within the run window', () => {
  const creationManifest = { ...manifest, records: [{ ...manifest.records[0], targetNativeId: null }] };
  const assertWrite = createControlledLiveTestPolicy(creationManifest, 'postgres://localhost/sync_issue60_test');
  const pendingScope = { ...scope, targetNativeId: null };
  withControlledLiveEventScope(pendingScope, () => assert.doesNotThrow(() => assertWrite('MOYSKLAD', 'CLIENT_CREATE', null, 'client:COMPANY')));
  withControlledLiveEventScope({ ...scope, admittedSourceName: 'тест forged LIVE-TEST-20261019T120000Z-a1b2c3' }, () =>
    assert.throws(() => assertWrite('MOYSKLAD', 'CLIENT_CREATE', null, 'client:COMPANY'), /TARGET_NOT_IN_MANIFEST/));
  withControlledLiveEventScope({ ...scope, admittedSourceCreatedAt: '2026-10-18T23:59:59Z' }, () =>
    assert.throws(() => assertWrite('MOYSKLAD', 'CLIENT_CREATE', null, 'client:COMPANY'), /TARGET_NOT_IN_MANIFEST/));
});

test('pre-admission reads and create readback are exact-ID scoped; shared record reads are refused', () => {
  const assertWrite = createControlledLiveTestPolicy(manifest, 'postgres://localhost/sync_issue60_test');
  const previousMode = process.env.CONTROLLED_LIVE_TEST_MODE;
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
  setControlledLiveTestWriteCheck(assertWrite);
  try {
    const sourceReadScope = { ...scope, phase: 'SOURCE_READ' as const, targetNativeId: null, admittedSourceName: '', admittedSourceCreatedAt: '2026-10-19T00:00:00Z' };
    withControlledLiveEventScope(sourceReadScope, () => {
      assert.doesNotThrow(() => assertControlledExternalRead('BITRIX24', 'b24-17', 'client:COMPANY'));
      assert.throws(() => assertControlledExternalRead('BITRIX24', 'shared-real-id', 'client:COMPANY'), /READ_ID_NOT_APPROVED/);
    });
    const createScope = { ...scope, targetNativeId: null };
    setControlledLiveTestWriteCheck(createControlledLiveTestPolicy({ ...manifest, records: [{ ...manifest.records[0], targetNativeId: null }] }, 'postgres://localhost/sync_issue60_test'));
    withControlledLiveEventScope(createScope, () => {
      registerControlledTargetReadback('MOYSKLAD', 'ms-new-29');
      assert.doesNotThrow(() => assertControlledExternalRead('MOYSKLAD', 'ms-new-29', 'client:COMPANY'));
      assert.throws(() => assertControlledExternalRead('MOYSKLAD', 'ms-other-30', 'client:COMPANY'), /READ_ID_NOT_APPROVED/);
    });
  } finally {
    setControlledLiveTestWriteCheck(null);
    if (previousMode === undefined) delete process.env.CONTROLLED_LIVE_TEST_MODE; else process.env.CONTROLLED_LIVE_TEST_MODE = previousMode;
  }
});

test('async event scopes remain isolated when concurrent events overlap', async () => {
  const assertWrite = createControlledLiveTestPolicy(manifest, 'postgres://localhost/sync_issue60_test');
  const outcomes = await Promise.all([
    withControlledLiveEventScope(scope, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      assertWrite('MOYSKLAD', 'CLIENT_UPDATE', 'ms-29', 'client:COMPANY');
      return 'allowed';
    }),
    withControlledLiveEventScope({ ...scope, targetNativeId: 'other' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      assert.throws(() => assertWrite('MOYSKLAD', 'CLIENT_UPDATE', 'ms-29', 'client:COMPANY'), /TARGET_NOT_IN_MANIFEST/);
      return 'rejected';
    }),
  ]);
  assert.deepEqual(outcomes, ['allowed', 'rejected']);
});

test('the existing provider-write seam blocks missing controlled-test policy and delegates to the manifest allowlist', () => {
  const previousMode = process.env.CONTROLLED_LIVE_TEST_MODE;
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
  try {
    setControlledLiveTestWriteCheck(null);
    assert.throws(() => assertApplyExternalWrite('MOYSKLAD', 'CLIENT_CHILD_RESOURCE_UPDATE'), /POLICY_NOT_INITIALIZED/);
    setControlledLiveTestWriteCheck(createControlledLiveTestPolicy(manifest, 'postgres://localhost/sync_issue60_test'));
    withControlledLiveEventScope(scope, () => assert.doesNotThrow(() => assertApplyExternalWrite('MOYSKLAD', 'CLIENT_CHILD_RESOURCE_UPDATE', 'ms-29', 'client:COMPANY')));
    withControlledLiveEventScope({ ...scope, targetNativeId: 'work-record-9' }, () =>
      assert.throws(() => assertApplyExternalWrite('MOYSKLAD', 'CLIENT_CHILD_RESOURCE_UPDATE', 'work-record-9', 'client:COMPANY'), /TARGET_NOT_IN_MANIFEST/));
  } finally {
    setControlledLiveTestWriteCheck(null);
    if (previousMode === undefined) delete process.env.CONTROLLED_LIVE_TEST_MODE;
    else process.env.CONTROLLED_LIVE_TEST_MODE = previousMode;
  }
});

test('client source admission, target readback binding and restart scope are durable and exact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue60-controlled-'));
  const manifestPath = join(directory, 'manifest.json');
  const dynamicManifest = { ...manifest, records: [{ ...manifest.records[0], targetNativeId: null }] };
  const records = new Map<string, any>();
  const fakeDatabase = {
    controlledTestAdmission: {
      findMany: async ({ where }: any) => [...records.values()].filter((row) => row.runId === where.runId && row.entity === where.entity),
      findUnique: async ({ where }: any) => records.get(where.eventId) ?? null,
      findFirst: async ({ where }: any) => [...records.values()].find((row) => row.runId === where.runId && row.targetSystem === where.targetSystem && row.targetNativeId === where.targetNativeId && row.eventId !== where.NOT.eventId) ?? null,
      upsert: async ({ where, create }: any) => { if (!records.has(where.eventId)) records.set(where.eventId, { ...create }); return records.get(where.eventId); },
      updateMany: async ({ where, data }: any) => { const row = records.get(where.eventId); if (!row || row.targetNativeId !== where.targetNativeId) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
    },
  };
  const previous = { mode: process.env.CONTROLLED_LIVE_TEST_MODE, instance: process.env.CONTROLLED_LIVE_TEST_INSTANCE, path: process.env.CONTROLLED_LIVE_TEST_MANIFEST, database: process.env.DATABASE_URL };
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
  process.env.CONTROLLED_LIVE_TEST_INSTANCE = 'isolated';
  process.env.DATABASE_URL = 'postgres://localhost/sync_issue60_test';
  process.env.CONTROLLED_LIVE_TEST_MANIFEST = manifestPath;
  await writeFile(manifestPath, JSON.stringify(dynamicManifest), 'utf8');
  try {
    const admission = new ControlledLiveTestAdmissionService(fakeDatabase as any);
    const source = { entity: 'client:COMPANY', sourceSystem: 'BITRIX24' as const, sourceNativeId: 'b24-17', currentNativeId: 'b24-17', currentName: dynamicManifest.records[0].name, sourceCreatedAt: new Date('2026-10-19T01:00:00Z') };
    await assert.rejects(admission.admit('forged', { ...source, currentName: `${source.currentName} spoof` }), /SOURCE_NOT_ADMITTED/);
    await admission.runForEvent('evt-1', async () => {
      await admission.admit('evt-1', source);
      enterControlledLiveEventScope(await admission.scopeForEvent('evt-1'));
      assert.throws(() => assertApplyExternalWrite('MOYSKLAD', 'CLIENT_UPDATE', null, 'client:COMPANY'), /TARGET_NOT_IN_MANIFEST/);
      await admission.bindCreatedTarget('evt-1', 'ms-29', 'ms-29', source.currentName, new Date('2026-10-19T02:00:00Z'));
      assert.doesNotThrow(() => assertApplyExternalWrite('MOYSKLAD', 'CLIENT_UPDATE', 'ms-29', 'client:COMPANY'));
    });
    const restartedAdmission = new ControlledLiveTestAdmissionService(fakeDatabase as any);
    await restartedAdmission.admit('evt-2', { entity: 'client:COMPANY', sourceSystem: 'MOYSKLAD', sourceNativeId: 'ms-29', currentNativeId: 'ms-29', currentName: source.currentName, sourceCreatedAt: new Date('2026-10-19T02:00:00Z') });
    await restartedAdmission.runForEvent('evt-2', async () => assert.doesNotThrow(() => assertApplyExternalWrite('BITRIX24', 'CLIENT_UPDATE', 'b24-17', 'client:COMPANY')));
    await assert.rejects(restartedAdmission.admit('evt-wrong-readback', { ...source, currentNativeId: 'different', currentName: source.currentName }), /SOURCE_ID_MISMATCH/);
    await assert.rejects(restartedAdmission.admit('evt-3', { ...source, sourceNativeId: 'shared-real-company', currentNativeId: 'shared-real-company', currentName: source.currentName }), /SOURCE_NOT_ADMITTED/);
  } finally {
    setControlledLiveTestWriteCheck(null);
    for (const [key, value] of [['CONTROLLED_LIVE_TEST_MODE', previous.mode], ['CONTROLLED_LIVE_TEST_INSTANCE', previous.instance], ['CONTROLLED_LIVE_TEST_MANIFEST', previous.path], ['DATABASE_URL', previous.database]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('manifest-admitted synthetic client can create, read back, bind, then accept its exact reverse update', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue60-client-e2e-'));
  const manifestPath = join(directory, 'manifest.json');
  const dynamicManifest = { ...manifest, records: [{ ...manifest.records[0], targetNativeId: null }] };
  const rows = new Map<string, any>();
  const fakeDatabase = { controlledTestAdmission: {
    findMany: async () => [...rows.values()],
    findUnique: async ({ where }: any) => rows.get(where.eventId) ?? null,
    findFirst: async () => null,
    upsert: async ({ where, create }: any) => { if (!rows.has(where.eventId)) rows.set(where.eventId, { ...create }); return rows.get(where.eventId); },
    updateMany: async ({ where, data }: any) => { const row = rows.get(where.eventId); if (!row || row.targetNativeId !== where.targetNativeId) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
  } };
  const database = { controlledTestAdmission: fakeDatabase.controlledTestAdmission };
  const previous = { mode: process.env.CONTROLLED_LIVE_TEST_MODE, instance: process.env.CONTROLLED_LIVE_TEST_INSTANCE, path: process.env.CONTROLLED_LIVE_TEST_MANIFEST, database: process.env.DATABASE_URL, sync: process.env.SYNC_MODE, msBase: process.env.MOYSKLAD_API_BASE_URL, b24Base: process.env.BITRIX24_REST_BASE_URL, msToken: process.env.MOYSKLAD_API_TOKEN };
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled'; process.env.CONTROLLED_LIVE_TEST_INSTANCE = 'isolated';
  process.env.DATABASE_URL = 'postgres://localhost/sync_issue60_test'; process.env.CONTROLLED_LIVE_TEST_MANIFEST = manifestPath;
  process.env.SYNC_MODE = 'apply'; process.env.MOYSKLAD_API_BASE_URL = 'https://fake.moysklad.invalid/api/remap/1.2/';
  process.env.BITRIX24_REST_BASE_URL = 'https://fake.bitrix.invalid/rest/'; process.env.MOYSKLAD_API_TOKEN = 'fake-token';
  await writeFile(manifestPath, JSON.stringify(dynamicManifest), 'utf8');
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fetcher: typeof fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? '');
    calls.push({ url, method, body });
    if (method === 'POST' && url.endsWith('/entity/counterparty')) return new Response(JSON.stringify({ id: 'ms-29', name: dynamicManifest.records[0].name, created: '2026-10-19T02:00:00Z' }), { status: 200 });
    if (method === 'GET' && url.endsWith('/entity/counterparty/ms-29')) return new Response(JSON.stringify({ id: 'ms-29', name: dynamicManifest.records[0].name, created: '2026-10-19T02:00:00Z' }), { status: 200 });
    if (method === 'POST' && url.endsWith('/crm.company.update.json')) return new Response(JSON.stringify({ result: true }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    const admission = new ControlledLiveTestAdmissionService(database as any);
    const source = { entity: 'client:COMPANY', sourceSystem: 'BITRIX24' as const, sourceNativeId: 'b24-17', currentNativeId: 'b24-17', currentName: dynamicManifest.records[0].name, sourceCreatedAt: new Date('2026-10-19T01:00:00Z') };
    await admission.runForEvent('client-create', async () => {
      await admission.admit('client-create', source);
      enterControlledLiveEventScope(await admission.scopeForEvent('client-create'));
      const candidate = new HttpClientCandidateGateway({} as any, fetcher);
      const targetId = await candidate.createTarget({ entity: 'COMPANY', targetSystem: 'MOYSKLAD', targetType: 'counterparty', parentId: null, source: { TITLE: source.currentName }, configuredFields: { name: 'forged config override' }, eventId: 'client-create' });
      assert.equal(targetId, 'ms-29');
      const readback = await candidate.readRecord('MOYSKLAD', 'COMPANY', targetId);
      await admission.bindCreatedTarget('client-create', targetId, String(readback.id), String(readback.name), new Date(String(readback.created)));
    });
    await admission.admit('client-echo', { entity: 'client:COMPANY', sourceSystem: 'MOYSKLAD', sourceNativeId: 'ms-29', currentNativeId: 'ms-29', currentName: source.currentName, sourceCreatedAt: new Date('2026-10-19T02:00:00Z') });
    await admission.runForEvent('client-echo', async () => new HttpClientSyncGateway(fetcher).updateBitrix('COMPANY', 'b24-17', { PHONE: '555-0100' }));
    assert.equal(calls.length, 3);
    assert.match(calls[0].body, /"name":"тест/);
    assert.doesNotMatch(calls[0].body, /forged/);
    assert.equal(calls[2].method, 'POST');
  } finally {
    setControlledLiveTestWriteCheck(null);
    for (const [key, value] of [['CONTROLLED_LIVE_TEST_MODE', previous.mode], ['CONTROLLED_LIVE_TEST_INSTANCE', previous.instance], ['CONTROLLED_LIVE_TEST_MANIFEST', previous.path], ['DATABASE_URL', previous.database], ['SYNC_MODE', previous.sync], ['MOYSKLAD_API_BASE_URL', previous.msBase], ['BITRIX24_REST_BASE_URL', previous.b24Base], ['MOYSKLAD_API_TOKEN', previous.msToken]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('final fetch guard catches exact provider mutation IDs and refuses unclassified external writes', async () => {
  const previous = { mode: process.env.CONTROLLED_LIVE_TEST_MODE, b24: process.env.BITRIX24_REST_BASE_URL, ms: process.env.MOYSKLAD_API_BASE_URL };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
  process.env.BITRIX24_REST_BASE_URL = 'https://guarded-bitrix.invalid/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://guarded-ms.invalid/api/';
  globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 200 }); }) as typeof fetch;
  setControlledLiveTestWriteCheck(createControlledLiveTestPolicy(manifest, 'postgres://localhost/sync_issue60_test'));
  try {
    installControlledLiveFetchGuard();
    const reverseScope = { ...scope, sourceSystem: 'MOYSKLAD' as const, sourceNativeId: 'ms-29', targetSystem: 'BITRIX24' as const, targetNativeId: 'b24-17' };
    await withControlledLiveEventScope(reverseScope, async () => {
      await fetch('https://guarded-bitrix.invalid/rest/crm.company.update.json', { method: 'POST', body: new URLSearchParams({ id: 'b24-17' }) });
      await assert.rejects(fetch('https://guarded-bitrix.invalid/rest/crm.company.update.json', { method: 'POST', body: new URLSearchParams({ id: 'shared-real-id' }) }), /TARGET_NOT_IN_MANIFEST/);
      await assert.rejects(fetch('https://guarded-bitrix.invalid/rest/crm.contact.update.json', { method: 'POST', body: new URLSearchParams({ id: 'b24-17' }) }), /ENTITY_MISMATCH/);
      const request = new Request('https://guarded-bitrix.invalid/rest/crm.company.update.json', {
        method: 'POST', body: new URLSearchParams({ id: 'b24-17' }),
      });
      await fetch(request);
      await fetch('https://guarded-bitrix.invalid/rest/crm.requisite.add.json', { method: 'POST', body: new URLSearchParams({ 'fields[ENTITY_TYPE_ID]': '4', 'fields[ENTITY_ID]': 'b24-17' }) });
      await fetch('https://guarded-bitrix.invalid/rest/crm.timeline.comment.add.json', { method: 'POST', body: new URLSearchParams({ 'fields[ENTITY_TYPE_ID]': '4', 'fields[ENTITY_ID]': 'b24-17' }) });
      await fetch('https://guarded-bitrix.invalid/rest/crm.company.get.json', { method: 'POST', body: new URLSearchParams({ id: 'b24-17' }) });
      await assert.rejects(fetch('https://guarded-bitrix.invalid/rest/crm.company.get.json', { method: 'POST', body: new URLSearchParams({ id: 'shared-real-id' }) }), /READ_ID_NOT_APPROVED/);
      await fetch('https://guarded-bitrix.invalid/rest/crm.company.fields.json', { method: 'POST' });
      await assert.rejects(fetch('https://guarded-bitrix.invalid/rest/crm.company.update.json', {
        method: 'POST', body: new FormData(),
      }), /TARGET_NOT_IN_MANIFEST/);
      await assert.rejects(fetch('https://unknown.invalid/anything', { method: 'POST', body: '{}' }), /UNCLASSIFIED_EXTERNAL_REQUEST/);
    });
    await withControlledLiveEventScope(scope, async () => {
      await fetch('https://guarded-ms.invalid/api/entity/counterparty/ms-29', { method: 'PUT', body: JSON.stringify({ name: 'synthetic update' }) });
      await assert.rejects(fetch('https://guarded-ms.invalid/api/entity/counterparty/shared-real-id', { method: 'PUT', body: JSON.stringify({ name: 'synthetic update' }) }), /TARGET_NOT_IN_MANIFEST/);
    });
    assert.equal(calls, 7);
  } finally {
    globalThis.fetch = originalFetch;
    setControlledLiveTestWriteCheck(null);
    if (previous.mode === undefined) delete process.env.CONTROLLED_LIVE_TEST_MODE; else process.env.CONTROLLED_LIVE_TEST_MODE = previous.mode;
    if (previous.b24 === undefined) delete process.env.BITRIX24_REST_BASE_URL; else process.env.BITRIX24_REST_BASE_URL = previous.b24;
    if (previous.ms === undefined) delete process.env.MOYSKLAD_API_BASE_URL; else process.env.MOYSKLAD_API_BASE_URL = previous.ms;
  }
});

test('final fetch guard binds invoice, deal rows, catalog prices and service mutations to their manifest owner IDs', async () => {
  const previous = { mode: process.env.CONTROLLED_LIVE_TEST_MODE, b24: process.env.BITRIX24_REST_BASE_URL, ms: process.env.MOYSKLAD_API_BASE_URL };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
  process.env.BITRIX24_REST_BASE_URL = 'https://matrix-bitrix.invalid/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://matrix-ms.invalid/api/';
  globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 200 }); }) as typeof fetch;
  try {
    installControlledLiveFetchGuard();
    const cases = [
      { provider: 'BITRIX24' as const, entity: 'deal-order', path: 'crm.deal.update.json', body: { id: 'deal-1' }, target: 'deal-1' },
      { provider: 'BITRIX24' as const, entity: 'invoice', path: 'crm.item.update.json', body: { entityTypeId: '31', id: 'invoice-1' }, target: 'invoice-1' },
      { provider: 'BITRIX24' as const, entity: 'catalog-product', path: 'catalog.price.update.json', body: { id: 'price-shared', productId: 'product-1' }, target: 'product-1' },
      { provider: 'BITRIX24' as const, entity: 'deal-order', path: 'crm.item.productrow.update.json', body: { id: 'row-shared', ownerId: 'deal-2' }, target: 'deal-2' },
      { provider: 'MOYSKLAD' as const, entity: 'invoice', path: 'entity/invoiceout/invoice-2', body: { name: 'synthetic invoice' }, target: 'invoice-2' },
      { provider: 'MOYSKLAD' as const, entity: 'catalog-product', path: 'entity/product/product-2/prices', body: { value: 100 }, target: 'product-2' },
      { provider: 'MOYSKLAD' as const, entity: 'catalog-service', path: 'entity/service/service-1', body: { name: 'synthetic service' }, target: 'service-1' },
      { provider: 'MOYSKLAD' as const, entity: 'deal-order', path: 'entity/customerorder/deal-3/positions/row-shared', body: { quantity: 2 }, target: 'deal-3' },
    ];
    for (const [index, item] of cases.entries()) {
      const runId = `LIVE-TEST-20261019T120000Z-matrix${String(index).padStart(2, '0')}`;
      const sourceSystem = item.provider === 'BITRIX24' ? 'MOYSKLAD' as const : 'BITRIX24' as const;
      const sourceNativeId = `source-${index}`;
      const name = `тест ${runId} ${item.entity}`;
      const record = { entity: item.entity, direction: `${sourceSystem}_TO_${item.provider}`, name, syntheticOnly: true as const,
        sourceSystem, sourceNativeId, targetSystem: item.provider, targetNativeId: item.target, createdAfterUtc: '2026-10-19T00:00:00Z' };
      setControlledLiveTestWriteCheck(createControlledLiveTestPolicy({ runId, testDatabaseName: 'sync_issue60_test', records: [record] }, 'postgres://localhost/sync_issue60_test'));
      const eventScope = { eventId: `matrix-${index}`, runId, entity: item.entity, sourceSystem, sourceNativeId,
        targetSystem: item.provider, targetNativeId: item.target, admittedSourceName: name, admittedSourceCreatedAt: '2026-10-19T01:00:00Z' };
      const form = new URLSearchParams(Object.entries(item.body).map(([key, value]) => [key, String(value)]));
      const url = item.provider === 'BITRIX24' ? `https://matrix-bitrix.invalid/rest/${item.path}` : `https://matrix-ms.invalid/api/${item.path}`;
      await withControlledLiveEventScope(eventScope, async () => {
        await fetch(url, { method: item.provider === 'BITRIX24' ? 'POST' : 'PUT', body: item.provider === 'BITRIX24' ? form : JSON.stringify(item.body) });
      });
    }
    assert.equal(calls, cases.length);
  } finally {
    globalThis.fetch = originalFetch;
    setControlledLiveTestWriteCheck(null);
    if (previous.mode === undefined) delete process.env.CONTROLLED_LIVE_TEST_MODE; else process.env.CONTROLLED_LIVE_TEST_MODE = previous.mode;
    if (previous.b24 === undefined) delete process.env.BITRIX24_REST_BASE_URL; else process.env.BITRIX24_REST_BASE_URL = previous.b24;
    if (previous.ms === undefined) delete process.env.MOYSKLAD_API_BASE_URL; else process.env.MOYSKLAD_API_BASE_URL = previous.ms;
  }
});
