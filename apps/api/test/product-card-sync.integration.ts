import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ProductCardApi, ProductCardLeaseError, ProductCardPair, ProductCardPrice, ProductCardSettings, ProductCardSnapshot, ProductCardStateStore, ProductCardSyncService, ProductCardSyncState } from '../src/products/product-card-sync.service';

const pair: ProductCardPair = {
  id: 'product-pair-1', entityType: 'PRODUCT', bitrix24Id: '101', moyskladId: 'product-uuid-1',
  active: true, source: 'MANUAL', reason: null, createdAt: new Date('2026-10-01T00:00:00Z'),
};

const settings: ProductCardSettings = {
  rules: [
    { id: 'product-name', entity: 'catalog', sourceField: 'name', targetField: 'name',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } },
    { id: 'product-description', entity: 'catalog', sourceField: 'detailText', targetField: 'description',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } },
  ],
  references: {
    units: [{ bitrix24Id: 3, moyskladId: 'unit-uuid-3', status: 'configured' }],
    priceTypes: [{ bitrix24Id: 2, moyskladId: 'price-type-2', status: 'configured' }],
  },
};

class MemoryState implements ProductCardStateStore {
  value: ProductCardSyncState | null = null;
  failNextWrite?: Error;
  async read() { return this.value; }
  async write(_pairId: string, _settingsVersion: number, state: ProductCardSyncState) {
    if (this.failNextWrite) {
      const error = this.failNextWrite;
      this.failNextWrite = undefined;
      throw error;
    }
    this.value = structuredClone(state);
  }
}

class FakeApi implements ProductCardApi {
  bitrix24: ProductCardSnapshot = card('Initial', 'B24 detail', '3', [{ priceId: 'b24-price-2', typeId: '2', value: 10, currency: 'RUB' }]);
  moysklad: ProductCardSnapshot = card('Initial', 'MS detail', 'unit-uuid-3', [
    { priceId: 'ms-price-2', typeId: 'price-type-2', value: 10, currency: 'RUB', currencyRef: msCurrencyRef() },
    { priceId: 'ms-unpaired-price', typeId: 'unpaired-price-type', value: 77, currency: 'RUB', currencyRef: msCurrencyRef() },
  ]);
  writes: Array<{ side: string; field: string }> = [];
  failMoyskladPriceWrite = false;
  failMoyskladNameWriteAfterApply = false;
  moyskladPricePayloads: Array<Array<{ value: number; priceType: { meta: { href: string; type: string; mediaType: string } } }>> = [];
  async readBitrix24() { return structuredClone(this.bitrix24); }
  async readMoysklad() { return structuredClone(this.moysklad); }
  async updateBitrix24(_id: string, fields: Record<string, unknown>) {
    this.writes.push({ side: 'BITRIX24', field: Object.keys(fields).join(',') });
    if ('name' in fields) this.bitrix24.name = String(fields.name);
    if ('detailText' in fields) this.bitrix24.detailText = String(fields.detailText);
    if ('measure' in fields) this.bitrix24.unitId = String(fields.measure);
  }
  async updateBitrix24Price(priceId: string, value: number) {
    this.writes.push({ side: 'BITRIX24', field: `price:${priceId}` });
    const price = this.bitrix24.prices.find((item) => item.priceId === priceId)!;
    price.value = value;
  }
  async updateMoysklad(_id: string, fields: Record<string, unknown>) {
    this.writes.push({ side: 'MOYSKLAD', field: Object.keys(fields).join(',') });
    if ('name' in fields) {
      this.moysklad.name = String(fields.name);
      if (this.failMoyskladNameWriteAfterApply) {
        this.failMoyskladNameWriteAfterApply = false;
        throw new Error('synthetic response lost after vendor applied write');
      }
    }
    if ('description' in fields) this.moysklad.detailText = String(fields.description);
    if ('uom' in fields) this.moysklad.unitId = 'unit-uuid-3';
    if ('salePrices' in fields) {
      if (this.failMoyskladPriceWrite) throw new Error('synthetic price write failure');
      const rows = fields.salePrices as Array<{ value: number; priceType: { meta: { href: string; type: string; mediaType: string } } }>;
      this.moyskladPricePayloads.push(structuredClone(rows));
      for (const row of rows) {
        const typeId = row.priceType.meta.href.split('/').at(-1);
        const price = this.moysklad.prices.find((item) => item.typeId === typeId);
        if (price) price.value = row.value;
      }
    }
  }
}

function card(name: string, detailText: string, unitId: string, prices: ProductCardPrice[]): ProductCardSnapshot {
  return { name, detailText, unitId, prices, updatedAt: '2026-10-07T10:00:00Z' };
}

test('existing product pair captures a no-write baseline, then propagates one-sided name edits idempotently', async () => {
  const api = new FakeApi();
  const state = new MemoryState();
  const sync = new ProductCardSyncService(api, state);
  assert.equal((await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings })).status, 'BASELINED');
  assert.equal(api.writes.length, 0);

  api.bitrix24.name = 'Renamed by Bitrix';
  const first = await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
  assert.equal(first.status, 'SYNCED');
  assert.equal(api.moysklad.name, 'Renamed by Bitrix');
  assert.deepEqual(api.writes, [{ side: 'MOYSKLAD', field: 'name' }]);

  const echo = await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings });
  assert.equal(echo.status, 'UNCHANGED');
  assert.equal(api.writes.length, 1);
});

test('simultaneous product name edits resolve to MySklad', async () => {
  const api = new FakeApi();
  const state = new MemoryState();
  const sync = new ProductCardSyncService(api, state);
  await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
  api.bitrix24.name = 'B24 concurrent';
  api.moysklad.name = 'MS concurrent';
  const result = await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
  assert.equal(result.status, 'SYNCED');
  assert.equal(api.bitrix24.name, 'MS concurrent');
  assert.deepEqual(api.writes, [{ side: 'BITRIX24', field: 'name' }]);
});

test('unmapped product unit holds the card and excluded price types remain untouched', async () => {
  const api = new FakeApi();
  const state = new MemoryState();
  const sync = new ProductCardSyncService(api, state);
  await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
  api.bitrix24.unitId = '14';
  api.bitrix24.name = 'Must not partially rename';
  const result = await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
  assert.deepEqual(result, { status: 'MANUAL_REVIEW', reason: 'PRODUCT_UNIT_MAPPING_MISSING_OR_AMBIGUOUS', changedFields: [] });
  assert.equal(api.moysklad.name, 'Initial');
  assert.equal(api.writes.length, 0);
});

test('configured catalog price changes preserve unpaired MySklad prices', async () => {
  const api = new FakeApi();
  const state = new MemoryState();
  const sync = new ProductCardSyncService(api, state);
  await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
  api.bitrix24.prices[0].value = 12;
  const result = await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
  assert.equal(result.status, 'SYNCED');
  assert.equal(api.moysklad.prices[0].value, 12);
  assert.deepEqual(api.moyskladPricePayloads[0].map((price) => price.value), [12, 77]);
  assert.equal(api.writes.some((write) => write.field === 'catalog.price.modify'), false);
});

test('multiple configured MySklad price writes retain earlier updates in the same pass', async () => {
  const api = new FakeApi();
  api.bitrix24.prices.push({ priceId: 'b24-price-4', typeId: '4', value: 20, currency: 'RUB' });
  api.moysklad.prices.push({ priceId: 'ms-price-4', typeId: 'price-type-4', value: 20, currency: 'RUB', currencyRef: msCurrencyRef() });
  const state = new MemoryState();
  const sync = new ProductCardSyncService(api, state);
  const settingsWithTwoPrices: ProductCardSettings = {
    ...settings,
    references: { ...settings.references, priceTypes: [
      ...settings.references.priceTypes,
      { bitrix24Id: 4, moyskladId: 'price-type-4', status: 'configured' },
    ] },
  };
  await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings: settingsWithTwoPrices });
  api.bitrix24.prices[0].value = 12;
  api.bitrix24.prices[1].value = 22;
  const result = await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings: settingsWithTwoPrices });
  assert.equal(result.status, 'SYNCED');
  assert.deepEqual(api.moysklad.prices.map((price) => price.value), [12, 77, 22]);
  assert.deepEqual(api.moyskladPricePayloads.map((rows) => rows.map((row) => row.value)), [[12, 77, 20], [12, 77, 22]]);
});

test('mapped product prices with different or unknown currencies hold without writing', async () => {
  for (const currency of ['USD', '']) {
    const api = new FakeApi();
    const state = new MemoryState();
    const sync = new ProductCardSyncService(api, state);
    await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
    api.bitrix24.name = 'Name still syncs';
    api.bitrix24.prices[0].value = 12;
    api.moysklad.prices[0].currency = currency;
    const result = await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
    assert.deepEqual(result, { status: 'MANUAL_REVIEW', reason: 'PRODUCT_PRICE_CURRENCY_UNVERIFIED_OR_MISMATCHED', changedFields: ['name'] });
    assert.equal(api.moysklad.name, 'Name still syncs');
    assert.equal(api.moysklad.prices[0].value, 10);
    assert.equal(api.writes.some((write) => write.field === 'salePrices'), false);
  }
});

test('a price write failure is field-local and does not block verified card name sync', async () => {
  const api = new FakeApi();
  const state = new MemoryState();
  const sync = new ProductCardSyncService(api, state);
  await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
  api.bitrix24.name = 'Name despite price failure';
  api.bitrix24.prices[0].value = 12;
  api.failMoyskladPriceWrite = true;
  const result = await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
  assert.deepEqual(result, { status: 'RETRYABLE_FAILURE', reason: 'PRODUCT_CARD_WRITE_OUTCOME_PENDING', changedFields: ['name'] });
  assert.equal(api.moysklad.name, 'Name despite price failure');
  assert.equal(api.moysklad.prices[0].value, 10);
});

test('a vendor write with a lost response is accepted only after target readback verifies it', async () => {
  const api = new FakeApi();
  const state = new MemoryState();
  const sync = new ProductCardSyncService(api, state);
  await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
  api.bitrix24.name = 'Applied despite lost response';
  api.failMoyskladNameWriteAfterApply = true;

  const result = await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });

  assert.deepEqual(result, { status: 'SYNCED', changedFields: ['name'] });
  assert.equal(api.moysklad.name, 'Applied despite lost response');
  assert.equal(state.value?.bitrix24Values.name, 'Applied despite lost response');
  assert.equal(state.value?.moyskladValues.name, 'Applied despite lost response');
  assert.deepEqual(api.writes, [{ side: 'MOYSKLAD', field: 'name' }]);
});

test('a lost pair lease propagates after a vendor write without committing stale last-success state', async () => {
  const api = new FakeApi();
  const state = new MemoryState();
  const sync = new ProductCardSyncService(api, state);
  await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
  const lastSuccessfulState = structuredClone(state.value);
  api.bitrix24.name = 'Lease holder changed this name';
  state.failNextWrite = new ProductCardLeaseError('PRODUCT_PAIR_LOCK_LOST');

  await assert.rejects(
    sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings }),
    ProductCardLeaseError,
  );
  assert.equal(api.moysklad.name, 'Lease holder changed this name');
  assert.deepEqual(state.value, lastSuccessfulState);
});

function msCurrencyRef() { return { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/currency/abcdefab-cdef-abcd-efab-cdefabcdefad', type: 'currency', mediaType: 'application/json' } }; }
