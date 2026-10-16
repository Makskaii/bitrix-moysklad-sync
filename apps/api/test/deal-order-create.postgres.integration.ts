import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../src/database.service';
import { SyncModeService } from '../src/sync-mode.service';
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

test('MySklad order ID persists after remote create and retry reuses it rather than creating a duplicate', async () => {
  posts = 0; failNextB24DealRead = true; b24OrderNumber = null;
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

function preparedInput(): any {
  return {
    bitrix24DealId: '901', bitrix24CompanyId: '902', bitrix24ContactId: null, confirmedCustomerPairIds: [companyPairId],
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
  if (url.pathname === '/api/remap/1.2/entity/customerorder' && request.method === 'POST') {
    posts++;
    return send(response, { id: ids.order, meta: { type: 'customerorder' } });
  }
  if (url.pathname === `/api/remap/1.2/entity/customerorder/${ids.order}`) return send(response, {
    id: ids.order, name: 'SO-54', meta: { type: 'customerorder' }, positions: { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assortment: { meta: { type: 'product', href: `${base}api/remap/1.2/entity/product/${ids.product}` } }, quantity: 2, price: 0, discount: 0, vat: 0, vatEnabled: false }] },
  });
  const entity = url.pathname.match(/\/entity\/(counterparty|organization|store|employee|currency)\/([0-9a-f-]{36})$/);
  if (entity) return send(response, { id: entity[2], meta: { type: entity[1] } });
  const state = url.pathname.match(/\/entity\/customerorder\/metadata\/states\/([0-9a-f-]{36})$/);
  if (state) return send(response, { id: state[1], meta: { type: 'state' } });
  const product = url.pathname.match(/\/entity\/product\/([0-9a-f-]{36})$/);
  if (product) return send(response, { id: product[1], meta: { type: 'product' }, uom: { id: ids.unit } });
  if (url.pathname === '/rest/crm.deal.get.json') {
    if (failNextB24DealRead) { failNextB24DealRead = false; response.writeHead(500); response.end('{}'); return; }
    return send(response, { result: { ID: '901', UF_CRM_1729757435964: b24OrderNumber } });
  }
  if (url.pathname === '/rest/crm.deal.update.json') {
    b24OrderNumber = body.get('fields[UF_CRM_1729757435964]');
    return send(response, { result: true });
  }
  response.writeHead(404); response.end('{}');
}
function send(response: ServerResponse, value: unknown) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }
