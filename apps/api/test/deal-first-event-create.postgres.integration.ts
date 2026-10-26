import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../src/database.service';
import { EventsController, EventIntakeService } from '../src/events.controller';
import { SyncModeService } from '../src/sync-mode.service';
import { DatabaseRecoveryService } from '../src/database-recovery.service';
import { DryRunDocumentReader } from '../src/dry-run-document-reader';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { DealOrderCreationPreparer } from '../src/deals-orders/deal-order-creation-preparer.service';
import { DealTimelineNoticeService } from '../src/deals-orders/deal-timeline-notice.service';
import { EventWorkerLeaseContext, EventWorkerLeaseService } from '../src/event-worker-lease.service';
import { DealOrderCreateOperationService } from '../src/deals-orders/deal-order-create-operation.service';
import { EntityPairService } from '../src/pairs/entity-pair.service';
import { PairResolutionProvider } from '../src/pairs/pair-resolution.provider';
import { PAIR_RESOLVER } from '../src/pairs/pair-resolver';
import { PairFirstEventProcessor } from '../src/pairs/pair-first-event.processor';
import { setDatabaseRecoveryReady } from '../src/external-write-guard';
import { DealOrderReverseCreateService } from '../src/deals-orders/deal-order-reverse-create.service';

const company = { bitrix24Id: `81${Date.now()}`, moyskladId: '11111111-1111-4111-8111-111111111111' };
const product = { bitrix24Id: `82${Date.now()}`, moyskladId: '22222222-2222-4222-8222-222222222222' };
const refs = {
  organization: '02ada5df-d515-11e2-3c12-7054d21a8d1e', store: '44444444-4444-4444-8444-444444444444',
  state: '55555555-5555-4555-8555-555555555555', employee: '66666666-6666-4666-8666-666666666666',
  currency: '77777777-7777-4777-8777-777777777777', unit: '88888888-8888-4888-8888-888888888888',
  order: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', position: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
let app: INestApplication;
let server: Server;
let providerBase = '';
let apiUrl = '';
let companyPairId = '';
let productPairId = '';
let createPosts = 0;
let nextPrepareWaiting = false;
let nextPrepareReview = false;
let b24OrderNumber: string | null = null;
let b24DealTitle: string | null = 'Original source title';
let orderPayload: Record<string, any> | null = null;
const createdEventIds: string[] = [];
const sourceCreatedAt = new Map<string, Date>();
const reverseOrderId = randomUUID();
let reverseItem: Record<string, unknown> | null = null;
let reverseAdds = 0;
const echoDealId = `84${Date.now()}`;
const echoOrderId = randomUUID();
const extraOrders = new Map<string, Record<string, any>>();
let forwardNativeId = refs.order;
let forwardReadBarrier: { started(): void; wait: Promise<void> } | null = null;
let failForwardReadOnce = false;
let failNativeReadOnce = false;
let beforeReverseAdd: (() => Promise<void>) | null = null;

const fieldSettingsFake = {
  saveAcceptedEvent: async (input: {
    source: string; deliveryKey: string; eventType: string | null; externalEntityId: string | null;
    externalEntityType: string | null; payload: Prisma.InputJsonValue; directionDisabled: boolean;
  }) => app.get(DatabaseService).inboundEvent.create({ data: {
    source: input.source, deliveryKey: input.deliveryKey, eventType: input.eventType,
    externalEntityId: input.externalEntityId, externalEntityType: input.externalEntityType,
    payload: input.payload, status: input.directionDisabled ? 'SKIPPED_DIRECTION_DISABLED' : 'RECEIVED',
    lastErrorCategory: input.directionDisabled ? 'DIRECTION_DISABLED' : null,
  }, select: { id: true } }),
  eventConfig: async (id: string) => {
    const event=await app.get(DatabaseService).inboundEvent.findUniqueOrThrow({where:{id}});
    return event.source==='MOYSKLAD' || event.externalEntityId===echoDealId ? { version:1, createdAt:new Date(), config:{
      schemaVersion:1,rules:[],groups:[],references:{units:[],priceTypes:[],dictionaries:[],namedPairs:[{kind:'dealStages',bitrix24Id:'0:PREPARATION',moyskladId:refs.state,status:'confirmed'}]},
      dealOrderRuntime:{nativeOrderNumberingVerified:true,unmappedReferencePolicy:'confirmed-defaults',defaultOrganizationId:refs.organization,defaultStoreId:refs.store,defaultEmployeeId:refs.employee,organizations:[],stores:[],employees:[],stages:[{bitrix24StageId:'PREPARATION',moyskladId:refs.state,creationEnabled:true}],currencies:[{bitrix24Code:'RUB',moyskladId:refs.currency}]},
    }} : {version:1,createdAt:new Date(),config:{}};
  },
};

@Module({
  controllers: [EventsController],
  providers: [
    DatabaseService, EventIntakeService, SyncModeService, EntityPairService, EventWorkerLeaseService,
    { provide: DealTimelineNoticeService, inject: [DatabaseService], useFactory: (db: DatabaseService) => {
      const notices = new DealTimelineNoticeService(db);
      // This public-worker test verifies durable enqueue. Delivery has its own
      // real-PG HTTP stub suite; do not start another background worker here.
      notices.onApplicationBootstrap = () => {};
      return notices;
    } },
    PairResolutionProvider, { provide: PAIR_RESOLVER, useExisting: PairResolutionProvider }, PairFirstEventProcessor,
    { provide: FieldSettingsService, useValue: fieldSettingsFake },
    {
      provide: DatabaseRecoveryService,
      useValue: { assertReady: async () => true, launchBoundary: async () => new Date('2026-10-20T14:00:00.000Z') },
    },
    { provide: DryRunDocumentReader, useValue: {
      readDealOrderCreationTimestamp: async (_source: string, id: string) => sourceCreatedAt.get(id) ?? new Date(),
      readMoySkladCustomerOrderForBaseline: (id: string) => new DryRunDocumentReader().readMoySkladCustomerOrderForBaseline(id),
    } },
    {
      provide: DealOrderCreationPreparer,
      useValue: { prepare: async (input: { bitrix24DealId: string; eventId: string }, workerLease?: EventWorkerLeaseContext) => {
        assert.ok(workerLease, 'actual public worker must pass its claimed event fence into preparation');
        await workerLease.assertOwned();
        assert.equal((await app.get(DatabaseService).inboundEvent.findUniqueOrThrow({where:{id:input.eventId}})).status,'PROCESSING');
        if (input.bitrix24DealId === echoDealId) return new DealOrderCreationPreparer(app.get(DatabaseService)).prepare({ ...input, eventConfig: await fieldSettingsFake.eventConfig(input.eventId) } as never, workerLease);
        if (nextPrepareWaiting) {
          nextPrepareWaiting = false;
          return { status: 'WAITING', reason: 'STAGE_NOT_READY' };
        }
        if (nextPrepareReview) { nextPrepareReview = false; return { status: 'MANUAL_REVIEW', reason: 'PRODUCT_UUID_INVALID', userAction: 'Исправьте UUID' }; }
        return { status: 'READY', input: preparedOrder(input.bitrix24DealId, input.eventId) };
      } },
    },
    DealOrderCreateOperationService,
    {provide:DealOrderReverseCreateService,inject:[DatabaseService,SyncModeService],useFactory:(database:DatabaseService,mode:SyncModeService)=>new DealOrderReverseCreateService(database,mode,{
      async resolveForDocument(){const pair={id:companyPairId,entityType:'COMPANY',bitrix24Id:company.bitrix24Id,moyskladId:company.moyskladId};return {status:'RESOLVED',pair,companyPair:pair};},
    } as never)},
  ],
})
class DealFirstEventCreatePostgresModule {}

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to an isolated ephemeral PostgreSQL database');
  assert.equal(process.env.DEAL_FIRST_EVENT_CREATE_TEST_ISOLATED, '1');
  const target = new URL(process.env.DATABASE_URL);
  assert.match(target.hostname, /^(127\.0\.0\.1|localhost)$/i);
  assert.match(target.pathname, /test/i);
  process.env.SYNC_MODE = 'apply';
  process.env.SYNC_STATE = 'on';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-b24-event-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'synthetic-ms-first-create';
  setDatabaseRecoveryReady(true);

  server = createServer((request, response) => { void reply(request, response); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  providerBase = `http://127.0.0.1:${address.port}/`;
  process.env.BITRIX24_REST_BASE_URL = `${providerBase}rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${providerBase}api/remap/1.2/`;
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-only';

  app = await NestFactory.create(DealFirstEventCreatePostgresModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  const database = app.get(DatabaseService);
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on', offSince: null } });
  await database.syncDirectionSetting.upsert({ where: { entityKey: 'deals-orders' },
    create: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: true },
    update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } });
  companyPairId = (await app.get(EntityPairService).assign({ entityType: 'COMPANY', ...company, moyskladType: 'counterparty' })).id;
  productPairId = (await app.get(EntityPairService).assign({ entityType: 'PRODUCT', ...product, moyskladType: 'product' })).id;
});

after(async () => {
  if (app) {
    const database = app.get(DatabaseService);
    const pairs = await database.entityPair.findMany({ where: { entityType: 'DEAL', bitrix24Id: { startsWith: '83' } }, select: { id: true } });
    if (pairs.length) await database.dealOrderPositionPair.deleteMany({ where: { pairId: { in: pairs.map((pair) => pair.id) } } });
    await database.pairReviewCase.deleteMany({ where: { sourceSystem: 'BITRIX24', sourceEntityId: { startsWith: '83' } } });
    await database.dealOrderCreateOperation.deleteMany({ where: { bitrix24DealId: { startsWith: '83' } } });
    await database.dealOrderReverseCreateOperation.deleteMany({where:{moyskladOrderId:reverseOrderId}});
    await database.entityPair.deleteMany({ where: { entityType: 'DEAL', bitrix24Id: { startsWith: '83' } } });
    await database.entityPair.deleteMany({ where: { id: { in: [companyPairId, productPairId] } } });
    await database.inboundEvent.deleteMany({ where: { id: { in: createdEventIds } } });
    (app.getHttpServer() as import('node:http').Server).closeAllConnections();
    await app.close();
  }
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  setDatabaseRecoveryReady(false);
});

test('public Bitrix ADD creates one real durable customer-order operation and pair through the production resolver', async () => {
  const dealId = `83${Date.now()}01`;
  sourceCreatedAt.set(dealId, new Date());
  createPosts = 0;
  orderPayload = null;
  b24OrderNumber = null;

  const first = await postDealEvent('ONCRMDEALADD', dealId);
  const completed = await waitForEvent(first.eventId, 'SUCCEEDED');
  assert.equal(completed.lastErrorCategory, null);
  assert.equal(createPosts, 1, 'the public intake/processor path should create exactly one remote order');
  const operation = await app.get(DatabaseService).dealOrderCreateOperation.findUniqueOrThrow({ where: { bitrix24DealId: dealId } });
  assert.equal(operation.status, 'SUCCEEDED');
  assert.equal(operation.moyskladOrderId, refs.order);
  assert.equal(b24DealTitle, 'Original source title'); assert.equal(b24OrderNumber, 'SO-TEST-1');
  const pair = await app.get(DatabaseService).entityPair.findFirstOrThrow({ where: { entityType: 'DEAL', bitrix24Id: dealId, active: true } });
  assert.equal(pair.moyskladId, refs.order);
  assert.equal(await app.get(DatabaseService).dealOrderPositionPair.count({ where: { pairId: pair.id } }), 1);
  assert.equal(await app.get(DatabaseService).dealTimelineNotice.count({ where: { bitrix24DealId: dealId, kind: 'CREATED', moyskladOrderId: refs.order } }), 1);

  const retry = await postDealEvent('ONCRMDEALUPDATE', dealId);
  await waitForEvent(retry.eventId, 'SUCCEEDED');
  assert.equal(createPosts, 1, 'a later event for the already-paired source must not create a duplicate order');
  assert.equal(await app.get(DatabaseService).dealTimelineNotice.count({ where: { bitrix24DealId: dealId, kind: 'CREATED' } }), 1);
});

test('public callbacks for a proven create ownership conflict are held without retrying or creating a duplicate', async () => {
  const db = app.get(DatabaseService), dealId = `83${Date.now()}93`, orderId = randomUUID();
  const prepared = preparedOrder(dealId, 'old-conflict-event');
  await db.dealOrderCreateOperation.create({ data: { bitrix24DealId: dealId, moyskladOrderId: orderId, syncId: randomUUID(),
    status: 'CONFLICT', lastErrorCategory: 'PAIR_CONFLICT', settingsVersion: 1, payload: prepared.payload as Prisma.InputJsonValue,
    attemptedAt: new Date(), confirmedCustomerPairIds: [companyPairId] } });
  const before = createPosts;
  for (const type of ['ONCRMDEALADD', 'ONCRMDEALUPDATE']) {
    const accepted = await postDealEvent(type, dealId);
    const held = await waitForEvent(accepted.eventId, 'MANUAL_REVIEW');
    assert.equal(held.lastErrorCategory, 'CUSTOMER_ORDER_PAIR_CONFLICT');
    assert.equal(held.retryAfter, null);
  }
  const journal = await db.dealOrderCreateOperation.findUniqueOrThrow({ where: { bitrix24DealId: dealId } });
  assert.equal(journal.status, 'CONFLICT'); assert.equal(journal.moyskladOrderId, orderId);
  assert.equal(createPosts, before);
  assert.equal(await db.entityPair.count({ where: { entityType: 'DEAL', bitrix24Id: dealId } }), 0);
});

test('public invalid-product event atomically queues a human-readable error without attempting CREATE', async () => {
  const dealId = `83${Date.now()}90`;
  sourceCreatedAt.set(dealId, new Date());
  const previousPosts = createPosts;
  nextPrepareReview = true;
  const event = await postDealEvent('ONCRMDEALUPDATE', dealId);
  const held = await waitForEvent(event.eventId, 'MANUAL_REVIEW');
  assert.equal(held.lastErrorCategory, 'PRODUCT_UUID_INVALID');
  assert.equal(createPosts, previousPosts);
  const notice = await app.get(DatabaseService).dealTimelineNotice.findFirstOrThrow({ where: { bitrix24DealId: dealId } });
  assert.equal(notice.reason, 'PRODUCT_UUID_INVALID');
  assert.equal(notice.status, 'PENDING');
});

test('public authenticated MS CREATE reaches real reverse creation and default stage through the production resolver',async()=>{
  const response=await fetch(`${apiUrl}/webhooks/moysklad/synthetic-ms-first-create?requestId=${randomUUID()}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({events:[{action:'CREATE',accountId:'11111111-1111-4111-8111-111111111111',meta:{type:'customerorder',href:`${providerBase}api/remap/1.2/entity/customerorder/${reverseOrderId}`}}]})});
  assert.equal(response.status,200,await response.clone().text());
  const body=await response.json() as {eventId:string};
  await waitForEvent(body.eventId,'SUCCEEDED');
  assert.equal(reverseAdds,1);
  assert.equal(reverseItem?.stageId,'PREPARATION');
  const database=app.get(DatabaseService);
  assert.ok(await database.entityPair.findFirst({where:{entityType:'DEAL',moyskladId:reverseOrderId,active:true}}));
  assert.equal(await database.pairReviewCase.count({where:{sourceSystem:'MOYSKLAD',sourceEntityId:reverseOrderId}}),0);
  assert.equal((await database.dealOrderReverseCreateOperation.findUniqueOrThrow({where:{moyskladOrderId:reverseOrderId}})).status,'SUCCEEDED');
});

test('public DELETE and pre-boundary events never enter first-order creation', async () => {
  const deleteId = `83${Date.now()}02`;
  sourceCreatedAt.set(deleteId, new Date());
  const beforeDeletePosts = createPosts;
  const deletion = await postDealEvent('ONCRMDEALDELETE', deleteId);
  const deletedEvent = await waitForEvent(deletion.eventId, 'MANUAL_REVIEW');
  assert.equal(deletedEvent.lastErrorCategory, 'PAIR_REVIEW_REQUIRED');
  assert.equal(createPosts, beforeDeletePosts);

  const oldId = `83${Date.now()}03`;
  sourceCreatedAt.set(oldId, new Date('2026-10-19T23:59:59.000Z'));
  const old = await postDealEvent('ONCRMDEALADD', oldId);
  const oldEvent = await waitForEvent(old.eventId, 'SKIPPED_PRE_LAUNCH');
  assert.equal(oldEvent.lastErrorCategory, 'PRE_LAUNCH_DOCUMENT');
  assert.equal(createPosts, beforeDeletePosts);
});

test('public eligible deal obeys the existing stage-preparer hold without creating a customer order', async () => {
  const dealId = `83${Date.now()}04`;
  sourceCreatedAt.set(dealId, new Date());
  nextPrepareWaiting = true;
  const before = createPosts;
  const acknowledgement = await postDealEvent('ONCRMDEALUPDATE', dealId);
  const event = await waitForEvent(acknowledgement.eventId, 'SUCCEEDED');
  assert.equal(event.lastErrorCategory, 'DEAL_ORDER_STAGE_NOT_ENABLED');
  const operation = await app.get(DatabaseService).dealOrderCreateOperation.findUniqueOrThrow({ where: { bitrix24DealId: dealId } });
  assert.equal(operation.status, 'WAITING');
  assert.equal(createPosts, before);
});

test('public MS UPDATE waits for the already accepted CREATE instead of opening a blocking review', async () => {
  const database = app.get(DatabaseService), id = randomUUID();
  extraOrders.set(id, nativeOrder(id));
  const create = await database.inboundEvent.create({ data: {
    source: 'MOYSKLAD', eventType: 'CREATE', externalEntityType: 'customerorder', externalEntityId: id,
    deliveryKey: `delayed-create-${randomUUID()}`, payload: {}, status: 'RETRYABLE_FAILURE', retryAfter: new Date(Date.now() + 86_400_000),
  } });
  createdEventIds.push(create.id);
  const addsBefore = reverseAdds;
  const response = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-ms-first-create?requestId=${randomUUID()}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [{
      action: 'UPDATE', accountId: '11111111-1111-4111-8111-111111111111',
      meta: { type: 'customerorder', href: `${providerBase}api/remap/1.2/entity/customerorder/${id}` },
    }] }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const acknowledgement = await response.json() as { eventId: string };
  const update = await waitForEvent(acknowledgement.eventId, 'RETRYABLE_FAILURE');
  assert.equal(update.lastErrorCategory, 'PAIR_CREATE_PENDING');
  assert.equal(await database.pairReviewCase.count({ where: { sourceSystem: 'MOYSKLAD', sourceEntityId: id } }), 0);
  assert.equal(reverseAdds, addsBefore, 'an UPDATE itself must never create a new B24 deal');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: create.id } })).status, 'RETRYABLE_FAILURE');
});

test('public callback for a newly imported deal waits through the real preparer without echo-order creation', async () => {
  const database = app.get(DatabaseService);
  await database.dealOrderReverseCreateOperation.create({ data: { moyskladOrderId: echoOrderId, syncId: randomUUID(), eventId: `echo-origin-${randomUUID()}`, payload: {}, settingsVersion: 1, status: 'PENDING' } });
  const before = createPosts;
  try {
    const acknowledgement = await postDealEvent('ONCRMDEALADD', echoDealId);
    const event = await waitForEvent(acknowledgement.eventId, 'RETRYABLE_FAILURE');
    assert.equal(event.lastErrorCategory, 'REVERSE_DEAL_CREATE_PENDING');
    assert.equal(createPosts, before);
    assert.equal(await database.entityPair.count({ where: { entityType: 'DEAL', bitrix24Id: echoDealId } }), 0);
    assert.equal((await database.dealOrderCreateOperation.findUniqueOrThrow({ where: { bitrix24DealId: echoDealId } })).status, 'WAITING');
    assert.equal(await database.pairReviewCase.count({ where: { sourceEntityId: echoDealId } }), 0);
  } finally {
    await database.dealOrderCreateOperation.deleteMany({ where: { bitrix24DealId: echoDealId } });
    await database.dealOrderReverseCreateOperation.delete({ where: { moyskladOrderId: echoOrderId } });
  }
});

test('own saved forward target defers concurrent genuine CREATE/UPDATE without reverse creation, false review or failure-budget consumption', async () => {
  const db = app.get(DatabaseService), id = randomUUID(), sourceId = `83${Date.now()}71`, before = reverseAdds;
  await forwardJournal(sourceId, id);
  const ids = await Promise.all(['CREATE','UPDATE','CREATE','UPDATE'].map(action => postMs(action, id)));
  for (const eventId of ids) {
    const event = await waitForEvent(eventId, 'RETRYABLE_FAILURE');
    assert.equal(event.lastErrorCategory, 'FORWARD_ORDER_PAIR_PENDING'); assert.equal(event.attempts, 0); assert.ok(event.retryAfter);
  }
  const eventId = ids[0];
  await db.inboundEvent.update({ where: { id: eventId }, data: { attempts: 7 } });
  await app.get(PairFirstEventProcessor).process(eventId);
  assert.equal((await db.inboundEvent.findUniqueOrThrow({ where: { id: eventId } })).attempts, 7, 'future deadline prevents a claim');
  for (let poll = 0; poll < 12; poll++) {
    await db.inboundEvent.update({ where: { id: eventId }, data: { retryAfter: null } });
    await app.get(PairFirstEventProcessor).process(eventId);
  }
  assert.equal((await db.inboundEvent.findUniqueOrThrow({ where: { id: eventId } })).attempts, 7, 'wait restores only its own claim, preserving seven actual failures');
  assert.equal(await db.operationalLog.count({ where: { referenceId: eventId, message: { contains: 'FORWARD_ORDER_ECHO_DEFERRED' } } }), 1);
  assert.equal(reverseAdds, before);
  assert.equal(await db.dealOrderReverseCreateOperation.count({ where: { moyskladOrderId: id } }), 0);
  assert.equal(await db.entityPair.count({ where: { entityType: 'DEAL', moyskladId: id } }), 0);
  assert.equal(await db.pairReviewCase.count({ where: { sourceSystem: 'MOYSKLAD', sourceEntityId: id } }), 0);
});

test('actual public forward create, delayed source read failure and cold restart resume original pair; pending native callbacks never reverse-create', async () => {
  const db = app.get(DatabaseService), sourceId = `83${Date.now()}72`, id = randomUUID(), before = reverseAdds, beforePosts = createPosts;
  forwardNativeId = id; b24OrderNumber = null; b24DealTitle = 'Original forward title';
  let started!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { started = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  forwardReadBarrier = { started, wait }; failForwardReadOnce = true;
  try {
    const forward = await postDealEvent('ONCRMDEALUPDATE', sourceId);
    await observed;
    const pending = await db.dealOrderCreateOperation.findUniqueOrThrow({ where: { bitrix24DealId: sourceId } });
    assert.equal(pending.moyskladOrderId, id); assert.equal(pending.status, 'PENDING');
    const callbacks = await Promise.all(['CREATE','UPDATE'].map(action => postMs(action, id)));
    for (const callback of callbacks) assert.equal((await waitForEvent(callback, 'RETRYABLE_FAILURE')).lastErrorCategory, 'FORWARD_ORDER_PAIR_PENDING');
    assert.equal(reverseAdds, before);
    release(); await waitForEvent(forward.eventId, 'RETRYABLE_FAILURE');
    await app.close();
    app = await NestFactory.create(DealFirstEventCreatePostgresModule, { logger: false }); await app.listen(0, '127.0.0.1'); apiUrl = await app.getUrl();
    const restarted = app.get(DatabaseService);
    await restarted.inboundEvent.update({ where: { id: forward.eventId }, data: { retryAfter: null } });
    await app.get(PairFirstEventProcessor).process(forward.eventId); await waitForEvent(forward.eventId, 'SUCCEEDED');
    for (const callback of callbacks) {
      await restarted.inboundEvent.update({ where: { id: callback }, data: { retryAfter: null } });
      await app.get(PairFirstEventProcessor).process(callback); await waitForEvent(callback, 'SUCCEEDED');
    }
    const pair = await restarted.entityPair.findFirstOrThrow({ where: { entityType: 'DEAL', moyskladId: id } });
    assert.equal(pair.bitrix24Id, sourceId); assert.equal(createPosts, beforePosts + 1); assert.equal(reverseAdds, before);
    assert.equal(await restarted.dealOrderReverseCreateOperation.count({ where: { moyskladOrderId: id } }), 0);
    assert.equal(await restarted.pairReviewCase.count({ where: { sourceEntityId: id } }), 0);
    assert.equal(b24DealTitle, 'Original forward title');
  } finally { release(); forwardReadBarrier = null; failForwardReadOnce = false; forwardNativeId = refs.order; }
});

test('native syncId proves an attempted forward origin before target-ID save; a temporary native read failure cannot create or poison a reverse pair', async () => {
  const db = app.get(DatabaseService), sourceId = `83${Date.now()}73`, id = randomUUID(), before = reverseAdds;
  const syncId = randomUUID(); const input = preparedOrder(sourceId, 'lost-response-original');
  await db.dealOrderCreateOperation.create({ data: { bitrix24DealId: sourceId, syncId, payload: input.payload, confirmedCustomerPairIds: [companyPairId], settingsVersion: 1, status: 'PENDING', attemptedAt: new Date() } });
  extraOrders.set(id, nativeOrder(id, { ...input.payload, syncId }));
  failNativeReadOnce = true;
  const failed = await postMs('UPDATE', id); const failedEvent = await waitForEvent(failed, 'RETRYABLE_FAILURE');
  assert.equal(failedEvent.lastErrorCategory, 'ORDER_ORGANIZATION_READ_RETRY');
  const waiting = await postMs('CREATE', id); assert.equal((await waitForEvent(waiting, 'RETRYABLE_FAILURE')).lastErrorCategory, 'FORWARD_ORDER_PAIR_PENDING');
  assert.equal(reverseAdds, before); assert.equal(await db.pairReviewCase.count({ where: { sourceEntityId: id } }), 0);
  await app.get(DealOrderCreateOperationService).createAndPair(input);
  for (const eventId of [failed, waiting]) {
    await db.inboundEvent.update({ where: { id: eventId }, data: { retryAfter: null } });
    await app.get(PairFirstEventProcessor).process(eventId); await waitForEvent(eventId, 'SUCCEEDED');
  }
  assert.equal((await db.entityPair.findFirstOrThrow({ where: { entityType: 'DEAL', moyskladId: id } })).bitrix24Id, sourceId);
  assert.equal(reverseAdds, before); assert.equal([...extraOrders.values()].filter(order => order.syncId === syncId).length, 1);
});

test('reverse mutation gate rechecks a forward target saved after resolution/preparation, before any Bitrix ADD', async () => {
  const db = app.get(DatabaseService), id = randomUUID(), sourceId = `83${Date.now()}74`, before = reverseAdds;
  extraOrders.set(id, nativeOrder(id));
  beforeReverseAdd = async () => { await forwardJournal(sourceId, id); };
  try {
    const event = await waitForEvent(await postMs('CREATE', id), 'RETRYABLE_FAILURE');
    assert.equal(event.lastErrorCategory, 'FORWARD_ORDER_PAIR_PENDING'); assert.equal(event.attempts, 0);
    assert.equal(reverseAdds, before); assert.equal(await db.entityPair.count({ where: { entityType: 'DEAL', moyskladId: id } }), 0);
    const journal = await db.dealOrderReverseCreateOperation.findUniqueOrThrow({ where: { moyskladOrderId: id } });
    assert.equal(journal.status, 'WAITING'); assert.equal(journal.bitrix24DealId, null);
    assert.equal(journal.lastErrorCategory, 'FORWARD_ORDER_PAIR_PENDING');
  } finally { beforeReverseAdd = null; }
});

test('a native marker matching an unattempted reservation is not proof of our CREATE; a genuine external order still creates one deal', async () => {
  const db = app.get(DatabaseService), id = randomUUID(), sourceId = `83${Date.now()}75`, syncId = randomUUID(), before = reverseAdds;
  await db.dealOrderCreateOperation.create({ data: { bitrix24DealId: sourceId, syncId, payload: {}, settingsVersion: 1, status: 'WAITING' } });
  extraOrders.set(id, nativeOrder(id, { syncId, description: 'FORWARD_CREATED_MARKER_ONLY' }));
  const event = await postMs('CREATE', id); await waitForEvent(event, 'SUCCEEDED');
  assert.equal(reverseAdds, before + 1);
  assert.ok(await db.entityPair.findFirst({ where: { entityType: 'DEAL', moyskladId: id } }));
});

test('OFF fences an already received native echo without claims, reverse writes or journal changes', async () => {
  const db = app.get(DatabaseService), id = randomUUID(), sourceId = `83${Date.now()}76`, before = reverseAdds;
  const origin = await forwardJournal(sourceId, id);
  await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'off' } });
  const event = await db.inboundEvent.create({ data: { source: 'MOYSKLAD', eventType: 'CREATE', externalEntityType: 'customerorder', externalEntityId: id, deliveryKey: randomUUID(), payload: {}, status: 'RECEIVED' } });
  createdEventIds.push(event.id);
  try {
    await app.get(PairFirstEventProcessor).process(event.id);
    assert.equal((await db.inboundEvent.findUniqueOrThrow({ where: { id: event.id } })).attempts, 0);
    assert.equal((await db.inboundEvent.findUniqueOrThrow({ where: { id: event.id } })).status, 'RECEIVED');
    assert.equal(reverseAdds, before); assert.deepEqual(await db.dealOrderCreateOperation.findUniqueOrThrow({ where: { bitrix24DealId: sourceId } }), origin);
  } finally { await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on', offSince: null } }); }
});

async function forwardJournal(sourceId: string, target: string) {
  if (!extraOrders.has(target)) extraOrders.set(target, nativeOrder(target));
  return app.get(DatabaseService).dealOrderCreateOperation.create({ data: { bitrix24DealId: sourceId, syncId: randomUUID(), payload: {}, settingsVersion: 1, status: 'PENDING', moyskladOrderId: target, attemptedAt: new Date() } });
}
async function postMs(action: string, id: string): Promise<string> {
  const response = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-ms-first-create?requestId=${randomUUID()}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [{ action, accountId: '11111111-1111-4111-8111-111111111111', meta: { type: 'customerorder', href: `${providerBase}api/remap/1.2/entity/customerorder/${id}` } }] }) });
  assert.equal(response.status, 200); const body = await response.json() as { eventId: string }; createdEventIds.push(body.eventId); return body.eventId;
}
function nativeOrder(id: string, payload: Record<string, any> = {}): Record<string, any> {
  return { id, name: 'SO-TEST-1', meta: { type: 'customerorder' }, sum: 0,
    agent: { id: company.moyskladId, meta: { type: 'counterparty' } }, state: { id: refs.state }, rate: { currency: { id: refs.currency } },
    ...payload,
    // The production organization filter validates native reference identity,
    // not the loopback transport used by this provider fixture.
    organization: { id: refs.organization, meta: { type: 'organization', href: `https://api.moysklad.ru/api/remap/1.2/entity/organization/${refs.organization}` } },
    positions: { rows: (payload.positions ?? []).map((p: any) => ({ ...p, id: refs.position })) } };
}

async function postDealEvent(event: string, id: string): Promise<{ eventId: string }> {
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ event, 'auth[application_token]': 'synthetic-b24-event-token', 'data[FIELDS][ID]': id }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ eventId: string }>;
}

async function waitForEvent(eventId: string, status: string) {
  const database = app.get(DatabaseService);
  const deadline = Date.now() + 5_000;
  let event = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
  createdEventIds.push(eventId);
  while (event.status !== status && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    event = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
  }
  assert.equal(event.status, status, `event should finish in ${status}`);
  return event;
}

function preparedOrder(dealId: string, eventId: string) {
  const base = new URL('api/remap/1.2/', providerBase).toString();
  const ref = (type: string, id: string) => ({ meta: { type, href: `${base}entity/${type}/${id}` } });
  return {
    bitrix24DealId: dealId, bitrix24CompanyId: company.bitrix24Id, bitrix24ContactId: null,
    confirmedCustomerPairIds: [companyPairId], eventId, settingsVersion: 1,
    sourceProductIds: [product.bitrix24Id], sourceRowIds: ['301'],
    sourceRowValues: [{ id: '301', productId: Number(product.bitrix24Id), quantity: 2, price: 12500, measureCode: 796 }],
    sourceMeasureCodes: [796], unitMappings: [{ bitrix24Id: 9, bitrix24Code: '796', moyskladId: refs.unit, status: 'configured' as const }],
    payload: {
      agent: ref('counterparty', company.moyskladId), organization: ref('organization', refs.organization),
      store: ref('store', refs.store), state: { meta: { type: 'state', href: `${base}entity/customerorder/metadata/states/${refs.state}` } },
      owner: ref('employee', refs.employee), rate: { currency: ref('currency', refs.currency) },
      positions: [{ assortment: ref('product', product.moyskladId), quantity: 2, price: 12500, discount: 0, vat: 0, vatEnabled: false }],
    },
  };
}

async function reply(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  const form = new URLSearchParams(text);
  const url = new URL(request.url ?? '/', providerBase);
  const extraId = url.pathname.match(/\/entity\/customerorder\/([0-9a-f-]{36})(\/positions)?$/)?.[1];
  if (extraId && extraOrders.has(extraId)) {
    if (failNativeReadOnce) { failNativeReadOnce = false; response.writeHead(503); response.end('temporary'); return; }
    const order = extraOrders.get(extraId)!;
    return send(response, url.pathname.endsWith('/positions') ? { rows: order.positions.rows, meta: { size: order.positions.rows.length, offset: 0, limit: 1000 } } : order);
  }
  if (url.pathname === '/rest/crm.deal.get.json' && form.get('id') === echoDealId) return send(response, { result: { ID: echoDealId, ORIGINATOR_ID: 'MOYSKLAD', ORIGIN_ID: echoOrderId } });
  if (['/rest/crm.item.add', '/rest/crm.item.get'].includes(url.pathname) && JSON.parse(text).useOriginalUfNames !== 'Y') {
    response.writeHead(400); response.end(JSON.stringify({ error: '100', error_description: 'useOriginalUfNames expects native Y/N string' })); return;
  }
  if(url.pathname===`/api/remap/1.2/entity/customerorder/${reverseOrderId}`)return send(response,{...nativeOrder(reverseOrderId),name:'SYNTHETIC-REVERSE',state:{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}});
  if(url.pathname===`/api/remap/1.2/entity/customerorder/${reverseOrderId}/positions`)return send(response,{rows:[],meta:{size:0,offset:0,limit:1000}});
  if(url.pathname==='/rest/crm.item.list'){
    if (beforeReverseAdd) { const hook = beforeReverseAdd; beforeReverseAdd = null; await hook(); }
    const requested = JSON.parse(text).filter?.originId;
    return send(response,{result:{items:reverseItem && reverseItem.originId === requested ? [reverseItem]:[]}});
  }
  if(url.pathname==='/rest/crm.item.add'){
    reverseAdds++;reverseItem={...JSON.parse(text).fields,id:`83${Date.now()}99`};
    return send(response,{result:{item:reverseItem}});
  }
  if(url.pathname==='/rest/crm.item.get')return send(response,{result:{item:reverseItem}});
  if(url.pathname==='/rest/crm.item.productrow.list')return send(response,{result:{productRows:[]},total:0});
  const typeAndId = url.pathname.match(/\/entity\/(counterparty|organization|store|employee|currency|product)\/([0-9a-f-]{36})$/i);
  if (typeAndId) {
    const [, type, id] = typeAndId;
    return send(response, { id, meta: { type }, ...(type === 'product' ? { uom: { id: refs.unit } } : {}) });
  }
  const state = url.pathname.match(/\/entity\/customerorder\/metadata\/states\/([0-9a-f-]{36})$/i);
  if (state) return send(response, { id: state[1], meta: { type: 'state' } });
  if (url.pathname === '/api/remap/1.2/entity/customerorder' && request.method === 'POST') {
    createPosts++;
    orderPayload = JSON.parse(text) as Record<string, any>;
    const recovered = [...extraOrders.values()].find(order => order.syncId === orderPayload?.syncId);
    const id = recovered?.id ?? forwardNativeId;
    if (id !== refs.order) extraOrders.set(id, nativeOrder(id, orderPayload));
    return send(response, { id, name: 'SO-TEST-1', meta: { type: 'customerorder' } });
  }
  if (url.pathname === `/api/remap/1.2/entity/customerorder/${refs.order}`) {
    const positions = orderPayload?.positions as Array<Record<string, any>> | undefined;
    return send(response, { id: refs.order, name: 'SO-TEST-1', meta: { type: 'customerorder' },
      positions: { rows: (positions ?? []).map((position) => ({ ...position, id: refs.position })) } });
  }
  if (url.pathname === '/rest/crm.deal.get.json') {
    if (forwardReadBarrier) { const barrier = forwardReadBarrier; forwardReadBarrier = null; barrier.started(); await barrier.wait; }
    if (failForwardReadOnce) { failForwardReadOnce = false; response.writeHead(503); response.end('{}'); return; }
    return send(response, { result: { ID: form.get('id'), TITLE: b24DealTitle, UF_CRM_1729757435964: b24OrderNumber } });
  }
  if (url.pathname === '/rest/crm.deal.update.json') {
    b24OrderNumber = form.get('fields[UF_CRM_1729757435964]');
    if (form.has('fields[TITLE]')) b24DealTitle = form.get('fields[TITLE]');
    return send(response, { result: true });
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{}');
}

function send(response: ServerResponse, value: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
