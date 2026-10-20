import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ProductCardEventProcessor } from '../src/products/product-card-event.processor';
import { ControlledLiveTestAdmissionService } from '../src/controlled-live-test-admission.service';
import { setVerifiedControlledLiveProviderNamespace } from '../src/controlled-live-test-namespace';
import { assertApplyExternalWrite } from '../src/external-write-guard';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const productId = '12345678-1234-1234-1234-123456789abc';

function harness(event: Record<string, unknown>, pairs: Array<Record<string, unknown>> = [{
  id: 'pair-1', entityType: 'PRODUCT', bitrix24Id: '101', moyskladId: productId,
  active: true, source: 'MANUAL', reason: null, createdAt: new Date(),
}], gate: { status: 'READY' } | { status: 'SKIPPED_DISABLED'; reason: string } | { status: 'SKIPPED_DIRECTION_DISABLED'; reason: string } = { status: 'READY' }) {
  const storedEvent: Record<string, unknown> = { id: 'event-1', source: 'BITRIX24', status: 'RECEIVED', attempts: 0, ...event };
  const reviewCases: Array<Record<string, unknown>> = [];
  const runtimeCalls: Array<Record<string, unknown>> = [];
  const database = {
    inboundEvent: {
      findUnique: async () => structuredClone(storedEvent),
      updateMany: async ({ where, data }: { where: { status?: string; OR?: Array<{ status: string }> }; data: Record<string, unknown> }) => {
        const allowed = where.status ? storedEvent.status === where.status : where.OR?.some(({ status }) => storedEvent.status === status) ?? false;
        if (!allowed) return { count: 0 };
        Object.assign(storedEvent, data);
        return { count: 1 };
      },
    },
    entityPair: { findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const kind = typeof where?.moyskladType === 'string' ? where.moyskladType : null;
      return structuredClone(pairs.filter((pair) => !kind || pair.moyskladType === kind));
    } },
    manualReviewCase: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => { reviewCases.push(create); },
      updateMany: async () => ({ count: 0 }),
    },
  };
  Object.assign(database, { $transaction: async (callback: (transaction: typeof database) => Promise<unknown>) => callback(database) });
  let priceReadCount = 0;
  const bitrixApi = { readBitrix24PriceProductId: async (id: string) => { priceReadCount += 1; return id === '51' ? '101' : '999'; } };
  const fieldSettings = { eventConfig: async () => ({ version: 9 }) };
  const runtime = {
    preflight: async () => gate,
    process: async (input: Record<string, unknown>) => { runtimeCalls.push(input); return { status: 'SYNCED', changedFields: ['name'] }; },
    processAuthoritativeRestore: async (input: Record<string, unknown>) => {
      if (gate.status !== 'READY') return { ...gate, changedFields: [] };
      runtimeCalls.push({ ...input, source: 'BITRIX24', authoritativeRestore: true });
      return { status: 'SYNCED', changedFields: ['name'] };
    },
  };
  const processor = new ProductCardEventProcessor(database as never, bitrixApi as never, fieldSettings as never, runtime as never);
  return { processor, storedEvent, reviewCases, runtimeCalls, get priceReadCount() { return priceReadCount; } };
}

test('product event dispatches only to an exact active PRODUCT pair and uses pinned settings version', async () => {
  const { processor, storedEvent, runtimeCalls } = harness({
    eventType: 'CATALOG.PRODUCT.ON.UPDATE', externalEntityType: 'product', externalEntityId: '101',
    payload: { event: 'CATALOG.PRODUCT.ON.UPDATE', data: { FIELDS: { ID: 101, TYPE: 1 } } },
  });
  const result = await processor.process('event-1');
  assert.deepEqual(result, { status: 'SYNCED', changedFields: ['name'] });
  assert.deepEqual(runtimeCalls, [{ pairId: 'pair-1', source: 'BITRIX24', authoritativeRestore: true, settingsVersion: 9, eventId: 'event-1', attempt: 1 }]);
  assert.equal(storedEvent.status, 'SUCCEEDED');
});

test('catalog service events use the same one-way product processor dispatch contract', () => {
  const { processor } = harness({
    source: 'MOYSKLAD', eventType: 'CREATE', externalEntityType: 'service', externalEntityId: productId,
  });
  assert.equal(processor.supports({
    id: 'service-event', source: 'MOYSKLAD', eventType: 'CREATE', externalEntityType: 'service', externalEntityId: productId,
  }), true);
});

test('Bitrix24 product update uses the dedicated restore gate for an exact active pair', async () => {
  const { processor, storedEvent, runtimeCalls } = harness({
    eventType: 'CATALOG.PRODUCT.ON.UPDATE', externalEntityType: 'product', externalEntityId: '101',
    payload: { event: 'CATALOG.PRODUCT.ON.UPDATE', data: { FIELDS: { ID: 101, TYPE: 1 } } },
  }, undefined, { status: 'SKIPPED_DIRECTION_DISABLED', reason: 'PRODUCT_DIRECTION_DISABLED' });
  const result = await processor.process('event-1');
  assert.deepEqual(result, { status: 'SKIPPED_DIRECTION_DISABLED', reason: 'PRODUCT_DIRECTION_DISABLED', changedFields: [] });
  assert.equal(storedEvent.status, 'SKIPPED_DIRECTION_DISABLED');
  assert.equal(runtimeCalls.length, 0);
});

test('Bitrix24 catalog add without a comparable pair is held for review, not sent to MySklad', async () => {
  const { processor, storedEvent, runtimeCalls } = harness({
    eventType: 'CATALOG.PRODUCT.ON.ADD', externalEntityType: 'product', externalEntityId: '101',
    payload: { event: 'CATALOG.PRODUCT.ON.ADD', data: { FIELDS: { ID: 101, TYPE: 1 } } },
  }, [], { status: 'SKIPPED_DIRECTION_DISABLED', reason: 'PRODUCT_DIRECTION_DISABLED' });

  assert.equal(processor.supports({
    id: 'event-1', source: 'BITRIX24', eventType: 'CATALOG.PRODUCT.ON.ADD', externalEntityType: 'product', externalEntityId: '101',
  }), true);
  assert.deepEqual(await processor.process('event-1'), {
    status: 'MANUAL_REVIEW', reason: 'PRODUCT_PAIR_NOT_ACTIVE', changedFields: [],
  });
  assert.equal(storedEvent.status, 'MANUAL_REVIEW');
  assert.equal(runtimeCalls.length, 0);
});

test('due retryable product events are claimed and reprocessed', async () => {
  const { processor, storedEvent, runtimeCalls } = harness({
    eventType: 'CATALOG.PRODUCT.ON.UPDATE', externalEntityType: 'product', externalEntityId: '101',
    payload: { event: 'CATALOG.PRODUCT.ON.UPDATE', data: { FIELDS: { ID: 101, TYPE: 1 } } },
    status: 'RETRYABLE_FAILURE', attempts: 2, retryAfter: new Date(0),
  });
  assert.equal((await processor.process('event-1'))?.status, 'SYNCED');
  assert.equal(storedEvent.status, 'SUCCEEDED');
  assert.equal(runtimeCalls.length, 1);
  assert.equal(runtimeCalls[0]?.attempt, 3, 'runtime receives the persisted attempt count plus the newly claimed attempt');
});

test('product event does not route a service card through a native product pair', async () => {
  const { processor, storedEvent, runtimeCalls } = harness({
    eventType: 'CATALOG.PRODUCT.ON.UPDATE', externalEntityType: 'product', externalEntityId: '101',
    payload: { event: 'CATALOG.PRODUCT.ON.UPDATE', data: { FIELDS: { ID: 101, TYPE: 7 } } },
  });
  assert.deepEqual(await processor.process('event-1'), { status: 'MANUAL_REVIEW', reason: 'PRODUCT_PAIR_NOT_ACTIVE', changedFields: [] });
  assert.equal(storedEvent.status, 'MANUAL_REVIEW');
  assert.equal(runtimeCalls.length, 0);
});

test('Bitrix24 price event resolves its exact product through catalog.price.get then active hardpair only', async () => {
  const { processor, storedEvent, runtimeCalls } = harness({
    eventType: 'CATALOG.PRICE.ON.UPDATE', externalEntityType: 'catalogprice', externalEntityId: '51',
    payload: { event: 'CATALOG.PRICE.ON.UPDATE', data: { FIELDS: { ID: 51 } } },
  });
  assert.equal((await processor.process('event-1'))?.status, 'SYNCED');
  assert.deepEqual(runtimeCalls, [{ pairId: 'pair-1', source: 'BITRIX24', authoritativeRestore: true, settingsVersion: 9, eventId: 'event-1', attempt: 1 }]);
  assert.equal(storedEvent.status, 'SUCCEEDED');
});

test('Bitrix24 price event observes apply/off/direction gates before catalog.price.get', async () => {
  const { processor, storedEvent, priceReadCount } = harness({
    eventType: 'CATALOG.PRICE.ON.UPDATE', externalEntityType: 'catalogprice', externalEntityId: '51',
    payload: { event: 'CATALOG.PRICE.ON.UPDATE', data: { FIELDS: { ID: 51 } } },
  }, undefined, { status: 'SKIPPED_DISABLED', reason: 'SERVICE_OFF' });
  const result = await processor.process('event-1');
  assert.deepEqual(result, { status: 'SKIPPED_DISABLED', reason: 'SERVICE_OFF', changedFields: [] });
  assert.equal(storedEvent.status, 'SKIPPED_DISABLED');
  assert.equal(priceReadCount, 0);
});

test('missing product hardpair opens manual review without guessing or creating a pair', async () => {
  const { processor, storedEvent, reviewCases, runtimeCalls } = harness({
    eventType: 'CATALOG.PRODUCT.ON.UPDATE', externalEntityType: 'product', externalEntityId: '101',
    payload: { event: 'CATALOG.PRODUCT.ON.UPDATE', data: { FIELDS: { ID: 101, TYPE: 1 } } },
  }, []);
  const result = await processor.process('event-1');
  assert.deepEqual(result, { status: 'MANUAL_REVIEW', reason: 'PRODUCT_PAIR_NOT_ACTIVE', changedFields: [] });
  assert.equal(storedEvent.status, 'MANUAL_REVIEW');
  assert.equal(reviewCases.length, 1);
  assert.equal(runtimeCalls.length, 0);
});

test('catalog ADD creates a persisted pair only after exact configured price, currency and tax match', async () => {
  const bitrixId = '807';
  const candidateId = '92345678-1234-1234-1234-123456789abc';
  const newerCandidateId = '12345678-1234-1234-1234-123456789abc';
  const row: Record<string, unknown> = { id: 'event-match', source: 'BITRIX24', eventType: 'CATALOG.PRODUCT.ON.ADD', externalEntityType: 'product',
    externalEntityId: bitrixId, payload: { event: 'CATALOG.PRODUCT.ON.ADD', data: { FIELDS: { ID: bitrixId, TYPE: 1 } } }, status: 'RECEIVED', attempts: 0 };
  const pairs: Array<Record<string, unknown>> = [];
  const operationalLogs: Array<{ message: string }> = [];
  const api = {
    readBitrix24: async () => ({ name: 'Exact name', createdAt: '2026-10-10T00:00:00Z', prices: [{ priceId: 'p1', typeId: '2', value: 10, currency: 'RUB' }], taxSemantics: '{"rate":20,"enabled":true,"included":false}', detailText: null, unitId: null, updatedAt: null }),
    findMoyskladProductsByExactName: async () => [
      { id: newerCandidateId, name: 'Exact name', createdAt: '2026-10-02T00:00:00Z' },
      { id: candidateId, name: 'Exact name', createdAt: '2026-10-01T00:00:00Z' },
    ],
    readMoysklad: async (id: string) => ({ name: 'Exact name', createdAt: id === candidateId ? '2026-10-01T00:00:00Z' : '2026-10-02T00:00:00Z', prices: [{ priceId: 't1', typeId: 'price-type', value: 10, currency: 'RUB' }], taxSemantics: '{"rate":20,"enabled":true,"included":false}', detailText: null, unitId: null, updatedAt: null }),
  };
  const database: any = {
    inboundEvent: { findUnique: async () => structuredClone(row), updateMany: async ({ data }: any) => { Object.assign(row, data); return { count: 1 }; } },
    entityPair: {
      findMany: async ({ where }: any) => pairs.filter((pair) => pair.active && (!where?.id || pair.id === where.id) && (!where?.bitrix24Id || pair.bitrix24Id === where.bitrix24Id)),
      findFirst: async () => null,
      create: async ({ data }: any) => { const pair = { id: 'auto-pair', entityType: 'PRODUCT', active: true, ...data }; pairs.push(pair); return { id: pair.id }; },
    },
    manualReviewCase: { upsert: async () => undefined, updateMany: async () => ({ count: 0 }) },
    operationalLog: { create: async ({ data }: any) => { operationalLogs.push(data); } },
    $queryRaw: async () => [{ locked: 1 }],
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation(database),
  };
  const aliasService = { resolveBitrix24Product: async () => ({ status: 'NONE' }), record: async () => { throw new Error('unexpected alias'); } };
  const config = { version: 4, config: { references: { priceTypes: [{ status: 'configured', bitrix24Id: 2, moyskladId: 'price-type' }] }, rules: [] } };
  const runtimeCalls: Array<Record<string, unknown>> = [];
  const processor = new ProductCardEventProcessor(database, api as never, { eventConfig: async () => config } as never,
    { processAuthoritativeRestore: async (input: Record<string, unknown>) => { runtimeCalls.push(input); return { status: 'SYNCED', changedFields: ['name'] }; } } as never,
    undefined, undefined, undefined, undefined, aliasService as never);

  const result = await processor.process('event-match');
  assert.equal(result?.status, 'SYNCED');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.bitrix24Id, bitrixId);
  assert.equal(pairs[0]?.moyskladId, candidateId);
  assert.equal(pairs[0]?.source, 'AUTO');
  assert.deepEqual(runtimeCalls.map((call) => call.pairId), ['auto-pair']);
  assert.equal(JSON.parse(operationalLogs[0]!.message).selectionReason, 'EARLIEST_CREATION_DATE');
});

test('product event rolls back terminal status when the worker lease is lost at transactional fence', async () => {
  const { processor, storedEvent } = harness({
    eventType: 'CATALOG.PRODUCT.ON.UPDATE', externalEntityType: 'product', externalEntityId: '101',
    payload: { event: 'CATALOG.PRODUCT.ON.UPDATE', data: { FIELDS: { ID: 101, TYPE: 1 } } },
  });
  let fenceCount = 0;
  let lost = false;
  const workerLease = {
    assertOwned: async () => { if (lost) throw Object.assign(new Error('EVENT_WORKER_LEASE_LOST'), { code: 'EVENT_WORKER_LEASE_LOST' }); },
    assertOwnedIn: async () => {
      fenceCount += 1;
      if (fenceCount >= 2) { lost = true; throw Object.assign(new Error('EVENT_WORKER_LEASE_LOST'), { code: 'EVENT_WORKER_LEASE_LOST' }); }
    },
  };
  const run = (processor as unknown as { processWithLease(eventId: string, lease: typeof workerLease): Promise<unknown> }).processWithLease.bind(processor);
  await assert.rejects(run('event-1', workerLease));
  assert.equal(storedEvent.status, 'PROCESSING');
  assert.equal(fenceCount, 2);
});

test('controlled product event admits a current synthetic source before allowing only its exact paired target write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue60-product-event-'));
  const manifestPath = join(directory, 'manifest.json');
  const runId = 'LIVE-TEST-20261019T120000Z-product01';
  const name = `тест ${runId} product`;
  const providerNamespace = { bitrix24PortalOrigin: 'https://issue60-b24-test.invalid', bitrix24UserId: '42', moyskladAccountId: 'b0b309ee-13e3-11e9-9109-f8fc0001f188' };
  const now = new Date();
  const previous = { mode: process.env.CONTROLLED_LIVE_TEST_MODE, instance: process.env.CONTROLLED_LIVE_TEST_INSTANCE,
    manifest: process.env.CONTROLLED_LIVE_TEST_MANIFEST, database: process.env.DATABASE_URL, sync: process.env.SYNC_MODE };
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled'; process.env.CONTROLLED_LIVE_TEST_INSTANCE = 'isolated';
  process.env.CONTROLLED_LIVE_TEST_MANIFEST = manifestPath; process.env.DATABASE_URL = 'postgres://localhost/sync_issue60_test?schema=issue60_harness_test'; process.env.SYNC_MODE = 'apply';
  await writeFile(manifestPath, JSON.stringify({ runId, testDatabaseName: 'sync_issue60_test', testSchemaName: 'issue60_harness_test', providerNamespace, records: [{
    entity: 'catalog-product', direction: 'MOYSKLAD_TO_BITRIX24', name, syntheticOnly: true,
    sourceSystem: 'MOYSKLAD', sourceNativeId: productId, targetSystem: 'BITRIX24', targetNativeId: '101',
    createdAfterUtc: new Date(now.getTime() - 10_000).toISOString(),
  }] }), 'utf8');
  const event = { id: 'event-1', source: 'BITRIX24', eventType: 'CATALOG.PRODUCT.ON.UPDATE', externalEntityType: 'product', externalEntityId: '101',
    payload: { event: 'CATALOG.PRODUCT.ON.UPDATE', data: { FIELDS: { ID: 101, TYPE: 1 } } }, status: 'RECEIVED', attempts: 0 } as Record<string, unknown>;
  const admissions = new Map<string, any>();
  const database: any = {
    inboundEvent: { findUnique: async () => structuredClone(event), updateMany: async ({ data }: any) => { Object.assign(event, data); return { count: 1 }; } },
    entityPair: { findMany: async () => [{ id: 'pair-product', entityType: 'PRODUCT', bitrix24Id: '101', moyskladId: productId, active: true, source: 'MANUAL', createdAt: now }] },
    manualReviewCase: { upsert: async () => undefined, updateMany: async () => ({ count: 0 }) },
    controlledTestAdmission: {
      findMany: async ({ where }: any) => [...admissions.values()].filter((row) => row.runId === where.runId && row.entity === where.entity),
      findUnique: async ({ where }: any) => admissions.get(where.eventId) ?? null,
      findFirst: async () => null,
      upsert: async ({ where, create }: any) => { if (!admissions.has(where.eventId)) admissions.set(where.eventId, { ...create }); return admissions.get(where.eventId); },
      updateMany: async () => ({ count: 0 }),
    },
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(database),
  };
  try {
    setVerifiedControlledLiveProviderNamespace(providerNamespace);
    const admission = new ControlledLiveTestAdmissionService(database);
    await assert.rejects(admission.withProductRestoreSourceRead({ eventId: 'event-1', sourceNativeId: productId, targetNativeId: '999', entity: 'catalog-product' }, async () => undefined), /PAIR_NOT_MANIFESTED/);
    await assert.rejects(admission.withProductRestoreSourceRead({ eventId: 'event-1', sourceNativeId: productId, targetNativeId: '101', entity: 'catalog-service' }, async () => undefined), /PAIR_NOT_MANIFESTED/);
    await assert.rejects(admission.withCurrentSourceRead('event-1', 'BITRIX24', '101', 'catalog-product', async () => undefined), /SOURCE_READ_NOT_UNIQUELY_MANIFESTED/);
    await admission.withProductRestoreSourceRead({ eventId: 'event-1', sourceNativeId: productId, targetNativeId: '101', entity: 'catalog-product' }, async () => {
      assert.throws(() => assertApplyExternalWrite('BITRIX24', 'PRODUCT_UPDATE', '101', 'catalog-product'), /WRITE_DURING_SOURCE_READ_FORBIDDEN/);
      assert.throws(() => assertApplyExternalWrite('MOYSKLAD', 'PRODUCT_UPDATE', productId, 'catalog-product'), /WRITE_DURING_SOURCE_READ_FORBIDDEN/);
    });
    let writes = 0;
    const runtime = { preflight: async () => ({ status: 'READY' }), processAuthoritativeRestore: async () => {
      assertApplyExternalWrite('BITRIX24', 'PRODUCT_UPDATE', '101', 'catalog-product');
      assert.throws(() => assertApplyExternalWrite('BITRIX24', 'PRODUCT_UPDATE', '999', 'catalog-product'), /TARGET_NOT_IN_MANIFEST/);
      writes += 1; return { status: 'SYNCED', changedFields: ['name'] };
    } };
    const processor = new ProductCardEventProcessor(database, { readBitrix24PriceProductId: async () => '101', readBitrix24: async () => ({
      name, detailText: null, unitId: null, prices: [], updatedAt: now.toISOString(), createdAt: now.toISOString(),
    }), readMoysklad: async () => ({ name, detailText: null, unitId: null, prices: [], updatedAt: now.toISOString(), createdAt: now.toISOString() }) } as never, { eventConfig: async () => ({ version: 9 }) } as never, runtime as never, undefined, undefined, undefined, admission);
    assert.equal((await processor.process('event-1'))?.status, 'SYNCED');
    assert.equal(writes, 1);
    assert.equal(admissions.get('event-1')?.targetNativeId, '101');
  } finally {
    for (const [key, value] of [['CONTROLLED_LIVE_TEST_MODE', previous.mode], ['CONTROLLED_LIVE_TEST_INSTANCE', previous.instance], ['CONTROLLED_LIVE_TEST_MANIFEST', previous.manifest], ['DATABASE_URL', previous.database], ['SYNC_MODE', previous.sync]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
