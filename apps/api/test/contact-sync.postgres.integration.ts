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
import { ContactSyncProcessor, ContactSyncStatusReader } from '../src/contact-sync.service';
import { DatabaseService } from '../src/database.service';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { SyncModeService } from '../src/sync-mode.service';

@Module({
  controllers: [EventsController, AdminController, ContactSyncStatusController],
  providers: [DatabaseService, EventIntakeService, ContactSyncProcessor, ContactSyncStatusReader, AdminAccessGuard, SyncModeService],
})
class RealDatabaseContactSyncModule {}

let app: INestApplication;
let apiUrl: string;
let mockUrl: string;
let mockServer: Server;
let originalFetch: typeof fetch;
let destinationEmail = 'before@example.test';
let writeCount = 0;
let writeDelayMs = 0;
let barrierMoyskladReads = false;
let moyskladReadArrivals = 0;
let releaseMoyskladReads = () => {};
let moyskladReadBarrier = Promise.resolve();

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

async function handleExternalRequest(request: IncomingMessage, response: ServerResponse) {
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
      destinationEmail = (JSON.parse(body) as { email: string }).email;
      writeCount++;
      return new Promise<void>((resolve) => setTimeout(() => {
        sendJson(response, 200, { id: 'synthetic-counterparty', email: destinationEmail, updated: '2026-10-02T10:00:03.000' });
        resolve();
      }, writeDelayMs));
    });
  }
  if (request.method === 'GET' && request.url?.startsWith('/api/entity/counterparty/')) {
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
  const deadline = Date.now() + 4_000;
  let latest = await readStatus(baseUrl, eventId);
  while (latest.status !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    latest = await readStatus(baseUrl, eventId);
  }
  assert.equal(latest.status, expected);
  return latest;
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
