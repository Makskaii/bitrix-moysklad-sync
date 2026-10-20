import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { AdminAccessGuard } from '../src/admin/admin-access.guard';
import { AdminController } from '../src/admin/admin.controller';
import { ContactSyncStatusController } from '../src/admin/contact-sync-status.controller';
import { SyncModeController } from '../src/admin/sync-mode.controller';
import { ContactSyncProcessor, ContactSyncStatusReader } from '../src/contact-sync.service';
import { DatabaseService } from '../src/database.service';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { SyncModeService } from '../src/sync-mode.service';
import { SyncRecoveryService } from '../src/sync-recovery.service';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { ReadOnlyFieldDataProvider } from '../src/field-settings/read-only-field-data.provider';
import { EntityPairService } from '../src/pairs/entity-pair.service';

@Module({
  controllers: [EventsController, AdminController, ContactSyncStatusController, SyncModeController],
  providers: [DatabaseService, EventIntakeService, ContactSyncProcessor, ContactSyncStatusReader, AdminAccessGuard,
    SyncModeService, SyncRecoveryService, ReadOnlyFieldDataProvider, EntityPairService, FieldSettingsService],
})
class RealDatabaseContactSyncModule {}

let app: INestApplication;
let apiUrl: string;
let mockUrl: string;
let mockServer: Server;
let originalFetch: typeof fetch;
const NativeDate = globalThis.Date;
let destinationEmail = 'before@example.test';
let writeCount = 0;
let failNextWrite = false;
let failNextWriteRetryAfter: string | null = null;
let writeDelayMs = 0;
let barrierMoyskladReads = false;
let holdMoyskladReads = false;
let moyskladReadArrivals = 0;
let releaseMoyskladReads = () => {};
let moyskladReadBarrier = Promise.resolve();
const nightlyProviderQueries: string[] = [];
let nightlyBitrixCompanyIds: string[] = [];
let nightlyBitrixSecondPageIds: string[] = [];
let nightlyMoyskladMetaSize = 0;
const nightlyContactpersonsByParent = new Map<string, Array<{ id: string; updated: string }>>();
let failNightlyBitrixFeed = false;
let nightlyBitrixRetryAfter = '3600';
let holdNightlyCompanyFeed = false;
let nightlyCompanyFeedArrived = false;
let releaseNightlyCompanyFeed = () => {};

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to the isolated ephemeral PostgreSQL database');
  process.env.SYNC_MODE = 'apply';
  process.env.SYNC_STATE = 'on';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-b24-event-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'synthetic-ms-webhook-secret';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-ms-api-token';

  // The suite reuses a disposable UTF8 database. Reset its durable event and
  // scheduler state before Nest starts recovery scans during bootstrap.
  const setupDatabase = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  await setupDatabase.inboundEvent.deleteMany({});
  await setupDatabase.syncSetting.upsert({
    where: { id: 'global' }, create: { serviceMode: 'pause' },
    update: {
      serviceMode: 'pause', lastInactiveAt: null, lastActiveAt: null,
      modeHistoryTrackedFrom: null,
      nightlyScheduledDate: null, nightlyStatus: 'idle', nightlyFrom: null, nightlyThrough: null,
      nightlyProvider: 'BITRIX24', nightlyBitrixStart: 0, nightlyBitrixEntityTypeId: 3,
      nightlyBitrixLastId: null, nightlyMoyskladOffset: 0, nightlyMoyskladEntity: 'counterparty', nightlyBitrixStatus: 'skipped',
      nightlyMoyskladStatus: 'skipped', nightlyLeaseToken: null, nightlyLeaseExpiresAt: null,
      nightlyRetryAfter: null, nightlyAttempts: 0, nightlyError: null,
    },
  });
  await setupDatabase.syncModeTransition.deleteMany({});
  await setupDatabase.$disconnect();

  mockServer = createServer((request, response) => { void handleExternalRequest(request, response); });
  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const address = mockServer.address();
  assert.ok(address && typeof address !== 'string');
  mockUrl = `http://127.0.0.1:${address.port}`;
  process.env.BITRIX24_REST_BASE_URL = `${mockUrl}/rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${mockUrl}/api/`;

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://aerosystems.bitrix24.ru/rest/user.admin.json') {
      const token = new URLSearchParams(init?.body?.toString() ?? '').get('auth');
      return new Response(JSON.stringify({ result: token === 'synthetic-admin-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  };

  app = await NestFactory.create(RealDatabaseContactSyncModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  const encoding = await app.get(DatabaseService).$queryRaw<Array<{ encoding: string }>>`SELECT current_setting('server_encoding') AS encoding`;
  assert.equal(encoding[0]?.encoding, 'UTF8', 'isolated PostgreSQL tests require UTF8 server encoding');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await app.get(DatabaseService).syncSetting.upsert({
    where: { id: 'global' }, create: { serviceMode: 'on' }, update: {
      serviceMode: 'on', offSince: null, lastInactiveAt: null, lastActiveAt: null,
      nightlyScheduledDate: null, nightlyStatus: 'idle', nightlyFrom: null, nightlyThrough: null,
      nightlyProvider: 'BITRIX24', nightlyBitrixStart: 0, nightlyBitrixEntityTypeId: 3,
      nightlyBitrixLastId: null, nightlyMoyskladOffset: 0, nightlyBitrixStatus: 'pending',
      nightlyMoyskladStatus: 'pending', nightlyLeaseToken: null, nightlyLeaseExpiresAt: null,
      nightlyRetryAfter: null, nightlyAttempts: 0, nightlyError: null,
    },
  });
});

after(async () => {
  if (app) {
    (app.getHttpServer() as Server).closeAllConnections();
    await app.close();
  }
  if (mockServer) {
    mockServer.closeAllConnections();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  }
  if (originalFetch) globalThis.fetch = originalFetch;
});

test('real PostgreSQL persists the public intake and processing status across API restart', async () => {
  const database = app.get(DatabaseService);
  const suffix = randomUUID();
  const contactId = `t08-contact-${suffix}`;
  const counterpartyId = `t08-counterparty-${suffix}`;
  const pair = await database.contactPair.create({
    data: { bitrix24ContactId: contactId, moyskladCounterpartyId: counterpartyId, moyskladType: 'COUNTERPARTY' },
  });
  await database.contactSnapshot.create({
    data: {
      pairId: pair.id,
      bitrix24Email: 'before@example.test',
      moyskladEmail: 'before@example.test',
      bitrix24UpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
      moyskladUpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
      revision: 1,
    },
  });

  const acknowledgement = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: contactId } },
      auth: { application_token: 'synthetic-b24-event-token' },
    }),
  });
  assert.equal(acknowledgement.status, 200);
  const ack = await acknowledgement.json() as { accepted: boolean; eventId: string };
  assert.equal(ack.accepted, true);

  let status = await waitForStatus(apiUrl, ack.eventId, 'SUCCEEDED');
  assert.equal(status.snapshotRevision, 2);
  assert.equal(status.direction, 'BITRIX24_TO_MOYSKLAD');
  assert.equal(destinationEmail, 'after@example.test');
  assert.equal(writeCount, 1);

  (app.getHttpServer() as Server).closeAllConnections();
  await app.close();
  app = await NestFactory.create(RealDatabaseContactSyncModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  status = await readStatus(apiUrl, ack.eventId);
  assert.equal(status.status, 'SUCCEEDED');
  assert.equal(status.snapshotRevision, 2);
  assert.equal(status.attempts, 1);
  assert.equal(destinationEmail, 'after@example.test');
  assert.equal(writeCount, 1);
});

test('two API instances preserve identical public notifications and serialize their processing', async () => {
  destinationEmail = 'before@example.test';
  writeCount = 0;
  writeDelayMs = 200;
  barrierMoyskladReads = true;
  moyskladReadArrivals = 0;
  moyskladReadBarrier = new Promise<void>((resolve) => { releaseMoyskladReads = resolve; });
  const database = app.get(DatabaseService);
  const suffix = randomUUID();
  const contactId = `t08-race-contact-${suffix}`;
  const pair = await database.contactPair.create({
    data: { bitrix24ContactId: contactId, moyskladCounterpartyId: `t08-race-counterparty-${suffix}` },
  });
  await database.contactSnapshot.create({
    data: {
      pairId: pair.id,
      bitrix24Email: 'before@example.test',
      moyskladEmail: 'before@example.test',
      bitrix24UpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
      moyskladUpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
      revision: 1,
    },
  });
  const secondApp = await NestFactory.create(RealDatabaseContactSyncModule, { logger: false });
  await secondApp.listen(0, '127.0.0.1');
  const secondApiUrl = await secondApp.getUrl();
  const body = JSON.stringify({
    event: 'ONCRMCONTACTUPDATE',
    data: { FIELDS: { ID: contactId } },
    auth: { application_token: 'synthetic-b24-event-token' },
  });
  try {
    process.env.SYNC_STATE = 'pause';
    const initialResponse = await fetch(`${apiUrl}/webhooks/bitrix24`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    assert.equal(initialResponse.status, 200);
    const initialAck = await initialResponse.json() as { eventId: string };
    process.env.SYNC_STATE = 'on';
    const responses = await Promise.all([apiUrl, secondApiUrl].map((url) => fetch(`${url}/webhooks/bitrix24`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })));
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const acknowledgements = await Promise.all(responses.map((response) => response.json() as Promise<{ eventId: string }>));
    assert.notEqual(acknowledgements[0].eventId, initialAck.eventId);
    assert.notEqual(acknowledgements[1].eventId, initialAck.eventId);
    assert.notEqual(acknowledgements[0].eventId, acknowledgements[1].eventId);
    const settled = await Promise.all([initialAck, ...acknowledgements].map(({ eventId }) => waitForSettledStatus(apiUrl, eventId)));
    assert.deepEqual(settled.map((event) => event.status).sort(), ['SUCCEEDED', 'SUPERSEDED', 'SUPERSEDED']);
    assert.equal(await database.inboundEvent.count({ where: { externalEntityId: contactId } }), 3);
    assert.equal(settled.find((event) => event.status === 'SUCCEEDED')?.attempts, 1);
    assert.equal(destinationEmail, 'after@example.test');
    assert.equal(writeCount, 1);
  } finally {
    (secondApp.getHttpServer() as Server).closeAllConnections();
    await secondApp.close();
    writeDelayMs = 0;
    barrierMoyskladReads = false;
  }
});

test('two API instances serialize distinct pending events for the same contact', async () => {
  destinationEmail = 'before@example.test';
  writeCount = 0;
  writeDelayMs = 200;
  const database = app.get(DatabaseService);
  const suffix = randomUUID();
  const contactId = `t21-distinct-contact-${suffix}`;
  const counterpartyId = `t21-distinct-counterparty-${suffix}`;
  await database.contactPair.create({
    data: {
      bitrix24ContactId: contactId,
      moyskladCounterpartyId: counterpartyId,
      moyskladType: 'COUNTERPARTY',
      snapshot: { create: {
        bitrix24Email: 'before@example.test',
        moyskladEmail: 'before@example.test',
        bitrix24UpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
        moyskladUpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
      } },
    },
  });
  const secondApp = await NestFactory.create(RealDatabaseContactSyncModule, { logger: false });
  await secondApp.listen(0, '127.0.0.1');
  const secondApiUrl = await secondApp.getUrl();
  holdMoyskladReads = true;
  moyskladReadArrivals = 0;
  moyskladReadBarrier = new Promise<void>((resolve) => { releaseMoyskladReads = resolve; });
  try {
    const body = (ts: string) => JSON.stringify({
      event: 'ONCRMCONTACTUPDATE', ts,
      data: { FIELDS: { ID: contactId } },
      auth: { application_token: 'synthetic-b24-event-token' },
    });
    const firstResponse = await fetch(`${apiUrl}/webhooks/bitrix24`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: body('distinct-1'),
    });
    assert.equal(firstResponse.status, 200);
    const firstAck = await firstResponse.json() as { eventId: string };
    await waitUntil(() => moyskladReadArrivals === 1);

    const secondResponse = await fetch(`${secondApiUrl}/webhooks/bitrix24`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: body('distinct-2'),
    });
    assert.equal(secondResponse.status, 200);
    const secondAck = await secondResponse.json() as { eventId: string };
    assert.notEqual(firstAck.eventId, secondAck.eventId);
    assert.equal(await database.inboundEvent.count({ where: { externalEntityId: contactId } }), 2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const concurrentReads = moyskladReadArrivals;
    releaseMoyskladReads();
    holdMoyskladReads = false;
    assert.equal(concurrentReads, 1, 'the second instance must wait for the first entity lease');
    const settled = await Promise.all([firstAck, secondAck].map(({ eventId }) => waitForSettledStatus(apiUrl, eventId)));
    assert.deepEqual(settled.map((event) => event.status).sort(), ['SUCCEEDED', 'UNCHANGED']);
    assert.equal(settled.reduce((total, event) => total + event.snapshotRevision, 0), 4);
    assert.equal(await database.contactPair.count({ where: { bitrix24ContactId: contactId } }), 1);
    assert.equal(writeCount, 1);
    assert.equal(destinationEmail, 'after@example.test');
  } finally {
    releaseMoyskladReads();
    holdMoyskladReads = false;
    writeDelayMs = 0;
    (secondApp.getHttpServer() as Server).closeAllConnections();
    await secondApp.close();
  }
});

test('two API instances serialize Bitrix24 and MoySklad events for the same confirmed pair', async () => {
  destinationEmail = 'before@example.test';
  writeCount = 0;
  writeDelayMs = 200;
  const database = app.get(DatabaseService);
  const suffix = randomUUID();
  const contactId = `t21-cross-source-contact-${suffix}`;
  const counterpartyId = `t21-cross-source-counterparty-${suffix}`;
  await database.contactPair.create({
    data: {
      bitrix24ContactId: contactId,
      moyskladCounterpartyId: counterpartyId,
      moyskladType: 'COUNTERPARTY',
      snapshot: { create: {
        bitrix24Email: 'before@example.test',
        moyskladEmail: 'before@example.test',
        bitrix24UpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
        moyskladUpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
      } },
    },
  });
  const secondApp = await NestFactory.create(RealDatabaseContactSyncModule, { logger: false });
  await secondApp.listen(0, '127.0.0.1');
  const secondApiUrl = await secondApp.getUrl();
  holdMoyskladReads = true;
  moyskladReadArrivals = 0;
  moyskladReadBarrier = new Promise<void>((resolve) => { releaseMoyskladReads = resolve; });
  try {
    const b24Response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'ONCRMCONTACTUPDATE', ts: `b24-${suffix}`,
        data: { FIELDS: { ID: contactId } },
        auth: { application_token: 'synthetic-b24-event-token' },
      }),
    });
    assert.equal(b24Response.status, 200);
    const b24Ack = await b24Response.json() as { eventId: string };
    await waitUntil(() => moyskladReadArrivals === 1);

    const msResponse = await fetch(`${secondApiUrl}/webhooks/moysklad/synthetic-ms-webhook-secret?requestId=${encodeURIComponent(`ms-${suffix}`)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ action: 'UPDATE', meta: {
        type: 'counterparty', href: `https://api.moysklad.ru/api/remap/1.2/entity/counterparty/${counterpartyId}`,
      } }] }),
    });
    assert.equal(msResponse.status, 200);
    const msAck = await msResponse.json() as { eventId: string };
    assert.notEqual(b24Ack.eventId, msAck.eventId);
    assert.equal(await database.inboundEvent.count({ where: { id: { in: [b24Ack.eventId, msAck.eventId] } } }), 2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const concurrentReads = moyskladReadArrivals;
    releaseMoyskladReads();
    holdMoyskladReads = false;
    assert.equal(concurrentReads, 1, 'cross-source events for a confirmed pair must share one entity lease');
    const settled = await Promise.all([b24Ack, msAck].map(({ eventId }) => waitForSettledStatus(apiUrl, eventId)));
    assert.deepEqual(settled.map((event) => event.status).sort(), ['SUCCEEDED', 'UNCHANGED']);
    assert.equal(settled.reduce((total, event) => total + event.snapshotRevision, 0), 4);
    assert.equal(await database.contactPair.count({ where: { bitrix24ContactId: contactId } }), 1);
    assert.equal(writeCount, 1);
    assert.equal(destinationEmail, 'after@example.test');
  } finally {
    releaseMoyskladReads();
    holdMoyskladReads = false;
    writeDelayMs = 0;
    (secondApp.getHttpServer() as Server).closeAllConnections();
    await secondApp.close();
  }
});

test('a stale PROCESSING event is recovered after restart without repeating a converged remote write', async () => {
  const database = app.get(DatabaseService);
  const suffix = randomUUID();
  const contactId = `t08-stale-contact-${suffix}`;
  const pair = await database.contactPair.create({
    data: { bitrix24ContactId: contactId, moyskladCounterpartyId: `t08-stale-counterparty-${suffix}` },
  });
  await database.contactSnapshot.create({
    data: {
      pairId: pair.id,
      bitrix24Email: 'before@example.test',
      moyskladEmail: 'before@example.test',
      bitrix24UpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
      moyskladUpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
      revision: 1,
    },
  });
  const event = await database.inboundEvent.create({
    data: {
      source: 'BITRIX24',
      deliveryKey: `t08-stale-${suffix}`,
      eventType: 'ONCRMCONTACTUPDATE',
      externalEntityId: contactId,
      payload: { event: 'ONCRMCONTACTUPDATE' },
      status: 'PROCESSING',
      attempts: 1,
      snapshotRevision: 1,
    },
  });

  destinationEmail = 'after@example.test';
  const previousWrites = writeCount;
  await restartApp();
  const status = await waitForStatus(apiUrl, event.id, 'SUCCEEDED');
  assert.equal(status.attempts, 2);
  assert.equal(status.snapshotRevision, 2);
  assert.equal(destinationEmail, 'after@example.test');
  assert.equal(writeCount, previousWrites);
});

test('a temporary external failure stays durable and retries the same stored event after backoff', async () => {
  destinationEmail = 'before@example.test';
  const suffix = randomUUID();
  const contactId = `t20-retry-contact-${suffix}`;
  const counterpartyId = `t20-retry-counterparty-${suffix}`;
  const database = app.get(DatabaseService);
  await database.contactPair.create({
    data: {
      bitrix24ContactId: contactId,
      moyskladCounterpartyId: counterpartyId,
      snapshot: { create: {
        bitrix24Email: 'before@example.test',
        moyskladEmail: 'before@example.test',
        bitrix24UpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
        moyskladUpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
      } },
    },
  });
  failNextWrite = true;
  const retryAt = new NativeDate(NativeDate.now() + 3_000);
  failNextWriteRetryAfter = retryAt.toUTCString();
  const previousWrites = writeCount;
  const body = JSON.stringify({
    event: 'ONCRMCONTACTUPDATE',
    data: { FIELDS: { ID: contactId } },
    auth: { application_token: 'synthetic-b24-event-token' },
  });
  const first = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  assert.equal(first.status, 200);
  const firstAck = await first.json() as { eventId: string };
  const failed = await waitForStatus(apiUrl, firstAck.eventId, 'RETRYABLE_FAILURE');
  assert.equal(failed.attempts, 1);
  const savedFailure = await database.inboundEvent.findUnique({ where: { id: firstAck.eventId }, select: { retryAfter: true } });
  assert.ok(savedFailure?.retryAfter);
  assert.ok(Math.abs(savedFailure.retryAfter.getTime() - Date.parse(retryAt.toUTCString())) < 1_000, 'HTTP-date Retry-After must survive in PostgreSQL as the durable due time');
  assert.equal(destinationEmail, 'before@example.test');

  assert.equal(await database.inboundEvent.count({ where: { externalEntityId: contactId } }), 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const waiting = await readStatus(apiUrl, firstAck.eventId);
  assert.equal(waiting.status, 'RETRYABLE_FAILURE');
  assert.equal(waiting.attempts, 1);
  assert.equal(writeCount, previousWrites);

  const succeeded = await waitForStatus(apiUrl, firstAck.eventId, 'SUCCEEDED');
  assert.equal(succeeded.attempts, 2);
  assert.equal(succeeded.snapshotRevision, 2);
  assert.equal(destinationEmail, 'after@example.test');
  assert.equal(writeCount, previousWrites + 1);
});

test('accumulated changes keep both journal entries and synchronize the latest state once', async () => {
  destinationEmail = 'before@example.test';
  const suffix = randomUUID();
  const contactId = `t20-batch-contact-${suffix}`;
  const counterpartyId = `t20-batch-counterparty-${suffix}`;
  await app.get(DatabaseService).contactPair.create({
    data: {
      bitrix24ContactId: contactId,
      moyskladCounterpartyId: counterpartyId,
      snapshot: { create: {
        bitrix24Email: 'before@example.test',
        moyskladEmail: 'before@example.test',
        bitrix24UpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
        moyskladUpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
      } },
    },
  });
  const previousWrites = writeCount;
  const post = (ts: string) => fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      ts,
      data: { FIELDS: { ID: contactId } },
      auth: { application_token: 'synthetic-b24-event-token' },
    }),
  });
  const first = await post('delivery-1');
  const firstAck = await first.json() as { eventId: string };
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await post('delivery-2');
  const secondAck = await second.json() as { eventId: string };
  assert.notEqual(secondAck.eventId, firstAck.eventId);

  const latestStatus = await waitForStatus(apiUrl, secondAck.eventId, 'SUCCEEDED');
  assert.equal(latestStatus.snapshotRevision, 2);
  const earlierStatus = await readStatus(apiUrl, firstAck.eventId);
  assert.equal(earlierStatus.status, 'SUPERSEDED');
  assert.equal(destinationEmail, 'after@example.test');
  assert.equal(writeCount, previousWrites + 1);
});

test('nightly reconciliation runs at 01:00 Moscow for the previous 24 hours', async () => {
  const database = app.get(DatabaseService);
  await database.syncSetting.update({
    where: { id: 'global' },
    data: {
      serviceMode: 'on', lastInactiveAt: null, lastActiveAt: null, nightlyScheduledDate: null, nightlyStatus: 'idle',
      nightlyFrom: null, nightlyThrough: null, nightlyProvider: 'BITRIX24',
      nightlyBitrixStart: 0, nightlyMoyskladOffset: 0, nightlyRetryAfter: null,
      nightlyAttempts: 0, nightlyError: null,
    },
  });
  nightlyProviderQueries.length = 0;
  try {
    await seedNightlyOnHistory(database, '2026-10-04T22:00:00.000Z');
    freezeTime('2026-10-05T22:00:00.000Z');
    await waitForNightlyStatus('awaiting_processing');
    const status = await readRecoveryStatus();
    assert.deepEqual({
      scheduledDate: status.nightly.scheduledDate,
      status: status.nightly.status,
      from: status.nightly.from,
      through: status.nightly.through,
      provider: status.nightly.provider,
      bitrixStart: status.nightly.bitrixStart,
      bitrixEntityTypeId: status.nightly.bitrixEntityTypeId,
      bitrixLastId: status.nightly.bitrixLastId,
      moyskladOffset: status.nightly.moyskladOffset,
      bitrixStatus: status.nightly.bitrixStatus,
      moyskladStatus: status.nightly.moyskladStatus,
      retryAfter: status.nightly.retryAfter,
      attempts: status.nightly.attempts,
      error: status.nightly.error,
    }, {
      scheduledDate: '2026-10-06',
      status: 'awaiting_processing',
      from: '2026-10-04T22:00:00.000Z',
      through: '2026-10-05T22:00:00.000Z',
      provider: 'COMPLETE',
      bitrixStart: 0,
      bitrixEntityTypeId: 5,
      bitrixLastId: null,
      moyskladOffset: 0,
      bitrixStatus: 'complete',
      moyskladStatus: 'complete',
      retryAfter: null,
      attempts: 1,
      error: 'Active interval feeds are queued for processing. Skipped intervals are shown in coverage; delete and archival changes remain outside this slice.',
    });
    const bitrixQueries = nightlyProviderQueries.filter((query) => query.startsWith('{')).map((query) => JSON.parse(query));
    assert.deepEqual(bitrixQueries.map((query) => query.entityTypeId), [2, 3, 4, 31]);
    assert.deepEqual(bitrixQueries.map((query) => [query.filter['>=updatedTime'], query.filter['<=updatedTime']]), [
      ['2026-10-04T22:00:00.000Z', '2026-10-05T22:00:00.000Z'],
      ['2026-10-04T22:00:00.000Z', '2026-10-05T22:00:00.000Z'],
      ['2026-10-04T22:00:00.000Z', '2026-10-05T22:00:00.000Z'],
      ['2026-10-04T22:00:00.000Z', '2026-10-05T22:00:00.000Z'],
    ]);
    const moyskladQuery = new URL(nightlyProviderQueries.find((query) => query.includes('/api/entity/counterparty?'))!, 'http://127.0.0.1');
    assert.equal(moyskladQuery.searchParams.get('filter'), 'updated>=2026-10-05 01:00:00;updated<=2026-10-06 01:00:00');
  } finally {
    restoreTime();
  }
});

test('nightly schedule is skipped while paused and is not backfilled after resume', async () => {
  const database = app.get(DatabaseService);
  await database.syncSetting.update({
    where: { id: 'global' }, data: { serviceMode: 'on', lastInactiveAt: null, lastActiveAt: null, nightlyScheduledDate: null, nightlyStatus: 'idle' },
  });
  nightlyProviderQueries.length = 0;
  freezeTime('2026-10-06T21:59:00.000Z');
  try {
    await setAdminMode('pause');
    freezeTime('2026-10-06T22:00:00.000Z');
    await waitForNightlyStatus('skipped');
    assert.equal(nightlyProviderQueries.length, 0);
    freezeTime('2026-10-06T22:01:00.000Z');
    await setAdminMode('on');
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    const status = await readRecoveryStatus();
    assert.equal(status.nightly.scheduledDate, '2026-10-07');
    assert.equal(status.nightly.status, 'skipped');
    assert.equal(nightlyProviderQueries.length, 0);
  } finally {
    restoreTime();
  }
});

test('nightly changed IDs are deduplicated, limited to active pairs, and pinned to field settings', async () => {
  const database = app.get(DatabaseService);
  const bitrixCompanyId = `nightly-company-${randomUUID()}`;
  const pair = await database.entityPair.create({
    data: { entityType: 'COMPANY', bitrix24Id: bitrixCompanyId, moyskladId: `nightly-ms-${randomUUID()}`, moyskladType: 'counterparty', active: true },
  });
  await database.syncSetting.update({
    where: { id: 'global' }, data: {
      serviceMode: 'on', lastInactiveAt: null, lastActiveAt: null, nightlyScheduledDate: null, nightlyStatus: 'idle',
      nightlyBitrixStatus: 'pending', nightlyMoyskladStatus: 'pending', nightlyFrom: null, nightlyThrough: null,
    },
  });
  nightlyBitrixCompanyIds = [bitrixCompanyId, bitrixCompanyId, `unpaired-${randomUUID()}`];
  nightlyProviderQueries.length = 0;
  try {
    await seedNightlyOnHistory(database, '2026-10-07T22:00:00.000Z');
    freezeTime('2026-10-08T22:00:00.000Z');
    await waitForNightlyStatus('awaiting_processing');
    const events = await database.inboundEvent.findMany({ where: { source: 'BITRIX24', externalEntityId: bitrixCompanyId } });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'ONCRMCOMPANYUPDATE');
    assert.equal(events[0].status, 'RECEIVED');
    assert.equal((events[0].payload as { recovery?: string }).recovery, 'nightly');
    const pin = await database.inboundEventSettings.findUnique({ where: { eventId: events[0].id } });
    assert.equal(pin?.settingsVersion, 1);
    const unpairedEvents = await database.inboundEvent.findMany({ where: { source: 'BITRIX24', externalEntityId: { startsWith: 'unpaired-' } } });
    assert.equal(unpairedEvents.length, 0);
  } finally {
    restoreTime();
    nightlyBitrixCompanyIds = [];
    await database.inboundEvent.deleteMany({ where: { externalEntityId: bitrixCompanyId } });
    await database.entityPair.delete({ where: { id: pair.id } });
  }
});

test('nightly rechecks accepted events only for an enabled scope with an active exact-ID pair', async () => {
  const database = app.get(DatabaseService);
  const suffix = randomUUID();
  const activeId = `accepted-contact-${suffix}`;
  const inactiveId = `inactive-contact-${suffix}`;
  const directionSkippedId = `skipped-contact-${suffix}`;
  const unreadyProductId = `accepted-product-${suffix}`;
  const activePair = await database.entityPair.create({ data: {
    entityType: 'CONTACT', bitrix24Id: activeId, moyskladId: `accepted-counterparty-${suffix}`,
    moyskladType: 'counterparty', active: true,
  } });
  const inactivePair = await database.entityPair.create({ data: {
    entityType: 'CONTACT', bitrix24Id: inactiveId, moyskladId: `inactive-counterparty-${suffix}`,
    moyskladType: 'counterparty', active: false,
  } });
  const skippedPair = await database.entityPair.create({ data: {
    entityType: 'CONTACT', bitrix24Id: directionSkippedId, moyskladId: `skipped-counterparty-${suffix}`,
    moyskladType: 'counterparty', active: true,
  } });
  const productPair = await database.entityPair.create({ data: {
    entityType: 'PRODUCT', bitrix24Id: unreadyProductId, moyskladId: `accepted-product-ms-${suffix}`,
    moyskladType: 'product', active: true,
  } });
  await database.syncDirectionSetting.upsert({
    where: { entityKey: 'contacts-companies' },
    create: { entityKey: 'contacts-companies', bitrix24ToMoysklad: true, moyskladToBitrix24: true },
    update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
  });
  const acceptedAt = new Date('2026-10-18T21:00:00.000Z');
  const originalEvents = await database.inboundEvent.createMany({ data: [activeId, inactiveId].map((id) => ({
    source: 'BITRIX24', deliveryKey: `accepted-recheck:${id}`, eventType: 'ONCRMCONTACTUPDATE',
    externalEntityType: 'contact', externalEntityId: id, payload: { event: 'ONCRMCONTACTUPDATE' },
    status: 'SUCCEEDED', receivedAt: acceptedAt,
  })) .concat([{
    source: 'BITRIX24', deliveryKey: `accepted-recheck:${directionSkippedId}`, eventType: 'ONCRMCONTACTUPDATE',
    externalEntityType: 'contact', externalEntityId: directionSkippedId, payload: { event: 'ONCRMCONTACTUPDATE' },
    status: 'SKIPPED_DIRECTION_DISABLED', receivedAt: acceptedAt,
  }, {
    source: 'BITRIX24', deliveryKey: `accepted-recheck:${unreadyProductId}`, eventType: 'CATALOG.PRODUCT.ON.UPDATE',
    externalEntityType: 'product', externalEntityId: unreadyProductId, payload: { event: 'CATALOG.PRODUCT.ON.UPDATE' },
    status: 'SUCCEEDED', receivedAt: acceptedAt,
  }]) });
  assert.equal(originalEvents.count, 4);
  await database.syncSetting.update({ where: { id: 'global' }, data: {
    serviceMode: 'on', lastInactiveAt: null, lastActiveAt: null,
    nightlyScheduledDate: null, nightlyStatus: 'idle', nightlyFrom: null, nightlyThrough: null,
    nightlyBitrixStatus: 'pending', nightlyMoyskladStatus: 'pending', nightlyRetryAfter: null,
  } });
  nightlyBitrixCompanyIds = [];
  nightlyBitrixSecondPageIds = [];
  nightlyMoyskladMetaSize = 0;
  try {
    await seedNightlyOnHistory(database, '2026-10-17T22:00:00.000Z');
    freezeTime('2026-10-18T22:00:00.000Z');
    await waitForNightlyStatus('awaiting_processing');
    const rechecks = await database.inboundEvent.findMany({
      where: { deliveryKey: { startsWith: 'nightly:2026-10-19:segment:0:CONTACT:' } },
      select: { externalEntityId: true, eventType: true, status: true, payload: true },
    });
    assert.deepEqual(rechecks.map((event) => event.externalEntityId), [activeId]);
    assert.equal(rechecks[0]?.eventType, 'ONCRMCONTACTUPDATE');
    assert.equal(rechecks[0]?.status, 'RECEIVED');
    assert.equal((rechecks[0]?.payload as { recovery?: string }).recovery, 'nightly');
  } finally {
    restoreTime();
    await database.inboundEvent.deleteMany({ where: { deliveryKey: { startsWith: `accepted-recheck:` } } });
    await database.inboundEvent.deleteMany({ where: { deliveryKey: { startsWith: 'nightly:2026-10-19:segment:0:CONTACT:' } } });
    await database.entityPair.deleteMany({ where: { id: { in: [activePair.id, inactivePair.id, skippedPair.id, productPair.id] } } });
  }
});

test('nightly schedule is skipped while Off', async () => {
  const database = app.get(DatabaseService);
  await database.syncSetting.update({
    where: { id: 'global' }, data: { serviceMode: 'on', offSince: null, lastInactiveAt: null, lastActiveAt: null, nightlyScheduledDate: null, nightlyStatus: 'idle' },
  });
  nightlyProviderQueries.length = 0;
  freezeTime('2026-10-07T21:59:00.000Z');
  try {
    await setAdminMode('off');
    freezeTime('2026-10-07T22:00:00.000Z');
    await waitForNightlyStatus('skipped');
    assert.equal(nightlyProviderQueries.length, 0);
  } finally {
    restoreTime();
  }
});

test('nightly provider failure leaves independent feed completed and retryable', async () => {
  const database = app.get(DatabaseService);
  await database.syncSetting.update({
    where: { id: 'global' }, data: {
      serviceMode: 'on', offSince: null, lastInactiveAt: null, lastActiveAt: null,
      nightlyScheduledDate: null, nightlyStatus: 'idle', nightlyBitrixStatus: 'pending',
      nightlyMoyskladStatus: 'pending', nightlyMoyskladEntity: 'counterparty', nightlyFrom: null, nightlyThrough: null,
      nightlyRetryAfter: null, nightlyBitrixStart: 0, nightlyMoyskladOffset: 0,
    },
  });
  nightlyProviderQueries.length = 0;
  failNightlyBitrixFeed = true;
  try {
    await seedNightlyOnHistory(database, '2026-10-08T22:00:00.000Z');
    freezeTime('2026-10-09T22:00:00.000Z');
    await waitForNightlyStatus('failed');
    let status = await readRecoveryStatus();
    const deadline = NativeDate.now() + 8_000;
    while (status.nightly.moyskladStatus !== 'complete' && NativeDate.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await readRecoveryStatus();
    }
    assert.equal(status.nightly.bitrixStatus, 'failed');
    assert.equal(status.nightly.moyskladStatus, 'complete');
    assert.ok(nightlyProviderQueries.some((query) => query.includes('/api/entity/counterparty?')));
    assert.equal(new Date(status.nightly.retryAfter!).getTime(), Date.parse('2026-10-09T23:00:00.000Z'));
  } finally {
    restoreTime();
    failNightlyBitrixFeed = false;
    nightlyBitrixRetryAfter = '3600';
  }
});

test('nightly run lease fences two API instances from querying and advancing the same cursors', async () => {
  const database = app.get(DatabaseService);
  await database.syncSetting.update({ where: { id: 'global' }, data: {
    serviceMode: 'on', lastInactiveAt: null, lastActiveAt: null,
    nightlyScheduledDate: '2026-10-10', nightlyStatus: 'pending',
    nightlyFrom: new Date('2026-10-09T22:00:00.000Z'), nightlyThrough: new Date('2026-10-10T22:00:00.000Z'),
    nightlyBitrixStatus: 'pending', nightlyBitrixEntityTypeId: 3, nightlyBitrixStart: 0,
    nightlyMoyskladStatus: 'pending', nightlyMoyskladEntity: 'counterparty', nightlyMoyskladOffset: 0,
    nightlyRetryAfter: null, nightlyLeaseToken: null, nightlyLeaseExpiresAt: null,
  } });
  nightlyProviderQueries.length = 0;
  const first = app.get(SyncRecoveryService);
  const second = new SyncRecoveryService(
    database, app.get(SyncModeService), app.get(ContactSyncProcessor), undefined, app.get(FieldSettingsService),
  );
  const run = (service: SyncRecoveryService) => (service as unknown as { runNightlyJob(): Promise<void> }).runNightlyJob();
  await Promise.all([run(first), run(second)]);
  const status = await readRecoveryStatus();
  assert.equal(status.nightly.status, 'complete_with_limitations');
  assert.equal(nightlyProviderQueries.filter((query) => query.startsWith('{')).length, 2);
  assert.equal(nightlyProviderQueries.filter((query) => query.includes('/api/entity/counterparty?')).length, 1);
  const stored = await database.syncSetting.findUnique({ where: { id: 'global' } });
  assert.equal(stored?.nightlyLeaseToken, null);
  assert.equal(stored?.nightlyLeaseExpiresAt, null);
});

test('lease loss during a provider call replays the page without duplicate durable events', async () => {
  const database = app.get(DatabaseService);
  const bitrixId = `nightly-lease-company-${randomUUID()}`;
  const pair = await database.entityPair.create({ data: {
    entityType: 'COMPANY', bitrix24Id: bitrixId, moyskladId: `nightly-ms-${randomUUID()}`,
    moyskladType: 'counterparty', active: true,
  } });
  await database.syncSetting.update({ where: { id: 'global' }, data: {
    serviceMode: 'on', lastInactiveAt: null, lastActiveAt: null,
    nightlyScheduledDate: '2026-10-11', nightlyStatus: 'pending',
    nightlyFrom: new Date('2026-10-10T22:00:00.000Z'), nightlyThrough: new Date('2026-10-11T22:00:00.000Z'),
    nightlyBitrixStatus: 'pending', nightlyBitrixEntityTypeId: 4, nightlyBitrixStart: 0,
    nightlyMoyskladStatus: 'pending', nightlyMoyskladEntity: 'counterparty', nightlyMoyskladOffset: 0,
    nightlyRetryAfter: null, nightlyLeaseToken: null, nightlyLeaseExpiresAt: null,
  } });
  nightlyBitrixCompanyIds = [bitrixId];
  nightlyCompanyFeedArrived = false;
  holdNightlyCompanyFeed = true;
  const service = app.get(SyncRecoveryService);
  const run = () => (service as unknown as { runNightlyJob(): Promise<void> }).runNightlyJob();
  try {
    const firstRun = run();
    const deadline = NativeDate.now() + 8_000;
    while (!nightlyCompanyFeedArrived && NativeDate.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(nightlyCompanyFeedArrived, true);
    await database.syncSetting.update({ where: { id: 'global' }, data: {
      nightlyLeaseToken: randomUUID(), nightlyLeaseExpiresAt: new Date(NativeDate.now() + 60_000),
    } });
    releaseNightlyCompanyFeed();
    await firstRun;
    let state = await database.syncSetting.findUnique({ where: { id: 'global' } });
    assert.equal(state?.nightlyBitrixEntityTypeId, 4);
    assert.equal(state?.nightlyBitrixStart, 0);
    assert.equal(await database.inboundEvent.count({ where: { source: 'BITRIX24', externalEntityId: bitrixId } }), 0);

    await database.syncSetting.update({ where: { id: 'global' }, data: { nightlyLeaseToken: null, nightlyLeaseExpiresAt: null } });
    holdNightlyCompanyFeed = false;
    await run();
    state = await database.syncSetting.findUnique({ where: { id: 'global' } });
    assert.equal(state?.nightlyStatus, 'awaiting_processing');
    assert.equal(await database.inboundEvent.count({ where: { source: 'BITRIX24', externalEntityId: bitrixId } }), 1);
  } finally {
    releaseNightlyCompanyFeed();
    holdNightlyCompanyFeed = false;
    nightlyBitrixCompanyIds = [];
    await database.inboundEvent.deleteMany({ where: { externalEntityId: bitrixId } });
    await database.entityPair.delete({ where: { id: pair.id } });
  }
});

test('Bitrix keyset pagination survives a moving result set between pages', async () => {
  const database = app.get(DatabaseService);
  const pairId = '51';
  const pair = await database.entityPair.create({ data: {
    entityType: 'COMPANY', bitrix24Id: pairId, moyskladId: `nightly-ms-${randomUUID()}`,
    moyskladType: 'counterparty', active: true,
  } });
  await database.syncSetting.update({ where: { id: 'global' }, data: {
    serviceMode: 'on', lastInactiveAt: null, lastActiveAt: null,
    nightlyScheduledDate: '2026-10-12', nightlyStatus: 'pending',
    nightlyFrom: new Date('2026-10-11T22:00:00.000Z'), nightlyThrough: new Date('2026-10-12T22:00:00.000Z'),
    nightlyBitrixStatus: 'pending', nightlyBitrixEntityTypeId: 3, nightlyBitrixStart: 0, nightlyBitrixLastId: null,
    nightlyMoyskladStatus: 'pending', nightlyMoyskladOffset: 0,
    nightlyRetryAfter: null, nightlyLeaseToken: null, nightlyLeaseExpiresAt: null,
  } });
  nightlyBitrixCompanyIds = Array.from({ length: 50 }, (_, index) => String(index + 1));
  nightlyBitrixSecondPageIds = [pairId];
  nightlyProviderQueries.length = 0;
  try {
    const service = app.get(SyncRecoveryService);
    await (service as unknown as { runNightlyJob(): Promise<void> }).runNightlyJob();
    const companyQueries = nightlyProviderQueries.filter((query) => query.startsWith('{')).map((query) => JSON.parse(query)).filter((query) => query.entityTypeId === 4);
    assert.equal(companyQueries.length, 2);
    assert.equal(companyQueries[0].start, -1);
    assert.deepEqual(companyQueries[0].order, { id: 'ASC' });
    assert.equal(companyQueries[1].start, -1);
    assert.equal(companyQueries[1].filter['>id'], '50');
    assert.equal(await database.inboundEvent.count({ where: { source: 'BITRIX24', externalEntityId: pairId } }), 1);
    const state = await database.syncSetting.findUnique({ where: { id: 'global' } });
    assert.equal(state?.nightlyBitrixStatus, 'complete');
    assert.equal(state?.nightlyBitrixLastId, null);
  } finally {
    nightlyBitrixCompanyIds = [];
    nightlyBitrixSecondPageIds = [];
    await database.inboundEvent.deleteMany({ where: { externalEntityId: pairId } });
    await database.entityPair.delete({ where: { id: pair.id } });
  }
});

test('MoySklad pagination beyond one documented page fails closed without checkpoint', async () => {
  const database = app.get(DatabaseService);
  await database.syncSetting.update({ where: { id: 'global' }, data: {
    serviceMode: 'on', lastInactiveAt: null, lastActiveAt: null,
    nightlyScheduledDate: '2026-10-13', nightlyStatus: 'pending',
    nightlyFrom: new Date('2026-10-12T22:00:00.000Z'), nightlyThrough: new Date('2026-10-13T22:00:00.000Z'),
    nightlyBitrixStatus: 'pending', nightlyBitrixEntityTypeId: 3, nightlyBitrixStart: 0, nightlyBitrixLastId: null,
    nightlyMoyskladStatus: 'pending', nightlyMoyskladEntity: 'counterparty', nightlyMoyskladOffset: 0,
    nightlyRetryAfter: null, nightlyLeaseToken: null, nightlyLeaseExpiresAt: null,
  } });
  nightlyMoyskladMetaSize = 1_001;
  try {
    const service = app.get(SyncRecoveryService);
    await (service as unknown as { runNightlyJob(): Promise<void> }).runNightlyJob();
    const status = await readRecoveryStatus();
    assert.equal(status.nightly.bitrixStatus, 'complete');
    assert.equal(status.nightly.moyskladStatus, 'failed');
    assert.ok(status.nightly.error);
    assert.match(status.nightly.error!, /changed-record total is inconsistent with the returned page/);
    const state = await database.syncSetting.findUnique({ where: { id: 'global' } });
    assert.equal(state?.nightlyMoyskladOffset, 0);
    assert.equal(await database.inboundEvent.count({ where: { source: 'MOYSKLAD', payload: { path: ['recovery'], equals: 'nightly' } } }), 0);
  } finally {
    nightlyMoyskladMetaSize = 0;
  }
});

test('nightly MoySklad contact-person feed pages active company collections and queues only in-window contacts', async () => {
  const database = app.get(DatabaseService);
  const parentId = `nightly-contact-parent-${randomUUID()}`;
  const changedContactId = `nightly-contact-changed-${randomUUID()}`;
  const oldContactId = `nightly-contact-old-${randomUUID()}`;
  const pair = await database.entityPair.create({ data: {
    entityType: 'COMPANY', bitrix24Id: `nightly-b24-company-${randomUUID()}`, moyskladId: parentId,
    moyskladType: 'counterparty', active: true,
  } });
  nightlyContactpersonsByParent.set(parentId, [
    ...Array.from({ length: 1_000 }, (_, index) => ({ id: `nightly-old-${index}`, updated: '2026-10-05 00:00:00.000' })),
    { id: changedContactId, updated: '2026-10-05 12:00:00.000' },
    { id: oldContactId, updated: '2026-10-03 12:00:00.000' },
  ]);
  await database.syncSetting.update({ where: { id: 'global' }, data: {
    serviceMode: 'on', lastInactiveAt: null, lastActiveAt: null,
    nightlyScheduledDate: '2026-10-06', nightlyStatus: 'pending',
    nightlyFrom: new Date('2026-10-04T22:00:00.000Z'), nightlyThrough: new Date('2026-10-05T22:00:00.000Z'),
    nightlyBitrixStatus: 'complete', nightlyMoyskladStatus: 'pending', nightlyMoyskladEntity: 'counterparty', nightlyMoyskladOffset: 0,
    nightlyRetryAfter: null, nightlyLeaseToken: null, nightlyLeaseExpiresAt: null,
  } });
  nightlyProviderQueries.length = 0;
  try {
    const service = app.get(SyncRecoveryService);
    await (service as unknown as { runNightlyJob(): Promise<void> }).runNightlyJob();
    const events = await database.inboundEvent.findMany({ where: {
      source: 'MOYSKLAD', externalEntityType: 'contactperson', payload: { path: ['recovery'], equals: 'nightly' },
    } });
    assert.deepEqual(events.map((event) => event.externalEntityId), [changedContactId]);
    assert.equal(events[0].eventType, 'UPDATE');
    assert.equal((events[0].payload as { meta: { href: string } }).meta.href, `${mockUrl}/api/entity/counterparty/${parentId}/contactpersons/${changedContactId}`);
    const pages = nightlyProviderQueries
      .filter((query) => query.includes(`/api/entity/counterparty/${parentId}/contactpersons?`))
      .map((query) => new URL(query, 'http://127.0.0.1'));
    assert.deepEqual(pages.map((url) => url.searchParams.get('offset')), ['0', '1000']);
    assert.equal((await database.syncSetting.findUnique({ where: { id: 'global' } }))?.nightlyMoyskladStatus, 'complete');
  } finally {
    nightlyContactpersonsByParent.delete(parentId);
    await database.inboundEvent.deleteMany({ where: { externalEntityId: { in: [changedContactId, oldContactId] } } });
    await database.entityPair.delete({ where: { id: pair.id } });
  }
});

test('nightly MoySklad contact-person feed rejects invalid timestamps without queueing staged contacts', async () => {
  const database = app.get(DatabaseService);
  const parentId = `nightly-contact-invalid-parent-${randomUUID()}`;
  const contactId = `nightly-contact-invalid-${randomUUID()}`;
  const stagedContactId = `nightly-contact-staged-${randomUUID()}`;
  const pair = await database.entityPair.create({ data: {
    entityType: 'COMPANY', bitrix24Id: `nightly-b24-company-${randomUUID()}`, moyskladId: parentId,
    moyskladType: 'counterparty', active: true,
  } });
  nightlyContactpersonsByParent.set(parentId, [
    { id: stagedContactId, updated: '2026-10-05 12:00:00.000' },
    { id: contactId, updated: '2026-02-31 12:00:00.000' },
  ]);
  await database.syncSetting.update({ where: { id: 'global' }, data: {
    serviceMode: 'on', lastInactiveAt: null, lastActiveAt: null,
    nightlyScheduledDate: '2026-10-06', nightlyStatus: 'pending',
    nightlyFrom: new Date('2026-10-04T22:00:00.000Z'), nightlyThrough: new Date('2026-10-05T22:00:00.000Z'),
    nightlyBitrixStatus: 'complete', nightlyMoyskladStatus: 'pending', nightlyMoyskladEntity: 'counterparty', nightlyMoyskladOffset: 0,
    nightlyRetryAfter: null, nightlyLeaseToken: null, nightlyLeaseExpiresAt: null,
  } });
  try {
    const service = app.get(SyncRecoveryService);
    await (service as unknown as { runNightlyJob(): Promise<void> }).runNightlyJob();
    const status = await readRecoveryStatus();
    assert.equal(status.nightly.moyskladStatus, 'failed');
    assert.equal(await database.inboundEvent.count({ where: { source: 'MOYSKLAD', externalEntityId: { in: [stagedContactId, contactId] } } }), 0);
  } finally {
    nightlyContactpersonsByParent.delete(parentId);
    await database.inboundEvent.deleteMany({ where: { externalEntityId: { in: [stagedContactId, contactId] } } });
    await database.entityPair.delete({ where: { id: pair.id } });
  }
});

test('mid-run PAUSE preserves the provider cursor and resumes without losing feed progress', async () => {
  const database = app.get(DatabaseService);
  await database.syncSetting.update({ where: { id: 'global' }, data: {
    serviceMode: 'on', lastInactiveAt: null, lastActiveAt: null,
    nightlyScheduledDate: '2026-10-14', nightlyStatus: 'pending',
    nightlyFrom: new Date('2026-10-13T22:00:00.000Z'), nightlyThrough: new Date('2026-10-14T22:00:00.000Z'),
    nightlyBitrixStatus: 'pending', nightlyBitrixEntityTypeId: 4, nightlyBitrixStart: 0, nightlyBitrixLastId: null,
    nightlyMoyskladStatus: 'pending', nightlyMoyskladOffset: 0,
    nightlyRetryAfter: null, nightlyLeaseToken: null, nightlyLeaseExpiresAt: null,
  } });
  nightlyCompanyFeedArrived = false;
  nightlyProviderQueries.length = 0;
  holdNightlyCompanyFeed = true;
  const service = app.get(SyncRecoveryService);
  const run = (service as unknown as { runNightlyJob(): Promise<void> }).runNightlyJob();
  try {
    const deadline = NativeDate.now() + 8_000;
    while (!nightlyCompanyFeedArrived && NativeDate.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(nightlyCompanyFeedArrived, true);
    await setAdminMode('pause');
    releaseNightlyCompanyFeed();
    await run;
    holdNightlyCompanyFeed = false;
    const status = await readRecoveryStatus();
    assert.equal(status.nightly.status, 'running');
    assert.equal(status.nightly.bitrixStatus, 'pending');
    assert.equal(status.nightly.bitrixEntityTypeId, 4);
    assert.equal(status.nightly.moyskladStatus, 'pending');
    const pausedSetting = await database.syncSetting.findUnique({ where: { id: 'global' } });
    assert.equal(pausedSetting?.nightlyLeaseToken, null);
    assert.deepEqual(nightlyProviderQueries.filter((query) => query.startsWith('{')).map((query) => JSON.parse(query).entityTypeId), [4]);

    // PAUSE stops progress after the in-flight request; resume retries that same
    // cursor before advancing and completes the durable nightly window.
    await setAdminMode('on');
    await (service as unknown as { runNightlyJob(): Promise<void> }).runNightlyJob();
    const resumed = await readRecoveryStatus();
    assert.equal(resumed.nightly.status, 'awaiting_processing');
    assert.equal(resumed.nightly.bitrixStatus, 'complete');
    assert.equal(resumed.nightly.moyskladStatus, 'complete');
    assert.equal(nightlyProviderQueries.filter((query) => query.startsWith('{') && JSON.parse(query).entityTypeId === 4).length, 2);
  } finally {
    releaseNightlyCompanyFeed();
    holdNightlyCompanyFeed = false;
    await setAdminMode('on');
  }
});

async function handleExternalRequest(request: IncomingMessage, response: ServerResponse) {
  if (request.method === 'POST' && request.url === '/rest/crm.item.list.json') {
    return readBody(request).then(async (body) => {
      nightlyProviderQueries.push(body);
      if (failNightlyBitrixFeed) return sendJson(response, 503, { error: 'synthetic rate limit' }, { 'retry-after': nightlyBitrixRetryAfter });
      const requestBody = JSON.parse(body) as { entityTypeId: number; filter?: Record<string, unknown> };
      if (requestBody.entityTypeId === 4 && holdNightlyCompanyFeed) {
        nightlyCompanyFeedArrived = true;
        await new Promise<void>((resolve) => { releaseNightlyCompanyFeed = resolve; });
      }
      const items = requestBody.entityTypeId === 4
        ? (requestBody.filter?.['>id'] ? nightlyBitrixSecondPageIds : nightlyBitrixCompanyIds).map((id) => ({ id }))
        : [];
      const result = sendJson(response, 200, { result: { items } });
      if (requestBody.entityTypeId === 4 && requestBody.filter?.['>id'] === undefined && nightlyBitrixSecondPageIds.length) {
        // Model an in-window row moving out of the fixed through-time filter after page one.
        nightlyBitrixCompanyIds = nightlyBitrixCompanyIds.slice(1);
      }
      return result;
    });
  }
  if (request.method === 'POST' && request.url === '/rest/crm.contact.get.json') {
    return readBody(request).then((body) => {
      const id = new URLSearchParams(body).get('id');
      return sendJson(response, 200, { result: {
        ID: id,
        NAME: 'Synthetic',
        LAST_NAME: 'Contact',
        PHONE: [{ ID: 'phone-field-1', VALUE: '+10000000000', VALUE_TYPE: 'WORK' }],
        EMAIL: [{ ID: 'email-field-1', VALUE: 'after@example.test', VALUE_TYPE: 'WORK' }],
        DATE_MODIFY: '2026-10-02T10:00:02+03:00',
      } });
    });
  }
  if (request.method === 'PUT' && request.url?.startsWith('/api/entity/counterparty/')) {
    return readBody(request).then((body) => {
      if (failNextWrite) {
        failNextWrite = false;
        const retryAfter = failNextWriteRetryAfter;
        failNextWriteRetryAfter = null;
        return sendJson(response, 503, { error: 'synthetic temporary failure' }, retryAfter ? { 'retry-after': retryAfter } : {});
      }
      destinationEmail = (JSON.parse(body) as { email: string }).email;
      writeCount++;
      return new Promise<void>((resolve) => setTimeout(() => {
        sendJson(response, 200, { id: 'synthetic-counterparty', email: destinationEmail, updated: '2026-10-02T10:00:03.000' });
        resolve();
      }, writeDelayMs));
    });
  }
  if (request.method === 'GET' && request.url?.startsWith('/api/entity/counterparty/') && request.url.includes('/contactpersons?')) {
    nightlyProviderQueries.push(request.url!);
    const url = new URL(request.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/');
    const parentId = decodeURIComponent(parts[parts.indexOf('counterparty') + 1] ?? '');
    const rows = nightlyContactpersonsByParent.get(parentId) ?? [];
    const limit = Number(url.searchParams.get('limit'));
    const offset = Number(url.searchParams.get('offset'));
    return sendJson(response, 200, { rows: rows.slice(offset, offset + limit), meta: { size: rows.length, limit, offset } });
  }
  if (request.method === 'GET' && request.url?.startsWith('/api/entity/counterparty/')) {
    if (holdMoyskladReads) {
      moyskladReadArrivals++;
      await moyskladReadBarrier;
    }
    if (barrierMoyskladReads) {
      moyskladReadArrivals++;
      if (moyskladReadArrivals >= 2) releaseMoyskladReads();
      await Promise.race([moyskladReadBarrier, new Promise((resolve) => setTimeout(resolve, 350))]);
    }
    return sendJson(response, 200, {
      id: 'synthetic-counterparty', name: 'Synthetic Customer', companyType: 'legal',
      phone: '+10000000000', email: destinationEmail,
      updated: destinationEmail === 'before@example.test' ? '2026-10-02T09:00:00.000' : '2026-10-02T10:00:03.000',
    });
  }
  if (request.method === 'GET' && /^\/api\/entity\/(counterparty|customerorder|invoiceout|product|service)\?/.test(request.url ?? '')) {
    nightlyProviderQueries.push(request.url!);
    return sendJson(response, 200, { rows: [], meta: { size: nightlyMoyskladMetaSize, limit: 1_000, offset: 0 } });
  }
  return sendJson(response, 404, {});
}

async function seedNightlyOnHistory(database: DatabaseService, windowFrom: string) {
  const onSince = new Date(Date.parse(windowFrom) - 1_000);
  await database.syncModeTransition.deleteMany({});
  await database.syncModeTransition.create({ data: { fromMode: 'off', toMode: 'on', transitionedAt: onSince } });
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on', modeHistoryTrackedFrom: onSince } });
}

async function restartApp() {
  (app.getHttpServer() as Server).closeAllConnections();
  await app.close();
  app = await NestFactory.create(RealDatabaseContactSyncModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
}

async function waitForStatus(baseUrl: string, eventId: string, expected: string) {
  const deadline = Date.now() + 12_000;
  let latest = await readStatus(baseUrl, eventId);
  while (latest.status !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    latest = await readStatus(baseUrl, eventId);
  }
  assert.equal(latest.status, expected);
  return latest;
}

async function waitForSettledStatus(baseUrl: string, eventId: string) {
  const deadline = NativeDate.now() + 8_000;
  let latest = await readStatus(baseUrl, eventId);
  while (['RECEIVED', 'PROCESSING'].includes(latest.status) && NativeDate.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    latest = await readStatus(baseUrl, eventId);
  }
  assert.ok(['SUCCEEDED', 'UNCHANGED', 'SUPERSEDED'].includes(latest.status), `Unexpected final event status: ${latest.status}`);
  return latest;
}

async function waitUntil(condition: () => boolean) {
  const deadline = NativeDate.now() + 5_000;
  while (!condition() && NativeDate.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(condition(), true, 'timed out waiting for the fake provider boundary');
}

async function readStatus(baseUrl: string, eventId: string) {
  const response = await fetch(`${baseUrl}/api/admin/contact-sync/events/${eventId}`, {
    headers: { authorization: 'Bearer synthetic-admin-token' },
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    status: string; attempts: number; direction: string; snapshotRevision: number;
  }>;
}

async function readRecoveryStatus() {
  const response = await fetch(`${apiUrl}/api/admin/sync-mode/recovery`, {
    headers: { authorization: 'Bearer synthetic-admin-token' },
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    nightly: {
      scheduledDate: string | null; status: string; from: string | null; through: string | null;
      provider: string; bitrixStart: number; bitrixEntityTypeId: number; bitrixLastId: string | null; moyskladOffset: number;
      bitrixStatus: string; moyskladStatus: string; retryAfter: string | null;
      attempts: number; error: string | null;
    };
  }>;
}

async function waitForNightlyStatus(expected: string) {
  // The feed intentionally probes five MoySklad collections at a 1 request/s cap.
  const deadline = NativeDate.now() + 20_000;
  let status = await readRecoveryStatus();
  while (status.nightly.status !== expected && NativeDate.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = await readRecoveryStatus();
  }
  assert.equal(status.nightly.status, expected, `nightly status did not reach ${expected}: ${JSON.stringify(status.nightly)}`);
}

async function setAdminMode(mode: 'on' | 'pause' | 'off') {
  const response = await fetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer synthetic-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ mode, confirmed: true }),
  });
  assert.equal(response.status, 200);
}

function freezeTime(isoDate: string) {
  const milliseconds = NativeDate.parse(isoDate);
  class FrozenDate extends NativeDate {
    constructor(value?: string | number) {
      if (value === undefined) super(milliseconds);
      else super(value);
    }

    static now() {
      return milliseconds;
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;
}

function restoreTime() {
  globalThis.Date = NativeDate;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}
