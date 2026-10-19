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
  bitrix24 = card('Initial', 'B24 detail', '3', [{ priceId: 'b24-price-2', typeId: '2', value: 10, currency: 'RUB' }], { weight: 1.5, xmlId: 'initial-external' });
  moysklad = card('Initial', 'MS detail', 'unit-uuid-3', [{ priceId: 'ms-price-2', typeId: 'price-type-2', value: 10, currency: 'RUB', currencyRef: currencyRef() }], { weight: 1.5, externalCode: 'initial-external' });
  writes: Array<{ side: string; fields: string }> = [];
  ambiguousBitrixUpdate = false;
  ambiguousBitrixPriceUpdate = false;
  async readBitrix24() { return structuredClone(this.bitrix24); }
  async readMoysklad() { return structuredClone(this.moysklad); }
  async updateBitrix24(_id: string, fields: Record<string, unknown>) {
    this.writes.push({ side: 'BITRIX24', fields: Object.keys(fields).join(',') });
    if ('name' in fields) this.bitrix24.name = String(fields.name);
    if ('detailText' in fields) this.bitrix24.detailText = String(fields.detailText);
    if ('code' in fields) this.bitrix24.code = String(fields.code);
    if ('measure' in fields) this.bitrix24.unitId = String(fields.measure);
    Object.assign(this.bitrix24.fields ?? {}, fields);
    if (this.ambiguousBitrixUpdate) {
      this.ambiguousBitrixUpdate = false;
      throw new ProviderFailure('BITRIX24', null);
    }
  }
  async updateBitrix24Price(priceId: string, value: number) {
    this.writes.push({ side: 'BITRIX24', fields: `price:${priceId}` });
    const price = this.bitrix24.prices.find((item) => item.priceId === priceId)!;
    price.value = value;
    if (this.ambiguousBitrixPriceUpdate) {
      this.ambiguousBitrixPriceUpdate = false;
      throw new ProviderFailure('BITRIX24', null);
    }
  }
  async updateMoysklad(_id: string, fields: Record<string, unknown>) {
    this.writes.push({ side: 'MOYSKLAD', fields: Object.keys(fields).join(',') });
    if ('name' in fields) this.moysklad.name = String(fields.name);
    if ('description' in fields) this.moysklad.detailText = String(fields.description);
    if ('uom' in fields) this.moysklad.unitId = 'unit-uuid-3';
  }
}

function card(name: string, detailText: string, unitId: string, prices: ProductCardPrice[], fields: Record<string, string | number | boolean | null> = {}): ProductCardSnapshot {
  return { name, detailText, unitId, prices, fields, updatedAt: '2026-10-07T10:00:00Z' };
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

test('configured writable catalog code updates Bitrix24 from MySklad without enabling reverse writes', async () => {
  const api = new FakeApi();
  api.bitrix24.code = 'OLD';
  api.moysklad.code = 'OLD';
  const configured = { ...settings, rules: [...settings.rules, {
    id: 'product-code', entity: 'catalog', sourceField: 'code', targetField: 'code',
    bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } },
  }] };
  const sync = new ProductCardSyncService(api, new MemoryState());
  await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings: configured });
  api.moysklad.code = 'NEW';
  assert.equal((await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings: configured })).status, 'SYNCED');
  assert.equal(api.bitrix24.code, 'NEW');
  assert.ok(api.writes.every((write) => write.side === 'BITRIX24'));
});

test('configured service price changes update Bitrix24 and an applied write with lost response is read back, not repeated', async () => {
  const api = new FakeApi();
  const servicePair = { ...pair, moyskladType: 'service' };
  const sync = new ProductCardSyncService(api, new MemoryState());
  await sync.sync({ pair: servicePair, source: 'MOYSKLAD', settingsVersion: 1, settings });
  api.moysklad.prices[0]!.value = 11;
  api.ambiguousBitrixPriceUpdate = true;
  const result = await sync.sync({ pair: servicePair, source: 'MOYSKLAD', settingsVersion: 1, settings });
  assert.equal(result.status, 'SYNCED');
  assert.equal(api.bitrix24.prices[0]!.value, 11);
  assert.equal(api.writes.filter((write) => write.fields.startsWith('price:')).length, 1);
  assert.ok(api.writes.every((write) => write.side === 'BITRIX24'));
});

test('explicit scalar mappings preserve zero and empty string without overwriting Bitrix24 recovery identity', async () => {
  const api = new FakeApi();
  const mapped = { ...settings, rules: [...settings.rules,
    { id: 'product-weight', entity: 'catalog', sourceField: 'weight', targetField: 'weight',
      bitrix24ToMoysklad: { enabled: false, transform: { kind: 'tbd' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } },
    { id: 'product-external-code', entity: 'catalog', sourceField: 'xmlId', targetField: 'externalCode',
      bitrix24ToMoysklad: { enabled: false, transform: { kind: 'tbd' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } },
  ] };
  const state = new MemoryState();
  const sync = new ProductCardSyncService(api, state);
  assert.equal((await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings: mapped })).status, 'BASELINED');
  api.moysklad.fields!.weight = 0;
  api.moysklad.fields!.externalCode = '';

  const result = await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings: mapped });

  assert.equal(result.status, 'SYNCED');
  assert.equal(api.bitrix24.fields!.weight, 0);
  assert.equal(api.bitrix24.fields!.xmlId, 'initial-external', 'the XML ID remains the durable catalog-create recovery key');
  assert.deepEqual(api.writes.map((write) => write.fields), ['weight']);
  assert.ok(api.writes.every((write) => write.side === 'BITRIX24'));
  assert.equal((await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings: mapped })).status, 'UNCHANGED');
  api.moysklad.fields!.externalCode = 'different-identity';
  assert.equal((await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings: mapped })).status, 'UNCHANGED');
  assert.equal(api.bitrix24.fields!.xmlId, 'initial-external');
  assert.deepEqual(api.writes.map((write) => write.fields), ['weight'], 'empty and changed MySklad external codes cannot replace the recovery XML ID');
});

test('unconfigured and disabled catalog scalar candidates are never written', async () => {
  const api = new FakeApi();
  const state = new MemoryState();
  const disabled = { ...settings, rules: [...settings.rules,
    { id: 'disabled-weight', entity: 'catalog', sourceField: 'weight', targetField: 'weight',
      bitrix24ToMoysklad: { enabled: false, transform: { kind: 'tbd' } },
      moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' } } },
  ] };
  const sync = new ProductCardSyncService(api, state);
  assert.equal((await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings: disabled })).status, 'BASELINED');
  api.moysklad.fields!.weight = 9;
  assert.equal((await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings: disabled })).status, 'UNCHANGED');
  assert.deepEqual(api.writes, []);
  api.moysklad.fields!.externalCode = 'unconfigured';
  assert.equal((await sync.sync({ pair, source: 'MOYSKLAD', settingsVersion: 1, settings })).status, 'UNCHANGED');
  assert.deepEqual(api.writes, []);
});
