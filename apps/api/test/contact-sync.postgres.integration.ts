import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AdminAccessGuard } from '../src/admin/admin-access.guard';
import { AdminController } from '../src/admin/admin.controller';
import { ContactSyncStatusController } from '../src/admin/contact-sync-status.controller';
import { SyncModeController } from '../src/admin/sync-mode.controller';
import { ContactSyncProcessor, ContactSyncStatusReader } from '../src/contact-sync.service';
import { DatabaseService } from '../src/database.service';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { SyncModeService } from '../src/sync-mode.service';
import { SyncRecoveryService } from '../src/sync-recovery.service';

@Module({
  controllers: [EventsController, AdminController, ContactSyncStatusController, SyncModeController],
  providers: [DatabaseService, EventIntakeService, ContactSyncProcessor, ContactSyncStatusReader, AdminAccessGuard, SyncModeService, SyncRecoveryService],
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
let writeDelayMs = 0;
let barrierMoyskladReads = false;
let holdMoyskladReads = false;
let moyskladReadArrivals = 0;
let releaseMoyskladReads = () => {};
let moyskladReadBarrier = Promise.resolve();
const nightlyProviderQueries: string[] = [];

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to the isolated ephemeral PostgreSQL database');
  process.env.SYNC_MODE = 'apply';
  process.env.SYNC_STATE = 'on';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-b24-event-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'synthetic-ms-webhook-secret';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-ms-api-token';

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
  await app.get(DatabaseService).syncSetting.upsert({
    where: { id: 'global' }, create: { serviceMode: 'on' }, update: { serviceMode: 'on', offSince: null },
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

test('two API instances claim one duplicate public delivery only once', async () => {
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
    assert.equal(acknowledgements[0].eventId, initialAck.eventId);
    assert.equal(acknowledgements[1].eventId, initialAck.eventId);
    assert.equal(acknowledgements[0].eventId, acknowledgements[1].eventId);
    const status = await waitForStatus(apiUrl, acknowledgements[0].eventId, 'SUCCEEDED');
    assert.equal(status.attempts, 1);
    assert.equal(status.snapshotRevision, 2);
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

test('a temporary external failure stays durable and retries the same event after backoff', async () => {
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
  const previousWrites = writeCount;
  const body = JSON.stringify({
    event: 'ONCRMCONTACTUPDATE',
    data: { FIELDS: { ID: contactId } },
    auth: { application_token: 'synthetic-b24-event-token' },
  });
  const post = () => fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  const first = await post();
  assert.equal(first.status, 200);
  const firstAck = await first.json() as { eventId: string };
  const failed = await waitForStatus(apiUrl, firstAck.eventId, 'RETRYABLE_FAILURE');
  assert.equal(failed.attempts, 1);
  assert.equal(destinationEmail, 'before@example.test');

  const repeated = await post();
  assert.equal(repeated.status, 200);
  const repeatedAck = await repeated.json() as { eventId: string };
  assert.equal(repeatedAck.eventId, firstAck.eventId);
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
      serviceMode: 'on', nightlyScheduledDate: null, nightlyStatus: 'idle',
      nightlyFrom: null, nightlyThrough: null, nightlyProvider: 'BITRIX24',
      nightlyBitrixStart: 0, nightlyMoyskladOffset: 0, nightlyRetryAfter: null,
      nightlyAttempts: 0, nightlyError: null,
    },
  });
  nightlyProviderQueries.length = 0;
  try {
    freezeTime('2026-10-05T20:00:00.000Z');
    await setAdminMode('pause');
    freezeTime('2026-10-05T20:15:00.000Z');
    await setAdminMode('on');
    freezeTime('2026-10-05T22:00:00.000Z');
    await waitForNightlyStatus('complete');
    const status = await readRecoveryStatus();
    assert.deepEqual(status.nightly, {
      scheduledDate: '2026-10-06',
      status: 'complete',
      from: '2026-10-04T22:00:00.000Z',
      through: '2026-10-05T22:00:00.000Z',
      provider: 'COMPLETE',
      bitrixStart: 0,
      moyskladOffset: 0,
      retryAfter: null,
      attempts: 1,
      error: null,
    });
    assert.equal(nightlyProviderQueries.some((query) => query.includes('2026-10-04T22%3A00%3A00.000Z')), true);
    assert.equal(nightlyProviderQueries.some((query) => query.includes('2026-10-05T22%3A00%3A00.000Z')), true);
  } finally {
    restoreTime();
  }
});

test('nightly schedule is skipped while paused and is not backfilled after resume', async () => {
  const database = app.get(DatabaseService);
  await database.syncSetting.update({
    where: { id: 'global' }, data: { serviceMode: 'on', nightlyScheduledDate: null, nightlyStatus: 'idle' },
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

test('nightly schedule is skipped while Off', async () => {
  const database = app.get(DatabaseService);
  await database.syncSetting.update({
    where: { id: 'global' }, data: { serviceMode: 'on', offSince: null, nightlyScheduledDate: null, nightlyStatus: 'idle' },
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

async function handleExternalRequest(request: IncomingMessage, response: ServerResponse) {
  if (request.method === 'POST' && request.url === '/rest/crm.contact.list.json') {
    return readBody(request).then((body) => {
      nightlyProviderQueries.push(body);
      return sendJson(response, 200, { result: [] });
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
        return sendJson(response, 503, { error: 'synthetic temporary failure' });
      }
      destinationEmail = (JSON.parse(body) as { email: string }).email;
      writeCount++;
      return new Promise<void>((resolve) => setTimeout(() => {
        sendJson(response, 200, { id: 'synthetic-counterparty', email: destinationEmail, updated: '2026-10-02T10:00:03.000' });
        resolve();
      }, writeDelayMs));
    });
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
  if (request.method === 'GET' && request.url?.startsWith('/api/entity/counterparty?')) {
    nightlyProviderQueries.push(request.url);
    return sendJson(response, 200, { rows: [], meta: { size: 0, limit: 1_000, offset: 0 } });
  }
  return sendJson(response, 404, {});
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
      provider: string; bitrixStart: number; moyskladOffset: number; retryAfter: string | null;
      attempts: number; error: string | null;
    };
  }>;
}

async function waitForNightlyStatus(expected: string) {
  const deadline = NativeDate.now() + 8_000;
  let status = await readRecoveryStatus();
  while (status.nightly.status !== expected && NativeDate.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = await readRecoveryStatus();
  }
  assert.equal(status.nightly.status, expected);
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

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
