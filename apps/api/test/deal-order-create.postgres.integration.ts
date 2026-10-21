import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../src/database.service';
import { SyncModeService } from '../src/sync-mode.service';
import { DealOrderCreationPreparer } from '../src/deals-orders/deal-order-creation-preparer.service';
import { DealOrderCreateOperationService } from '../src/deals-orders/deal-order-create-operation.service';

process.env.SYNC_MODE ??= 'apply';
const db = new PrismaClient();
const database = new DatabaseService();
const ids = {
  order: '11111111-1111-4111-8111-111111111111', company: '22222222-2222-4222-8222-222222222222',
  product: '33333333-3333-4333-8333-333333333333', organization: '44444444-4444-4444-8444-444444444444',
  store: '55555555-5555-4555-8555-555555555555', state: '66666666-6666-4666-8666-666666666666',
  currency: '77777777-7777-4777-8777-777777777777', unit: '88888888-8888-4888-8888-888888888888',
  employee: '99999999-9999-4999-8999-999999999999',
};
const fakeBaseLoop = randomUUID();
let server: Server;
let base = '';
let posts = 0;
let failNextB24DealRead = true;
let b24OrderNumber: string | null = null;
let activeOrderId = ids.order;
let nextNumberReadBarrier: { started: () => void; wait: Promise<void> } | null = null;
let offAcknowledged = false;
let requestsAfterOff = 0;
let numberUpdates = 0;
let headerContractDealId: string | null = null;
let headerContractRequests: Array<{ path: string; accept: string | undefined; acceptEncoding: string | undefined }> = [];
let headerContractMeasureCode = 796;
const suffix = randomUUID();
let companyPairId = '';
let productPairId = '';
let service: DealOrderCreateOperationService;

before(async () => {
  const target = new URL(process.env.DATABASE_URL ?? '');
  assert.match(target.hostname, /^(127\.0\.0\.1|localhost)$/i);
  assert.match(target.pathname, /test/i);
  assert.equal(process.env.DEAL_ORDER_CREATE_TEST_ISOLATED, '1');
  await db.$connect();
  await db.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  await db.syncDirectionSetting.upsert({ where: { entityKey: 'deals-orders' }, create: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: true }, update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } });
  companyPairId = (await db.entityPair.create({ data: { entityType: 'COMPANY', bitrix24Id: '902', moyskladId: ids.company, source: 'MANUAL' } })).id;
  productPairId = (await db.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: '904', moyskladId: ids.product, source: 'MANUAL' } })).id;
  server = createServer((request, response) => { void reply(request, response); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}/`;
  process.env.BITRIX24_REST_BASE_URL = `${base}rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${base}api/remap/1.2/`;
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-only';
  service = new DealOrderCreateOperationService(database, new SyncModeService(database));
});

after(async () => {
  await db.dealOrderCreateOperation.deleteMany({ where: { bitrix24DealId: '901' } });
  await db.entityPair.deleteMany({ where: { entityType: 'DEAL', bitrix24Id: '901' } });
  await db.entityPair.deleteMany({ where: { id: { in: [companyPairId, productPairId] } } });
  await db.$disconnect();
  await database.$disconnect();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('durable OFF acknowledged after number read blocks the next B24 provider request', async () => {
  const previousMode = (await db.syncSetting.findUniqueOrThrow({ where: { id: 'global' } })).serviceMode;
  const bitrix24DealId = String(Date.now());
  activeOrderId = randomUUID();
  posts = 0;
  failNextB24DealRead = false;
  b24OrderNumber = null;
  numberUpdates = 0;
  requestsAfterOff = 0;
  offAcknowledged = false;
  let resolveReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => { resolveReadStarted = resolve; });
  let unblockRead!: () => void;
  const readBarrier = new Promise<void>((resolve) => { unblockRead = resolve; });
  nextNumberReadBarrier = { started: resolveReadStarted, wait: readBarrier };

  const creation = service.createAndPair(preparedInput(bitrix24DealId)).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await readStarted;
    const off = db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'off' } }).then((row) => {
      offAcknowledged = true;
      return row;
    });
    unblockRead();
    await off;
    const error = await creation;
    assert.ok(error instanceof Error, 'the gated source-number write must stop after OFF');
    assert.equal(numberUpdates, 0, 'no B24 update starts after the gated read releases');
    assert.equal(requestsAfterOff, 0, 'no provider request starts after durable OFF acknowledgement');
    assert.equal(posts, 1, 'the already-created MySklad order is not duplicated or rolled back');
    assert.equal((await db.dealOrderCreateOperation.findUniqueOrThrow({ where: { bitrix24DealId } })).moyskladOrderId, activeOrderId);
  } finally {
    unblockRead();
    nextNumberReadBarrier = null;
    await creation;
    const pair = await db.entityPair.findFirst({ where: { entityType: 'DEAL', bitrix24Id: bitrix24DealId }, select: { id: true } });
    if (pair) await db.dealOrderPositionPair.deleteMany({ where: { pairId: pair.id } });
    await db.entityPair.deleteMany({ where: { entityType: 'DEAL', bitrix24Id: bitrix24DealId } });
    await db.dealOrderCreateOperation.deleteMany({ where: { bitrix24DealId } });
    await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: previousMode } });
    activeOrderId = ids.order;
    offAcknowledged = false;
  }
});

test('production preparer resolves a Bitrix unit mapping by catalog code under the PostgreSQL mode gate', async () => {
  const mode = await db.syncSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { serviceMode: true } });
  assert.equal(mode.serviceMode, 'on');
  headerContractDealId = `903${Date.now()}`;
  headerContractRequests = [];
  headerContractMeasureCode = 796;
  const resolver = {
    async resolveForDocument() {
      const pair = await db.entityPair.findUniqueOrThrow({ where: { id: companyPairId } });
      return { status: 'RESOLVED', pair, companyPair: pair, selectedSourceId: '902', reason: 'TEST_FIXTURE' } as const;
    },
    async scheduleOptionalContactRetry() {},
    async verifyServiceCounterparty() { return true; },
  };
  const preparer = new DealOrderCreationPreparer(database, resolver as never);
  const settings: any = {
    version: 4,
    createdAt: new Date(0),
    config: {
      schemaVersion: 1,
      rules: [],
      groups: [],
      references: {
        units: [{ bitrix24Id: 9, bitrix24Code: '796', moyskladId: ids.unit, moyskladCode: '796', status: 'configured' }],
        priceTypes: [], dictionaries: [],
      },
      dealOrderRuntime: {
        nativeOrderNumberingVerified: true,
        defaultOrganizationId: ids.organization,
        defaultStoreId: ids.store,
        defaultEmployeeId: ids.employee,
        defaultProductGroupId: null,
        currencies: [{ bitrix24Code: 'RUB', moyskladId: ids.currency }],
        stages: [{ bitrix24StageId: 'NEW', moyskladId: ids.state, creationEnabled: true }],
        organizations: [], stores: [], employees: [],
      },
    },
    references: { units: [], priceTypes: [], dictionaries: [] },
  };
  try {
    const result = await preparer.prepare({ bitrix24DealId: headerContractDealId, eventId: `unit-code-${suffix}`, eventConfig: settings });
    assert.equal(result.status, 'READY');
    if (result.status === 'READY') {
      assert.deepEqual(result.input.sourceRowIds, ['301'], 'measureCode 796 must resolve the saved catalog row id 9/code 796 mapping');
      assert.deepEqual(result.input.sourceMeasureCodes, [796]);
      assert.deepEqual(result.input.unitMappings, [{ bitrix24Id: 9, moyskladId: ids.unit, status: 'configured' }], 'resolution must not rewrite the saved mapping');
      assert.equal(result.input.payload.positions.length, 1);
      assert.equal(result.input.payload.positions[0]?.quantity, 1);
      assert.equal(result.input.payload.positions[0]?.price, 1000);
    }
    assert.equal(headerContractRequests.length, 6, 'five named refs and one product assortment are read through the preparer');
    assert.ok(headerContractRequests.every((request) => request.accept === 'application/json;charset=utf-8' && request.acceptEncoding === 'gzip'));

    headerContractRequests = [];
    settings.config.references.units = [
      { bitrix24Id: 9, bitrix24Code: '796', moyskladId: ids.unit, moyskladCode: '796', status: 'configured' },
      { bitrix24Id: 10, bitrix24Code: '796', moyskladId: ids.unit, moyskladCode: '796', status: 'configured' },
    ];
    const ambiguous = await preparer.prepare({ bitrix24DealId: headerContractDealId, eventId: `unit-ambiguous-${suffix}`, eventConfig: settings });
    assert.equal(ambiguous.status, 'READY');
    if (ambiguous.status === 'READY') {
      assert.equal(ambiguous.input.payload.positions.length, 0, 'duplicate source catalog codes must not guess one saved mapping');
      assert.deepEqual(ambiguous.input.skippedRows, [{ sourceRowId: '301', reason: 'UNIT_UNMAPPED' }]);
    }

    headerContractRequests = [];
    settings.config.references.units = [
      { bitrix24Id: 9, bitrix24Code: '796', moyskladId: ids.unit, moyskladCode: '796', status: 'configured' },
    ];
    headerContractMeasureCode = 797;
    const unknown = await preparer.prepare({ bitrix24DealId: headerContractDealId, eventId: `unit-unknown-${suffix}`, eventConfig: settings });
    assert.equal(unknown.status, 'READY');
    if (unknown.status === 'READY') {
      assert.equal(unknown.input.payload.positions.length, 0, 'unknown source measure codes must remain unmapped');
      assert.deepEqual(unknown.input.skippedRows, [{ sourceRowId: '301', reason: 'UNIT_UNMAPPED' }]);
    }

    headerContractMeasureCode = 796;
    settings.config.references.units = [
      { bitrix24Id: 796, bitrix24Code: '797', moyskladId: ids.unit, moyskladCode: '796', status: 'configured' },
    ];
    const mismatched = await preparer.prepare({ bitrix24DealId: headerContractDealId, eventId: `unit-mismatched-${suffix}`, eventConfig: settings });
    assert.equal(mismatched.status, 'READY');
    if (mismatched.status === 'READY') {
      assert.equal(mismatched.input.payload.positions.length, 0, 'an ID match cannot override a mismatched source catalog code');
      assert.deepEqual(mismatched.input.skippedRows, [{ sourceRowId: '301', reason: 'UNIT_UNMAPPED' }]);
    }
  } finally {
    headerContractDealId = null;
    headerContractRequests = [];
    headerContractMeasureCode = 796;
  }
});

test('MySklad order ID persists after remote create and retry reuses it rather than creating a duplicate', async () => {
  posts = 0; failNextB24DealRead = true; b24OrderNumber = null;
  activeOrderId = ids.order;
  const input = preparedInput();
  input.skippedRows = [{ sourceRowId: '302', reason: 'UNIT_UNMAPPED' }];
  const firstError = await service.createAndPair(input).then(() => null, (error: unknown) => error);
  assert.ok(firstError instanceof Error);
  assert.match(firstError.message, /customer-order number read failed/i);
  const afterLoss = await db.dealOrderCreateOperation.findUniqueOrThrow({ where: { bitrix24DealId: '901' } });
  assert.equal(afterLoss.moyskladOrderId, ids.order, 'provider ID is durably saved before later B24 work');
  assert.equal(afterLoss.status, 'PENDING');

  const result = await service.createAndPair(input);
  assert.deepEqual(result, { status: 'PARTIAL', bitrix24DealId: '901', moyskladOrderId: ids.order, skippedRows: input.skippedRows });
  assert.equal(posts, 1, 'MySklad customer order is never duplicated');
  const pair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'DEAL', bitrix24Id: '901', active: true } });
  const links = await db.dealOrderPositionPair.findMany({ where: { pairId: pair.id } });
  assert.equal(links.length, 1);
  const operation = await db.dealOrderCreateOperation.findUniqueOrThrow({ where: { bitrix24DealId: '901' } });
  assert.equal(operation.status, 'PARTIAL');
  assert.deepEqual(operation.skippedRows, input.skippedRows);
  assert.equal(b24OrderNumber, 'SO-54');
});

function preparedInput(bitrix24DealId = '901'): any {
  return {
    bitrix24DealId, bitrix24CompanyId: '902', bitrix24ContactId: null, confirmedCustomerPairIds: [companyPairId],
    eventId: `b24-event-${suffix}`, settingsVersion: 4, sourceProductIds: ['904'], sourceRowIds: ['301'],
    sourceRowValues: [{ id: '301', productId: 904, quantity: 2, price: 0, measureCode: 796 }], sourceMeasureCodes: [796],
    unitMappings: [{ bitrix24Id: 796, moyskladId: ids.unit, status: 'configured' }],
    payload: {
      agent: ref('counterparty', ids.company), organization: ref('organization', ids.organization), store: ref('store', ids.store),
      state: { meta: { type: 'state', href: `${base}api/remap/1.2/entity/customerorder/metadata/states/${ids.state}` } },
      owner: ref('employee', ids.employee), rate: { currency: ref('currency', ids.currency) },
      positions: [{ assortment: ref('product', ids.product), quantity: 2, price: 0, discount: 0, vat: 0, vatEnabled: false }],
    },
  };
}
function ref(type: string, id: string) { return { meta: { type, href: `${base}api/remap/1.2/entity/${type}/${id}` } }; }
async function reply(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  const body = text ? new URLSearchParams(text) : new URLSearchParams();
  const url = new URL(request.url ?? '/', base);
  if (offAcknowledged) requestsAfterOff++;
  if (url.pathname === '/api/remap/1.2/entity/customerorder' && request.method === 'POST') {
    posts++;
    return send(response, { id: activeOrderId, meta: { type: 'customerorder' } });
  }
  if (url.pathname === `/api/remap/1.2/entity/customerorder/${activeOrderId}`) return send(response, {
    id: activeOrderId, name: 'SO-54', meta: { type: 'customerorder' }, positions: { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assortment: { meta: { type: 'product', href: `${base}api/remap/1.2/entity/product/${ids.product}` } }, quantity: 2, price: 0, discount: 0, vat: 0, vatEnabled: false }] },
  });
  if (url.pathname === '/api/remap/1.2/entity/assortment' && headerContractDealId) {
    captureHeaderContractRequest(request, url.pathname);
    if (!hasRequiredMySkladReadHeaders(request)) return send(response, { errors: [{ code: 1062 }] }, 400);
    return send(response, { rows: [{ id: ids.product, meta: { type: 'product', href: `${base}api/remap/1.2/entity/product/${ids.product}` }, uom: { id: ids.unit } }] });
  }
  const entity = url.pathname.match(/\/entity\/(counterparty|organization|store|employee|currency)\/([0-9a-f-]{36})$/);
  if (entity) {
    if (headerContractDealId) {
      captureHeaderContractRequest(request, url.pathname);
      if (!hasRequiredMySkladReadHeaders(request)) return send(response, { errors: [{ code: 1062 }] }, 400);
    }
    return send(response, { id: entity[2], meta: { type: entity[1] } });
  }
  const state = url.pathname.match(/\/entity\/customerorder\/metadata\/states\/([0-9a-f-]{36})$/);
  if (state) {
    if (headerContractDealId) {
      captureHeaderContractRequest(request, url.pathname);
      if (!hasRequiredMySkladReadHeaders(request)) return send(response, { errors: [{ code: 1062 }] }, 400);
    }
    return send(response, { id: state[1], meta: { type: 'state' } });
  }
  const product = url.pathname.match(/\/entity\/product\/([0-9a-f-]{36})$/);
  if (product) return send(response, { id: product[1], meta: { type: 'product' }, uom: { id: ids.unit } });
  if (url.pathname === '/rest/crm.deal.get.json') {
    if (body.get('id') === headerContractDealId) return send(response, { result: {
      ID: headerContractDealId, COMPANY_ID: '902', CONTACT_ID: null, STAGE_ID: 'NEW', CURRENCY_ID: 'RUB', ASSIGNED_BY_ID: null,
      OPPORTUNITY: '10', TITLE: 'Synthetic PostgreSQL preparer header fixture',
    } });
    if (nextNumberReadBarrier) {
      const barrier = nextNumberReadBarrier;
      nextNumberReadBarrier = null;
      barrier.started();
      await barrier.wait;
    }
    if (failNextB24DealRead) { failNextB24DealRead = false; response.writeHead(500); response.end('{}'); return; }
    return send(response, { result: { ID: body.get('id'), UF_CRM_1729757435964: b24OrderNumber } });
  }
  if (url.pathname === '/rest/crm.item.productrow.list' && body.get('filter[=ownerId]') === headerContractDealId) {
    return send(response, { result: { productRows: [{ id: '301', productId: '904', measureCode: headerContractMeasureCode, quantity: 1, price: 10, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: null, taxIncluded: 'N' }] }, total: 1 });
  }
  if (url.pathname === '/rest/crm.deal.update.json') {
    numberUpdates++;
    b24OrderNumber = body.get('fields[UF_CRM_1729757435964]');
    return send(response, { result: true });
  }
  response.writeHead(404); response.end('{}');
}
function send(response: ServerResponse, value: unknown, status = 200) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }
function captureHeaderContractRequest(request: IncomingMessage, path: string) {
  headerContractRequests.push({ path, accept: request.headers.accept, acceptEncoding: request.headers['accept-encoding'] });
}
function hasRequiredMySkladReadHeaders(request: IncomingMessage) {
  return request.headers.accept === 'application/json;charset=utf-8' && request.headers['accept-encoding'] === 'gzip';
}
