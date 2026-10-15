import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DatabaseService } from '../src/database.service';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { SyncModeService } from '../src/sync-mode.service';
import { ContactSyncProcessor } from '../src/contact-sync.service';
import { EntityPairService } from '../src/pairs/entity-pair.service';
import { PairResolutionProvider } from '../src/pairs/pair-resolution.provider';
import { PAIR_RESOLVER } from '../src/pairs/pair-resolver';
import { PairFirstEventProcessor } from '../src/pairs/pair-first-event.processor';

@Module({
  controllers: [EventsController],
  providers: [
    DatabaseService, EventIntakeService, SyncModeService,
    { provide: ContactSyncProcessor, useValue: { enqueue: () => undefined } },
    EntityPairService, PairResolutionProvider, { provide: PAIR_RESOLVER, useExisting: PairResolutionProvider }, PairFirstEventProcessor,
  ],
})
class PairResolutionPostgresModule {}

let app: INestApplication;
let apiUrl: string;
const suffix = randomUUID();
const createdPairIds: string[] = [];
const createdReviewIds: string[] = [];
const createdEventIds: string[] = [];

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to an isolated ephemeral PostgreSQL database');
  assert.equal(process.env.PAIR_RESOLUTION_TEST_ISOLATED, '1', 'set PAIR_RESOLUTION_TEST_ISOLATED=1 only for the isolated test database');
  const databaseUrl = new URL(process.env.DATABASE_URL);
  assert.match(databaseUrl.hostname, /^(localhost|127\.0\.0\.1|postgres)$/i, 'refusing to run against a non-local database host');
  assert.match(databaseUrl.pathname, /(test|issue11|verify)/i, 'refusing to run unless the database name identifies an isolated test database');
  process.env.SYNC_MODE = 'dry';
  const dryUrl = new URL(process.env.DATABASE_URL);
  dryUrl.searchParams.set('schema', 'dry_pair_resolution_test');
  process.env.DRY_DATABASE_URL = dryUrl.toString();
  process.env.SYNC_STATE = 'on';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-b24-event-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'synthetic-ms-webhook-secret';
  app = await NestFactory.create(PairResolutionPostgresModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  await app.get(DatabaseService).syncSetting.upsert({
    where: { id: 'global' }, create: { serviceMode: 'on' }, update: { serviceMode: 'on', offSince: null },
  });
});

after(async () => {
  if (app) {
    const database = app.get(DatabaseService);
    await database.pairReviewCase.deleteMany({ where: { id: { in: createdReviewIds } } });
    await database.entityPair.deleteMany({ where: { id: { in: createdPairIds } } });
    await database.inboundEvent.deleteMany({ where: { id: { in: createdEventIds } } });
    (app.getHttpServer() as import('node:http').Server).closeAllConnections();
    await app.close();
  }
});

test('PostgreSQL enforces canonical type and one active pair per entity on each side', async () => {
  const database = app.get(DatabaseService);
  const id = `t11-${suffix}`;
  await assert.rejects(() => database.entityPair.create({ data: {
    entityType: 'SMART_INVOICE', bitrix24Id: `${id}-unsupported`, moyskladId: `${id}-unsupported`, source: 'MANUAL',
  } }));
  const first = await database.entityPair.create({ data: {
    entityType: 'DEAL', bitrix24Id: `${id}-b24`, moyskladId: `${id}-ms`, source: 'MANUAL',
  } });
  createdPairIds.push(first.id);
  await assert.rejects(() => database.entityPair.create({ data: {
    entityType: 'DEAL', bitrix24Id: `${id}-b24`, moyskladId: `${id}-ms2`, source: 'MANUAL',
  } }));
});

test('concurrent first-event resolutions converge on one open review case', async () => {
  const database = app.get(DatabaseService);
  const provider = app.get(PairResolutionProvider);
  const eventId = `event-${suffix}`;
  const input = { entityType: 'DEAL' as const, sourceSystem: 'BITRIX24' as const, externalId: `unpaired-${suffix}`, eventId };
  const results = await Promise.all([provider.resolve(input), provider.resolve(input)]);
  assert.ok(results.every((result) => result.status === 'manual_review'));
  const reviews = await database.pairReviewCase.findMany({ where: { entityType: 'DEAL', sourceSystem: 'BITRIX24', sourceEntityId: input.externalId, status: 'OPEN' } });
  assert.equal(reviews.length, 1);
  createdReviewIds.push(reviews[0].id);
});

test('assignment racing first-event resolution leaves the persisted pair authoritative and no orphan review', async () => {
  const database = app.get(DatabaseService);
  const provider = app.get(PairResolutionProvider);
  const pairs = app.get(EntityPairService);
  const bitrix24Id = `racing-b24-${suffix}`;
  const moyskladId = `racing-ms-${suffix}`;
  const event = await database.inboundEvent.create({ data: {
    source: 'BITRIX24', deliveryKey: `race-${suffix}`, eventType: 'ONCRMDEALADD',
    externalEntityId: bitrix24Id, externalEntityType: 'deal', payload: {}, status: 'RECEIVED',
  } });
  createdEventIds.push(event.id);
  const previouslyUnavailableEvent = await database.inboundEvent.create({ data: {
    source: 'BITRIX24', deliveryKey: `race-unavailable-${suffix}`, eventType: 'ONCRMDEALUPDATE',
    externalEntityId: bitrix24Id, externalEntityType: 'deal', payload: {}, status: 'MANUAL_REVIEW',
    lastErrorCategory: 'PAIR_RESOLUTION_UNAVAILABLE',
  } });
  createdEventIds.push(previouslyUnavailableEvent.id);
  const resolution = app.get(PairFirstEventProcessor).process(event.id);
  const assignment = pairs.assign({ entityType: 'DEAL', bitrix24Id, moyskladId });
  const [result, pair] = await Promise.all([resolution, assignment]);
  createdPairIds.push(pair.id);
  assert.ok(result?.status === 'manual_review' || result?.status === 'confirmed');
  const authoritative = await provider.resolve({ entityType: 'DEAL', sourceSystem: 'BITRIX24', externalId: bitrix24Id });
  assert.equal(authoritative.status, 'confirmed');
  const openReviews = await database.pairReviewCase.findMany({ where: { entityType: 'DEAL', sourceSystem: 'BITRIX24', sourceEntityId: bitrix24Id, status: 'OPEN' } });
  assert.equal(openReviews.length, 0);
  const finalEvent = await database.inboundEvent.findUnique({ where: { id: event.id } });
  assert.equal(finalEvent?.status, 'SUCCEEDED', 'pair assignment clears a stale manual hold and the claim-safe resolver completes');
  assert.equal(finalEvent?.lastErrorCategory, null);
  const recoveredUnavailableEvent = await waitForEventStatus(database, previouslyUnavailableEvent.id, 'SUCCEEDED');
  assert.equal(recoveredUnavailableEvent?.status, 'SUCCEEDED', 'a successful explicit assignment releases prior resolver-outage holds and completes the event');
  assert.equal(recoveredUnavailableEvent?.lastErrorCategory, null);
  const allReviews = await database.pairReviewCase.findMany({ where: { entityType: 'DEAL', sourceSystem: 'BITRIX24', sourceEntityId: bitrix24Id } });
  createdReviewIds.push(...allReviews.map((review) => review.id));
});

async function waitForEventStatus(database: DatabaseService, eventId: string, expected: string) {
  const deadline = Date.now() + 3_000;
  let event = await database.inboundEvent.findUnique({ where: { id: eventId } });
  while (event?.status !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    event = await database.inboundEvent.findUnique({ where: { id: eventId } });
  }
  return event;
}

test('public webhook invokes first-event resolution and durably holds unresolved event for manual review', async () => {
  const id = `deal-${suffix}`;
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ event: 'ONCRMDEALADD', 'auth[application_token]': 'synthetic-b24-event-token', 'data[FIELDS][ID]': id }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { eventId: string };
  createdEventIds.push(ack.eventId);
  const database = app.get(DatabaseService);
  let event = await database.inboundEvent.findUnique({ where: { id: ack.eventId } });
  for (let attempt = 0; attempt < 100 && ['RECEIVED', 'PROCESSING'].includes(event?.status ?? ''); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    event = await database.inboundEvent.findUnique({ where: { id: ack.eventId } });
  }
  assert.equal(event?.status, 'MANUAL_REVIEW');
  assert.equal(event?.lastErrorCategory, 'PAIR_REVIEW_REQUIRED');
  const review = await database.pairReviewCase.findFirst({ where: { entityType: 'DEAL', sourceSystem: 'BITRIX24', sourceEntityId: id, status: 'OPEN' } });
  assert.ok(review);
  createdReviewIds.push(review.id);
});

test('typed manual CONTACT pair resolves on a subsequent event and leaves prior events untouched', async () => {
  const database = app.get(DatabaseService);
  const bitrix24Id = `contact-b24-${suffix}`;
  const moyskladId = `contactperson-ms-${suffix}`;
  const parentId = `counterparty-parent-${suffix}`;
  const oldBitrixEvent = await database.inboundEvent.create({ data: {
    source: 'BITRIX24', deliveryKey: `old-contact-b24-${suffix}`, eventType: 'ONCRMCONTACTUPDATE',
    externalEntityId: bitrix24Id, externalEntityType: 'deal', payload: {}, status: 'MANUAL_REVIEW', lastErrorCategory: 'PAIR_REVIEW_REQUIRED',
  } });
  const oldMoyskladEvent = await database.inboundEvent.create({ data: {
    source: 'MOYSKLAD', deliveryKey: `old-contact-ms-${suffix}`, eventType: 'UPDATE',
    externalEntityId: moyskladId, externalEntityType: 'customerorder', payload: {}, status: 'MANUAL_REVIEW', lastErrorCategory: 'PAIR_REVIEW_REQUIRED',
  } });
  createdEventIds.push(oldBitrixEvent.id, oldMoyskladEvent.id);
  const pair = await app.get(EntityPairService).assign({
    entityType: 'CONTACT', bitrix24Id, moyskladId, moyskladType: 'contactperson', moyskladParentId: parentId,
  });
  createdPairIds.push(pair.id);
  assert.equal(pair.moyskladType, 'contactperson');
  assert.equal(pair.moyskladParentId, parentId);

  const resolved = await app.get(PairResolutionProvider).resolve({ entityType: 'CONTACT', sourceSystem: 'BITRIX24', externalId: bitrix24Id, eventId: `next-${suffix}` });
  assert.equal(resolved.status, 'confirmed');
  if (resolved.status === 'confirmed') {
    assert.equal(resolved.pair.moyskladType, 'contactperson');
    assert.equal(resolved.pair.moyskladParentId, parentId);
  }
  const [stillOldBitrix, stillOldMoysklad] = await Promise.all([
    database.inboundEvent.findUnique({ where: { id: oldBitrixEvent.id } }),
    database.inboundEvent.findUnique({ where: { id: oldMoyskladEvent.id } }),
  ]);
  assert.equal(stillOldBitrix?.status, 'MANUAL_REVIEW');
  assert.equal(stillOldMoysklad?.status, 'MANUAL_REVIEW');
});

test('confirmed pair lookup reports identity without mutating baseline readiness', async () => {
  const database = app.get(DatabaseService);
  const bitrix24Id = `confirmed-b24-${suffix}`;
  const moyskladId = `confirmed-ms-${suffix}`;
  const pair = await app.get(EntityPairService).assign({ entityType: 'DEAL', bitrix24Id, moyskladId });
  createdPairIds.push(pair.id);
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ event: 'ONCRMDEALADD', 'auth[application_token]': 'synthetic-b24-event-token', 'data[FIELDS][ID]': bitrix24Id }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { eventId: string };
  createdEventIds.push(ack.eventId);
  const event = await waitForEventStatus(database, ack.eventId, 'SUCCEEDED');
  assert.equal(event?.status, 'SUCCEEDED');
  assert.equal(event?.lastErrorCategory, null);
});

test('public MoySklad customer-order webhook resolves through the canonical DEAL type', async () => {
  const id = `order-${suffix}`;
  const response = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-ms-webhook-secret?requestId=pair-test-${suffix}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{
      meta: { type: 'customerorder', href: `https://online.moysklad.ru/api/remap/1.2/entity/customerorder/${id}` },
      action: 'CREATE',
    }] }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { eventId: string };
  createdEventIds.push(ack.eventId);
  const database = app.get(DatabaseService);
  let event = await database.inboundEvent.findUnique({ where: { id: ack.eventId } });
  for (let attempt = 0; attempt < 100 && ['RECEIVED', 'PROCESSING'].includes(event?.status ?? ''); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    event = await database.inboundEvent.findUnique({ where: { id: ack.eventId } });
  }
  assert.equal(event?.status, 'MANUAL_REVIEW');
  assert.equal(event?.lastErrorCategory, 'PAIR_REVIEW_REQUIRED');
  const review = await database.pairReviewCase.findFirst({ where: { entityType: 'DEAL', sourceSystem: 'MOYSKLAD', sourceEntityId: id, status: 'OPEN' } });
  assert.ok(review);
  createdReviewIds.push(review.id);
});
