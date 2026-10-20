import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { ProductCardEventProcessor } from '../src/products/product-card-event.processor';
import { withServiceModeOn } from '../src/service-mode-transaction';

const databaseUrl = process.env.PRODUCT_MODE_GATE_TEST_DATABASE_URL;

function assertIsolatedTarget(value: string, enabled: string | undefined) {
  assert.equal(enabled, '1', 'PRODUCT_MODE_GATE_TEST_ISOLATED=1 is required');
  const url = new URL(value);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname), 'test DB must use loopback');
  assert.equal(url.pathname, '/sync_issue79_mode_gate_codex_test', 'test must use its dedicated database');
  assert.equal(url.searchParams.get('schema'), 'issue79_mode_gate_codex', 'test must use its dedicated schema');
}

test('product bootstrap and worker preserve pending queue in OFF/PAUSE and process in ON', { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  assertIsolatedTarget(databaseUrl, process.env.PRODUCT_MODE_GATE_TEST_ISOLATED);
  const previous = { database: process.env.DATABASE_URL, mode: process.env.SYNC_MODE };
  process.env.DATABASE_URL = databaseUrl;
  process.env.SYNC_MODE = 'apply';
  const database = new DatabaseService();
  const eventIds: string[] = [];
  const pairIds: string[] = [];
  const providerCalls: string[] = [];
  const bitrixId = String(Date.now());
  const moyskladId = randomUUID();
  const pairId = randomUUID();
  const processor = new ProductCardEventProcessor(database, {
    readBitrix24PriceProductId: async () => { providerCalls.push('read-price-product'); return bitrixId; },
    readBitrix24: async () => { providerCalls.push('read-bitrix'); return { name: 'test', prices: [], taxSemantics: '{}', createdAt: null }; },
    readMoysklad: async () => { providerCalls.push('read-moysklad'); return { name: 'test', prices: [], taxSemantics: '{}', createdAt: null }; },
  } as never, { eventConfig: async () => ({ version: 1, config: { references: { priceTypes: [] } } }) } as never, {
    processAuthoritativeRestore: async () => { providerCalls.push('runtime'); return { status: 'SYNCED', changedFields: [] }; },
    process: async () => { providerCalls.push('runtime'); return { status: 'SYNCED', changedFields: [] }; },
  } as never);

  const createPending = async () => {
    const row = await database.inboundEvent.create({ data: {
      deliveryKey: `mode-gate-${randomUUID()}`, source: 'BITRIX24', eventType: 'CATALOG.PRODUCT.ON.UPDATE', externalEntityType: 'product', externalEntityId: bitrixId,
      payload: { event: 'CATALOG.PRODUCT.ON.UPDATE', data: { FIELDS: { ID: bitrixId, TYPE: 1 } } }, status: 'RECEIVED', attempts: 0,
    } });
    eventIds.push(row.id);
    return row.id;
  };

  try {
    await database.syncSetting.upsert({ where: { id: 'global' }, create: { serviceMode: 'off' }, update: { serviceMode: 'off' } });
    await database.entityPair.create({ data: { id: pairId, entityType: 'PRODUCT', bitrix24Id: bitrixId, moyskladId, moyskladType: 'product', active: true, source: 'MANUAL' } });
    pairIds.push(pairId);

    for (const mode of ['off', 'pause'] as const) {
      await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: mode } });
      const eventId = await createPending();
      processor.onApplicationBootstrap();
      await (processor as unknown as { recoveryScan: Promise<void> | null }).recoveryScan;
      await processor.process(eventId);
      const stored = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
      assert.equal(stored.status, 'RECEIVED');
      assert.equal(stored.attempts, 0);
      assert.deepEqual(providerCalls, []);
      await processor.onModuleDestroy();
    }

    await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
    const onEventId = await createPending();
    assert.equal((await processor.process(onEventId))?.status, 'SYNCED');
    const onRow = await database.inboundEvent.findUniqueOrThrow({ where: { id: onEventId } });
    assert.equal(onRow.status, 'SUCCEEDED');
    assert.ok(providerCalls.includes('runtime'), 'ON is a positive control that reaches the runtime');

    // Model a provider operation already in flight. A durable OFF update must
    // wait for its per-operation shared lock, then block any subsequent work.
    let releaseOperation!: () => void;
    let operationStarted!: () => void;
    const operationGate = new Promise<void>((resolve) => { releaseOperation = resolve; });
    const started = new Promise<void>((resolve) => { operationStarted = resolve; });
    const inFlight = withServiceModeOn(database, async () => {
      operationStarted();
      await operationGate;
    });
    await started;
    let offCommitted = false;
    const offUpdate = database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'off' } }).then(() => { offCommitted = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(offCommitted, false, 'OFF acknowledgement waits for the in-flight operation');
    releaseOperation();
    assert.equal((await inFlight).enabled, true);
    await offUpdate;

    const afterOffEventId = await createPending();
    const readsBeforeOff = providerCalls.length;
    await processor.process(afterOffEventId);
    const afterOff = await database.inboundEvent.findUniqueOrThrow({ where: { id: afterOffEventId } });
    assert.equal(afterOff.status, 'RECEIVED');
    assert.equal(afterOff.attempts, 0);
    assert.equal(providerCalls.length, readsBeforeOff, 'no provider/runtime calls occur after OFF commits');
  } finally {
    await processor.onModuleDestroy();
    await database.inboundEvent.deleteMany({ where: { id: { in: eventIds } } }).catch(() => undefined);
    await database.entityPair.deleteMany({ where: { id: { in: pairIds } } }).catch(() => undefined);
    await database.$disconnect();
    if (previous.database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.database;
    if (previous.mode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = previous.mode;
  }
});
