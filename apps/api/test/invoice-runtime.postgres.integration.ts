import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../src/database.service';
import { EventWorkerLeaseService } from '../src/event-worker-lease.service';
import { InvoiceEventProcessor } from '../src/invoices/invoice-event.processor';
import { InvoiceHttpApi, InvoiceRecord } from '../src/invoices/invoice-http-api';
import { SyncModeService } from '../src/sync-mode.service';
import { ClientLifecycleService } from '../src/clients/client-lifecycle.service';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { ControlledLiveTestAdmissionService } from '../src/controlled-live-test-admission.service';
import { installControlledLiveFetchGuard, setControlledLiveTestWriteCheck } from '../src/external-write-guard';
import { setVerifiedControlledLiveProviderNamespace } from '../src/controlled-live-test-namespace';
import { LocalAdminPreviewModule } from '../src/admin/local-preview.module';
import { EventDispatcherService } from '../src/event-dispatcher.service';

const suffix = randomUUID();
const orderId = randomUUID();
const dealId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const launchBoundary = new Date('2026-10-15T00:00:00.000Z');
const createdAfterBoundary = '2026-10-16T10:00:00.000Z';
const fieldConfig = { rules: [{ id: 'invoice-title', entity: 'smart-invoices', sourceField: 'title', targetField: 'name',
  bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
  moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }], groups: [] };
let activeFieldConfig = fieldConfig;
let activeSettingsVersion = 1;
const testSettingsHistory = new Map<number, typeof fieldConfig>([[1, fieldConfig]]);
const testEventSettings = new Map<string, { version: number; config: typeof fieldConfig }>();
let db: DatabaseService;
let server: Server;
let base = '';
let processor: InvoiceEventProcessor;
let settingsAdapter: { eventConfig: (eventId: string) => Promise<unknown>; version: (version: number) => Promise<unknown>; transformFieldResult: typeof FieldSettingsService.prototype.transformFieldResult };
let oldMode: string | undefined;
let oldBitrixBase: string | undefined;
let oldMoyskladBase: string | undefined;
let oldMoyskladToken: string | undefined;
let oldDatabaseUrl: string | undefined;
let invoiceCounter = 5000;
let failNextInvoiceCreate = false;
let failNextMoyskladUpdate = false;
let failNextBitrixUpdateField: string | null = null;
let reparentOnNextMoyskladWrite = false;
let failPositionReadAfterWrite = false;
let failNextPositionRead = false;
let moyskladWrites = 0;
let processorStarted = false;
const bitrixInvoices = new Map<string, InvoiceRecord>();
const moyskladInvoices = new Map<string, InvoiceRecord>();
const deals = new Map<string, InvoiceRecord>();
const orders = new Map<string, InvoiceRecord>();
const invoiceRows = new Map<string, InvoiceRecord[]>();

before(async () => {
  const connection = new URL(process.env.INVOICE_TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '');
  assert.match(connection.hostname, /^(127\.0\.0\.1|localhost)$/i, 'invoice integration tests require local PostgreSQL');
  const testSchema = process.env.INVOICE_TEST_SCHEMA ?? 'issue55_invoices_test';
  assert.match(testSchema, /^issue55_[a-z0-9_]*_test$/i, 'invoice integration tests require a dedicated issue-55 test schema');
  assert.equal(connection.searchParams.get('schema'), testSchema, 'refusing to use any schema except the explicitly selected issue-55 test schema');
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
  settingsAdapter = {
    eventConfig: async (eventId) => testEventSettings.get(eventId) ?? ({ version: activeSettingsVersion, config: activeFieldConfig }),
    version: async (version) => ({ version, config: testSettingsHistory.get(version) }),
    transformFieldResult: FieldSettingsService.prototype.transformFieldResult,
  };
  const recovery = { launchBoundary: async () => launchBoundary, assertReady: async () => true };
  processor = new InvoiceEventProcessor(db, new InvoiceHttpApi(), settingsAdapter as never, new SyncModeService(db), recovery as never, new EventWorkerLeaseService(db), new ClientLifecycleService(db));
});

after(async () => {
  if (processorStarted) await processor.onModuleDestroy();
  await db.inboundEvent.deleteMany({ where: { deliveryKey: { startsWith: `invoice55-${suffix}-` } } }).catch(() => undefined);
  await db.pairReviewCase.deleteMany({ where: { id: { startsWith: `invoice55-${suffix}-` } } }).catch(() => undefined);
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

test('database constraints accept invoice pairs and review cases while preserving the allowlist', async () => {
  await db.entityPair.create({ data: {
    id: `invoice55-${suffix}-constraint-pair`, entityType: 'INVOICE', bitrix24Id: '510001', moyskladId: randomUUID(),
    moyskladType: 'invoiceout', moyskladParentId: orderId, source: 'AUTOMATIC',
  } });
  await db.pairReviewCase.create({ data: {
    id: `invoice55-${suffix}-constraint-review`, entityType: 'INVOICE', sourceSystem: 'BITRIX24',
    sourceEntityId: '510001', reason: 'INVOICE_TEST_REVIEW',
  } });
  await assert.rejects(db.entityPair.create({ data: {
    id: `invoice55-${suffix}-invalid-pair`, entityType: 'UNSUPPORTED', bitrix24Id: '510002', moyskladId: randomUUID(), source: 'MANUAL',
  } }));
  await assert.rejects(db.pairReviewCase.create({ data: {
    id: `invoice55-${suffix}-invalid-review`, entityType: 'UNSUPPORTED', sourceSystem: 'BITRIX24',
    sourceEntityId: '510002', reason: 'INVOICE_TEST_REVIEW',
  } }));
});

test('admin HTTP V1→V2 invoice settings save is applied by the inbound webhook processor', async () => {
  const savedEnv = Object.fromEntries(['ADMIN_PREVIEW', 'BITRIX24_EVENT_APPLICATION_TOKEN'].map((key) => [key, process.env[key]]));
  const sourceId = String(++invoiceCounter);
  const boundary = new Date(launchBoundary);
  let app: INestApplication | undefined;
  try {
    process.env.ADMIN_PREVIEW = '1';
    process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-invoice-http-token';
    await db.databaseRecoveryState.upsert({ where: { id: 'global' }, create: { id: 'global', status: 'READY', previousLaunchBoundary: boundary, pairsRestored: true, lostEventsAcknowledged: true, acknowledgedAt: new Date(), acknowledgement: 'isolated issue79 HTTP fixture confirmation' }, update: { status: 'READY', previousLaunchBoundary: boundary, pairsRestored: true, lostEventsAcknowledged: true, acknowledgedAt: new Date(), acknowledgement: 'isolated issue79 HTTP fixture confirmation' } });
    await db.databaseRecoveryAudit.create({ data: { id: randomUUID(), action: 'DATABASE_LOSS_RECOVERY_CONFIRMED', actorType: 'VERIFIED_BITRIX24_ADMIN', actorId: 'BITRIX24_USER:42', oldBoundaryAt: null, boundaryAt: boundary, pairsRestored: true, lostEventsAcknowledged: true, acknowledgement: 'isolated issue79 HTTP fixture confirmation', recoveryStateId: 'global' } });
    app = await NestFactory.create(LocalAdminPreviewModule.register(), { logger: false });
    await app.listen(0, '127.0.0.1');
    const api = await app.getUrl();
    const saveUrl = `${api}/api/admin/field-settings`;
    const headers = { 'content-type': 'application/json' };
    const activeResponse = await fetch(saveUrl);
    assert.equal(activeResponse.status, 200);
    const active = await activeResponse.json() as { config: { references: unknown } };
    const v1 = { rules: [{ id: 'http-invoice-title', entity: 'smart-invoices', sourceField: 'title', targetField: 'name', bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } }, moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }], groups: [], references: active.config.references };
    const saveV1 = await fetch(saveUrl, { method: 'PUT', headers, body: JSON.stringify({ config: v1 }) });
    assert.equal(saveV1.status, 200);
    const v1Saved = await saveV1.json() as { version: number };
    assert.equal(v1Saved.version, 2);
    bitrixInvoices.set(sourceId, { id: sourceId, title: 'HTTP V1 invoice', parentId2: Number(dealId), createdTime: createdAfterBoundary });
    const webhook = (event: string) => fetch(`${api}/webhooks/bitrix24`, { method: 'POST', headers, body: JSON.stringify({ event, data: { FIELDS: { ID: sourceId, ENTITY_TYPE_ID: 31 } }, auth: { application_token: 'synthetic-invoice-http-token' } }) });
    const createResponse = await webhook('ONCRMDYNAMICITEMADD');
    assert.ok(createResponse.status === 200 || createResponse.status === 201);
    const createAck = await createResponse.json() as { eventId: string };
    await app.get(EventDispatcherService).dispatch(createAck.eventId);
    await waitForEventStatus(createAck.eventId, 'SUCCEEDED');
    assert.equal((await db.inboundEventSettings.findUniqueOrThrow({ where: { eventId: createAck.eventId } })).settingsVersion, v1Saved.version);
    const pair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'INVOICE', bitrix24Id: sourceId, active: true } });
    const savedV2 = { ...v1, rules: [...v1.rules, { id: 'http-invoice-code', entity: 'smart-invoices', sourceField: 'code', targetField: 'code', bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } }, moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }] };
    const saveV2 = await fetch(saveUrl, { method: 'PUT', headers, body: JSON.stringify({ config: savedV2 }) });
    assert.equal(saveV2.status, 200);
    const v2Version = (await saveV2.json() as { version: number }).version;
    assert.equal(v2Version, v1Saved.version + 1);
    const target = moyskladInvoices.get(pair.moyskladId)!;
    target.code = 'HTTP-V2-CODE';
    const updateResponse = await webhook('ONCRMDYNAMICITEMUPDATE');
    assert.ok(updateResponse.status === 200 || updateResponse.status === 201);
    const updateAck = await updateResponse.json() as { eventId: string };
    await app.get(EventDispatcherService).dispatch(updateAck.eventId);
    const completed = await waitForEventStatus(updateAck.eventId, 'SUCCEEDED');
    assert.equal(completed.status, 'SUCCEEDED');
    assert.equal((await db.inboundEventSettings.findUniqueOrThrow({ where: { eventId: updateAck.eventId } })).settingsVersion, v2Version);
    assert.equal(bitrixInvoices.get(sourceId)?.code, 'HTTP-V2-CODE');
    const revision = await db.entityPairSettingsRevision.findUniqueOrThrow({ where: { pairId_toSettingsVersion: { pairId: pair.id, toSettingsVersion: v2Version } } });
    assert.equal(revision.status, 'COMPLETE');
    assert.equal((await db.entityPairBaseline.findUniqueOrThrow({ where: { pairId: pair.id } })).settingsVersion, v2Version);
  } finally {
    if (app) { (app.getHttpServer() as Server).closeAllConnections(); await app.close(); }
    // Recovery audit rows are intentionally immutable; this test uses a disposable isolated database.
    await db.entityPair.deleteMany({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } });
    bitrixInvoices.delete(sourceId);
    for (const [id, invoice] of moyskladInvoices) if (invoice.externalCode === sourceId) moyskladInvoices.delete(id);
    moyskladWrites = 0;
    restoreEnv('ADMIN_PREVIEW', savedEnv.ADMIN_PREVIEW);
    restoreEnv('BITRIX24_EVENT_APPLICATION_TOKEN', savedEnv.BITRIX24_EVENT_APPLICATION_TOKEN);
  }
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

test('invoice goods create/update/add/recovery keep native row IDs and stop unsafe total, deletion, or target conflicts', async () => {
  const sourceId = String(++invoiceCounter);
  const productId = `55${Date.now()}`;
  const targetId = 'd813b5d2-5939-11ee-0a80-1143000e2d5c';
  const secondProductId = `56${Date.now()}`;
  await db.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: productId, moyskladId: targetId, moyskladType: 'product', source: 'MANUAL' } });
  bitrixInvoices.set(sourceId, { id: sourceId, title: 'Invoice own goods', parentId2: Number(dealId), createdTime: createdAfterBoundary, opportunity: 342, currencyId: 'RUB' });
  invoiceRows.set(sourceId, [{ id: 321, ownerType: 'SI', ownerId: Number(sourceId), productId: Number(productId), quantity: 2, price: 171,
    priceNetto: 140.16393443, priceBrutto: 171, taxRate: 22, taxIncluded: 'Y', discountTypeId: 2, discountRate: 0, discountSum: 0 }]);
  try {
    const event = await createEvent(`own-goods-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', sourceId);
    assert.equal((await processor.process(event.id))?.status, 'SUCCEEDED');
    const pair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } });
    const target = moyskladInvoices.get(pair.moyskladId)!;
    assert.deepEqual((target.positions as InvoiceRecord[]).map(({id,...value})=>value), [{ quantity: 2, price: 17100, discount: 0, vat: 22, assortment: { meta: {
      href: `${base}api/remap/1.2/entity/product/${targetId}`, type: 'product', mediaType: 'application/json' } } }]);
    assert.equal(target.vatIncluded, true);
    assert.equal((target.organization as any).meta.type, 'organization');
    assert.equal((target.agent as any).meta.type, 'counterparty');
    const originalRowId=(target.positions as InvoiceRecord[])[0]!.id;
    const sourceRow=invoiceRows.get(sourceId)![0]!;
    Object.assign(sourceRow,{quantity:3,price:150,priceBrutto:150,priceNetto:122.95081967});
    bitrixInvoices.get(sourceId)!.opportunity=450;
    let writes=moyskladWrites;
    const update=await createEvent(`goods-update-${sourceId}`,'BITRIX24','ONCRMDYNAMICITEMUPDATE','invoice',sourceId);
    assert.equal((await processor.process(update.id))?.status,'SUCCEEDED');
    assert.equal(moyskladWrites,writes+1);
    assert.equal((target.positions as InvoiceRecord[])[0]!.id,originalRowId);
    assert.equal((target.positions as InvoiceRecord[])[0]!.price,15000);
    assert.equal(invoiceSum(target),45000);
    const secondTargetId=randomUUID();
    await db.entityPair.create({data:{entityType:'PRODUCT',bitrix24Id:secondProductId,moyskladId:secondTargetId,moyskladType:'product',source:'MANUAL'}});
    invoiceRows.get(sourceId)!.push({...sourceRow,id:322,productId:Number(secondProductId),quantity:1,price:80,priceBrutto:80,priceNetto:65.57377049});
    bitrixInvoices.get(sourceId)!.opportunity=530;
    const add=await createEvent(`goods-add-${sourceId}`,'BITRIX24','ONCRMDYNAMICITEMUPDATE','invoice',sourceId);
    assert.equal((await processor.process(add.id))?.status,'SUCCEEDED');
    assert.equal((target.positions as InvoiceRecord[]).length,2);
    assert.equal((target.positions as InvoiceRecord[])[0]!.id,originalRowId);
    writes=moyskladWrites;
    const repeat=await createEvent(`goods-repeat-${sourceId}`,'BITRIX24','ONCRMDYNAMICITEMUPDATE','invoice',sourceId);
    assert.equal((await processor.process(repeat.id))?.status,'SUCCEEDED');
    assert.equal(moyskladWrites,writes);
    Object.assign(sourceRow,{quantity:4});bitrixInvoices.get(sourceId)!.opportunity=680;
    failPositionReadAfterWrite=true;
    const recover=await createEvent(`goods-readback-retry-${sourceId}`,'BITRIX24','ONCRMDYNAMICITEMUPDATE','invoice',sourceId);
    assert.equal((await processor.process(recover.id))?.status,'RETRYABLE_FAILURE');
    writes=moyskladWrites;
    await db.inboundEvent.update({where:{id:recover.id},data:{retryAfter:new Date(Date.now()-1)}});
    assert.equal((await processor.process(recover.id))?.status,'SUCCEEDED');
    assert.equal(moyskladWrites,writes,'provider success before failed readback must not issue a duplicate row write');
    assert.equal((target.positions as InvoiceRecord[])[0]!.id,originalRowId);
    const secondRow=invoiceRows.get(sourceId)!.pop()!;bitrixInvoices.get(sourceId)!.opportunity=600;
    const removed=await createEvent(`goods-removed-${sourceId}`,'BITRIX24','ONCRMDYNAMICITEMUPDATE','invoice',sourceId);
    assert.equal((await processor.process(removed.id))?.status,'MANUAL_REVIEW');
    assert.equal((await db.inboundEvent.findUniqueOrThrow({where:{id:removed.id}})).lastErrorCategory,'INVOICE_GOODS_SOURCE_ROW_REMOVED');
    assert.equal((target.positions as InvoiceRecord[]).length,2);
    assert.equal(moyskladWrites,writes);
    invoiceRows.get(sourceId)!.push(secondRow);bitrixInvoices.get(sourceId)!.opportunity=680;
    (target.positions as InvoiceRecord[])[0]!.price=15100;
    const conflict=await createEvent(`goods-ms-change-${sourceId}`,'BITRIX24','ONCRMDYNAMICITEMUPDATE','invoice',sourceId);
    assert.equal((await processor.process(conflict.id))?.status,'MANUAL_REVIEW');
    assert.equal((await db.inboundEvent.findUniqueOrThrow({where:{id:conflict.id}})).lastErrorCategory,'INVOICE_GOODS_TARGET_CHANGED');
    assert.equal(moyskladWrites,writes);
    const mismatchedId = String(++invoiceCounter);
    bitrixInvoices.set(mismatchedId, { ...bitrixInvoices.get(sourceId), id: mismatchedId, opportunity: 999 });
    invoiceRows.set(mismatchedId, invoiceRows.get(sourceId)!.map((row) => ({ ...row, ownerId: Number(mismatchedId) })));
    const beforeWrites = moyskladWrites;
    const bad = await createEvent(`wrong-total-${mismatchedId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', mismatchedId);
    assert.equal((await processor.process(bad.id))?.status, 'MANUAL_REVIEW');
    assert.equal((await db.inboundEvent.findUniqueOrThrow({ where: { id: bad.id } })).lastErrorCategory, 'INVOICE_SOURCE_TOTAL_MISMATCH');
    assert.equal(moyskladWrites, beforeWrites);
  } finally {
    await db.entityPair.deleteMany({ where: { entityType: 'PRODUCT', bitrix24Id: {in:[productId,secondProductId]} } });
  }
});

test('controlled invoice processor admits a synthetic source, creates and binds its target, then resumes an exact BOTH echo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue60-invoice-processor-'));
  const manifestPath = join(directory, 'manifest.json');
  const sourceId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const runId = `LIVE-TEST-20261019T120000Z-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const sourceName = `тест ${runId} invoice`;
  let createdTargetId: string | null = null;
  const originalFetch = globalThis.fetch;
  const oldConfig = activeFieldConfig;
  let echoEventId: string | null = null;
  const savedEnv = Object.fromEntries(['CONTROLLED_LIVE_TEST_MODE', 'CONTROLLED_LIVE_TEST_INSTANCE', 'CONTROLLED_LIVE_TEST_MANIFEST', 'CONTROLLED_LIVE_TEST_FAKE_PROVIDER_HTTP'].map((key) => [key, process.env[key]]));
  const providerNamespace = { bitrix24PortalOrigin: new URL(process.env.BITRIX24_REST_BASE_URL!).origin,
    bitrix24UserId: '42', moyskladAccountId: 'b0b309ee-13e3-11e9-9109-f8fc0001f188' };
  activeFieldConfig = { rules: [
    ...fieldConfig.rules,
    { id: 'invoice-description-controlled', entity: 'smart-invoices', sourceField: 'description', targetField: 'description',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } },
  ], groups: [] };
  bitrixInvoices.set(sourceId, { id: sourceId, title: sourceName, description: 'before echo', parentId2: Number(dealId), createdTime: createdAfterBoundary });
  const created = await createEvent(`controlled-create-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', sourceId);
  const connection = new URL(process.env.DATABASE_URL!);
  const runManifest = { runId, testDatabaseName: decodeURIComponent(connection.pathname.slice(1)), testSchemaName: connection.searchParams.get('schema'), providerNamespace, records: [{
    entity: 'invoice', direction: 'BOTH', name: sourceName, syntheticOnly: true,
    sourceSystem: 'BITRIX24', sourceNativeId: sourceId, targetSystem: 'MOYSKLAD', targetNativeId: null,
    createdAfterUtc: '2026-10-15T00:00:00.000Z', readOnlyDependencies: [
      { provider: 'BITRIX24', entity: 'deal-order', nativeId: dealId },
      { provider: 'MOYSKLAD', entity: 'deal-order', nativeId: orderId },
    ],
  }] };
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
  process.env.CONTROLLED_LIVE_TEST_INSTANCE = 'isolated';
  process.env.CONTROLLED_LIVE_TEST_FAKE_PROVIDER_HTTP = 'enabled';
  process.env.CONTROLLED_LIVE_TEST_MANIFEST = manifestPath;
  await writeFile(manifestPath, JSON.stringify(runManifest), 'utf8');
  try {
    setVerifiedControlledLiveProviderNamespace(providerNamespace);
    installControlledLiveFetchGuard(providerNamespace);
    const admission = new ControlledLiveTestAdmissionService(db);
    const controlledProcessor = new InvoiceEventProcessor(db, new InvoiceHttpApi(), settingsAdapter as never, new SyncModeService(db),
      { launchBoundary: async () => launchBoundary, assertReady: async () => true } as never, new EventWorkerLeaseService(db), new ClientLifecycleService(db), admission);
    assert.equal((await controlledProcessor.process(created.id))?.status, 'SUCCEEDED', JSON.stringify(await db.inboundEvent.findUnique({ where: { id: created.id } })));
    const pair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'INVOICE', bitrix24Id: sourceId, active: true } });
    createdTargetId = pair.moyskladId;
    const target = moyskladInvoices.get(pair.moyskladId)!;
    assert.equal(target.name, sourceName);
    assert.equal((await db.controlledTestAdmission.findUnique({ where: { eventId: created.id } }))?.targetNativeId, pair.moyskladId);

    target.description = 'synthetic echo value';
    // A real reverse callback is enabled only after the newly verified target is
    // explicitly pinned in the immutable manifest used by the resumed instance.
    (runManifest.records[0] as { targetNativeId: string | null }).targetNativeId = pair.moyskladId;
    await writeFile(manifestPath, JSON.stringify(runManifest), 'utf8');
    const echoAdmission = new ControlledLiveTestAdmissionService(db);
    const echoProcessor = new InvoiceEventProcessor(db, new InvoiceHttpApi(), settingsAdapter as never, new SyncModeService(db),
      { launchBoundary: async () => launchBoundary, assertReady: async () => true } as never, new EventWorkerLeaseService(db), new ClientLifecycleService(db), echoAdmission);
    const echoed = await createEvent(`controlled-echo-${sourceId}`, 'MOYSKLAD', 'UPDATE', 'invoiceout', pair.moyskladId);
    echoEventId = echoed.id;
    await echoAdmission.withCurrentSourceRead(echoed.id, 'MOYSKLAD', pair.moyskladId, 'invoice', async () => {
      const current = await new InvoiceHttpApi().readMoysklad(pair.moyskladId);
      await echoAdmission.admit(echoed.id, { entity: 'invoice', sourceSystem: 'MOYSKLAD', sourceNativeId: pair.moyskladId,
        currentNativeId: String(current.id), currentName: String(current.name), sourceCreatedAt: new Date(String(current.created)) });
    });
    await echoProcessor.process(echoed.id);
    const echoState = await db.inboundEvent.findUniqueOrThrow({ where: { id: echoed.id } });
    assert.equal(echoState.status, 'SUCCEEDED', JSON.stringify(echoState));
    assert.equal(bitrixInvoices.get(sourceId)?.description, 'synthetic echo value');
    assert.equal((await db.controlledTestAdmission.findUnique({ where: { eventId: echoed.id } }))?.targetNativeId, sourceId);
  } finally {
    globalThis.fetch = originalFetch;
    setControlledLiveTestWriteCheck(null);
    activeFieldConfig = oldConfig;
    for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await db.inboundEvent.deleteMany({ where: { id: { in: [created.id, ...(echoEventId ? [echoEventId] : [])] } } });
    await db.entityPair.deleteMany({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } });
    bitrixInvoices.delete(sourceId);
    if (createdTargetId) moyskladInvoices.delete(createdTargetId);
    await rm(directory, { recursive: true, force: true });
  }
});

test('invoice worker durably defers before the deal/order pair exists, then automatically resumes against that exact order', async () => {
  const nextDeal = `${Date.now()}91`;
  const nextOrder = randomUUID();
  deals.set(nextDeal, { ID: nextDeal, DATE_CREATE: createdAfterBoundary });
  orders.set(nextOrder, { id: nextOrder, meta: { type: 'customerorder' }, created: createdAfterBoundary });
  const sourceId = String(++invoiceCounter);
  bitrixInvoices.set(sourceId, { id: sourceId, title: 'Invoice Beta', parentId2: Number(nextDeal), createdTime: createdAfterBoundary });
  const writesBeforeInvoiceEvent = moyskladWrites;
  const event = await createEvent(`wait-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', sourceId);
  assert.equal((await processor.process(event.id))?.status, 'WAITING_FOR_ORDER');
  const waiting = await db.inboundEvent.findUniqueOrThrow({ where: { id: event.id } });
  assert.equal(waiting.status, 'WAITING_FOR_ORDER');
  assert.equal(waiting.lastErrorCategory, 'INVOICE_LINKED_ORDER_PAIR_PENDING');
  assert.equal(await db.entityPair.count({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } }), 0);
  const writesBeforeOrderPair = moyskladWrites;
  assert.equal(writesBeforeOrderPair, writesBeforeInvoiceEvent, 'the waiting invoice must not create an invoiceout or bypass the order-pair gate');
  await db.entityPair.create({ data: { id: `invoice55-${suffix}-deal-${nextDeal}`, entityType: 'DEAL', bitrix24Id: nextDeal, moyskladId: nextOrder, moyskladType: 'customerorder', source: 'MANUAL' } });
  startRecoveryScanner();
  await waitForEventStatus(event.id, 'SUCCEEDED');
  assert.equal(await db.entityPair.count({ where: { entityType: 'INVOICE', bitrix24Id: sourceId, moyskladParentId: nextOrder } }), 1);
  const invoicePair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } });
  assert.equal((moyskladInvoices.get(invoicePair.moyskladId)?.customerOrder as any)?.meta?.href, `${base}api/remap/1.2/entity/customerorder/${nextOrder}`);
  assert.equal(moyskladWrites, writesBeforeOrderPair + 1, 'automatic resume creates exactly one invoice linked to the paired order');
});

test('MySklad invoiceout durably waits for a new customer order pair and automatically resumes against its exact deal', async () => {
  const nextOrder = randomUUID();
  const nextDeal = `${Date.now()}92`;
  const sourceId = randomUUID();
  orders.set(nextOrder, { id: nextOrder, meta: { type: 'customerorder' }, created: createdAfterBoundary });
  moyskladInvoices.set(sourceId, { id: sourceId, name: 'Early MySklad invoice', created: createdAfterBoundary, meta: { type: 'invoiceout' },
    customerOrder: { id: nextOrder, meta: { type: 'customerorder' } } });
  const writesBefore = bitrixInvoices.size;
  const event = await createEvent(`ms-wait-${sourceId}`, 'MOYSKLAD', 'CREATE', 'invoiceout', sourceId);
  assert.equal((await processor.process(event.id))?.status, 'WAITING_FOR_ORDER');
  const waiting = await db.inboundEvent.findUniqueOrThrow({ where: { id: event.id } });
  assert.equal(waiting.status, 'WAITING_FOR_ORDER');
  assert.equal(waiting.lastErrorCategory, 'INVOICE_LINKED_ORDER_PAIR_PENDING');
  assert.equal(await db.entityPair.count({ where: { entityType: 'INVOICE', moyskladId: sourceId } }), 0);
  assert.equal(bitrixInvoices.size, writesBefore, 'the invoice must not create a standalone smart invoice before its order pair exists');

  deals.set(nextDeal, { ID: nextDeal, DATE_CREATE: createdAfterBoundary });
  await db.entityPair.create({ data: { id: `invoice55-${suffix}-ms-deal-${nextOrder}`, entityType: 'DEAL', bitrix24Id: nextDeal, moyskladId: nextOrder, moyskladType: 'customerorder', source: 'MANUAL' } });
  startRecoveryScanner();
  await waitForEventStatus(event.id, 'SUCCEEDED');
  const pair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'INVOICE', moyskladId: sourceId } });
  assert.equal(pair.moyskladParentId, nextOrder);
  assert.equal(bitrixInvoices.get(pair.bitrix24Id)?.parentId2, Number(nextDeal));
  assert.equal(bitrixInvoices.size, writesBefore + 1);
});

test('invoice groups use the configured #56 join transform and baseline for create and update', async () => {
  activeFieldConfig = { ...fieldConfig, rules: [{ id: 'invoice-code', entity: 'smart-invoices', sourceField: 'title', targetField: 'code',
    bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }], groups: [{ id: 'invoice-name', entity: 'smart-invoices', direction: 'BITRIX24_TO_MOYSKLAD',
    targetField: 'name', sourceFields: ['title', 'description'], criticality: 'optional',
    transform: { kind: 'join-non-empty', separator: ' ' } },
  { id: 'invoice-moysklad-label', entity: 'smart-invoices', direction: 'MOYSKLAD_TO_BITRIX24',
    targetField: 'description', sourceFields: ['name', 'code'], criticality: 'optional',
    transform: { kind: 'join-non-empty', separator: ' / ' } }] } as unknown as typeof activeFieldConfig;
  try {
    const sourceId = String(++invoiceCounter);
    bitrixInvoices.set(sourceId, { id: sourceId, title: '  Customer ', description: 'Invoice  ', parentId2: Number(dealId), createdTime: createdAfterBoundary });
    const create = await createEvent(`group-create-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', sourceId);
    assert.equal((await processor.process(create.id))?.status, 'SUCCEEDED');
    const pair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } });
    assert.equal(moyskladInvoices.get(pair.moyskladId)?.name, 'Customer Invoice');
    assert.equal(moyskladInvoices.get(pair.moyskladId)?.code, '  Customer ');

    bitrixInvoices.get(sourceId)!.description = ' Updated ';
    const update = await createEvent(`group-update-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', sourceId);
    assert.equal((await processor.process(update.id))?.status, 'SUCCEEDED');
    assert.equal(moyskladInvoices.get(pair.moyskladId)?.name, 'Customer Updated');

    moyskladInvoices.get(pair.moyskladId)!.name = 'MySklad label';
    const reverse = await createEvent(`group-reverse-${sourceId}`, 'MOYSKLAD', 'UPDATE', 'invoiceout', pair.moyskladId);
    assert.equal((await processor.process(reverse.id))?.status, 'SUCCEEDED');
    assert.equal(bitrixInvoices.get(sourceId)?.description, 'MySklad label / Customer');

    bitrixInvoices.get(sourceId)!.title = 'Customer 2';
    moyskladInvoices.get(pair.moyskladId)!.name = 'MySklad wins';
    const conflict = await createEvent(`group-conflict-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', sourceId);
    assert.equal((await processor.process(conflict.id))?.status, 'SUCCEEDED');
    assert.equal(moyskladInvoices.get(pair.moyskladId)?.name, 'MySklad wins', 'the MySklad target wins a simultaneous group edit');

    bitrixInvoices.get(sourceId)!.description = 'retry';
    failNextMoyskladUpdate = true;
    const retry = await createEvent(`group-retry-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', sourceId);
    assert.equal((await processor.process(retry.id))?.status, 'RETRYABLE_FAILURE');
    startRecoveryScanner();
    await waitForEventStatus(retry.id, 'SUCCEEDED');
    assert.equal(moyskladInvoices.get(pair.moyskladId)?.name, 'Customer 2 retry');

    const emptyId = String(++invoiceCounter);
    bitrixInvoices.set(emptyId, { id: emptyId, title: '  ', parentId2: Number(dealId), createdTime: createdAfterBoundary });
    const emptyCreate = await createEvent(`group-empty-${emptyId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', emptyId);
    assert.equal((await processor.process(emptyCreate.id))?.status, 'SUCCEEDED');
    const emptyPair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'INVOICE', bitrix24Id: emptyId } });
    assert.equal(moyskladInvoices.get(emptyPair.moyskladId)?.name, '');
    bitrixInvoices.get(emptyId)!.description = 'Now present';
    const emptyUpdate = await createEvent(`group-empty-update-${emptyId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', emptyId);
    assert.equal((await processor.process(emptyUpdate.id))?.status, 'SUCCEEDED');
    assert.equal(moyskladInvoices.get(emptyPair.moyskladId)?.name, 'Now present', 'the persisted empty baseline must detect a later non-empty group value');
  } finally {
    activeFieldConfig = fieldConfig;
  }
});

test('an invoice webhook applies a new MS-authoritative mapping and persists its verified settings revision', async () => {
  const sourceId = String(++invoiceCounter);
  bitrixInvoices.set(sourceId, { id: sourceId, title: 'Invoice revision', parentId2: Number(dealId), createdTime: createdAfterBoundary });
  const create = await createEvent(`revision-create-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', sourceId);
  assert.equal((await processor.process(create.id))?.status, 'SUCCEEDED');
  const pair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } });
  const baselineV1 = await db.entityPairBaseline.findUniqueOrThrow({ where: { pairId: pair.id } });
  assert.equal(baselineV1.settingsVersion, 1);
  const oldRetry = await createEvent(`revision-old-retry-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', sourceId);
  const pinnedV1 = testEventSettings.get(oldRetry.id)!;
  await db.inboundEvent.update({ where: { id: oldRetry.id }, data: { status: 'RETRYABLE_FAILURE', retryAfter: new Date(Date.now() + 3_600_000), lastErrorCategory: 'SYNTHETIC_DEFERRED_RETRY' } });
  bitrixInvoices.get(sourceId)!.title = 'V1 edit retained across rebase';

  const oldConfig = activeFieldConfig;
  const oldVersion = activeSettingsVersion;
  try {
    activeSettingsVersion = 2;
    activeFieldConfig = { ...fieldConfig, rules: [fieldConfig.rules[0]!,
      { id: 'invoice-code-from-ms', entity: 'smart-invoices', sourceField: 'code', targetField: 'code',
        bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } },
        moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } },
      { id: 'invoice-description-from-ms', entity: 'smart-invoices', sourceField: 'description', targetField: 'description',
        bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } },
        moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } },
    ], groups: [{ id: 'invoice-ms-label', entity: 'smart-invoices', direction: 'MOYSKLAD_TO_BITRIX24', targetField: 'notes', sourceFields: ['code', 'description'], criticality: 'optional', transform: { kind: 'join-non-empty', separator: ' - ' } }] } as unknown as typeof activeFieldConfig;
    testSettingsHistory.set(2, activeFieldConfig);
    moyskladInvoices.get(pair.moyskladId)!.code = 'authoritative-ms-code';
    moyskladInvoices.get(pair.moyskladId)!.description = 'authoritative-ms-description';
    const update = await createEvent(`revision-update-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', sourceId);
    failNextBitrixUpdateField = 'description';
    const partial = await processor.process(update.id);
    assert.equal(partial?.status, 'RETRYABLE_FAILURE');
    assert.equal(bitrixInvoices.get(sourceId)?.code, 'authoritative-ms-code', 'the first provider write may succeed before a later field fails');
    assert.equal(bitrixInvoices.get(sourceId)?.description, undefined);
    assert.equal((await db.entityPairBaseline.findUniqueOrThrow({ where: { pairId: pair.id } })).settingsVersion, 1, 'a partial revision must not advance the baseline version');
    assert.equal((await db.entityPairSettingsRevision.findUniqueOrThrow({ where: { pairId_toSettingsVersion: { pairId: pair.id, toSettingsVersion: 2 } } })).status, 'PREPARED');
    await db.inboundEvent.update({ where: { id: update.id }, data: { retryAfter: new Date(Date.now() - 1_000) } });
    const outcome = await processor.process(update.id);
    assert.equal(outcome?.status, 'SUCCEEDED', JSON.stringify(outcome));
    assert.equal(bitrixInvoices.get(sourceId)?.code, 'authoritative-ms-code');
    assert.equal(bitrixInvoices.get(sourceId)?.description, 'authoritative-ms-description');
    assert.equal(bitrixInvoices.get(sourceId)?.notes, 'authoritative-ms-code - authoritative-ms-description');
    assert.equal(moyskladInvoices.get(pair.moyskladId)?.name, 'V1 edit retained across rebase', 'the unchanged V1 mapping keeps its earlier difference state for ordinary synchronization');
    const baselineV2 = await db.entityPairBaseline.findUniqueOrThrow({ where: { pairId: pair.id } });
    assert.equal(baselineV2.settingsVersion, 2);
    assert.equal((baselineV2.bitrix24Values as Record<string, unknown>)['rule:invoice-code-from-ms'], 'authoritative-ms-code');
    assert.equal((await db.entityPairSyncState.findUniqueOrThrow({ where: { pairId: pair.id } })).settingsVersion, 2);
    const revision = await db.entityPairSettingsRevision.findUniqueOrThrow({ where: { pairId_toSettingsVersion: { pairId: pair.id, toSettingsVersion: 2 } } });
    assert.equal(revision.status, 'COMPLETE');
    assert.equal(await db.entityPair.count({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } }), 1);
    const writesBeforeOldRetry = moyskladWrites;
    testEventSettings.set(oldRetry.id, pinnedV1);
    await db.inboundEvent.update({ where: { id: oldRetry.id }, data: { retryAfter: new Date(Date.now() - 1_000) } });
    const oldOutcome = await processor.process(oldRetry.id);
    assert.equal(oldOutcome?.status, 'UNCHANGED');
    assert.equal(oldOutcome?.reason, 'SETTINGS_PIN_SUPERSEDED');
    assert.equal(moyskladWrites, writesBeforeOldRetry);
    assert.equal((await db.entityPairBaseline.findUniqueOrThrow({ where: { pairId: pair.id } })).settingsVersion, 2);
    assert.equal(await db.entityPair.count({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } }), 1);
  } finally {
    activeFieldConfig = oldConfig;
    activeSettingsVersion = oldVersion;
    testSettingsHistory.delete(2);
    failNextBitrixUpdateField = null;
    testEventSettings.delete(oldRetry.id);
    await db.entityPair.deleteMany({ where: { id: pair.id } });
    bitrixInvoices.delete(sourceId);
    moyskladInvoices.delete(pair.moyskladId);
  }
});

test('invoice processor rejects transforms that #56 does not allow for smart invoices', async () => {
  try {
    const invalidGroups = [
      { id: 'invoice-invalid-split', entity: 'smart-invoices', direction: 'MOYSKLAD_TO_BITRIX24', targetField: 'PHONE', sourceFields: ['description'], criticality: 'optional', transform: { kind: 'split-non-empty', separator: ';', valueType: 'WORK' } },
      { id: 'invoice-invalid-order-link', entity: 'smart-invoices', direction: 'BITRIX24_TO_MOYSKLAD', targetField: 'customerOrder', sourceFields: ['title'], criticality: 'optional', transform: { kind: 'join-non-empty', separator: ' ' } },
    ];
    const expectedReasons = ['INVOICE_FIELD_GROUP_UNSUPPORTED', 'INVOICE_RELATIONSHIP_MAPPING_UNSUPPORTED'];
    for (let index = 0; index < invalidGroups.length; index++) {
      activeFieldConfig = { ...fieldConfig, groups: [invalidGroups[index]] } as unknown as typeof activeFieldConfig;
      const sourceId = String(++invoiceCounter);
      bitrixInvoices.set(sourceId, { id: sourceId, title: 'Protected group field', parentId2: Number(dealId), createdTime: createdAfterBoundary });
      const event = await createEvent(`invalid-group-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', sourceId);
      const writesBefore = moyskladWrites;
      assert.equal((await processor.process(event.id))?.status, 'MANUAL_REVIEW');
      assert.equal((await db.inboundEvent.findUniqueOrThrow({ where: { id: event.id } })).lastErrorCategory, expectedReasons[index]);
      assert.equal(moyskladWrites, writesBefore);
    }
  } finally {
    activeFieldConfig = fieldConfig;
  }
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
  const createResult = await processor.process(create.id);
  const createState = await db.inboundEvent.findUniqueOrThrow({ where: { id: create.id } });
  assert.equal(createResult?.status, 'SUCCEEDED', `${createState.status}: ${createState.lastErrorCategory ?? ''}`);
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

test('invoice processor applies every configured field rule in each enabled direction', async () => {
  activeFieldConfig = { rules: [...fieldConfig.rules.map((rule) => rule.id === 'invoice-title' ? {
    ...rule,
    criticality: 'critical',
    bitrix24ToMoysklad: { enabled: true, transform: { kind: 'string-to-number' as const, numberType: 'decimal' as const } },
    moyskladToBitrix24: { enabled: true, transform: { kind: 'number-to-string' as const } },
  } : rule), {
    id: 'invoice-description', entity: 'smart-invoices', sourceField: 'description', targetField: 'description',
    bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } },
  }], groups: [] };
  try {
    const sourceId = String(++invoiceCounter);
    bitrixInvoices.set(sourceId, { id: sourceId, title: '123.5', description: 'Initial note', parentId2: Number(dealId), createdTime: createdAfterBoundary });
    const create = await createEvent(`configured-fields-create-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMADD', 'invoice', sourceId);
    assert.equal((await processor.process(create.id))?.status, 'SUCCEEDED');
    const pair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } });
    const moysklad = moyskladInvoices.get(pair.moyskladId)!;
    assert.equal(moysklad.name, 123.5, 'invoice creation uses the shared explicit number transform');
    assert.equal(moysklad.description, 'Initial note');

    bitrixInvoices.get(sourceId)!.title = '456.75';
    bitrixInvoices.get(sourceId)!.description = 'Updated in Bitrix';
    const bitrixUpdate = await createEvent(`configured-fields-b24-update-${sourceId}`, 'BITRIX24', 'ONCRMDYNAMICITEMUPDATE', 'invoice', sourceId);
    assert.equal((await processor.process(bitrixUpdate.id))?.status, 'SUCCEEDED');
    assert.equal(moysklad.description, 'Updated in Bitrix');
    assert.equal(moysklad.name, 456.75, 'invoice update uses the same transform contract as creation');

    moysklad.name = 789.25;
    moysklad.description = 'Updated in MySklad';
    const moyskladUpdate = await createEvent(`configured-fields-ms-update-${sourceId}`, 'MOYSKLAD', 'UPDATE', 'invoiceout', pair.moyskladId);
    assert.equal((await processor.process(moyskladUpdate.id))?.status, 'SUCCEEDED');
    assert.equal(bitrixInvoices.get(sourceId)?.description, 'Updated in MySklad');
    assert.equal(bitrixInvoices.get(sourceId)?.title, '789.25', 'reverse invoice updates use the configured number-to-string transform');
  } finally {
    activeFieldConfig = fieldConfig;
  }
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
  const createResult = await processor.process(create.id);
  const createState = await db.inboundEvent.findUniqueOrThrow({ where: { id: create.id } });
  assert.equal(createResult?.status, 'SUCCEEDED', `${createState.status}: ${createState.lastErrorCategory ?? ''}`);
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
    assert.equal(((target.customerOrder as Record<string, unknown>).meta as Record<string, unknown>).href,
      `${base}api/remap/1.2/entity/customerorder/${orderId}`);
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
  const firstAttempt = await processor.process(event.id);
  const firstAttemptState = await db.inboundEvent.findUniqueOrThrow({ where: { id: event.id } });
  assert.equal(firstAttempt?.status, 'RETRYABLE_FAILURE', `${firstAttemptState.status}: ${firstAttemptState.lastErrorCategory ?? ''}`);
  await db.inboundEvent.update({ where: { id: event.id }, data: { retryAfter: new Date(0) } });
  assert.equal((await processor.process(event.id))?.status, 'SUCCEEDED');
  assert.equal(await db.entityPair.count({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } }), 1);
});

test('invoice group saved through field settings is reloaded and consumed by invoice runtime', async () => {
  const provider = {
    fieldCatalogs: async (_token: string, entity: string) => entity === 'smart-invoices' ? {
      bitrix24: [
        { code: 'title', type: 'string', writable: true }, { code: 'description', type: 'string', writable: true },
        { code: 'parentId2', type: 'integer', writable: true },
      ],
      moysklad: [
        { code: 'name', type: 'string', writable: true }, { code: 'description', type: 'string', writable: true },
        { code: 'customerOrder', type: 'object', writable: true },
      ],
    } : { bitrix24: [], moysklad: [] },
  };
  assert.ok((await provider.fieldCatalogs('synthetic-invoice-settings-token', 'smart-invoices')).bitrix24.some((field) => field.code === 'title'));
  const settings = new FieldSettingsService(db, provider as never, {} as never);
  const originalEventConfig = settingsAdapter.eventConfig;
  const current = await settings.active();
  const saved = await settings.save({
    ...current.config,
    rules: [],
    groups: [{ id: `invoice55-${suffix}-saved-join`, entity: 'smart-invoices',
      direction: 'BITRIX24_TO_MOYSKLAD', targetField: 'name', sourceFields: ['description'],
      criticality: 'optional', transform: { kind: 'join-non-empty', separator: ' ' } }],
  }, 'synthetic-invoice-settings-token');
  const reloaded = await settings.version(saved.version);
  assert.deepEqual(reloaded.config.groups, saved.config.groups, 'a persisted version read reloads the operator-saved group');
  settingsAdapter.eventConfig = (eventId) => settings.eventConfig(eventId);
  try {
    const sourceId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    bitrixInvoices.set(sourceId, { id: sourceId, title: 'Saved customer', description: 'Saved invoice', parentId2: Number(dealId), createdTime: createdAfterBoundary });
    const event = await settings.saveAcceptedEvent({ source: 'BITRIX24', deliveryKey: `invoice55-${suffix}-saved-group-${sourceId}`,
      eventType: 'ONCRMDYNAMICITEMADD', externalEntityType: 'invoice', externalEntityId: sourceId,
      payload: {}, directionDisabled: false });
    const pinned = await settings.eventConfig(event.id);
    assert.equal(pinned.version, saved.version);
    assert.deepEqual(pinned.config.groups, saved.config.groups);
    const processed = await processor.process(event.id);
    assert.equal(processed?.status, 'SUCCEEDED', JSON.stringify(await db.inboundEvent.findUnique({ where: { id: event.id } })));
    const pair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'INVOICE', bitrix24Id: sourceId } });
    assert.equal(moyskladInvoices.get(pair.moyskladId)?.name, 'Saved invoice', 'runtime consumes the persisted group, not an injected fieldConfig seed');

    const invalidGroups = [
      { id: 'invalid-invoice-split', entity: 'smart-invoices', direction: 'MOYSKLAD_TO_BITRIX24', targetField: 'title', sourceFields: ['description'], criticality: 'optional', transform: { kind: 'split-non-empty', separator: ';', valueType: 'WORK' } },
      { id: 'invalid-invoice-order-target', entity: 'smart-invoices', direction: 'BITRIX24_TO_MOYSKLAD', targetField: 'customerOrder', sourceFields: ['title'], criticality: 'optional', transform: { kind: 'join-non-empty', separator: ' ' } },
      { id: 'invalid-invoice-deal-source', entity: 'smart-invoices', direction: 'BITRIX24_TO_MOYSKLAD', targetField: 'name', sourceFields: ['parentId2'], criticality: 'optional', transform: { kind: 'join-non-empty', separator: ' ' } },
    ];
    for (const group of invalidGroups) {
      await assert.rejects(settings.save({ ...saved.config, groups: [group] }, 'synthetic-invoice-settings-token'));
      assert.equal((await settings.active()).version, saved.version, 'invalid relationships and transforms do not create active settings versions');
    }
  } finally {
    settingsAdapter.eventConfig = originalEventConfig;
  }
});

async function createEvent(id: string, source: string, eventType: string, externalEntityType: string, externalEntityId: string) {
  const event = await db.inboundEvent.create({ data: {
    source, deliveryKey: `invoice55-${suffix}-${id}`, eventType, externalEntityType, externalEntityId,
    payload: {}, status: 'RECEIVED',
  } });
  testEventSettings.set(event.id, { version: activeSettingsVersion, config: activeFieldConfig });
  return event;
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
      return send(response, item ? { result: { item: { id, opportunity: 0, currencyId: 'RUB', ...item } } } : { error: 'NOT_FOUND', error_description: 'Element not found' }, item ? 200 : 400);
    }
    if (method === 'crm.item.productrow.list.json') {
      assert.equal(form.get('filter[=ownerType]'), 'SI');
      return send(response, { result: { productRows: invoiceRows.get(form.get('filter[=ownerId]') ?? '') ?? [] } });
    }
    if (method === 'crm.item.fields.json') return send(response, { result: { fields: { title: { type: 'string', title: 'Title', isReadOnly: false }, code: { type: 'string', title: 'Code', isReadOnly: false } } } });
    if (method === 'crm.deal.get.json') {
      const id = form.get('id') ?? '';
      const deal = deals.get(id);
      return send(response, deal ? { result: { deal: { CURRENCY_ID: 'RUB', ...deal } } } : { error: 'NOT_FOUND', error_description: 'Element not found' }, deal ? 200 : 400);
    }
    if (method === 'crm.item.add.json') {
      const id = String(++invoiceCounter);
      const item = { id, title: form.get('fields[title]') ?? '', description: form.get('fields[description]') ?? '', parentId2: Number(form.get('fields[parentId2]')),
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
      if (item) {
        if (failNextBitrixUpdateField && form.has(`fields[${failNextBitrixUpdateField}]`)) {
          failNextBitrixUpdateField = null;
          return send(response, { error: 'TEMPORARY_PROVIDER_FAILURE', error_description: 'temporary' }, 503);
        }
        const title = form.get('fields[title]'); if (title !== null) item.title = title;
        const description = form.get('fields[description]'); if (description !== null) item.description = description;
        for (const [key, value] of form.entries()) {
          const field = /^fields\[([^\]]+)\]$/.exec(key)?.[1];
          if (field && field !== 'title' && field !== 'description') item[field] = value;
        }
      }
      return send(response, { result: { item } });
    }
  }
  if (url.pathname.startsWith('/api/remap/1.2/')) {
    if (request.method === 'GET' && url.pathname.endsWith('/entity/invoiceout/metadata/attributes')) return send(response, { rows: [{ id: randomUUID(), name: 'Code', type: 'string', writable: true }] });
    if (request.method === 'GET' && url.pathname === '/api/remap/1.2/entity/invoiceout') {
      const externalCode = url.searchParams.get('filter')?.replace(/^externalCode=/, '');
      return send(response, { rows: [...moyskladInvoices.values()].filter((invoice) => invoice.externalCode === externalCode) });
    }
    if (request.method === 'POST' && url.pathname === '/api/remap/1.2/entity/invoiceout') {
      if (failNextInvoiceCreate) { failNextInvoiceCreate = false; return send(response, { errors: [{ error: 'temporary' }] }, 503); }
      moyskladWrites++;
      const body = JSON.parse(raw) as InvoiceRecord;
      const id = randomUUID();
      const positions = Array.isArray(body.positions) ? body.positions.map((row:any)=>({...row,id:randomUUID()})) : [];
      const invoice = { ...body, positions, id, created: createdAfterBoundary, meta: { type: 'invoiceout' } };
      moyskladInvoices.set(id, invoice);
      return send(response, { id, meta: { type: 'invoiceout' } });
    }
    const invoiceId = url.pathname.match(/^\/api\/remap\/1\.2\/entity\/invoiceout\/([0-9a-f-]{36})$/i)?.[1];
    if (invoiceId && request.method === 'GET') {
      const invoice = moyskladInvoices.get(invoiceId);
      return send(response, invoice ? {...invoice,sum:invoiceSum(invoice)} : { errors: [{ error: 'not found' }] }, invoice ? 200 : 404);
    }
    const positionPath = url.pathname.match(/^\/api\/remap\/1\.2\/entity\/invoiceout\/([0-9a-f-]{36})\/positions(?:\/([0-9a-f-]{36}))?$/i);
    if(positionPath) {
      const invoice = moyskladInvoices.get(positionPath[1]!);
      if(!invoice) return send(response,{},404);
      const rows=Array.isArray(invoice.positions)?invoice.positions as InvoiceRecord[]:[];
      if(request.method==='GET') {
        if(failNextPositionRead) {failNextPositionRead=false;return send(response,{errors:[{code:1000}]},503);}
        return send(response,{meta:{size:rows.length},rows});
      }
      if(request.method==='POST') {
        moyskladWrites++;
        const row={...JSON.parse(raw),id:randomUUID()};rows.push(row);invoice.positions=rows;
        return send(response,[row]);
      }
      if(request.method==='PUT') {
        const row=rows.find(r=>r.id===positionPath[2]);
        if(!row) return send(response,{},404);
        moyskladWrites++;Object.assign(row,JSON.parse(raw));
        if(failPositionReadAfterWrite) {failPositionReadAfterWrite=false;failNextPositionRead=true;}
        return send(response,row);
      }
    }
    if (invoiceId && request.method === 'PUT') {
      if (failNextMoyskladUpdate) { failNextMoyskladUpdate = false; return send(response, { errors: [{ error: 'temporary' }] }, 503); }
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
    if (order && request.method === 'GET') return send(response, {
      organization: { meta: { href: `${base}api/remap/1.2/entity/organization/02ada5df-d515-11e2-3c12-7054d21a8d1e`, type: 'organization' } },
      agent: { meta: { href: `${base}api/remap/1.2/entity/counterparty/b0b309ee-13e3-11e9-9109-f8fc0001f188`, type: 'counterparty' } },
      ...(orders.get(order) ?? { id: order, meta: { type: 'customerorder' }, created: createdAfterBoundary }),
    });
  }
  return send(response, { error: 'NOT_FOUND', path: url.pathname }, 404);
}

function send(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function invoiceSum(invoice:InvoiceRecord):number {
  const rows=Array.isArray(invoice.positions)?invoice.positions as InvoiceRecord[]:[];
  return rows.reduce((sum,row)=>sum+Math.round(Number(row.price)*Number(row.quantity)*(1-Number(row.discount??0)/100)*(invoice.vatEnabled===true&&invoice.vatIncluded!==true?1+Number(row.vat??0)/100:1)),0);
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

async function waitForEventStatus(eventId: string, expected: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const event = await db.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
    if (event.status === expected) return event;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const event = await db.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
  assert.equal(event.status, expected, `expected invoice event ${eventId} to reach ${expected}`);
  return event;
}

function startRecoveryScanner() {
  if (processorStarted) return;
  processorStarted = true;
  processor.onApplicationBootstrap();
}
