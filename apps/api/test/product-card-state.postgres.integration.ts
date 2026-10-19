import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/database.service';
import { DatabaseProductCardStateStore, ProductCardRuntimeService } from '../src/products/product-card-runtime.service';

const databaseUrl = process.env.PRODUCT_TEST_DATABASE_URL;

function assertProductTestDatabaseTarget(databaseUrl: string, isolatedFlag: string | undefined) {
  assert.equal(isolatedFlag, '1', 'set PRODUCT_TEST_ISOLATED=1 only for a fresh disposable product test database');
  const parsedUrl = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname), 'refusing a non-local product-card test database');
  assert.match(parsedUrl.pathname, /^\/(?:aerosystems_product|issue61)_[a-z0-9_]+_test$/i, 'requires a dedicated product test database name');
  assert.equal(parsedUrl.searchParams.get('schema'), 'issue15_product_test', 'refusing to run product-card tests outside issue15_product_test schema');
}

test('product PostgreSQL test harness only permits an explicitly isolated loopback database and dedicated schema', () => {
  const safe = 'postgresql://local-test@127.0.0.1:5432/aerosystems_product_issue61_test?schema=issue15_product_test';
  assert.doesNotThrow(() => assertProductTestDatabaseTarget(safe, '1'));
  assert.throws(() => assertProductTestDatabaseTarget(safe, undefined), /PRODUCT_TEST_ISOLATED/);
  assert.throws(() => assertProductTestDatabaseTarget('postgresql://local-test@example.invalid:5432/aerosystems_product_issue61_test?schema=issue15_product_test', '1'), /non-local/);
  assert.throws(() => assertProductTestDatabaseTarget('postgresql://local-test@127.0.0.1:5432/sync?schema=issue15_product_test', '1'), /dedicated product test database/);
  assert.throws(() => assertProductTestDatabaseTarget('postgresql://local-test@127.0.0.1:5432/aerosystems_product_issue61_test?schema=public', '1'), /outside issue15_product_test/);
});

test('product last-success state persists by active pair in isolated PostgreSQL', { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl, 'PRODUCT_TEST_DATABASE_URL must point to the dedicated #15 test database');
  assertProductTestDatabaseTarget(databaseUrl, process.env.PRODUCT_TEST_ISOLATED);
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
  assertProductTestDatabaseTarget(databaseUrl, process.env.PRODUCT_TEST_ISOLATED);
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
  api.blockNextBitrixNameWrite(firstNameWriteGate, signalFirstNameWrite);
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
    await firstDatabase.syncSetting.upsert({
      where: { id: 'global' }, create: { serviceMode: 'on' }, update: { serviceMode: 'on' },
    });

    const blockedBitrixEvent = await firstRuntime.process({ pairId, source: 'BITRIX24', settingsVersion: 4, eventId: 'blocked-bitrix-event' });
    assert.deepEqual(blockedBitrixEvent, { status: 'SKIPPED_DIRECTION_DISABLED', reason: 'PRODUCT_DIRECTION_DISABLED', changedFields: [] });
    assert.equal(api.writes.length, 0, 'Bitrix24 product events must not read or write through the reverse direction');

    const baseline = await firstRuntime.process({ pairId, source: 'MOYSKLAD', settingsVersion: 4, eventId: 'baseline-event' });
    assert.equal(baseline.status, 'BASELINED');
    assert.equal(api.writes.length, 0);

    const entityKey = `PRODUCT_PAIR:${pairId}`;
    await firstDatabase.inboundEntityLock.create({
      data: { entityKey, ownerToken: 'expired-owner', eventId: 'expired-event', leaseExpiresAt: new Date(0) },
    });
    const recovered = await firstRuntime.process({ pairId, source: 'MOYSKLAD', settingsVersion: 4, eventId: 'recovered-event' });
    assert.equal(recovered.status, 'UNCHANGED');
    assert.equal(await firstDatabase.inboundEntityLock.findUnique({ where: { entityKey } }), null);

    api.moysklad.name = 'Renamed in MoySklad';
    api.failNextBitrixNameResponseAfterApply = true;
    const firstSync = firstRuntime.process({ pairId, source: 'MOYSKLAD', settingsVersion: 4, eventId: 'name-event' });
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

    assert.equal(api.bitrix24.name, 'Renamed in MoySklad');
    assert.equal(api.moysklad.name, 'Renamed in MoySklad');
    assert.equal(api.bitrix24.detailText, 'Description changed in MySklad');
    assert.equal(api.moysklad.detailText, 'Description changed in MySklad');
    assert.deepEqual(api.writes, [
      { side: 'BITRIX24', field: 'name' },
      { side: 'BITRIX24', field: 'detailText' },
    ]);

    const state = await stateStore.read(pairId);
    assert.equal(state?.bitrix24Values.name, 'Renamed in MoySklad');
    assert.equal(state?.moyskladValues.name, 'Renamed in MoySklad');
    assert.equal(state?.bitrix24Values.description, 'Description changed in MySklad');
    assert.equal(state?.moyskladValues.description, 'Description changed in MySklad');

    api.moysklad.name = 'Next MoySklad name';
    api.failNextBitrixNameWriteBeforeApply = true;
    const pending = await firstRuntime.process({ pairId, source: 'MOYSKLAD', settingsVersion: 4, eventId: 'pending-name-event' });
    assert.equal(pending.status, 'RETRYABLE_FAILURE');
    if (pending.status !== 'RETRYABLE_FAILURE') assert.fail('expected an uncertain target write to remain retryable');
    assert.equal(pending.reason, 'PRODUCT_CARD_WRITE_OUTCOME_PENDING');
    assert.deepEqual(pending.changedFields, []);
    assert.ok(pending.retryAfter instanceof Date, 'uncertain target writes retain a durable retry time');
    const unchangedState = await stateStore.read(pairId);
    assert.equal(unchangedState?.bitrix24Values.name, 'Renamed in MoySklad');
    assert.equal(unchangedState?.moyskladValues.name, 'Renamed in MoySklad');

    const retriedPending = await firstRuntime.process({ pairId, source: 'MOYSKLAD', settingsVersion: 4, eventId: 'pending-name-event' });
    assert.deepEqual(retriedPending, { status: 'SYNCED', changedFields: ['name'] });
    const verifiedRetryState = await stateStore.read(pairId);
    assert.equal(verifiedRetryState?.bitrix24Values.name, 'Next MoySklad name');
    assert.equal(verifiedRetryState?.moyskladValues.name, 'Next MoySklad name');
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
  failNextBitrixNameResponseAfterApply = false;
  failNextBitrixNameWriteBeforeApply = false;
  private nameWriteStarted?: () => void;
  private nameWriteGate?: Promise<void>;

  blockNextBitrixNameWrite(gate: Promise<void>, signal: () => void) {
    this.shouldBlockNameWrite = true;
    this.nameWriteStarted = signal;
    this.nameWriteGate = gate;
  }

  async readBitrix24() { return structuredClone(this.bitrix24); }
  async readMoysklad() { return structuredClone(this.moysklad); }

  async updateBitrix24(_id: string, fields: Record<string, unknown>) {
    if ('name' in fields && this.failNextBitrixNameWriteBeforeApply) {
      this.failNextBitrixNameWriteBeforeApply = false;
      this.writes.push({ side: 'BITRIX24', field: 'name' });
      throw new Error('synthetic connection failure before Bitrix24 applied write');
    }
    this.writes.push({ side: 'BITRIX24', field: Object.keys(fields).join(',') });
    if ('name' in fields) {
      this.bitrix24.name = String(fields.name);
      if (this.shouldBlockNameWrite) {
        this.shouldBlockNameWrite = false;
        this.nameWriteStarted?.();
        await this.nameWriteGate;
      }
      if (this.failNextBitrixNameResponseAfterApply) {
        this.failNextBitrixNameResponseAfterApply = false;
        throw new Error('synthetic response lost after Bitrix24 applied write');
      }
    }
    if ('detailText' in fields) this.bitrix24.detailText = String(fields.detailText);
  }

  async updateBitrix24Price() { throw new Error('No price fields are configured in this test'); }

  async updateMoysklad(_id: string, fields: Record<string, unknown>) {
    this.writes.push({ side: 'MOYSKLAD', field: Object.keys(fields).join(',') });
    if ('name' in fields) this.moysklad.name = String(fields.name);
    if ('description' in fields) this.moysklad.detailText = String(fields.description);
  }
}
