import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ProductCardApi, ProductCardPair, ProductCardPrice, ProductCardSettings, ProductCardSnapshot, ProductCardStateStore, ProductCardSyncService, ProductCardSyncState } from '../src/products/product-card-sync.service';
import { ProviderFailure } from '../src/provider-failure';

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
  async read() { return this.value; }
  async write(_pairId: string, _version: number, state: ProductCardSyncState) { this.value = structuredClone(state); }
}

class FakeApi implements ProductCardApi {
  bitrix24 = card('Initial', 'B24 detail', '3', [{ priceId: 'b24-price-2', typeId: '2', value: 10, currency: 'RUB' }]);
  moysklad = card('Initial', 'MS detail', 'unit-uuid-3', [{ priceId: 'ms-price-2', typeId: 'price-type-2', value: 10, currency: 'RUB', currencyRef: currencyRef() }]);
  writes: Array<{ side: string; fields: string }> = [];
  ambiguousBitrixUpdate = false;
  async readBitrix24() { return structuredClone(this.bitrix24); }
  async readMoysklad() { return structuredClone(this.moysklad); }
  async updateBitrix24(_id: string, fields: Record<string, unknown>) {
    this.writes.push({ side: 'BITRIX24', fields: Object.keys(fields).join(',') });
    if ('name' in fields) this.bitrix24.name = String(fields.name);
    if ('detailText' in fields) this.bitrix24.detailText = String(fields.detailText);
    if ('measure' in fields) this.bitrix24.unitId = String(fields.measure);
    if (this.ambiguousBitrixUpdate) {
      this.ambiguousBitrixUpdate = false;
      throw new ProviderFailure('BITRIX24', null);
    }
  }
  async updateBitrix24Price(priceId: string, value: number) {
    this.writes.push({ side: 'BITRIX24', fields: `price:${priceId}` });
    const price = this.bitrix24.prices.find((item) => item.priceId === priceId)!;
    price.value = value;
  }
  async updateMoysklad(_id: string, fields: Record<string, unknown>) {
    this.writes.push({ side: 'MOYSKLAD', fields: Object.keys(fields).join(',') });
    if ('name' in fields) this.moysklad.name = String(fields.name);
    if ('description' in fields) this.moysklad.detailText = String(fields.description);
    if ('uom' in fields) this.moysklad.unitId = 'unit-uuid-3';
  }
}

function card(name: string, detailText: string, unitId: string, prices: ProductCardPrice[]): ProductCardSnapshot {
  return { name, detailText, unitId, prices, updatedAt: '2026-10-07T10:00:00Z' };
}
function currencyRef() { return { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/currency/currency-id', type: 'currency', mediaType: 'application/json' } }; }

test('product cards only accept MySklad updates and never write card data back to MySklad', async () => {
  const api = new FakeApi();
  const sync = new ProductCardSyncService(api, new MemoryState());
  assert.equal((await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings })).status, 'BASELINED');

  api.moysklad.name = 'Changed in MySklad';
  assert.equal((await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings })).status, 'SYNCED');
  assert.equal(api.bitrix24.name, 'Changed in MySklad');
  assert.ok(api.writes.every((write) => write.side === 'BITRIX24'));

  api.bitrix24.name = 'Changed in Bitrix24';
  const skipped = await sync.sync({ pair, source: 'BITRIX24', settingsVersion: 1, settings });
  assert.deepEqual(skipped, { status: 'SKIPPED_DIRECTION_DISABLED', reason: 'PRODUCT_DIRECTION_DISABLED', changedFields: [] });
  assert.equal(api.moysklad.name, 'Changed in MySklad');
});

test('a Bitrix24-only field change is repaired from MySklad during a MySklad event', async () => {
  const api = new FakeApi();
  const sync = new ProductCardSyncService(api, new MemoryState());
  await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings });
  api.bitrix24.name = 'Local Bitrix change';

  const result = await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings });

  assert.equal(result.status, 'SYNCED');
  assert.equal(api.bitrix24.name, 'Initial');
  assert.ok(api.writes.every((write) => write.side === 'BITRIX24'));
});

test('mapped catalog prices flow from MySklad to Bitrix24 while unmapped prices stay untouched', async () => {
  const api = new FakeApi();
  api.moysklad.prices.push({ priceId: 'unmapped-ms-price', typeId: 'unmapped-type', value: 77, currency: 'RUB', currencyRef: currencyRef() });
  const sync = new ProductCardSyncService(api, new MemoryState());
  await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings });
  api.moysklad.prices[0]!.value = 12;

  const result = await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings });

  assert.equal(result.status, 'SYNCED');
  assert.equal(api.bitrix24.prices[0]!.value, 12);
  assert.equal(api.moysklad.prices[1]!.value, 77);
  assert.ok(api.writes.every((write) => write.side === 'BITRIX24'));
});

test('product provider retries use the durable attempt number for bounded fallback backoff', async () => {
  const api = new FakeApi();
  const state = new MemoryState();
  state.value = {
    bitrix24Values: { name: 'Initial', description: 'B24 detail', unitId: '3', prices: [] },
    moyskladValues: { name: 'Initial', description: 'MS detail', unitId: 'unit-uuid-3', prices: [] },
  };
  api.readBitrix24 = async () => { throw new ProviderFailure('BITRIX24', 503); };
  const result = await new ProductCardSyncService(api, state).sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings, attempt: 2 });
  assert.equal(result.status, 'RETRYABLE_FAILURE');
  if (result.status !== 'RETRYABLE_FAILURE') return;
  const delay = result.retryAfter!.getTime() - Date.now();
  assert.ok(delay > 8_000 && delay <= 10_000, `second provider failure should use ~10s fallback, got ${delay}ms`);
});

test('applied product write with a lost response is read back instead of repeated', async () => {
  const api = new FakeApi();
  const state = new MemoryState();
  const sync = new ProductCardSyncService(api, state);
  await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings });
  api.moysklad.name = 'Applied once';
  api.ambiguousBitrixUpdate = true;

  const result = await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings, attempt: 2 });

  assert.equal(result.status, 'SYNCED');
  assert.equal(api.bitrix24.name, 'Applied once');
  assert.deepEqual(api.writes, [{ side: 'BITRIX24', fields: 'name' }], 'target readback confirms the applied value before a retry can issue another write');
});
