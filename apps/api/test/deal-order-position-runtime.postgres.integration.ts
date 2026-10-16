import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../src/database.service';
import { DealOrderPositionRuntimeService } from '../src/deals-orders/deal-order-position-runtime.service';
import { SyncModeService } from '../src/sync-mode.service';

process.env.SYNC_MODE ??= 'apply';
const db = new PrismaClient();
const database = new DatabaseService();
const productId = '33333333-3333-4333-8333-333333333333';
const unitId = '66666666-6666-4666-8666-666666666666';
let server: Server;
let base = '';
let productPairId = '';
let runtime: DealOrderPositionRuntimeService;
let activeOrderId = '';
let vatIncluded = false;
let b24Rows: Record<string, unknown>[] = [];
let msRows: Record<string, unknown>[] = [];
let calls: Array<{ method: string; path: string }> = [];
let positionAdds = 0;
let failPositionReadId: string | null = null;
let pauseAfterNextMsPositionUpdate = false;

before(async () => {
  const target = new URL(process.env.DATABASE_URL ?? '');
  assert.match(target.hostname, /^(127\.0\.0\.1|localhost)$/i);
  assert.match(target.pathname, /test/i);
  assert.equal(process.env.DEAL_ORDER_POSITION_TEST_ISOLATED, '1');
  await db.$connect();
  await db.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  await db.syncDirectionSetting.upsert({ where: { entityKey: 'deals-orders' }, create: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: true }, update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } });
  productPairId = (await db.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: '904', moyskladId: productId, source: 'MANUAL' } })).id;
  server = createServer((request, response) => { void reply(request, response); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}/`;
  process.env.BITRIX24_REST_BASE_URL = `${base}rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${base}api/remap/1.2/`;
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-only';
  runtime = new DealOrderPositionRuntimeService(database, new SyncModeService(database));
});

after(async () => {
  await db.entityPair.deleteMany({ where: { entityType: 'DEAL', bitrix24Id: { startsWith: '98' } } });
  await db.entityPair.deleteMany({ where: { id: productPairId } });
  await db.$disconnect(); await database.$disconnect();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('quantity, discount, and price updates use exact row/position IDs in both directions and pre-read+read back', async () => {
  const one = await seed('98101');
  calls = [];
  b24Rows[0] = { ...b24Rows[0], quantity: 3, price: 9, priceNetto: 10, discountTypeId: 2, discountRate: 10, discountSum: 1 };
  const result = await runtime.process({ pair: confirmed(one.pair), eventId: 'event-row-update-b24', eventConfig: config() });
  assert.deepEqual(result, { status: 'SYNCED', rowValuesChanged: true });
  assert.equal(msRows[0].quantity, 3); assert.equal(msRows[0].price, 1000); assert.equal(msRows[0].discount, 10);
  assert.ok(calls.some((call) => call.method === 'PUT' && call.path.endsWith(`/positions/${one.positionId}`)));
  assert.equal(calls.some((call) => /productrows\.set/.test(call.path)), false);

  await db.dealOrderPositionPair.update({ where: { pairId_bitrix24ProductRowId: { pairId: one.pair.id, bitrix24ProductRowId: '301' } }, data: { bitrix24Values: sourceValues(b24Rows[0]), moyskladValues: targetValues(msRows[0]) } });
  msRows[0] = { ...msRows[0], quantity: 4, price: 900, discount: 20 };
  calls = [];
  const reverse = await runtime.process({ pair: confirmed(one.pair), eventId: 'event-row-update-ms', eventConfig: config() });
  assert.deepEqual(reverse, { status: 'SYNCED', rowValuesChanged: true });
  assert.equal(b24Rows[0].quantity, 4); assert.equal(b24Rows[0].price, 7.2); assert.equal(b24Rows[0].discountRate, 20);
  assert.ok(calls.some((call) => call.path.endsWith('/crm.item.productrow.update')));
  assert.equal(calls.some((call) => /productrows\.set/.test(call.path)), false);
});

test('addressed row updates preserve explicitly excluded VAT and only use the current MS order VAT mode', async () => {
  const one = await seed('98106');
  vatIncluded = false;
  b24Rows[0] = { ...b24Rows[0], quantity: 2, price: 10, priceNetto: 10, taxRate: 20, taxIncluded: 'N' };
  calls = [];
  const result = await runtime.process({ pair: confirmed(one.pair), eventId: 'event-row-update-vat-excluded', eventConfig: config() });
  assert.deepEqual(result, { status: 'SYNCED', rowValuesChanged: true });
  assert.equal(msRows[0].price, 1000);
  assert.equal(msRows[0].vatEnabled, true);
  assert.equal(msRows[0].vat, 20);
  assert.ok(calls.some((call) => call.method === 'GET' && call.path.endsWith(`/entity/customerorder/${one.pair.moyskladId}`)));
});

test('unsupported linked row is durably skipped while other valid rows update without deleting either partner row', async () => {
  const one = await seed('98107');
  const badPositionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const badSource = { id: '399', productId: 904, measureCode: 999, quantity: 4, price: 5, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: null };
  const badTarget = msPosition(badPositionId, 4, 500);
  b24Rows = [{ ...b24Rows[0]!, quantity: 3 }, badSource];
  msRows = [{ ...msRows[0]! }, badTarget];
  await db.dealOrderPositionPair.create({ data: { pairId: one.pair.id, bitrix24ProductRowId: '399', moyskladPositionId: badPositionId,
    bitrix24Values: sourceValues(badSource), moyskladValues: targetValues(badTarget) } });
  calls = [];
  const eventId = 'event-row-partial-skip';
  const result = await runtime.process({ pair: confirmed(one.pair), eventId, eventConfig: config() });
  assert.equal(result.status, 'PARTIAL');
  if (result.status !== 'PARTIAL') return;
  assert.deepEqual(result.skippedRows, [{ sourceSystem: 'BITRIX24', sourceRowId: '399', reason: 'DEAL_ORDER_POSITION_DEPENDENCY_CHANGED' }]);
  assert.equal(msRows[0]!.quantity, 3, 'valid row still reconciles');
  assert.equal(b24Rows.length, 2); assert.equal(msRows.length, 2, 'unsupported row is not deleted from either side');
  const badLink = await db.dealOrderPositionPair.findUniqueOrThrow({ where: { pairId_bitrix24ProductRowId: { pairId: one.pair.id, bitrix24ProductRowId: '399' } } });
  assert.deepEqual(badLink.bitrix24Values, JSON.parse(JSON.stringify(sourceValues(badSource))), 'bad row baseline is not advanced');
  const journal = await db.operationalLog.findMany({ where: { referenceId: eventId } });
  assert.ok(journal.some((entry) => entry.message.includes('DEAL_ORDER_POSITION_ROW_SKIPPED') && entry.message.includes('"sourceRowId":"399"') && entry.message.includes('"settingsVersion":2')));
  assert.equal(calls.some((call) => call.method === 'DELETE' || /productrow\.delete/.test(call.path)), false);
});

test('persisted pause between addressed row writes blocks the next mutation and never reports success', async () => {
  const one = await seed('98108');
  const secondId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const secondSource = { id: '398', productId: 904, measureCode: 796, quantity: 2, price: 5, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: null };
  const secondTarget = msPosition(secondId, 2, 500);
  b24Rows = [{ ...b24Rows[0]!, quantity: 3 }, { ...secondSource, quantity: 3 }];
  msRows = [{ ...msRows[0]! }, secondTarget];
  await db.dealOrderPositionPair.create({ data: { pairId: one.pair.id, bitrix24ProductRowId: '398', moyskladPositionId: secondId,
    bitrix24Values: sourceValues(secondSource), moyskladValues: targetValues(secondTarget) } });
  pauseAfterNextMsPositionUpdate = true;
  calls = [];
  const result = await runtime.process({ pair: confirmed(one.pair), eventId: 'event-pause-between-row-writes', eventConfig: config() });
  assert.deepEqual(result, { status: 'RETRY', reason: 'DEAL_ORDER_WRITE_BLOCKED_PAUSE' });
  assert.equal((await db.syncSetting.findUniqueOrThrow({ where: { id: 'global' } })).serviceMode, 'pause');
  assert.equal(calls.filter((call) => call.method === 'PUT' && call.path.includes('/positions/')).length, 1, 'second provider mutation was blocked by a fresh DB mode read');
  assert.equal(msRows[0]!.quantity, 3, 'the first accepted write remains for idempotent resume');
  assert.equal(msRows[1]!.quantity, 2, 'the next row was not changed');
  await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
});

test('deletions remove only the linked address on either provider, never replace a full row list', async () => {
  const one = await seed('98102');
  calls = []; msRows = [];
  const deleteB24 = await runtime.process({ pair: confirmed(one.pair), eventId: 'event-delete-b24-row', eventConfig: config() });
  assert.deepEqual(deleteB24, { status: 'SYNCED', rowValuesChanged: true }, JSON.stringify(calls));
  assert.equal(b24Rows.length, 0);
  assert.ok(calls.some((call) => call.path.endsWith('/crm.item.productrow.delete')));
  assert.equal(calls.some((call) => /productrows\.set/.test(call.path)), false);

  const two = await seed('98103');
  calls = []; b24Rows = [];
  const deleteMs = await runtime.process({ pair: confirmed(two.pair), eventId: 'event-delete-ms-row', eventConfig: config() });
  assert.deepEqual(deleteMs, { status: 'SYNCED', rowValuesChanged: true }, JSON.stringify(calls));
  assert.equal(msRows.length, 0);
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.path.endsWith(`/positions/${two.positionId}`)));
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.path.endsWith('/positions')), false);
});

test('all Bitrix24 and MySklad pages are read before addressed reconciliation', async () => {
  const orderId = '98104';
  const pair = await db.entityPair.create({ data: { entityType: 'DEAL', bitrix24Id: '98104', moyskladId: orderId, source: 'MANUAL' } });
  const source: Record<string, unknown>[] = [];
  const target: Record<string, unknown>[] = [];
  const links: Array<{ pairId: string; bitrix24ProductRowId: string; moyskladPositionId: string; bitrix24Values: any; moyskladValues: any }> = [];
  for (let i = 0; i < 51; i++) {
    const b24Id = String(4000 + i); const msId = `${String(i + 1).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    const row = { id: b24Id, productId: 904, measureCode: 796, quantity: i + 1, price: 5, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: null };
    const position = msPosition(msId, i + 1, 500);
    source.push(row); target.push(position);
    links.push({ pairId: pair.id, bitrix24ProductRowId: b24Id, moyskladPositionId: msId, bitrix24Values: sourceValues(row), moyskladValues: targetValues(position) });
  }
  await db.dealOrderPositionPair.createMany({ data: links });
  b24Rows = source; msRows = target; b24Rows[50] = { ...b24Rows[50], quantity: 77 };
  calls = [];
  const result = await runtime.process({ pair: confirmed(pair), eventId: 'event-paged-reads', eventConfig: config() });
  assert.deepEqual(result, { status: 'SYNCED', rowValuesChanged: true });
  assert.ok(calls.some((call) => call.path.includes('start=50')));
  assert.ok(calls.some((call) => call.path.includes('offset=50')));
  assert.equal(msRows[50].quantity, 77);
});

test('new MySklad position ID is journaled before readback and retry resumes without a duplicate POST', async () => {
  const one = await seed('98105');
  const addedRow = { id: '302', productId: 904, measureCode: 796, quantity: 4, price: 0, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: null };
  b24Rows = [b24Rows[0], addedRow];
  positionAdds = 0;
  calls = [];
  const oldFetchRows = msRows.length;
  const first = await runtime.process({ pair: confirmed(one.pair), eventId: 'event-row-add-1', eventConfig: config() });
  assert.deepEqual(first, { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_ADD_OUTCOME_UNKNOWN' });
  const operation = await db.dealOrderPositionAddOperation.findUniqueOrThrow({ where: { pairId_bitrix24ProductRowId: { pairId: one.pair.id, bitrix24ProductRowId: '302' } } });
  assert.ok(operation.moyskladPositionId, 'provider row ID is persisted before readback');
  assert.equal(operation.status, 'PENDING');
  const second = await runtime.process({ pair: confirmed(one.pair), eventId: 'event-row-add-2', eventConfig: config() });
  assert.deepEqual(second, { status: 'SYNCED', rowValuesChanged: true });
  assert.equal(positionAdds, 1);
  assert.equal(msRows.length, oldFetchRows + 1);
  const saved = await db.dealOrderPositionPair.findUniqueOrThrow({ where: { pairId_bitrix24ProductRowId: { pairId: one.pair.id, bitrix24ProductRowId: '302' } } });
  assert.equal(saved.moyskladPositionId, operation.moyskladPositionId);
  assert.equal((await db.dealOrderPositionAddOperation.findUniqueOrThrow({ where: { id: operation.id } })).status, 'SUCCEEDED');
});

async function seed(dealId: string) {
  await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  const orderId = randomUUID();
  activeOrderId = orderId;
  const pair = await db.entityPair.create({ data: { entityType: 'DEAL', bitrix24Id: dealId, moyskladId: orderId, source: 'MANUAL' } });
  b24Rows = [{ id: '301', productId: 904, measureCode: 796, quantity: 2, price: 5, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: null }];
  const positionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  msRows = [msPosition(positionId, 2, 500)];
  await db.dealOrderPositionPair.create({ data: { pairId: pair.id, bitrix24ProductRowId: '301', moyskladPositionId: positionId, bitrix24Values: sourceValues(b24Rows[0]), moyskladValues: targetValues(msRows[0]) } });
  return { pair, positionId };
}
function config(): any { return { version: 2, createdAt: new Date(0).toISOString(), config: { schemaVersion: 1, rules: [], groups: [], references: { units: [{ bitrix24Id: 796, bitrix24Code: '796', moyskladId: unitId, moyskladCode: '796', status: 'configured' }], priceTypes: [], dictionaries: [] } }, references: { units: [], priceTypes: [], dictionaries: [] } }; }
function msPosition(id: string, quantity: number, price: number) { return { id, assortment: { meta: { type: 'product', href: `${base}api/remap/1.2/entity/product/${productId}` } }, quantity, price, discount: 0, vat: 0, vatEnabled: false }; }
function confirmed(pair: any): any { return { id: pair.id, entityType: 'DEAL', bitrix24Id: pair.bitrix24Id, moyskladId: pair.moyskladId, status: 'CONFIRMED', source: 'PERSISTED' }; }
function sourceValues(row: Record<string, unknown>): any { return { productId: String(row.productId), measureCode: row.measureCode, quantity: row.quantity, price: row.price, priceNetto: row.priceNetto, discountTypeId: row.discountTypeId, discountRate: row.discountRate, discountSum: row.discountSum, taxRate: row.taxRate, taxIncluded: row.taxIncluded }; }
function targetValues(row: Record<string, unknown>): any { return { assortment: row.assortment, quantity: row.quantity, price: row.price, discount: row.discount, vat: row.vat, vatEnabled: row.vatEnabled }; }

async function reply(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8'); const params = new URLSearchParams(text); const url = new URL(request.url ?? '/', base);
  calls.push({ method: request.method ?? 'GET', path: `${url.pathname}${url.search}` });
  if (url.pathname === '/rest/crm.item.productrow.list') {
    const start = Number(params.get('start') ?? url.searchParams.get('start') ?? 0);
    return send(response, { result: { productRows: b24Rows.slice(start, start + 50) }, total: b24Rows.length });
  }
  if (url.pathname === '/rest/crm.item.productrow.update') {
    const payload = JSON.parse(text) as { id: string; fields: Record<string, unknown> };
    const row = b24Rows.find((entry) => String(entry.id) === payload.id);
    if (row) Object.assign(row, payload.fields);
    return send(response, { result: { productRow: row } });
  }
  if (url.pathname === '/rest/crm.item.productrow.delete') {
    b24Rows = b24Rows.filter((entry) => String(entry.id) !== params.get('id'));
    return send(response, { result: true });
  }
  if (url.pathname === `/api/remap/1.2/entity/customerorder/${activeOrderId}` && request.method === 'GET') return send(response, { id: activeOrderId, vatIncluded });
  if (url.pathname === '/api/remap/1.2/entity/product/' + productId) return send(response, { id: productId, meta: { type: 'product' }, uom: { id: unitId } });
  if (/\/positions\/[^/]+$/.test(url.pathname) && url.pathname.includes('/entity/customerorder/')) {
    const id = url.pathname.split('/').at(-1)!; const row = msRows.find((entry) => entry.id === id);
    if (request.method === 'GET' && failPositionReadId === id) { failPositionReadId = null; response.writeHead(500); response.end('{}'); return; }
    if (request.method === 'PUT' && row) { const update = JSON.parse(text); Object.assign(row, update); if (pauseAfterNextMsPositionUpdate) { pauseAfterNextMsPositionUpdate = false; await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'pause' } }); } }
    if (request.method === 'DELETE') { msRows = msRows.filter((entry) => entry.id !== id); return send(response, {}); }
    const current = msRows.find((entry) => entry.id === id);
    return current ? send(response, current) : send(response, {}, 404);
  }
  if (url.pathname.endsWith('/positions') && request.method === 'POST') {
    positionAdds++;
    const payload = JSON.parse(text) as Record<string, unknown>;
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const created = { ...payload, id };
    msRows.push(created);
    failPositionReadId = id;
    return send(response, { id, meta: { type: 'customerorderposition' } });
  }
  if (url.pathname.endsWith('/positions')) {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return send(response, { rows: msRows.slice(offset, offset + 50), meta: { size: msRows.length, ...(offset + 50 < msRows.length ? { nextHref: `${base}api/remap/1.2/entity/customerorder/98104/positions?offset=${offset + 50}` } : {}) } });
  }
  response.writeHead(404); response.end('{}');
}
function send(response: ServerResponse, value: unknown, status = 200) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }
