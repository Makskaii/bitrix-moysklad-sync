import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ProductCardEventProcessor } from '../src/products/product-card-event.processor';

const productId = '12345678-1234-1234-1234-123456789abc';

function harness(event: Record<string, unknown>, pairs: Array<Record<string, unknown>> = [{
  id: 'pair-1', entityType: 'PRODUCT', bitrix24Id: '101', moyskladId: productId,
  active: true, source: 'MANUAL', reason: null, createdAt: new Date(),
}], gate: { status: 'READY' } | { status: 'SKIPPED_DISABLED'; reason: string } = { status: 'READY' }) {
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
    entityPair: { findMany: async () => structuredClone(pairs) },
    manualReviewCase: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => { reviewCases.push(create); },
      updateMany: async () => ({ count: 0 }),
    },
  };
  let priceReadCount = 0;
  const bitrixApi = { readBitrix24PriceProductId: async (id: string) => { priceReadCount += 1; return id === '51' ? '101' : '999'; } };
  const fieldSettings = { eventConfig: async () => ({ version: 9 }) };
  const runtime = {
    preflight: async () => gate,
    process: async (input: Record<string, unknown>) => { runtimeCalls.push(input); return { status: 'SYNCED', changedFields: ['name'] }; },
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
  assert.deepEqual(runtimeCalls, [{ pairId: 'pair-1', source: 'BITRIX24', settingsVersion: 9 }]);
  assert.equal(storedEvent.status, 'SUCCEEDED');
});

test('product event rejects unsupported B24 service and variation kinds without runtime writes', async () => {
  const { processor, storedEvent, runtimeCalls } = harness({
    eventType: 'CATALOG.PRODUCT.ON.UPDATE', externalEntityType: 'product', externalEntityId: '101',
    payload: { event: 'CATALOG.PRODUCT.ON.UPDATE', data: { FIELDS: { ID: 101, TYPE: 7 } } },
  });
  assert.equal(await processor.process('event-1'), null);
  assert.equal(storedEvent.status, 'SKIPPED_UNSUPPORTED_ENTITY');
  assert.equal(runtimeCalls.length, 0);
});

test('Bitrix24 price event resolves its exact product through catalog.price.get then active hardpair only', async () => {
  const { processor, storedEvent, runtimeCalls } = harness({
    eventType: 'CATALOG.PRICE.ON.UPDATE', externalEntityType: 'catalogprice', externalEntityId: '51',
    payload: { event: 'CATALOG.PRICE.ON.UPDATE', data: { FIELDS: { ID: 51 } } },
  });
  assert.equal((await processor.process('event-1'))?.status, 'SYNCED');
  assert.deepEqual(runtimeCalls, [{ pairId: 'pair-1', source: 'BITRIX24', settingsVersion: 9 }]);
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
