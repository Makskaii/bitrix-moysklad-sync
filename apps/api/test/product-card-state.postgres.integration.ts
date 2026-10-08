import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/database.service';
import { DatabaseProductCardStateStore, ProductCardRuntimeService } from '../src/products/product-card-runtime.service';

const databaseUrl = process.env.PRODUCT_TEST_DATABASE_URL;

test('product last-success state persists by active pair in isolated PostgreSQL', { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl, 'PRODUCT_TEST_DATABASE_URL must point to the dedicated #15 test database');
  const parsedUrl = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname), 'refusing to run product-card persistence test against a non-local database');
  assert.equal(parsedUrl.pathname, '/sync', 'product-card persistence test requires its dedicated test database');
  assert.equal(parsedUrl.searchParams.get('schema'), 'issue15_product_test', 'refusing to run product-card persistence outside issue15_product_test schema');
  const previousMode = process.env.SYNC_MODE;
  const previousUrl = process.env.DATABASE_URL;
  process.env.SYNC_MODE = 'apply';
  process.env.DATABASE_URL = databaseUrl;
  const database = new DatabaseService();
  const pairId = randomUUID();
  const stateStore = new DatabaseProductCardStateStore(database);
  try {
    await database.entityPair.create({
      data: { id: pairId, entityType: 'PRODUCT', bitrix24Id: String(Date.now()), moyskladId: randomUUID(), active: true, source: 'MANUAL' },
    });
    const firstState = {
      bitrix24Values: { name: 'V1', unitId: '3', prices: [{ typeId: '2', value: 12.5 }] },
      moyskladValues: { name: 'V1', unitId: 'unit-uuid', prices: [{ typeId: 'price-uuid', value: 12.5 }] },
    };
    await stateStore.write(pairId, 4, firstState);
    assert.deepEqual(await stateStore.read(pairId), firstState);

    const changedState = structuredClone(firstState);
    changedState.bitrix24Values.name = 'V2';
    changedState.moyskladValues.name = 'V2';
    await stateStore.write(pairId, 5, changedState);
    assert.deepEqual(await stateStore.read(pairId), changedState);
  } finally {
    await database.entityPair.deleteMany({ where: { id: pairId } }).catch(() => undefined);
    await database.$disconnect();
    if (previousMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = previousMode;
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
  }
});

test('concurrent runtime instances retry by PRODUCT pair and retain both verified field updates', { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl, 'PRODUCT_TEST_DATABASE_URL must point to the dedicated #15 test database');
  const parsedUrl = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname), 'refusing to run product-card concurrency test against a non-local database');
  assert.equal(parsedUrl.pathname, '/sync', 'product-card concurrency test requires its dedicated test database');
  assert.equal(parsedUrl.searchParams.get('schema'), 'issue15_product_test', 'refusing to run product-card concurrency test outside issue15_product_test schema');
  const previousMode = process.env.SYNC_MODE;
  const previousUrl = process.env.DATABASE_URL;
  process.env.SYNC_MODE = 'apply';
  process.env.DATABASE_URL = databaseUrl;
  const firstDatabase = new DatabaseService();
  const secondDatabase = new DatabaseService();
  const pairId = randomUUID();
  const moyskladId = randomUUID();
  const api = new ConcurrentProductCardApi();
  let releaseFirstNameWrite!: () => void;
  let signalFirstNameWrite!: () => void;
  const firstNameWriteGate = new Promise<void>((resolve) => { releaseFirstNameWrite = resolve; });
  const firstNameWriteStarted = new Promise<void>((resolve) => { signalFirstNameWrite = resolve; });
  api.blockNextMoyskladNameWrite(firstNameWriteGate, signalFirstNameWrite);
  const fieldSettings = {
    version: async (version: number) => ({ version, config: productCardSettings }),
  };
  const syncMode = {
    read: async () => ({ mode: 'on' as const }),
    isDirectionEnabled: async () => true,
  };
  const firstRuntime = new ProductCardRuntimeService(firstDatabase, api as never, fieldSettings as never, syncMode as never);
  const secondRuntime = new ProductCardRuntimeService(secondDatabase, api as never, fieldSettings as never, syncMode as never);
  const stateStore = new DatabaseProductCardStateStore(firstDatabase);
  try {
    await firstDatabase.entityPair.create({
      data: { id: pairId, entityType: 'PRODUCT', bitrix24Id: String(Date.now()), moyskladId, active: true, source: 'MANUAL' },
    });

    const baseline = await firstRuntime.process({ pairId, source: 'BITRIX24', settingsVersion: 4, eventId: 'baseline-event' });
    assert.equal(baseline.status, 'BASELINED');
    assert.equal(api.writes.length, 0);

    const entityKey = `PRODUCT_PAIR:${pairId}`;
    await firstDatabase.inboundEntityLock.create({
      data: { entityKey, ownerToken: 'expired-owner', eventId: 'expired-event', leaseExpiresAt: new Date(0) },
    });
    const recovered = await firstRuntime.process({ pairId, source: 'BITRIX24', settingsVersion: 4, eventId: 'recovered-event' });
    assert.equal(recovered.status, 'UNCHANGED');
    assert.equal(await firstDatabase.inboundEntityLock.findUnique({ where: { entityKey } }), null);

    api.bitrix24.name = 'Renamed in Bitrix';
    const firstSync = firstRuntime.process({ pairId, source: 'BITRIX24', settingsVersion: 4, eventId: 'name-event' });
    await firstNameWriteStarted;

    api.moysklad.detailText = 'Description changed in MySklad';
    const contendingSync = await secondRuntime.process({ pairId, source: 'MOYSKLAD', settingsVersion: 4, eventId: 'description-event' });
    assert.deepEqual(contendingSync, {
      status: 'RETRYABLE_FAILURE', reason: 'PRODUCT_PAIR_BUSY', changedFields: [],
    });

    releaseFirstNameWrite();
    const firstResult = await firstSync;
    assert.deepEqual(firstResult, { status: 'SYNCED', changedFields: ['name'] });

    const retriedSync = await secondRuntime.process({ pairId, source: 'MOYSKLAD', settingsVersion: 4, eventId: 'description-event' });
    assert.deepEqual(retriedSync, { status: 'SYNCED', changedFields: ['description'] });

    assert.equal(api.bitrix24.name, 'Renamed in Bitrix');
    assert.equal(api.moysklad.name, 'Renamed in Bitrix');
    assert.equal(api.bitrix24.detailText, 'Description changed in MySklad');
    assert.equal(api.moysklad.detailText, 'Description changed in MySklad');
    assert.deepEqual(api.writes, [
      { side: 'MOYSKLAD', field: 'name' },
      { side: 'BITRIX24', field: 'detailText' },
    ]);

    const state = await stateStore.read(pairId);
    assert.equal(state?.bitrix24Values.name, 'Renamed in Bitrix');
    assert.equal(state?.moyskladValues.name, 'Renamed in Bitrix');
    assert.equal(state?.bitrix24Values.description, 'Description changed in MySklad');
    assert.equal(state?.moyskladValues.description, 'Description changed in MySklad');
  } finally {
    releaseFirstNameWrite();
    await firstDatabase.entityPair.deleteMany({ where: { id: pairId } }).catch(() => undefined);
    await Promise.all([firstDatabase.$disconnect(), secondDatabase.$disconnect()]);
    if (previousMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = previousMode;
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
  }
});

const productCardSettings = {
  rules: [
    { entity: 'catalog', sourceField: 'name', targetField: 'name',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } },
    { entity: 'catalog', sourceField: 'detailText', targetField: 'description',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } },
  ],
  references: { units: [], priceTypes: [] },
};

class ConcurrentProductCardApi {
  bitrix24 = { name: 'Initial', detailText: 'Initial description', unitId: null, prices: [], updatedAt: null };
  moysklad = { name: 'Initial', detailText: 'Initial description', unitId: null, prices: [], updatedAt: null };
  writes: Array<{ side: string; field: string }> = [];
  private shouldBlockNameWrite = false;
  private nameWriteStarted?: () => void;
  private nameWriteGate?: Promise<void>;

  blockNextMoyskladNameWrite(gate: Promise<void>, signal: () => void) {
    this.shouldBlockNameWrite = true;
    this.nameWriteStarted = signal;
    this.nameWriteGate = gate;
  }

  async readBitrix24() { return structuredClone(this.bitrix24); }
  async readMoysklad() { return structuredClone(this.moysklad); }

  async updateBitrix24(_id: string, fields: Record<string, unknown>) {
    this.writes.push({ side: 'BITRIX24', field: Object.keys(fields).join(',') });
    if ('name' in fields) this.bitrix24.name = String(fields.name);
    if ('detailText' in fields) this.bitrix24.detailText = String(fields.detailText);
  }

  async updateBitrix24Price() { throw new Error('No price fields are configured in this test'); }

  async updateMoysklad(_id: string, fields: Record<string, unknown>) {
    this.writes.push({ side: 'MOYSKLAD', field: Object.keys(fields).join(',') });
    if ('name' in fields) {
      this.moysklad.name = String(fields.name);
      if (this.shouldBlockNameWrite) {
        this.shouldBlockNameWrite = false;
        this.nameWriteStarted?.();
        await this.nameWriteGate;
      }
    }
    if ('description' in fields) this.moysklad.detailText = String(fields.description);
  }
}
