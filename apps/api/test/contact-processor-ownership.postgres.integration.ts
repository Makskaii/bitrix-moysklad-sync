import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/main';
import { ContactSyncProcessor } from '../src/contact-sync.service';
import { DatabaseService } from '../src/database.service';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { SyncModeService } from '../src/sync-mode.service';

const suffix = randomUUID();
const sourceId = `contact-routing-${suffix}`;
const deliveryPrefix = `contact-routing-${suffix}-`;
const fixturePrefix = `contact-routing-${suffix}-`;
let database: DatabaseService;
let app: NestExpressApplication;
let apiUrl: string;
let provider: Server;
let providerUrl: string;
const providerRequests: string[] = [];
let oldEnv: Record<string, string | undefined> = {};

before(async () => {
  assert.equal(process.env.CONTACT_PROCESSOR_OWNERSHIP_TEST_ISOLATED, '1', 'explicit disposable-database opt-in required');
  const databaseUrl = new URL(process.env.CONTACT_PROCESSOR_OWNERSHIP_DATABASE_URL ?? '');
  assert.equal(databaseUrl.hostname, '127.0.0.1');
  assert.match(databaseUrl.pathname, /_test$/);
  assert.equal(databaseUrl.searchParams.get('schema'), 'issue79_contact_routing_test');
  for (const name of ['DATABASE_URL', 'SYNC_MODE', 'BITRIX24_EVENT_APPLICATION_TOKEN', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN', 'CONTROLLED_LIVE_TEST_MODE']) oldEnv[name] = process.env[name];
  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-contact-routing-token';
  process.env.CONTROLLED_LIVE_TEST_MODE = 'disabled';
  provider = createServer(async (request, response) => {
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const path = request.url ?? '/';
    providerRequests.push(`${request.method} ${path}`);
    if (path.endsWith('/crm.contact.get.json')) {
      const id = new URLSearchParams(Buffer.concat(body).toString('utf8')).get('id');
      if (id === sourceId) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: {
        ID: id, NAME: 'Paired', LAST_NAME: 'Legacy', DATE_MODIFY: new Date().toISOString(),
        EMAIL: [{ ID: 'legacy-email-id', VALUE: 'legacy@example.test', VALUE_TYPE: 'WORK' }],
      } }));
      return;
    }
    if (path.startsWith('/api/entity/counterparty/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      const id = path.split('/').at(-1);
      response.end(JSON.stringify({ id, email: 'legacy@example.test', companyType: id?.startsWith('modern-target-') ? 'individual' : 'personal', updated: '2026-10-20 08:00:00.000' }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  providerUrl = `http://127.0.0.1:${address.port}`;
  process.env.BITRIX24_REST_BASE_URL = `${providerUrl}/rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${providerUrl}/api/`;
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-only-token';

  database = new DatabaseService();
  await database.$connect();
  const boundary = new Date();
  await database.databaseRecoveryState.upsert({ where: { id: 'global' }, create: {
    id: 'global', status: 'READY', previousLaunchBoundary: boundary, pairsRestored: true,
    lostEventsAcknowledged: true, acknowledgedAt: boundary, acknowledgement: 'isolated integration fixture recovery confirmation',
  }, update: {
    status: 'READY', previousLaunchBoundary: boundary, pairsRestored: true,
    lostEventsAcknowledged: true, acknowledgedAt: boundary, acknowledgement: 'isolated integration fixture recovery confirmation',
  } });
  await database.databaseRecoveryAudit.create({ data: {
    action: 'DATABASE_LOSS_RECOVERY_CONFIRMED', actorType: 'VERIFIED_BITRIX24_ADMIN', actorId: 'BITRIX24_USER:3664',
    oldBoundaryAt: boundary, boundaryAt: boundary, pairsRestored: true, lostEventsAcknowledged: true,
    acknowledgement: 'isolated integration fixture recovery confirmation', recoveryStateId: 'global',
  } });
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  await database.syncDirectionSetting.upsert({ where: { entityKey: 'contacts-companies' }, create: {
    entityKey: 'contacts-companies', bitrix24ToMoysklad: true, moyskladToBitrix24: true,
  }, update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } });

  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  await app.get(DatabaseService).$connect();
  await app.get(FieldSettingsService).active();
});

after(async () => {
  if (app) {
    app.getHttpServer().closeAllConnections();
    await app.close();
  }
  if (database) {
    await database.inboundEvent.deleteMany({ where: { deliveryKey: { startsWith: deliveryPrefix } } });
    await database.contactPair.deleteMany({ where: { bitrix24ContactId: { startsWith: fixturePrefix } } });
    await database.entityPair.deleteMany({ where: { bitrix24Id: { startsWith: fixturePrefix } } });
    await database.$disconnect();
  }
  if (provider) {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
  for (const [name, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function postContactEvent(id: string, deliveryLabel: string) {
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE', auth: { application_token: 'synthetic-contact-routing-token' },
      data: { FIELDS: { ID: id } },
    }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ eventId: string }>;
}

async function waitForEvent(eventId: string, status: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let event = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
  while (event.status !== status && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    event = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
  }
  return event;
}

test('an unpaired contact retry is not reclaimed by the legacy email processor', async () => {
  const acknowledgement = await postContactEvent(sourceId, 'unpaired');
  let event = await waitForEvent(acknowledgement.eventId, 'RETRYABLE_FAILURE');
  assert.equal(event.status, 'RETRYABLE_FAILURE');
  assert.equal(event.status, 'RETRYABLE_FAILURE', 'the modern contact processor should record the provider failure for retry');
  await database.inboundEvent.update({ where: { id: event.id }, data: { retryAfter: new Date(Date.now() - 1) } });

  const beforeAttempts = event.attempts;
  await app.get(ContactSyncProcessor).process(event.id);
  const afterEvent = await database.inboundEvent.findUniqueOrThrow({ where: { id: event.id } });
  assert.equal(afterEvent.status, 'RETRYABLE_FAILURE');
  assert.equal(afterEvent.attempts, beforeAttempts);
  assert.equal(await database.manualReviewCase.count({ where: { eventId: event.id, reason: 'CONTACT_PAIR_NOT_FOUND' } }), 0);
  await database.inboundEvent.update({ where: { id: event.id }, data: { retryAfter: new Date(Date.now() - 1) } });
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  const afterLegacyRecoveryTick = await database.inboundEvent.findUniqueOrThrow({ where: { id: event.id } });
  assert.equal(afterLegacyRecoveryTick.status, 'RETRYABLE_FAILURE', 'legacy recovery scan must not steal the modern retry');
  assert.equal(afterLegacyRecoveryTick.attempts, beforeAttempts);
  assert.equal(await database.manualReviewCase.count({ where: { eventId: event.id, reason: 'CONTACT_PAIR_NOT_FOUND' } }), 0);
  await database.inboundEvent.update({ where: { id: event.id }, data: { retryAfter: new Date(Date.now() + 60_000) } });
});

test('a legacy-paired contact remains owned by the email compatibility processor', async () => {
  const id = `${fixturePrefix}legacy-b24`;
  const pair = await database.contactPair.create({ data: {
    bitrix24ContactId: id, moyskladCounterpartyId: `${fixturePrefix}legacy-ms`, moyskladType: 'COUNTERPARTY',
  } });
  const timestamp = new Date('2026-10-20T05:00:00.000Z');
  await database.contactSnapshot.create({ data: {
    pairId: pair.id, bitrix24Email: 'legacy@example.test', moyskladEmail: 'legacy@example.test',
    bitrix24UpdatedAt: timestamp, moyskladUpdatedAt: timestamp, revision: 1,
  } });

  const acknowledgement = await postContactEvent(id, 'legacy-paired');
  const event = await waitForEvent(acknowledgement.eventId, 'UNCHANGED');
  assert.equal(event.status, 'UNCHANGED');
  assert.equal(event.attempts, 1);
  assert.ok(providerRequests.some((request) => request.includes(`/api/entity/counterparty/${fixturePrefix}legacy-ms`)));
});

test('a modern contact pair takes precedence over a conflicting legacy target', async () => {
  const id = `${fixturePrefix}modern-b24`;
  const legacyTarget = `${fixturePrefix}legacy-conflict-ms`;
  const modernTarget = `modern-target-${suffix}`;
  const parentId = `${fixturePrefix}modern-parent`;
  const legacyPair = await database.contactPair.create({ data: { bitrix24ContactId: id, moyskladCounterpartyId: legacyTarget } });
  const timestamp = new Date('2026-10-20T05:00:00.000Z');
  await database.contactSnapshot.create({ data: {
    pairId: legacyPair.id, bitrix24Email: 'legacy@example.test', moyskladEmail: 'legacy@example.test',
    bitrix24UpdatedAt: timestamp, moyskladUpdatedAt: timestamp, revision: 1,
  } });
  await database.entityPair.create({ data: {
    entityType: 'CONTACT', bitrix24Id: id, moyskladId: modernTarget, moyskladType: 'counterparty',
    active: true, source: 'MANUAL',
  } });
  const before = providerRequests.length;

  const acknowledgement = await postContactEvent(id, 'modern-pair-conflict');
  const event = await waitForEvent(acknowledgement.eventId, 'SUCCEEDED');
  assert.equal(event.status, 'SUCCEEDED');
  assert.equal(event.attempts, 1);
  const reads = providerRequests.slice(before).join('\n');
  assert.match(reads, new RegExp(`/api/entity/counterparty/${modernTarget}`));
  assert.doesNotMatch(reads, new RegExp(`/api/entity/counterparty/${legacyTarget}`));
});

test('public contact intake stays queued without provider reads in PAUSE and rejects intake in OFF', async () => {
  const mode = app.get(SyncModeService);
  await mode.setMode('pause');
  const pausedId = `${fixturePrefix}paused`;
  const beforeRequests = providerRequests.length;
  const paused = await postContactEvent(pausedId, 'pause');
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  const pausedEvent = await database.inboundEvent.findUniqueOrThrow({ where: { id: paused.eventId } });
  assert.equal(pausedEvent.status, 'RECEIVED');
  assert.equal(pausedEvent.attempts, 0);
  assert.equal(providerRequests.length, beforeRequests, 'PAUSE must not start provider reads');

  await mode.setMode('off');
  const offResponse = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMCONTACTUPDATE', auth: { application_token: 'synthetic-contact-routing-token' }, data: { FIELDS: { ID: `${fixturePrefix}off` } } }),
  });
  assert.equal(offResponse.status, 410);
  await mode.setMode('on');
});
