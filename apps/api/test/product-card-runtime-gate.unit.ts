import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ProductCardRuntimeService } from '../src/products/product-card-runtime.service';

test('product runtime does not enter provider reads or writes when PAUSE wins after preflight', async () => {
  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  let ownerToken = '';
  let apiCalls = 0;
  const database = {
    entityPair: { findFirst: async () => ({ id: 'pair-1', entityType: 'PRODUCT', bitrix24Id: '10', moyskladId: 'ms-10', active: true, source: 'MANUAL', reason: null, createdAt: new Date() }) },
    inboundEntityLock: {
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }: { data: { ownerToken: string } }) => { ownerToken = data.ownerToken; },
      deleteMany: async () => ({ count: 1 }),
    },
    $transaction: async <T>(operation: (transaction: unknown) => Promise<T>) => operation({
      $queryRaw: async (strings: TemplateStringsArray) => strings.join('').includes('InboundEntityLock')
        ? [{ ownerToken, leaseExpiresAt: new Date(Date.now() + 60_000) }]
        : [{ serviceMode: 'pause' }],
    }),
  };
  const fieldSettings = { version: async () => ({ version: 1, config: {
    rules: [{ id: 'product-name', entity: 'catalog', sourceField: 'name', targetField: 'name',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }],
    references: { units: [], priceTypes: [] },
  } }) };
  const mode = { read: async () => ({ mode: 'on' as const }), isDirectionEnabled: async () => true };
  const api = {
    readBitrix24: async () => { apiCalls++; return {}; },
    readMoysklad: async () => { apiCalls++; return {}; },
    updateBitrix24: async () => { apiCalls++; },
    updateBitrix24Price: async () => { apiCalls++; },
    updateMoysklad: async () => { apiCalls++; },
  };
  const runtime = new ProductCardRuntimeService(database as never, api as never, fieldSettings as never, mode as never);
  try {
    const result = await runtime.process({ pairId: 'pair-1', source: 'MOYSKLAD', settingsVersion: 1, eventId: 'event-1' });
    assert.equal(result.status, 'DEFERRED_PAUSE');
    assert.equal(apiCalls, 0);
  } finally {
    if (previousMode === undefined) delete process.env.SYNC_MODE;
    else process.env.SYNC_MODE = previousMode;
  }
});

test('product reconciliation holds the shared lifecycle lock across provider calls', async () => {
  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  let ownerToken = '';
  let lifecycleDepth = 0;
  let guardedProviderCalls = 0;
  const database = {
    entityPair: { findFirst: async () => ({ id: 'pair-product', entityType: 'PRODUCT', bitrix24Id: '10', moyskladId: 'ms-10', active: true, source: 'MANUAL', reason: null, createdAt: new Date() }) },
    inboundEntityLock: {
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }: { data: { ownerToken: string } }) => { ownerToken = data.ownerToken; },
      deleteMany: async () => ({ count: 1 }),
    },
    entityPairSyncState: {
      findUnique: async () => ({ bitrix24Values: { name: 'Name', description: null, unitId: null, prices: [] }, moyskladValues: { name: 'Old name', description: null, unitId: null, prices: [] } }),
      upsert: async () => ({}),
    },
    $transaction: async <T>(operation: (transaction: unknown) => Promise<T>) => operation({
      $queryRaw: async (strings: TemplateStringsArray) => {
        const query = strings.join('');
        if (query.includes('InboundEntityLock')) return [{ ownerToken, leaseExpiresAt: new Date(Date.now() + 60_000) }];
        if (query.includes('SyncSetting')) return [{ serviceMode: 'on' }];
        if (query.includes('SyncDirectionSetting')) return [{ moyskladToBitrix24: true }];
        return [];
      },
      entityPairSyncState: {
        findUnique: async () => ({ bitrix24Values: { name: 'Name', description: null, unitId: null, prices: [] }, moyskladValues: { name: 'Old name', description: null, unitId: null, prices: [] } }),
        upsert: async () => ({}),
      },
    }),
  };
  const fieldSettings = { version: async () => ({ version: 1, config: {
    rules: [{ id: 'product-name', entity: 'catalog', sourceField: 'name', targetField: 'name',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }],
    references: { units: [], priceTypes: [] },
  } }) };
  const mode = { read: async () => ({ mode: 'on' as const }), isDirectionEnabled: async () => true };
  let bitrixName = 'Name';
  const api = {
    readBitrix24: async () => { assert.equal(lifecycleDepth, 1); guardedProviderCalls++; return { name: bitrixName, detailText: null, unitId: null, prices: [], updatedAt: null }; },
    readMoysklad: async () => { assert.equal(lifecycleDepth, 1); guardedProviderCalls++; return { name: 'New name', detailText: null, unitId: null, prices: [], updatedAt: null }; },
    updateBitrix24: async (_id: string, fields: Record<string, unknown>) => { assert.equal(lifecycleDepth, 1); guardedProviderCalls++; bitrixName = String(fields.name); },
    updateBitrix24Price: async () => { assert.equal(lifecycleDepth, 1); guardedProviderCalls++; },
    updateMoysklad: async () => { assert.equal(lifecycleDepth, 1); guardedProviderCalls++; },
  };
  const lifecycle = {
    withPairActiveLock: async <T>(pairId: string, entity: string, operation: () => Promise<T>) => {
      assert.equal(pairId, 'pair-product');
      assert.equal(entity, 'PRODUCT');
      lifecycleDepth++;
      try { return await operation(); } finally { lifecycleDepth--; }
    },
  };
  const runtime = new ProductCardRuntimeService(database as never, api as never, fieldSettings as never, mode as never, lifecycle as never);
  try {
    const result = await runtime.process({ pairId: 'pair-product', source: 'MOYSKLAD', settingsVersion: 1, eventId: 'event-product' });
    assert.equal(result.status, 'SYNCED', JSON.stringify(result));
    assert.equal(bitrixName, 'New name');
    assert.equal(guardedProviderCalls, 4);
  } finally {
    if (previousMode === undefined) delete process.env.SYNC_MODE;
    else process.env.SYNC_MODE = previousMode;
  }
});
