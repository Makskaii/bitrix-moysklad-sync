import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/database.service';
import { EventWorkerLeaseService } from '../src/event-worker-lease.service';
import { InvoiceEventProcessor } from '../src/invoices/invoice-event.processor';
import { InvoiceHttpApi, InvoiceRecord } from '../src/invoices/invoice-http-api';
import { SyncModeService } from '../src/sync-mode.service';
import { ClientLifecycleService } from '../src/clients/client-lifecycle.service';

const suffix = randomUUID();
const orderId = randomUUID();
const dealId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const launchBoundary = new Date('2026-10-15T00:00:00.000Z');
const createdAfterBoundary = '2026-10-16T10:00:00.000Z';
const fieldConfig = { rules: [{ id: 'invoice-title', entity: 'smart-invoices', sourceField: 'title', targetField: 'name',
  bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
  moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }], groups: [] };
let activeFieldConfig = fieldConfig;
let db: DatabaseService;
let server: Server;
let base = '';
let processor: InvoiceEventProcessor;
let oldMode: string | undefined;
let oldBitrixBase: string | undefined;
let oldMoyskladBase: string | undefined;
let oldMoyskladToken: string | undefined;
let oldDatabaseUrl: string | undefined;
let invoiceCounter = 5000;
let failNextInvoiceCreate = false;
let reparentOnNextMoyskladWrite = false;
let moyskladWrites = 0;
const bitrixInvoices = new Map<string, InvoiceRecord>();
const moyskladInvoices = new Map<string, InvoiceRecord>();
const deals = new Map<string, InvoiceRecord>();
const orders = new Map<string, InvoiceRecord>();

before(async () => {
  const connection = new URL(process.env.INVOICE_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '');
  assert.match(connection.hostname, /^(127\.0\.0\.1|localhost)$/i, 'invoice integration tests require local PostgreSQL');
  assert.equal(connection.searchParams.get('schema'), 'issue55_invoices_test', 'refusing to use any schema except the dedicated issue-55 schema');
  assert.equal(process.env.INVOICE_TEST_ISOLATED, '1', 'set INVOICE_TEST_ISOLATED=1 only for the disposable issue-55 schema');
  oldMode = process.env.SYNC_MODE;
  oldBitrixBase = process.env.BITRIX24_REST_BASE_URL;
  oldMoyskladBase = process.env.MOYSKLAD_API_BASE_URL;
  oldMoyskladToken = process.env.MOYSKLAD_API_TOKEN;
  oldDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = connection.href;
  process.env.SYNC_MODE = 'apply';
  db = new DatabaseService();
  await db.$connect();
  await db.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  await db.syncDirectionSetting.upsert({ where: { entityKey: 'invoices' }, create: { entityKey: 'invoices', bitrix24ToMoysklad: true, moyskladToBitrix24: true }, update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } });
  await db.entityPair.create({ data: { id: `invoice-test-deal-${suffix}`, entityType: 'DEAL', bitrix24Id: dealId, moyskladId: orderId, moyskladType: 'customerorder', source: 'MANUAL' } });
  deals.set(dealId, { ID: dealId, DATE_CREATE: createdAfterBoundary });
  orders.set(orderId, { id: orderId, meta: { type: 'customerorder' }, created: createdAfterBoundary });
  server = createServer((request, response) => { void reply(request, response); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}/`;
  process.env.BITRIX24_REST_BASE_URL = new URL('rest/', base).href;
  process.env.MOYSKLAD_API_BASE_URL = new URL('api/remap/1.2/', base).href;
  process.env.MOYSKLAD_API_TOKEN = 'invoice-fake-provider-only';
  const settings = { eventConfig: async () => ({ version: 1, config: activeFieldConfig }) };
  const recovery = { launchBoundary: async () => launchBoundary, assertReady: async () => true };
  processor = new InvoiceEventProcessor(db, new InvoiceHttpApi(), settings as never, new SyncModeService(db), recovery as never, new EventWorkerLeaseService(db), new ClientLifecycleService(db));
});

after(async () => {
  await db.inboundEvent.deleteMany({ where: { deliveryKey: { startsWith: `invoice55-${suffix}-` } } }).catch(() => undefined);
  await db.entityPair.deleteMany({ where: { id: { startsWith: `invoice55-${suffix}-` } } }).catch(() => undefined);
  await db.entityPair.deleteMany({ where: { id: `invoice-test-deal-${suffix}` } }).catch(() => undefined);
  await db.$disconnect();
  restoreEnv('SYNC_MODE', oldMode);
  restoreEnv('BITRIX24_REST_BASE_URL', oldBitrixBase);
  restoreEnv('MOYSKLAD_API_BASE_URL', oldMoyskladBase);
  restoreEnv('MOYSKLAD_API_TOKEN', oldMoyskladToken);
  restoreEnv('DATABASE_URL', oldDatabaseUrl);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('invoice processor creates one independently paired invoiceout, then update replay echoes without another write', async () => {
  const sourceId = String(++invoiceCounter);
  bitrixInvoices.set(sourceId, { id: sourceId, title: 'Invoice Alpha', parentId2: Number(dealId), createdTime: createdAfterBoundary });
  const first = await createEvent(`create-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', sourceId);
  assert.equal((await processor.process(first.id))?.status, 'SUCCEEDED');
  assert.equal(moyskladWrites, 1);
  const pair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'INVOICE', bitrix24Id: sourceId, active: true } });
  assert.equal(pair.moyskladType, 'invoiceout');
  assert.equal(pair.moyskladParentId, orderId);
  const partner = moyskladInvoices.get(pair.moyskladId)!;
  assert.equal(partner.name, 'Invoice Alpha');
  assert.equal((partner.customerOrder as any).meta.href, `${base}api/remap/1.2/entity/customerorder/${orderId}`);

  const replay = await createEvent(`replay-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', sourceId);
  assert.equal((await processor.process(replay.id))?.status, 'SUCCEEDED');
  assert.equal(moyskladWrites, 1, 'a duplicate/update event must not create or echo-write a second invoice');
});

test('invoice worker defers a new linked deal until its exact deal/order pair exists, then resumes', async () => {
  const nextDeal = `${Date.now()}91`;
  const nextOrder = randomUUID();
  deals.set(nextDeal, { ID: nextDeal, DATE_CREATE: createdAfterBoundary });
  orders.set(nextOrder, { id: nextOrder, meta: { type: 'customerorder' }, created: createdAfterBoundary });
  const sourceId = String(++invoiceCounter);
  bitrixInvoices.set(sourceId, { id: sourceId, title: 'Invoice Beta', parentId2: Number(nextDeal), createdTime: createdAfterBoundary });
  const event = await createEvent(`wait-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', sourceId);
  assert.equal((await processor.process(event.id))?.status, 'WAITING_FOR_ORDER');
  assert.equal(await db.entityPair.count({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } }), 0);
  await db.entityPair.create({ data: { id: `invoice55-${suffix}-deal-${nextDeal}`, entityType: 'DEAL', bitrix24Id: nextDeal, moyskladId: nextOrder, moyskladType: 'customerorder', source: 'MANUAL' } });
  assert.equal((await processor.process(event.id))?.status, 'SUCCEEDED');
  assert.equal(await db.entityPair.count({ where: { entityType: 'INVOICE', bitrix24Id: sourceId, moyskladParentId: nextOrder } }), 1);
});

test('MySklad invoiceout creates a linked smart invoice, and multiple invoices on one order stay independent', async () => {
  const firstMsId = randomUUID();
  const secondMsId = randomUUID();
  for (const [msId, title] of [[firstMsId, 'MS invoice one'], [secondMsId, 'MS invoice two']]) {
    moyskladInvoices.set(msId, { id: msId, name: title, created: createdAfterBoundary, meta: { type: 'invoiceout' }, customerOrder: { id: orderId, meta: { type: 'customerorder' } } });
    const event = await createEvent(`ms-create-${msId}`, 'MOYSKLAD', 'CREATE', 'invoiceout', msId);
    assert.equal((await processor.process(event.id))?.status, 'SUCCEEDED');
  }
  const pairs = await db.entityPair.findMany({ where: { entityType: 'INVOICE', moyskladId: { in: [firstMsId, secondMsId] }, active: true } });
  assert.equal(pairs.length, 2);
  assert.notEqual(pairs[0]?.bitrix24Id, pairs[1]?.bitrix24Id);
  for (const pair of pairs) assert.equal(bitrixInvoices.get(pair.bitrix24Id)?.parentId2, Number(dealId));
});

test('invoice field conflicts use the configured MySklad-wins baseline policy and tombstones prevent writes', async () => {
  const sourceId = String(++invoiceCounter);
  bitrixInvoices.set(sourceId, { id: sourceId, title: 'Baseline title', parentId2: Number(dealId), createdTime: createdAfterBoundary });
  const create = await createEvent(`conflict-create-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', sourceId);
  assert.equal((await processor.process(create.id))?.status, 'SUCCEEDED');
  const pair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } });
  const msInvoice = moyskladInvoices.get(pair.moyskladId)!;
  bitrixInvoices.get(sourceId)!.title = 'Bitrix changed';
  msInvoice.name = 'MySklad wins';
  const update = await createEvent(`conflict-update-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', sourceId);
  assert.equal((await processor.process(update.id))?.status, 'SUCCEEDED');
  assert.equal(bitrixInvoices.get(sourceId)?.title, 'MySklad wins');

  const beforeTombstone = moyskladWrites;
  await db.entityPair.update({ where: { id: pair.id }, data: { active: false, lifecycleStatus: 'TOMBSTONED' } });
  const tombstoneEvent = await createEvent(`tombstone-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', sourceId);
  assert.equal((await processor.process(tombstoneEvent.id))?.status, 'MANUAL_REVIEW');
  assert.equal(moyskladWrites, beforeTombstone);
});

test('MySklad invoices with missing/ambiguous order or historical order never create a smart invoice', async () => {
  const before = bitrixInvoices.size;
  const cases: Array<[string, InvoiceRecord]> = [
    [randomUUID(), { customerOrder: null }],
    [randomUUID(), { customerOrder: { id: 'not-an-order' } }],
  ];
  for (const [id, fields] of cases) {
    moyskladInvoices.set(id, { id, created: createdAfterBoundary, meta: { type: 'invoiceout' }, ...fields });
    const event = await createEvent(`ms-no-order-${id}`, 'MOYSKLAD', 'CREATE', 'invoiceout', id);
    assert.equal((await processor.process(event.id))?.status, 'MANUAL_REVIEW');
  }
  const historicalOrder = randomUUID();
  orders.set(historicalOrder, { id: historicalOrder, meta: { type: 'customerorder' }, created: '2026-10-14T00:00:00.000Z' });
  const oldInvoice = randomUUID();
  moyskladInvoices.set(oldInvoice, { id: oldInvoice, created: createdAfterBoundary, meta: { type: 'invoiceout' }, customerOrder: { id: historicalOrder, meta: { type: 'customerorder' } } });
  const event = await createEvent(`ms-old-order-${oldInvoice}`, 'MOYSKLAD', 'CREATE', 'invoiceout', oldInvoice);
  assert.equal((await processor.process(event.id))?.status, 'SKIPPED_PRE_LAUNCH');
  assert.equal(bitrixInvoices.size, before);
});

test('create recovery refuses an existing counterpart linked to a different order and persists no pair', async () => {
  const sourceId = String(++invoiceCounter);
  const wrongOrderId = randomUUID();
  const wrongDealId = `${Date.now()}93`;
  orders.set(wrongOrderId, { id: wrongOrderId, meta: { type: 'customerorder' }, created: createdAfterBoundary });
  deals.set(wrongDealId, { ID: wrongDealId, DATE_CREATE: createdAfterBoundary });
  const existingMsId = randomUUID();
  moyskladInvoices.set(existingMsId, { id: existingMsId, name: 'Already linked elsewhere', externalCode: sourceId, created: createdAfterBoundary,
    meta: { type: 'invoiceout' }, customerOrder: { id: wrongOrderId, meta: { type: 'customerorder' } } });
  bitrixInvoices.set(sourceId, { id: sourceId, title: 'Original invoice', parentId2: Number(dealId), createdTime: createdAfterBoundary });
  const event = await createEvent(`recovery-wrong-order-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', sourceId);
  const beforeWrites = moyskladWrites;
  assert.equal((await processor.process(event.id))?.status, 'MANUAL_REVIEW');
  assert.equal(await db.entityPair.count({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } }), 0);
  assert.equal(moyskladWrites, beforeWrites);
});

test('MySklad create recovery refuses an existing smart invoice linked to a different deal', async () => {
  const sourceId = randomUUID();
  const wrongDealId = `${Date.now()}94`;
  deals.set(wrongDealId, { ID: wrongDealId, DATE_CREATE: createdAfterBoundary });
  const existingB24Id = String(++invoiceCounter);
  bitrixInvoices.set(existingB24Id, { id: existingB24Id, title: 'Linked elsewhere', parentId2: Number(wrongDealId),
    originatorId: 'MOYSKLAD', originId: sourceId, createdTime: createdAfterBoundary });
  moyskladInvoices.set(sourceId, { id: sourceId, name: 'Source invoice', created: createdAfterBoundary, meta: { type: 'invoiceout' },
    customerOrder: { id: orderId, meta: { type: 'customerorder' } } });
  const event = await createEvent(`b24-recovery-wrong-order-${sourceId}`, 'MOYSKLAD', 'CREATE', 'invoiceout', sourceId);
  const beforeWrites = bitrixInvoices.size;
  assert.equal((await processor.process(event.id))?.status, 'MANUAL_REVIEW');
  assert.equal(await db.entityPair.count({ where: { entityType: 'INVOICE', moyskladId: sourceId } }), 0);
  assert.equal(bitrixInvoices.size, beforeWrites);
});

test('relationship mappings are rejected and post-write reads confirm both invoice links remain on the paired order', async () => {
  const sourceId = String(++invoiceCounter);
  bitrixInvoices.set(sourceId, { id: sourceId, title: 'Relationship mapping guard', parentId2: Number(dealId), createdTime: createdAfterBoundary });
  const create = await createEvent(`relationship-create-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', sourceId);
  assert.equal((await processor.process(create.id))?.status, 'SUCCEEDED');
  const pair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } });
  const target = moyskladInvoices.get(pair.moyskladId)!;
  const beforeWrites = moyskladWrites;
  activeFieldConfig = { rules: [...fieldConfig.rules, { id: 'invoice-order-link', entity: 'smart-invoices', sourceField: 'parentId2', targetField: 'customerOrder',
    bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }], groups: [] };
  try {
    bitrixInvoices.get(sourceId)!.title = 'Changed while relationship mapping is configured';
    const event = await createEvent(`relationship-guard-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', sourceId);
    assert.equal((await processor.process(event.id))?.status, 'MANUAL_REVIEW');
    assert.equal(moyskladWrites, beforeWrites);
    assert.equal((target.customerOrder as Record<string, unknown>).id, orderId);
  } finally {
    activeFieldConfig = fieldConfig;
  }

  bitrixInvoices.get(sourceId)!.title = 'Post-write link verification';
  reparentOnNextMoyskladWrite = true;
  const update = await createEvent(`reparent-readback-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', sourceId);
  assert.equal((await processor.process(update.id))?.status, 'MANUAL_REVIEW');
  assert.notEqual((moyskladInvoices.get(pair.moyskladId)!.customerOrder as Record<string, unknown>).id, orderId);
});

test('missing/ambiguous order links and pre-launch invoices are reviewed or skipped without provider writes', async () => {
  const beforeWrites = moyskladWrites;
  const missingId = String(++invoiceCounter);
  bitrixInvoices.set(missingId, { id: missingId, title: 'Missing order', createdTime: createdAfterBoundary });
  const missing = await createEvent(`missing-${missingId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', missingId);
  assert.equal((await processor.process(missing.id))?.status, 'MANUAL_REVIEW');
  assert.equal(moyskladWrites, beforeWrites);

  const ambiguousId = String(++invoiceCounter);
  bitrixInvoices.set(ambiguousId, { id: ambiguousId, title: 'Ambiguous order', parentId2: [Number(dealId)], createdTime: createdAfterBoundary });
  const ambiguous = await createEvent(`ambiguous-${ambiguousId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', ambiguousId);
  assert.equal((await processor.process(ambiguous.id))?.status, 'MANUAL_REVIEW');
  assert.equal(moyskladWrites, beforeWrites);

  const oldId = String(++invoiceCounter);
  bitrixInvoices.set(oldId, { id: oldId, title: 'Historical invoice', parentId2: Number(dealId), createdTime: '2026-10-14T23:59:59.000Z' });
  const old = await createEvent(`old-${oldId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', oldId);
  assert.equal((await processor.process(old.id))?.status, 'SKIPPED_PRE_LAUNCH');
  assert.equal(moyskladWrites, beforeWrites);

  const historicDeal = `${Date.now()}92`;
  const historicOrder = randomUUID();
  deals.set(historicDeal, { ID: historicDeal, DATE_CREATE: '2026-10-14T00:00:00.000Z' });
  orders.set(historicOrder, { id: historicOrder, meta: { type: 'customerorder' }, created: '2026-10-14T00:00:00.000Z' });
  await db.entityPair.create({ data: { id: `invoice55-${suffix}-historic-deal`, entityType: 'DEAL', bitrix24Id: historicDeal, moyskladId: historicOrder, moyskladType: 'customerorder', source: 'MANUAL' } });
  const linkedOldId = String(++invoiceCounter);
  bitrixInvoices.set(linkedOldId, { id: linkedOldId, title: 'Post-launch invoice on historical order', parentId2: Number(historicDeal), createdTime: createdAfterBoundary });
  const linkedOld = await createEvent(`linked-old-${linkedOldId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', linkedOldId);
  assert.equal((await processor.process(linkedOld.id))?.status, 'SKIPPED_PRE_LAUNCH');
  assert.equal(moyskladWrites, beforeWrites);
});

test('invoice creation retries a transient provider failure using the same source identity', async () => {
  const sourceId = String(++invoiceCounter);
  bitrixInvoices.set(sourceId, { id: sourceId, title: 'Invoice Retry', parentId2: Number(dealId), createdTime: createdAfterBoundary });
  const event = await createEvent(`retry-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', sourceId);
  failNextInvoiceCreate = true;
  assert.equal((await processor.process(event.id))?.status, 'RETRYABLE_FAILURE');
  await db.inboundEvent.update({ where: { id: event.id }, data: { retryAfter: new Date(0) } });
  assert.equal((await processor.process(event.id))?.status, 'SUCCEEDED');
  assert.equal(await db.entityPair.count({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } }), 1);
});

async function createEvent(id: string, source: string, eventType: string, externalEntityType: string, externalEntityId: string) {
  return db.inboundEvent.create({ data: {
    source, deliveryKey: `invoice55-${suffix}-${id}`, eventType, externalEntityType, externalEntityId,
    payload: {}, status: 'RECEIVED',
  } });
}

async function reply(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  const url = new URL(request.url ?? '/', base || 'http://127.0.0.1');
  if (url.pathname.startsWith('/rest/')) {
    const form = new URLSearchParams(raw);
    const method = url.pathname.split('/').at(-1);
    if (method === 'crm.item.get.json') {
      const id = form.get('id') ?? '';
      const item = bitrixInvoices.get(id);
      return send(response, item ? { result: { item: { id, ...item } } } : { error: 'NOT_FOUND', error_description: 'Element not found' }, item ? 200 : 400);
    }
    if (method === 'crm.deal.get.json') {
      const id = form.get('id') ?? '';
      const deal = deals.get(id);
      return send(response, deal ? { result: { deal } } : { error: 'NOT_FOUND', error_description: 'Element not found' }, deal ? 200 : 400);
    }
    if (method === 'crm.item.add.json') {
      const id = String(++invoiceCounter);
      const item = { id, title: form.get('fields[title]') ?? '', parentId2: Number(form.get('fields[parentId2]')),
        originatorId: form.get('fields[originatorId]'), originId: form.get('fields[originId]'), createdTime: createdAfterBoundary };
      bitrixInvoices.set(id, item);
      return send(response, { result: { item: { id } } });
    }
    if (method === 'crm.item.list.json') {
      const sourceId = form.get('filter[originId]');
      const items = [...bitrixInvoices.values()].filter((invoice) => invoice.originatorId === 'MOYSKLAD' && invoice.originId === sourceId);
      return send(response, { result: { items } });
    }
    if (method === 'crm.item.update.json') {
      const item = bitrixInvoices.get(form.get('id') ?? '');
      if (item) { const title = form.get('fields[title]'); if (title !== null) item.title = title; }
      return send(response, { result: { item } });
    }
  }
  if (url.pathname.startsWith('/api/remap/1.2/')) {
    if (request.method === 'GET' && url.pathname === '/api/remap/1.2/entity/invoiceout') {
      const externalCode = url.searchParams.get('filter')?.replace(/^externalCode=/, '');
      return send(response, { rows: [...moyskladInvoices.values()].filter((invoice) => invoice.externalCode === externalCode) });
    }
    if (request.method === 'POST' && url.pathname === '/api/remap/1.2/entity/invoiceout') {
      if (failNextInvoiceCreate) { failNextInvoiceCreate = false; return send(response, { errors: [{ error: 'temporary' }] }, 503); }
      moyskladWrites++;
      const body = JSON.parse(raw) as InvoiceRecord;
      const id = randomUUID();
      const invoice = { ...body, id, created: createdAfterBoundary, meta: { type: 'invoiceout' } };
      moyskladInvoices.set(id, invoice);
      return send(response, { id, meta: { type: 'invoiceout' } });
    }
    const invoiceId = url.pathname.match(/^\/api\/remap\/1\.2\/entity\/invoiceout\/([0-9a-f-]{36})$/i)?.[1];
    if (invoiceId && request.method === 'GET') {
      const invoice = moyskladInvoices.get(invoiceId);
      return send(response, invoice ?? { errors: [{ error: 'not found' }] }, invoice ? 200 : 404);
    }
    if (invoiceId && request.method === 'PUT') {
      moyskladWrites++;
      const invoice = moyskladInvoices.get(invoiceId);
      if (invoice) Object.assign(invoice, JSON.parse(raw));
      if (invoice && reparentOnNextMoyskladWrite) {
        reparentOnNextMoyskladWrite = false;
        invoice.customerOrder = { id: randomUUID(), meta: { type: 'customerorder' } };
      }
      return send(response, invoice ?? {}, invoice ? 200 : 404);
    }
    const order = url.pathname.match(/^\/api\/remap\/1\.2\/entity\/customerorder\/([0-9a-f-]{36})$/i)?.[1];
    if (order && request.method === 'GET') return send(response, orders.get(order) ?? { id: order, meta: { type: 'customerorder' }, created: createdAfterBoundary });
  }
  return send(response, { error: 'NOT_FOUND', path: url.pathname }, 404);
}

function send(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
