import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { DealOrderCreationPreparer, readRuntimeReferences } from '../src/deals-orders/deal-order-creation-preparer.service';

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
  async resolveForDocument(input: { entity: string }, lease?: unknown) {
    if (expectedOwnerLease) assert.equal(lease, expectedOwnerLease);
    const pair = { id: 'company-pair', entityType: 'COMPANY', bitrix24Id: '200', moyskladId: uuids.company };
    return { status: 'RESOLVED', pair, companyPair: pair, selectedSourceId: '200', reason: 'TEST' } as const;
  },
  async scheduleOptionalContactRetry() {},
  async verifyServiceCounterparty() { return true; },
};
const preparer = new DealOrderCreationPreparer(createPreparerDatabase(), clientResolver as never);
let productPairExists = true;
let expectedOwnerLease: {assertOwned():Promise<void>} | undefined;
let rows: Record<string, unknown>[] = [];
let deal: Record<string, unknown>;
let requestCount = 0;
let nextRowId = 1;
let operationalMessages: string[] = [];
let requireExactMoyskladReadHeaders = false;
let observedMoyskladReferenceHeaders: Array<{ accept: string | null; acceptEncoding: string | null }> = [];

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

test('claimed deal worker lease is forwarded unchanged to client dependencies, never replaced by a RECEIVED assumption', async()=>{
  reset(); rows=[productRow(10,1)];
  let asserted=0;
  expectedOwnerLease={async assertOwned(){asserted++;}};
  try{
    const result=await preparer.prepare({bitrix24DealId:'100',eventId:'event-1',eventConfig:eventConfig()},expectedOwnerLease);
    assert.equal(result.status,'READY');assert.ok(asserted>=1);
    expectedOwnerLease={async assertOwned(){throw new Error('EVENT_WORKER_LEASE_LOST');}};
    await assert.rejects(preparer.prepare({bitrix24DealId:'100',eventId:'event-1',eventConfig:eventConfig()},expectedOwnerLease),/EVENT_WORKER_LEASE_LOST/);
  }finally{expectedOwnerLease=undefined;}
});

test('deal-order reference probes use the required MySklad JSON charset and gzip headers', async () => {
  reset();
  rows = [productRow(10, 1)];
  requireExactMoyskladReadHeaders = true;
  observedMoyskladReferenceHeaders = [];
  try {
    const result = await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-ms-reference-headers', eventConfig: eventConfig() });
    assert.equal(result.status, 'READY');
    assert.equal(observedMoyskladReferenceHeaders.length, 5);
    assert.deepEqual(observedMoyskladReferenceHeaders, Array.from({ length: 5 }, () => ({
      accept: 'application/json;charset=utf-8',
      acceptEncoding: 'gzip',
    })));
  } finally {
    requireExactMoyskladReadHeaders = false;
  }
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

test('unmapped store and employee use only confirmed configured defaults when policy explicitly allows it', async () => {
  reset();
  rows = [productRow(10, 1)];
  deal.UF_CRM_1732004209 = '999';
  deal.ASSIGNED_BY_ID = '998';
  const settings = eventConfig();
  settings.config.dealOrderRuntime.unmappedReferencePolicy = 'confirmed-defaults';
  const result = await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-default-fallback', eventConfig: settings });

  assert.equal(result.status, 'READY');
  if (result.status !== 'READY') return;
  assert.equal(result.input.payload.store.meta.href, msRef('store', uuids.store));
  assert.equal(result.input.payload.owner.meta.href, msRef('employee', uuids.employee));
  assert.ok(operationalMessages.some((message) => message.includes('reason=UNMAPPED_SOURCE_STORE_DEFAULT_APPLIED')));
  assert.ok(operationalMessages.some((message) => message.includes('reason=UNMAPPED_SOURCE_EMPLOYEE_DEFAULT_APPLIED')));
});

test('unmapped store holds while legacy employee fallback remains compatible unless explicit hold is saved', async () => {
  reset();
  rows = [productRow(10, 1)];
  deal.UF_CRM_1732004209 = '999';
  const storeHeld = await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-strict-store', eventConfig: eventConfig() });
  assert.deepEqual(storeHeld, { status: 'WAITING', reason: 'STORE_MAPPING_UNCONFIRMED' });

  reset();
  rows = [productRow(10, 1)];
  deal.ASSIGNED_BY_ID = '998';
  const employeeHeld = await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-strict-employee', eventConfig: eventConfig() });
  assert.equal(employeeHeld.status, 'READY', 'legacy configs keep the previously supported configured-default employee fallback');

  reset();
  rows = [productRow(10, 1)];
  deal.ASSIGNED_BY_ID = '998';
  const strictSettings = eventConfig();
  strictSettings.config.dealOrderRuntime.unmappedReferencePolicy = 'hold';
  assert.deepEqual(
    await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-explicit-employee-hold', eventConfig: strictSettings }),
    { status: 'WAITING', reason: 'EMPLOYEE_MAPPING_UNCONFIRMED' },
  );
});

test('confirmed defaults never turn an unmapped forward deal stage into an order create', async () => {
  reset();
  rows = [productRow(10, 1)];
  deal.STAGE_ID = 'NEW';
  const settings = eventConfig();
  settings.config.dealOrderRuntime.unmappedReferencePolicy = 'confirmed-defaults';
  assert.deepEqual(
    await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-unmapped-stage', eventConfig: settings }),
    { status: 'WAITING', reason: 'STAGE_NOT_CONFIGURED' },
  );
});

test('confirmed defaults preserve explicitly configured creation-enabled custom forward stages', async () => {
  reset();
  rows = [productRow(10, 1)];
  deal.STAGE_ID = 'NEW';
  const settings = eventConfig();
  settings.config.dealOrderRuntime.unmappedReferencePolicy = 'confirmed-defaults';
  settings.config.dealOrderRuntime.stages.push({ bitrix24StageId: 'NEW', moyskladId: uuids.state, creationEnabled: true });
  const result = await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-configured-custom-stage', eventConfig: settings });
  assert.equal(result.status, 'READY');
});

test('confirmed defaults never guess an unknown currency or explicit organization', async () => {
  reset();
  rows = [productRow(10, 1)];
  const settings = eventConfig();
  settings.config.dealOrderRuntime.unmappedReferencePolicy = 'confirmed-defaults';
  deal.CURRENCY_ID = 'USD';
  assert.deepEqual(
    await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-unmapped-currency', eventConfig: settings }),
    { status: 'WAITING', reason: 'RUNTIME_REFERENCES_MISSING' },
  );

  reset();
  rows = [productRow(10, 1)];
  deal.UF_CRM_1776347243 = '1234';
  assert.deepEqual(
    await preparer.prepare({ bitrix24DealId: '100', eventId: 'event-unmapped-organization', eventConfig: settings }),
    { status: 'WAITING', reason: 'RUNTIME_REFERENCES_MISSING' },
  );
});

test('runtime policy parsing defaults to hold and rejects unknown policy values', () => {
  const runtime = eventConfig().config.dealOrderRuntime;
  assert.equal(readRuntimeReferences(runtime)?.unmappedReferencePolicy, undefined);
  assert.equal(readRuntimeReferences({ ...runtime, unmappedReferencePolicy: 'guess' }), null);
});

function createPreparerDatabase(): DatabaseService {
  const database: any = {
    entityPair: { findMany },
    operationalLog: { create: async ({ data }: { data?: { message?: string } }) => { if (data?.message) operationalMessages.push(data.message); return {}; } },
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
        stages: [{ bitrix24StageId: 'PREPARATION', moyskladId: uuids.state, creationEnabled: true }],
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
  operationalMessages = [];
  productPairExists = true;
  deal = { ID: '100', COMPANY_ID: 200, STAGE_ID: 'PREPARATION', CURRENCY_ID: 'RUB', ASSIGNED_BY_ID: null };
}

async function findMany(args: { where: { entityType: string; bitrix24Id: string }; take: number }) {
  const id = args.where.entityType === 'COMPANY' ? uuids.company : productPairExists ? uuids.product : null;
  return id ? [{ moyskladId: id, bitrix24Id: args.where.bitrix24Id, active: true, lifecycleStatus: 'ACTIVE', moyskladType: 'product' }] : [];
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  requestCount++;
  if (url.hostname === 'bitrix.test' && url.pathname.endsWith('/crm.deal.get.json')) return json({ result: deal });
  if (url.hostname === 'bitrix.test' && url.pathname.endsWith('/crm.item.productrow.list')) {
    return json({ result: { productRows: rows }, total: rows.length });
  }
  if (url.hostname === 'moysklad.test' && url.pathname.endsWith('/entity/assortment')) {
    return json({ rows: [{ id: uuids.product, meta: { type: 'product', href: msRef('product', uuids.product) }, uom: { meta: {type:'uom',href:msRef('uom',uuids.unit)} } }] });
  }
  if (url.hostname === 'moysklad.test') {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers || undefined).forEach((value, name) => headers.set(name, value));
    const isReferenceProbe = /\/entity\/(organization|store|employee|currency)\//.test(url.pathname) || /\/entity\/customerorder\/metadata\/states\//.test(url.pathname);
    if (isReferenceProbe) {
      observedMoyskladReferenceHeaders.push({ accept: headers.get('accept'), acceptEncoding: headers.get('accept-encoding') });
      if (requireExactMoyskladReadHeaders &&
          (headers.get('accept') !== 'application/json;charset=utf-8' || headers.get('accept-encoding') !== 'gzip')) {
        return json({ errors: [{ code: 1062 }] }, 400);
      }
    }
    const state = url.pathname.match(/\/entity\/customerorder\/metadata\/states\/([0-9a-f-]{36})$/);
    if (state) return json({ id: state[1], meta: { type: 'state' } });
    const entity = url.pathname.match(/\/entity\/(organization|store|employee|currency)\/([0-9a-f-]{36})$/);
    if (entity) return json({ id: entity[2], meta: { type: entity[1] } });
  }
  return json({}, 404);
}

function msRef(type: string, id: string) { return `https://moysklad.test/api/remap/1.2/entity/${type}/${id}`; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
