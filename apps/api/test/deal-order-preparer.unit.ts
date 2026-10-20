import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { DealOrderCreationPreparer } from '../src/deals-orders/deal-order-creation-preparer.service';

const uuids = {
  company: '11111111-1111-4111-8111-111111111111',
  product: '33333333-3333-4333-8333-333333333333',
  organization: '44444444-4444-4444-8444-444444444444',
  store: '55555555-5555-4555-8555-555555555555',
  state: '66666666-6666-4666-8666-666666666666',
  currency: '77777777-7777-4777-8777-777777777777',
  unit: '88888888-8888-4888-8888-888888888888',
  employee: '99999999-9999-4999-8999-999999999999',
};
const originalEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
const clientResolver = {
  async resolveForDocument(input: { entity: string }) {
    const pair = { id: 'company-pair', entityType: 'COMPANY', bitrix24Id: '200', moyskladId: uuids.company };
    return { status: 'RESOLVED', pair, companyPair: pair, selectedSourceId: '200', reason: 'TEST' } as const;
  },
  async scheduleOptionalContactRetry() {},
  async verifyServiceCounterparty() { return true; },
};
const preparer = new DealOrderCreationPreparer(createPreparerDatabase(), clientResolver as never);
let productPairExists = true;
let rows: Record<string, unknown>[] = [];
let deal: Record<string, unknown>;
let requestCount = 0;
let nextRowId = 1;

before(() => {
  for (const key of ['BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN']) originalEnv.set(key, process.env[key]);
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.test/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.test/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-token';
  globalThis.fetch = fakeFetch as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('complete preflight preserves every row, including repeated products and explicit zero price', async () => {
  reset();
  rows = [productRow(12.5, 2), productRow(0, 1)];
  const result = await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-1', eventConfig: eventConfig() });
  assert.equal(result.status, 'READY');
  if (result.status !== 'READY') return;
  assert.equal(result.input.payload.positions.length, 2);
  assert.deepEqual(result.input.payload.positions.map((position) => [position.quantity, position.price]), [[2, 1250], [1, 0]]);
  assert.deepEqual(result.input.sourceRowIds, ['7001', '7002']);
  assert.equal(result.input.sourceRowValues.length, 2);
  assert.equal(result.input.payload.organization.meta.href, msRef('organization', uuids.organization));
  assert.equal(result.input.payload.store.meta.href, msRef('store', uuids.store));
});

test('creation includes supported scalar custom attributes and holds unsupported configured mappings before order creation', async () => {
  reset();
  rows = [productRow(10, 1)];
  deal.ACQUIRER_PAYMENT = 'confirmed';
  const supported = eventConfig();
  supported.config.rules = [{
    id: 'acquirer-payment', entity: 'deals-orders', sourceField: 'ACQUIRER_PAYMENT', targetField: 'attributes.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } },
  }];
  const ready = await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-custom-field', eventConfig: supported });
  assert.equal(ready.status, 'READY');
  if (ready.status === 'READY') assert.deepEqual(ready.input.payload.attributes, [{
    meta: { href: 'https://moysklad.test/api/remap/1.2/entity/customerorder/metadata/attributes/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'attributemetadata', mediaType: 'application/json' },
    value: 'confirmed',
  }]);

  const unsupported = eventConfig();
  unsupported.config.rules = [{
    id: 'unsupported-target', entity: 'deals-orders', sourceField: 'ACQUIRER_PAYMENT', targetField: 'description',
    bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: false, transform: { kind: 'copy' } },
  }];
  const held = await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-unsupported-field', eventConfig: unsupported });
  assert.deepEqual(held, { status: 'WAITING', reason: 'FIELD_MAPPING_UNSUPPORTED' });
});

test('a row with an unmapped unit is skipped while other confirmed rows remain eligible', async () => {
  reset();
  rows = [productRow(10, 1), { ...productRow(5, 1), measureCode: 14 }];
  const result = await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-2', eventConfig: eventConfig() });
  assert.equal(result.status, 'READY');
  if (result.status === 'READY') assert.equal(result.input.payload.positions.length, 1);
});

test('discount and VAT convert from explicit source net price; missing net value is skipped', async () => {
  reset();
  rows = [
    { ...productRow(9, 1), priceNetto: 10, discountTypeId: 1, discountSum: 1 },
    { ...productRow(12, 1), priceNetto: 10, taxRate: 20, taxIncluded: 'N' },
    { ...productRow(9, 1), discountTypeId: 1, discountSum: 1 },
  ];
  const result = await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-3', eventConfig: eventConfig() });
  assert.equal(result.status, 'READY');
  if (result.status === 'READY') {
    assert.deepEqual(result.input.payload.positions.map((position) => [position.price, position.discount, position.vat, position.vatEnabled]), [[1000, 10, 0, false], [1000, 0, 20, true]]);
    assert.equal(result.input.payload.vatIncluded, false);
    assert.deepEqual(result.input.skippedRows, [{ sourceRowId: '7003', reason: 'DISCOUNT_OR_VAT_TRANSFORM_UNSUPPORTED' }]);
  }
});

test('a later unsupported row is omitted without suppressing the other valid row', async () => {
  reset();
  rows = [productRow(10, 1), { ...productRow(5, 1), taxRate: 20 }];
  let dependencyCalls = 0;
  const resolver = {
    async resolveForDocument() { dependencyCalls++; return { status: 'RESOLVED', pair: { id: 'company-pair', entityType: 'COMPANY', bitrix24Id: '200', moyskladId: uuids.company }, companyPair: null, selectedSourceId: '200', reason: 'TEST' }; },
    async scheduleOptionalContactRetry() {}, async verifyServiceCounterparty() { return true; },
  };
  const withResolver = new DealOrderCreationPreparer(createPreparerDatabase(), resolver as never);
  const result = await withResolver.prepare({ bitrix24DealId: '100', eventId: 'event-preflight-before-deps', eventConfig: eventConfig() });
  assert.equal(result.status, 'READY');
  if (result.status === 'READY') assert.equal(result.input.payload.positions.length, 1);
  assert.equal(dependencyCalls, 1);
});

test('native MySklad numbering must be explicitly verified before an order can be prepared', async () => {
  reset();
  rows = [productRow(10, 1)];
  const settings = eventConfig();
  settings.config.dealOrderRuntime.nativeOrderNumberingVerified = false;
  const result = await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-5', eventConfig: settings });
  assert.deepEqual(result, { status: 'WAITING', reason: 'NATIVE_ORDER_NUMBERING_UNVERIFIED' });
});

function createPreparerDatabase(): DatabaseService {
  const database: any = {
    entityPair: { findMany },
    operationalLog: { create: async () => ({}) },
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
      $queryRaw: async () => [{ serviceMode: 'on' }],
    }),
  };
  return database as DatabaseService;
}

function eventConfig(): any {
  return {
    version: 7,
    createdAt: new Date(0).toISOString(),
    config: {
      schemaVersion: 1,
      rules: [],
      groups: [],
      references: {
        units: [{ bitrix24Id: 796, bitrix24Code: '796', moyskladId: uuids.unit, moyskladCode: '796', status: 'configured' }],
        priceTypes: [], dictionaries: [],
      },
      dealOrderRuntime: {
        nativeOrderNumberingVerified: true,
        defaultOrganizationId: uuids.organization,
        defaultStoreId: uuids.store,
        defaultEmployeeId: uuids.employee,
        currencies: [{ bitrix24Code: 'RUB', moyskladId: uuids.currency }],
        stages: [{ bitrix24StageId: 'NEW', moyskladId: uuids.state, creationEnabled: true }],
        organizations: [], stores: [], employees: [],
      },
    },
    references: { units: [], priceTypes: [], dictionaries: [] },
  } as never;
}

function productRow(price: number, quantity: number) {
  return { id: String(7000 + nextRowId++), productId: 300, measureCode: 796, price, quantity, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: null, taxIncluded: 'N' };
}

function reset() {
  requestCount = 0;
  nextRowId = 1;
  productPairExists = true;
  deal = { ID: '100', COMPANY_ID: 200, STAGE_ID: 'NEW', CURRENCY_ID: 'RUB', ASSIGNED_BY_ID: null };
}

async function findMany(args: { where: { entityType: string; bitrix24Id: string }; take: number }) {
  const id = args.where.entityType === 'COMPANY' ? uuids.company : productPairExists ? uuids.product : null;
  return id ? [{ moyskladId: id }] : [];
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  requestCount++;
  if (url.hostname === 'bitrix.test' && url.pathname.endsWith('/crm.deal.get.json')) return json({ result: deal });
  if (url.hostname === 'bitrix.test' && url.pathname.endsWith('/crm.item.productrow.list')) {
    return json({ result: { productRows: rows }, total: rows.length });
  }
  if (url.hostname === 'moysklad.test' && url.pathname.endsWith('/entity/assortment')) {
    return json({ rows: [{ id: uuids.product, meta: { type: 'product', href: msRef('product', uuids.product) }, uom: { id: uuids.unit } }] });
  }
  if (url.hostname === 'moysklad.test') {
    const state = url.pathname.match(/\/entity\/customerorder\/metadata\/states\/([0-9a-f-]{36})$/);
    if (state) return json({ id: state[1], meta: { type: 'state' } });
    const entity = url.pathname.match(/\/entity\/(organization|store|employee|currency)\/([0-9a-f-]{36})$/);
    if (entity) return json({ id: entity[2], meta: { type: entity[1] } });
  }
  return json({}, 404);
}

function msRef(type: string, id: string) { return `https://moysklad.test/api/remap/1.2/entity/${type}/${id}`; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
