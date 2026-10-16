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
let rowAdds = 0;
let loseSecondRowResponse = true;
let items: Record<string, unknown>[] = [];
let rows: Record<string, unknown>[] = [];
let orderPositions: Record<string, unknown>[] = [];
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
  const product = await db.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: '902', moyskladId: ids.product, source: 'MANUAL' } });
  pairIds = [company.id, product.id];
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
  await db.entityPair.deleteMany({ where: { entityType: 'DEAL', moyskladId: ids.order } });
  await db.entityPair.deleteMany({ where: { id: { in: pairIds } } });
  await db.$disconnect();
  await database.$disconnect();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('partial B24 row-create response loss resumes the same deal and addressed rows without duplicate adds', async () => {
  dealAdds = 0; rowAdds = 0; loseSecondRowResponse = true; items = []; rows = [];
  orderPositions = [position('p1', 2), position('p2', 3), { ...position('p3', 1), price: 0 }, { ...position('p4', 1), assortment: { id: '77777777-7777-4777-8777-777777777777', uom: { id: ids.unit } } }];
  const eventConfig = config();
  const input = { moyskladOrderId: ids.order, eventId: `event-${suffix}`, eventConfig };
  const firstAttempt = await service.createAndPair(input).then(() => null, (error: unknown) => error);
  assert.ok(firstAttempt instanceof Error, `expected injected response loss; rowAdds=${rowAdds}, recordedRows=${rows.length}`);
  assert.match(firstAttempt.message, /Provider request failed \(500\)/);
  const afterLoss = await db.dealOrderReverseCreateOperation.findUniqueOrThrow({ where: { moyskladOrderId: ids.order }, include: { positions: true } });
  assert.equal(afterLoss.bitrix24DealId, '801', 'created deal ID persists before row writes');
  assert.equal(afterLoss.status, 'PENDING');
  assert.equal(afterLoss.positions.filter((row) => row.bitrix24ProductRowId === '1001').length, 1);
  assert.equal(afterLoss.positions.filter((row) => row.bitrix24ProductRowId === null).length, 2);

  const result = await service.createAndPair(input);
  assert.deepEqual(result, { status: 'CREATED', bitrix24DealId: '801' });
  assert.equal(dealAdds, 1, 'deal is never duplicated');
  assert.equal(rowAdds, 3, 'ambiguous row response recovered by durable sort slots, no duplicate row is added');
  assert.equal(rows.length, 3, 'unpaired product position was skipped');
  assert.equal(items[0].title, 'Заказ покупателя SO-54');
  assert.equal(items[0].UF_CRM_1729757435964, 'SO-54');
  assert.equal(items[0].originId, ids.order);
  assert.deepEqual(rows.map((row) => [row.sort, row.productId, row.price, row.quantity]), [[1, 902, 123.45, 2], [2, 902, 123.45, 3], [3, 902, 0, 1]]);
  assert.equal(rows.some((row) => Number(row.productId) === 0), false);
  const savedPair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'DEAL', moyskladId: ids.order, active: true } });
  assert.equal(savedPair.bitrix24Id, '801');
  const links = await db.dealOrderPositionPair.findMany({ where: { pairId: savedPair.id }, orderBy: { moyskladPositionId: 'asc' } });
  assert.equal(links.length, 3);
  assert.equal((await db.dealOrderReverseCreateOperation.findUniqueOrThrow({ where: { moyskladOrderId: ids.order } })).status, 'SUCCEEDED');
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

function config(): any {
  return { version: 4, createdAt: new Date(0).toISOString(), config: {
    schemaVersion: 1, rules: [], groups: [], serviceCounterpartyId: null,
    references: { units: [{ bitrix24Id: 796, bitrix24Code: '796', moyskladId: ids.unit, moyskladCode: '796', status: 'configured' }], priceTypes: [], dictionaries: [] },
    dealOrderRuntime: {
      nativeOrderNumberingVerified: true,
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
  if (pathname === '/api/remap/1.2/entity/customerorder/' + ids.order) return send(response, { id: ids.order, name: 'SO-54', sum: 50000, state: { id: ids.state }, rate: { currency: { id: ids.currency } }, agent: { id: ids.company, meta: { type: 'counterparty' } }, description: 'from MS' });
  if (pathname === `/api/remap/1.2/entity/customerorder/${ids.order}/positions`) {
    const offset = Number(new URL(request.url ?? '/', base).searchParams.get('offset') ?? 0);
    return send(response, { rows: orderPositions.slice(offset, offset + 100) });
  }
  if (pathname === '/rest/crm.item.list') return send(response, { result: { items: items.filter((item) => item.originatorId === body.filter?.originatorId && item.originId === body.filter?.originId) } });
  if (pathname === '/rest/crm.item.add') {
    dealAdds++;
    const item = { ...body.fields, id: 801 };
    items = [item];
    return send(response, { result: { item } });
  }
  if (pathname === '/rest/crm.item.get') return send(response, { result: { item: items[0] } });
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
  response.writeHead(404); response.end(JSON.stringify({ error: `unexpected ${request.method} ${pathname}` }));
}
function send(response: ServerResponse, body: unknown) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }
