import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../src/database.service';
import { SyncModeService } from '../src/sync-mode.service';
import { DealOrderReverseCreateService, DealOrderReverseManualReviewError } from '../src/deals-orders/deal-order-reverse-create.service';

process.env.SYNC_MODE ??= 'apply';
const db = new PrismaClient();
const database = new DatabaseService();
const portMarker = 'issue54_reverse_test';
const ids = {
  order: '11111111-1111-4111-8111-111111111111',
  company: '22222222-2222-4222-8222-222222222222',
  product: '33333333-3333-4333-8333-333333333333',
  state: '44444444-4444-4444-8444-444444444444',
  currency: '55555555-5555-4555-8555-555555555555',
  unit: '66666666-6666-4666-8666-666666666666',
};
let server: Server;
let base = '';
let dealAdds = 0;
let nextDealId = 801;
let rowAdds = 0;
let loseSecondRowResponse = true;
let loseProductCreateResponse = true;
let items: Record<string, unknown>[] = [];
let rows: Record<string, unknown>[] = [];
let products: Record<string, unknown>[] = [];
let orderPositions: Record<string, unknown>[] = [];
let activeOrderId = ids.order;
let sourceProductName = 'MS product name';
let productAdds = 0;
let msProductWrites = 0;
const suffix = randomUUID();
let pairIds: string[] = [];
let service: DealOrderReverseCreateService;
const clientPair: any = { id: '', entityType: 'COMPANY', bitrix24Id: '901', moyskladId: ids.company };

before(async () => {
  const target = new URL(process.env.DATABASE_URL ?? '');
  assert.match(target.hostname, /^(127\.0\.0\.1|localhost)$/i, 'test must use loopback PostgreSQL');
  assert.match(target.pathname, /test/i, 'test database name must identify an isolated test DB');
  assert.equal(process.env.DEAL_ORDER_REVERSE_TEST_ISOLATED, '1', 'set explicit isolated-test marker');
  await db.$connect();
  await db.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  await db.syncDirectionSetting.upsert({ where: { entityKey: 'deals-orders' }, create: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: true }, update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } });
  const company = await db.entityPair.create({ data: { entityType: 'COMPANY', bitrix24Id: '901', moyskladId: ids.company, source: 'MANUAL' } });
  pairIds = [company.id];
  clientPair.id = company.id;
  server = createServer((request, response) => { void reply(request, response); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}/`;
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_REST_BASE_URL = `${base}rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${base}api/remap/1.2/`;
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-only';
  process.env.BITRIX24_API_TOKEN = 'synthetic-test-only';
  service = new DealOrderReverseCreateService(database, new SyncModeService(database), {
    async resolveForDocument() { return { status: 'RESOLVED', pair: clientPair, companyPair: clientPair, selectedSourceId: ids.company, reason: 'TEST_PAIR' }; },
    async scheduleOptionalContactRetry() {}, async verifyServiceCounterparty() { return true; },
  } as never);
});

after(async () => {
  await db.dealOrderReverseCreateOperation.deleteMany({ where: { moyskladOrderId: ids.order } });
  await db.dealOrderReverseProductOperation.deleteMany({ where: { moyskladProductId: ids.product } });
  await db.entityPair.deleteMany({ where: { entityType: 'PRODUCT', moyskladId: ids.product } });
  await db.entityPair.deleteMany({ where: { entityType: 'DEAL', moyskladId: ids.order } });
  await db.entityPair.deleteMany({ where: { id: { in: pairIds } } });
  await db.$disconnect();
  await database.$disconnect();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('partial B24 row-create response loss resumes the same deal and addressed rows without duplicate adds', async () => {
  dealAdds = 0; rowAdds = 0; productAdds = 0; msProductWrites = 0; loseProductCreateResponse = true; loseSecondRowResponse = true; items = []; rows = []; products = [];
  nextDealId = 801;
  orderPositions = [position('p1', 2), position('p2', 3), { ...position('p3', 1), price: 0 }];
  const eventConfig = config();
  const input = { moyskladOrderId: ids.order, eventId: `event-${suffix}`, eventConfig };
  const firstAttempt = await service.createAndPair(input).then(() => null, (error: unknown) => error);
  assert.ok(firstAttempt instanceof Error, `expected injected response loss; productAdds=${productAdds}, rowAdds=${rowAdds}`);
  assert.match(firstAttempt.message, /Provider request failed \(500\)/);
  const pendingProduct = await db.dealOrderReverseProductOperation.findUniqueOrThrow({ where: { moyskladProductId: ids.product } });
  assert.equal(pendingProduct.bitrix24ProductId, null, 'uncertain product response stays journaled without guessing the ID');
  assert.equal(products.length, 1, 'fake provider applied the product add before losing its response');

  const secondAttempt = await service.createAndPair(input).then(() => null, (error: unknown) => error);
  assert.ok(secondAttempt instanceof Error, 'second attempt reaches injected row response loss after product recovery and deal creation');
  assert.match(secondAttempt.message, /Provider request failed \(500\)/);
  const afterLoss = await db.dealOrderReverseCreateOperation.findUniqueOrThrow({ where: { moyskladOrderId: ids.order }, include: { positions: true } });
  assert.equal(afterLoss.bitrix24DealId, '801', 'created deal ID persists before row writes');
  assert.equal(afterLoss.status, 'PENDING');
  assert.equal(afterLoss.positions.filter((row) => row.bitrix24ProductRowId === '1001').length, 1);
  assert.equal(afterLoss.positions.filter((row) => row.bitrix24ProductRowId === null).length, 2);

  const result = await service.createAndPair(input);
  assert.deepEqual(result, { status: 'CREATED', bitrix24DealId: '801' });
  assert.equal(productAdds, 1, 'product create response recovery never creates a duplicate');
  assert.equal(msProductWrites, 0, 'product cards are never written to MySklad');
  assert.equal(products[0].iblockId, 42);
  assert.equal(products[0].name, 'MS product name');
  assert.equal(products[0].code, 'MS-SKU-54');
  assert.equal(products[0].detailText, 'MS product description');
  assert.equal(products[0].measure, 796);
  assert.equal(products[0].xmlId, `MOYSKLAD_PRODUCT_${ids.product}`);
  assert.equal((await db.entityPair.findFirstOrThrow({ where: { entityType: 'PRODUCT', moyskladId: ids.product, active: true } })).bitrix24Id, '903');
  assert.equal(dealAdds, 1, 'deal is never duplicated');
  assert.equal(rowAdds, 3, 'ambiguous row response recovered by durable sort slots, no duplicate row is added');
  assert.equal(rows.length, 3, 'unpaired product position was skipped');
  assert.equal(items[0].title, 'Заказ покупателя SO-54');
  assert.equal(items[0].UF_CRM_1729757435964, 'SO-54');
  assert.equal(items[0].originId, ids.order);
  assert.deepEqual(rows.map((row) => [row.sort, row.productId, row.price, row.quantity]), [[1, 903, 123.45, 2], [2, 903, 123.45, 3], [3, 903, 0, 1]]);
  assert.equal(rows.some((row) => Number(row.productId) !== 903), false);
  const savedPair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'DEAL', moyskladId: ids.order, active: true } });
  assert.equal(savedPair.bitrix24Id, '801');
  const links = await db.dealOrderPositionPair.findMany({ where: { pairId: savedPair.id }, orderBy: { moyskladPositionId: 'asc' } });
  assert.equal(links.length, 3);
  assert.equal((await db.dealOrderReverseCreateOperation.findUniqueOrThrow({ where: { moyskladOrderId: ids.order } })).status, 'SUCCEEDED');
});

test('concurrent retries create one missing B24 product and durably pair it before using the product row', async () => {
  const dealPair = await db.entityPair.findFirst({ where: { entityType: 'DEAL', moyskladId: ids.order } });
  if (dealPair) await db.dealOrderPositionPair.deleteMany({ where: { pairId: dealPair.id } });
  await db.dealOrderReverseCreateOperation.deleteMany({ where: { moyskladOrderId: ids.order } });
  await db.entityPair.deleteMany({ where: { entityType: 'DEAL', moyskladId: ids.order } });
  await db.dealOrderReverseProductOperation.deleteMany({ where: { moyskladProductId: ids.product } });
  await db.entityPair.deleteMany({ where: { entityType: 'PRODUCT', moyskladId: ids.product } });
  dealAdds = 0; rowAdds = 0; productAdds = 0; msProductWrites = 0; loseProductCreateResponse = false; loseSecondRowResponse = false; items = []; rows = []; products = [];
  nextDealId = 801;
  orderPositions = [position('concurrent-1', 1)];
  const input = { moyskladOrderId: ids.order, eventId: `event-${suffix}-concurrent`, eventConfig: config() };
  const attempts = await Promise.allSettled([service.createAndPair(input), service.createAndPair(input)]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1, 'one worker owns and completes the durable operation');
  assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1, 'the competing worker is fenced while the owner is active');
  assert.equal(productAdds, 1, 'the prerequisite lease prevents concurrent duplicate product creates');
  assert.equal(msProductWrites, 0);
  assert.equal((await db.entityPair.findMany({ where: { entityType: 'PRODUCT', moyskladId: ids.product, active: true } })).length, 1);
  const dealOperation = await db.dealOrderReverseCreateOperation.findUniqueOrThrow({ where: { moyskladOrderId: ids.order }, include: { positions: true } });
  assert.equal(dealOperation.status, 'SUCCEEDED');
  assert.equal(dealOperation.positions.length, 1);
  assert.ok(dealOperation.positions[0].bitrix24ProductRowId);
});

test('an existing product pair is preserved when the MySklad product name changes', async () => {
  const orderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  activeOrderId = orderId;
  sourceProductName = 'Renamed in MySklad';
  await db.entityPair.deleteMany({ where: { entityType: 'PRODUCT', moyskladId: ids.product } });
  const productPair = await db.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: '904', moyskladId: ids.product, source: 'MANUAL' } });
  pairIds.push(productPair.id);
  items = []; rows = []; products = [{ id: 904, iblockId: 42, xmlId: `MOYSKLAD_PRODUCT_${ids.product}`, name: 'Existing Bitrix product name', measure: 796 }];
  nextDealId = 802;
  productAdds = 0; dealAdds = 0; rowAdds = 0; msProductWrites = 0; loseProductCreateResponse = false; loseSecondRowResponse = false;
  orderPositions = [position('rename-1', 1)];
  try {
    const result = await service.createAndPair({ moyskladOrderId: orderId, eventId: `event-${suffix}-rename`, eventConfig: config() });
    assert.equal(result.status, 'CREATED');
    assert.equal(productAdds, 0, 'a confirmed product pair prevents replacement or duplicate creation');
    assert.equal(products[0].name, 'Existing Bitrix product name', 'a source rename does not overwrite an existing B24 product');
    assert.equal(rows[0].productId, 904);
    assert.equal(msProductWrites, 0);
  } finally {
    const dealPair = await db.entityPair.findFirst({ where: { entityType: 'DEAL', moyskladId: orderId } });
    if (dealPair) await db.dealOrderPositionPair.deleteMany({ where: { pairId: dealPair.id } });
    await db.dealOrderReverseCreateOperation.deleteMany({ where: { moyskladOrderId: orderId } });
    await db.entityPair.deleteMany({ where: { entityType: 'DEAL', moyskladId: orderId } });
    await db.entityPair.deleteMany({ where: { id: productPair.id } });
    activeOrderId = ids.order;
    sourceProductName = 'MS product name';
  }
});

test('missing pinned numbering/runtime references are held for review before any provider write', async () => {
  dealAdds = 0; rowAdds = 0;
  const orderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const eventConfig = config();
  eventConfig.config.dealOrderRuntime.nativeOrderNumberingVerified = false;
  await assert.rejects(
    service.createAndPair({ moyskladOrderId: orderId, eventId: `event-${suffix}-missing-config`, eventConfig }),
    (error: unknown) => error instanceof DealOrderReverseManualReviewError,
  );
  assert.equal(dealAdds, 0);
  assert.equal(rowAdds, 0);
  assert.equal(await db.dealOrderReverseCreateOperation.count({ where: { moyskladOrderId: orderId } }), 0);
});

test('missing confirmed product-catalog selection holds an unpaired product for review without a provider write', async () => {
  activeOrderId = ids.order;
  dealAdds = 0; rowAdds = 0; productAdds = 0; products = [];
  await db.dealOrderReverseCreateOperation.deleteMany({ where: { moyskladOrderId: ids.order } });
  await db.dealOrderReverseProductOperation.deleteMany({ where: { moyskladProductId: ids.product } });
  await db.entityPair.deleteMany({ where: { entityType: 'DEAL', moyskladId: ids.order } });
  await db.entityPair.deleteMany({ where: { entityType: 'PRODUCT', moyskladId: ids.product } });
  const eventConfig = config();
  eventConfig.config.dealOrderRuntime.bitrix24ProductCatalogId = null;
  await assert.rejects(service.createAndPair({ moyskladOrderId: ids.order, eventId: `event-${suffix}-catalog`, eventConfig }), (error: unknown) => error instanceof DealOrderReverseManualReviewError);
  assert.equal(productAdds, 0);
  assert.equal(dealAdds, 0);
});

function config(): any {
  return { version: 4, createdAt: new Date(0).toISOString(), config: {
    schemaVersion: 1, rules: [], groups: [], serviceCounterpartyId: null,
    references: { units: [{ bitrix24Id: 796, bitrix24Code: '796', moyskladId: ids.unit, moyskladCode: '796', status: 'configured' }], priceTypes: [], dictionaries: [] },
    dealOrderRuntime: {
      nativeOrderNumberingVerified: true,
      bitrix24ProductCatalogId: '42',
      moyskladProductFields: ['name', 'code', 'description'],
      defaultOrganizationId: ids.company, defaultStoreId: ids.company, defaultEmployeeId: ids.company,
      currencies: [{ bitrix24Code: 'RUB', moyskladId: ids.currency }],
      stages: [{ bitrix24StageId: 'C2:UC_TEST', moyskladId: ids.state, creationEnabled: true }],
      organizations: [], stores: [], employees: [],
    },
  }, references: { units: [], priceTypes: [], dictionaries: [] } };
}
function position(id: string, quantity: number): Record<string, unknown> {
  return { id, quantity, price: 12345, discount: 0, vat: 0, vatEnabled: false, assortment: { id: ids.product, uom: { id: ids.unit } } };
}
async function reply(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const bodyText = Buffer.concat(chunks).toString('utf8');
  const body = bodyText ? JSON.parse(bodyText) as Record<string, any> : {};
  const pathname = new URL(request.url ?? '/', base).pathname;
  if (pathname === '/api/remap/1.2/entity/product/' + ids.product) return send(response, { id: ids.product, meta: { type: 'product' }, name: sourceProductName, code: 'MS-SKU-54', description: 'MS product description', uom: { id: ids.unit } });
  if (pathname === '/api/remap/1.2/entity/customerorder/' + activeOrderId) return send(response, { id: activeOrderId, name: 'SO-54', sum: 50000, state: { id: ids.state }, rate: { currency: { id: ids.currency } }, agent: { id: ids.company, meta: { type: 'counterparty' } }, description: 'from MS' });
  if (pathname === `/api/remap/1.2/entity/customerorder/${activeOrderId}/positions`) {
    const offset = Number(new URL(request.url ?? '/', base).searchParams.get('offset') ?? 0);
    return send(response, { rows: orderPositions.slice(offset, offset + 100) });
  }
  if (pathname === '/rest/crm.item.list') return send(response, { result: { items: items.filter((item) => item.originatorId === body.filter?.originatorId && item.originId === body.filter?.originId) } });
  if (pathname === '/rest/crm.item.add') {
    dealAdds++;
    const item = { ...body.fields, id: nextDealId++ };
    items.push(item);
    return send(response, { result: { item } });
  }
  if (pathname === '/rest/crm.item.get') return send(response, { result: { item: items.find((item) => String(item.id) === String(body.id)) } });
  if (pathname === '/rest/crm.item.productrow.list') {
    const start = Number(body.start ?? 0);
    return send(response, { result: { productRows: rows.slice(start, start + 50) } });
  }
  if (pathname === '/rest/crm.item.productrow.add') {
    rowAdds++;
    const added = { ...body.fields, id: 1000 + rowAdds };
    rows.push(added);
    if (rowAdds === 2 && loseSecondRowResponse) {
      loseSecondRowResponse = false;
      response.writeHead(500); response.end(JSON.stringify({ error: 'synthetic response loss after provider success' })); return;
    }
    return send(response, { result: { productRow: added } });
  }
  if (pathname === '/rest/catalog.product.list') {
    const found = products.filter((product) => product.xmlId === body.filter?.xmlId && String(product.iblockId) === String(body.filter?.iblockId));
    return send(response, { result: { products: found }, total: found.length });
  }
  if (pathname === '/rest/catalog.product.add') {
    productAdds++;
    const created = { ...body.fields, id: 903 };
    products.push(created);
    if (loseProductCreateResponse) { loseProductCreateResponse = false; response.writeHead(500); response.end(JSON.stringify({ error: 'synthetic product create response loss' })); return; }
    return send(response, { result: { element: created } });
  }
  response.writeHead(404); response.end(JSON.stringify({ error: `unexpected ${request.method} ${pathname}` }));
}
function send(response: ServerResponse, body: unknown) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }
