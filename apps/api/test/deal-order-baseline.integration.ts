import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { LocalAdminPreviewModule } from '../src/admin/local-preview.module';
import { LocalPreviewFixtureFieldDataProvider } from '../src/admin/local-preview-fixtures';
import { DatabaseService } from '../src/database.service';
import { DatabaseRecoveryService } from '../src/database-recovery.service';
import { DealOrderHeaderSyncProcessor } from '../src/deals-orders/deal-order-header-sync.processor';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { PairFirstEventProcessor } from '../src/pairs/pair-first-event.processor';
import { DEFAULT_FIELD_SETTINGS } from '../src/field-settings/approved-mappings';

let app: INestApplication;
let apiUrl = '';
let fakeApi: Server;
let fakeBase = '';
const externalRequests: Array<{ method: string; path: string }> = [];
let bitrixId = '';
let moyskladId = '';
const serviceCounterpartyId = '12345678-1234-1234-1234-123456789abd';
const bitrixProductId = '9001';
const moyskladProductId = '22345678-1234-1234-1234-123456789abc';
const moyskladPositionId = '32345678-1234-1234-1234-123456789abc';
const moyskladUnitId = '42345678-1234-1234-1234-123456789abc';
const oldEnv = new Map<string, string | undefined>();
let bitrixComments = 'B24 initial';
let bitrixTitle = 'B24 title initial';
let moyskladDescription = 'MS initial';
let moyskladName = 'MS title initial';
let bitrixCompanyId = '0';
let moyskladAgentId: string | null = null;
let bitrixOpportunity = '1';
let moyskladOrderSum: number | string = 1;
let nativeCurrencyRelation = false;
const nativeCurrencyId = '02afc9d5-d515-11e2-4ba4-7054d21a8d1e';
let runtimeCompanyId = '';
let runtimeCompanyMoyskladId = '';
let runtimeCompanyEmail = 'Match.Email@Example.Test';
let opportunityWrites = 0;
let bitrixRowPrice = 1;
let moyskladPositionPrice = 100;
let moyskladPositionVat = 0;
let moyskladPositionVatEnabled = false;
let failNextMoyskladWriteRetryAfter: string | null = null;
let failNextBitrixWriteRetryAfter: string | null = null;
let failNextBitrixRead: { status: number; retryAfter: string | null; skip?: number } | null = null;
let failNextMoyskladRead: { status: number; retryAfter: string | null } | null = null;

before(async () => {
  for (const key of ['SYNC_MODE', 'DATABASE_URL', 'DRY_DATABASE_URL', 'ADMIN_PREVIEW', 'LOCAL_HEADER_EXCHANGE', 'LOCAL_HEADER_EXCHANGE_READY', 'BITRIX24_EVENT_APPLICATION_TOKEN', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_WEBHOOK_SECRET', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN']) oldEnv.set(key, process.env[key]);
  process.env.DATABASE_URL = process.env.BASELINE_TEST_DATABASE_URL ?? 'postgresql://sync:local-only@127.0.0.1:55414/sync?schema=issue14_apply_test';
  process.env.DRY_DATABASE_URL = process.env.BASELINE_DRY_TEST_DATABASE_URL ?? 'postgresql://sync:local-only@127.0.0.1:55414/sync?schema=issue14_test';
  process.env.SYNC_MODE = 'apply';
  process.env.LOCAL_HEADER_EXCHANGE = '1';
  process.env.LOCAL_HEADER_EXCHANGE_READY = '1';
  process.env.ADMIN_PREVIEW = '1';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-event-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'synthetic-webhook-secret';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-api-token';
  fakeApi = createServer((request, response) => { void reply(request, response); });
  await new Promise<void>((resolve) => fakeApi.listen(0, '127.0.0.1', resolve));
  const address = fakeApi.address();
  assert.ok(address && typeof address !== 'string');
  fakeBase = `http://127.0.0.1:${address.port}`;
  process.env.BITRIX24_REST_BASE_URL = `${fakeBase}/b24/rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${fakeBase}/ms/api/remap/1.2/`;

  // Clear only the explicitly supplied isolated apply-test schema before
  // Nest starts recovery scans in onApplicationBootstrap.
  const setupDatabase = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  await setupDatabase.inboundEvent.deleteMany({});
  await setupDatabase.entityPairBaseline.deleteMany({});
  await setupDatabase.entityPairSyncState.deleteMany({});
  await setupDatabase.entityPair.deleteMany({ where: { entityType: 'DEAL' } });
  await setupDatabase.$disconnect();

  app = await NestFactory.create(LocalAdminPreviewModule.register(DatabaseService, LocalPreviewFixtureFieldDataProvider), { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  const database = app.get(DatabaseService);
  const recovery = app.get(DatabaseRecoveryService);
  if (!await recovery.assertReady()) {
    await recovery.confirmRecovery({
      previousLaunchBoundary: '2026-01-01T00:00:00.000Z',
      pairsRestored: true,
      lostEventsAcknowledged: true,
      acknowledgement: 'Synthetic isolated-test fixture confirms its disposable database state.',
    }, 'BITRIX24_USER:999999');
  }
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  await database.syncDirectionSetting.upsert({
    where: { entityKey: 'deals-orders' },
    create: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: true },
    update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
  });
});

beforeEach(async () => {
  bitrixComments = 'B24 initial';
  bitrixTitle = 'B24 title initial';
  moyskladDescription = 'MS initial';
  moyskladName = 'MS title initial';
  bitrixCompanyId = '0';
  moyskladAgentId = null;
  bitrixOpportunity = '1';
  moyskladOrderSum = 1;
  nativeCurrencyRelation = false;
  opportunityWrites = 0;
  bitrixRowPrice = 1;
  moyskladPositionPrice = 100;
  moyskladPositionVat = 0;
  moyskladPositionVatEnabled = false;
  failNextMoyskladWriteRetryAfter = null;
  failNextBitrixWriteRetryAfter = null;
  failNextBitrixRead = null;
  failNextMoyskladRead = null;
  externalRequests.length = 0;
  process.env.SYNC_MODE = 'apply';
  process.env.ADMIN_PREVIEW = '1';
  process.env.LOCAL_HEADER_EXCHANGE = '1';
  process.env.LOCAL_HEADER_EXCHANGE_READY = '1';
  const database = app.get(DatabaseService);
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  await database.syncDirectionSetting.upsert({
    where: { entityKey: 'deals-orders' },
    create: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: true },
    update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
  });
});

after(async () => {
  if (app) await app.close();
  if (fakeApi) await new Promise<void>((resolve, reject) => fakeApi.close((error) => error ? reject(error) : resolve()));
  for (const [key, value] of oldEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('local-only header exchange uses bilateral baseline, MS conflict priority, echo guard, and readback', async () => {
  const database = app.get(DatabaseService);
  bitrixId = String(7_000_000_000 + Math.floor(Math.random() * 1_000_000));
  moyskladId = '12345678-1234-1234-1234-123456789abc';
  const settingsVersion = 700_000 + Math.floor(Math.random() * 100_000);
  const config = {
    schemaVersion: 1,
    rules: [{ id: 'deal-comments', entity: 'deals-orders', sourceField: 'COMMENTS', targetField: 'description',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }],
    groups: [], references: { units: [{ bitrix24Id: 796, bitrix24Code: '796', moyskladId: moyskladUnitId, moyskladCode: '796', status: 'configured' }], priceTypes: [], dictionaries: [] }, serviceCounterpartyId,
  };
  await database.fieldSettingsVersion.create({ data: { version: settingsVersion, config } });
  await database.fieldSettingsState.upsert({ where: { id: 'global' }, create: { id: 'global', version: settingsVersion }, update: { version: settingsVersion } });
  await database.entityPair.create({ data: { entityType: 'DEAL', bitrix24Id: bitrixId, moyskladId, source: 'MANUAL', reason: 'public integration fixture' } });
  await createProductPair(database);

  const intake = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMDEALUPDATE', data: { FIELDS: { ID: bitrixId } }, auth: { application_token: 'synthetic-event-token' } }),
  });
  assert.equal(intake.status, 200);
  const { eventId } = await intake.json() as { eventId: string };

  for (let attempt = 0; attempt < 50 && externalRequests.length < 3; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
  await waitForEventStatus(database, eventId, 'SUCCEEDED');
  assert.deepEqual(externalRequests.slice(0, 5).map(({ method, path }) => [method, path]), [
    ['POST', '/b24/rest/crm.deal.get.json'], // launch-boundary guard reads the source creation timestamp
    ['POST', '/b24/rest/crm.deal.get.json'], // dependency discovery reads the deal before baseline capture
    ['GET', `/ms/api/remap/1.2/entity/counterparty/${serviceCounterpartyId}`],
    ['GET', `/ms/api/remap/1.2/entity/customerorder/${moyskladId}`],
    ['POST', '/b24/rest/crm.deal.get.json'], // baseline captures current B24 fields after dependencies
  ]);
  assertPositionReadPaths(5);
  assert.equal(externalRequests.filter(isWrite).length, 0, 'baseline capture must not write either system');
  assert.equal(moyskladDescription, 'MS initial');
  const syncStateAfterHeaderNoop = await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId: (await database.entityPair.findFirstOrThrow({ where: { entityType: 'DEAL', bitrix24Id: bitrixId } })).id } });
  assert.equal((syncStateAfterHeaderNoop.bitrix24Values as Record<string, unknown>)['rule:deal-comments'], 'B24 initial', 'header state initialization preserves field-runtime snapshots');
  assert.equal((syncStateAfterHeaderNoop.bitrix24Values as Record<string, unknown>)['deal-order-comments'], 'B24 initial', 'header and field-runtime state share a complete snapshot');


  process.env.LOCAL_HEADER_EXCHANGE_READY = '0';
  bitrixComments = 'blocked while entity readiness gate is closed';
  const readinessGated = await postB24(bitrixId, bitrixComments, 'entity-not-ready');
  assert.equal(readinessGated.status, 200);
  const { eventId: readinessGatedEventId } = await readinessGated.json() as { eventId: string };
  await waitForEventStatus(database, readinessGatedEventId, 'SUCCEEDED');
  assert.equal(externalRequests.filter(isWrite).length, 0, 'global mode and mapping alone do not bypass entity readiness');
  process.env.LOCAL_HEADER_EXCHANGE_READY = '1';

  bitrixComments = 'B24 changed'; // source system state changes before its webhook is delivered
  const changedB24 = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMDEALUPDATE', data: { FIELDS: { ID: bitrixId, COMMENTS: 'B24 changed' }, marker: 'b24-change-1' }, auth: { application_token: 'synthetic-event-token' } }),
  });
  assert.equal(changedB24.status, 200);
  const { eventId: changedB24EventId } = await changedB24.json() as { eventId: string };
  await waitUntil(() => moyskladDescription === 'B24 changed');
  await waitForEventStatus(database, changedB24EventId, 'SUCCEEDED');
  const b24UpdateCount = externalRequests.filter((request) => request.path.endsWith('/crm.deal.update.json')).length;
  assert.equal(b24UpdateCount, 0);
  assert.equal(externalRequests.filter((request) => request.method === 'PUT').length, 1);

  // Re-delivery of the same value is an echo/no-op, not another write.
  const echoB24 = await postB24(bitrixId, 'B24 changed', 'b24-echo');
  assert.equal(echoB24.status, 200);
  const { eventId: echoB24EventId } = await echoB24.json() as { eventId: string };
  await waitForEventStatus(database, echoB24EventId, 'SUCCEEDED');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(externalRequests.filter((request) => request.method === 'PUT').length, 1);
  assert.equal(externalRequests.filter((request) => request.path.endsWith('/crm.deal.update.json')).length, 0);

  // A later MySklad edit wins and is propagated back to B24.
  moyskladDescription = 'MS wins';
  const msChange = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-webhook-secret?requestId=ms-change-1`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { type: 'customerorder', href: `${fakeBase}/entity/customerorder/${moyskladId}` } }] }),
  });
  assert.equal(msChange.status, 200);
  const { eventId: msChangeEventId } = await msChange.json() as { eventId: string };
  await waitUntil(() => bitrixComments === 'MS wins');
  await waitForEventStatus(database, msChangeEventId, 'SUCCEEDED');
  assert.equal(externalRequests.filter((request) => request.path.endsWith('/crm.deal.update.json')).length, 1);

  const writesBeforeEcho = externalRequests.filter(isWrite).length;
  const echoMs = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-webhook-secret?requestId=ms-echo-1`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { type: 'customerorder', href: `${fakeBase}/entity/customerorder/${moyskladId}` } }] }),
  });
  assert.equal(echoMs.status, 200);
  const { eventId: echoMsEventId } = await echoMs.json() as { eventId: string };
  await waitForEventStatus(database, echoMsEventId, 'SUCCEEDED');
  assert.equal(externalRequests.filter(isWrite).length, writesBeforeEcho, 'matching bilateral values are not rewritten');

  // Provider throttling leaves the event durable at the supplied HTTP-date due time.
  const retryAt = new Date(Date.now() + 30_000);
  failNextMoyskladWriteRetryAfter = retryAt.toUTCString();
  bitrixComments = 'rate limited update';
  const rateLimitedEventResponse = await postB24(bitrixId, bitrixComments, 'rate-limited-header-write');
  assert.equal(rateLimitedEventResponse.status, 200);
  const { eventId: rateLimitedEventId } = await rateLimitedEventResponse.json() as { eventId: string };
  const rateLimitedEvent = await waitForEventStatus(database, rateLimitedEventId, 'RETRYABLE_FAILURE');
  assert.ok(rateLimitedEvent.retryAfter);
  assert.ok(Math.abs(rateLimitedEvent.retryAfter.getTime() - Date.parse(retryAt.toUTCString())) < 1_000);
  assert.equal(moyskladDescription, 'MS wins', 'a rejected write does not change the fake provider state');

  const bitrixWriteRetryAt = new Date(Date.now() + 35_000);
  failNextBitrixWriteRetryAfter = bitrixWriteRetryAt.toUTCString();
  moyskladDescription = 'MS rate limited B24 update';
  const bitrixRateLimitedResponse = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-webhook-secret?requestId=rate-limited-b24-header-write`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { type: 'customerorder', href: `${fakeBase}/entity/customerorder/${moyskladId}` } }] }),
  });
  assert.equal(bitrixRateLimitedResponse.status, 200);
  const { eventId: bitrixRateLimitedEventId } = await bitrixRateLimitedResponse.json() as { eventId: string };
  const bitrixRateLimitedEvent = await waitForEventStatus(database, bitrixRateLimitedEventId, 'RETRYABLE_FAILURE');
  assert.ok(bitrixRateLimitedEvent.retryAfter);
  assert.ok(Math.abs(bitrixRateLimitedEvent.retryAfter.getTime() - Date.parse(bitrixWriteRetryAt.toUTCString())) < 1_000);
  assert.equal(bitrixComments, 'rate limited update', 'a malformed rejected B24 write does not change provider state');

  const writesAfterRateLimit = externalRequests.filter(isWrite).length;
  const base24BeforeGate = process.env.BITRIX24_REST_BASE_URL;
  process.env.LOCAL_HEADER_EXCHANGE = '0';
  bitrixComments = 'must not write while disabled';
  const disabled = await postB24(bitrixId, bitrixComments, 'local-gate-off');
  assert.equal(disabled.status, 200);
  const { eventId: disabledEventId } = await disabled.json() as { eventId: string };
  await waitForEventStatus(database, disabledEventId, 'SUCCEEDED');
  assert.equal(externalRequests.filter(isWrite).length, writesAfterRateLimit, 'the local exchange gate defaults closed');

  process.env.LOCAL_HEADER_EXCHANGE = '1';
  const requestsBeforeGate = externalRequests.length;
  const pair = await database.entityPair.findFirstOrThrow({ where: { entityType: 'DEAL', bitrix24Id: bitrixId, moyskladId } });
  const eventConfig = await app.get(FieldSettingsService).eventConfig(disabledEventId);
  const headerSync = app.get(DealOrderHeaderSyncProcessor);
  process.env.BITRIX24_REST_BASE_URL = 'https://external.example/rest/';
  assert.equal(await headerSync.process({ eventId: disabledEventId, pair: { id: pair.id, entityType: 'DEAL', bitrix24Id: bitrixId, moyskladId, status: 'MANUAL', source: 'PERSISTED' }, eventConfig, baselineId: pair.id }), 'DISABLED');
  assert.equal(externalRequests.length, requestsBeforeGate, 'the header writer rejects non-loopback B24 before making another HTTP request');
  process.env.BITRIX24_REST_BASE_URL = base24BeforeGate;

  const baseMsBeforeGate = process.env.MOYSKLAD_API_BASE_URL;
  process.env.MOYSKLAD_API_BASE_URL = 'http://remote.example/api/';
  assert.equal(await headerSync.process({ eventId: disabledEventId, pair: { id: pair.id, entityType: 'DEAL', bitrix24Id: bitrixId, moyskladId, status: 'MANUAL', source: 'PERSISTED' }, eventConfig, baselineId: pair.id }), 'DISABLED');
  assert.equal(externalRequests.length, requestsBeforeGate, 'the header writer rejects non-loopback MySklad before making another HTTP request');
  process.env.MOYSKLAD_API_BASE_URL = baseMsBeforeGate;

  const unconfirmedId = String(Number(bitrixId) + 1);
  const writesBeforeUnmatched = externalRequests.filter(isWrite).length;
  const unconfirmed = await postB24(unconfirmedId, 'unmatched', 'unconfirmed-pair');
  assert.equal(unconfirmed.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(externalRequests.filter(isWrite).length, writesBeforeUnmatched, 'unconfirmed pairs never reach a writer');
  assert.ok(externalRequests.every((request) => ['GET', 'POST', 'PUT'].includes(request.method)));
  assert.ok(externalRequests.filter(isWrite).every((request) =>
    (request.method === 'PUT' && request.path === `/ms/api/remap/1.2/entity/customerorder/${moyskladId}`) ||
    (request.method === 'POST' && request.path === '/b24/rest/crm.deal.update.json')));
});

test('paired-client updates run without COMMENTS mapping or the legacy header gate, preserve pair, and use MS conflict priority', async (t) => {
  const database = app.get(DatabaseService);
  const priorFlags = ['ADMIN_PREVIEW', 'LOCAL_HEADER_EXCHANGE', 'LOCAL_HEADER_EXCHANGE_READY'].map((key) => process.env[key]);
  t.after(() => {
    for (const [key, value] of ['ADMIN_PREVIEW', 'LOCAL_HEADER_EXCHANGE', 'LOCAL_HEADER_EXCHANGE_READY'].map((name, index) => [name, priorFlags[index]] as const)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  bitrixId = String(7_300_000_000 + Math.floor(Math.random() * 1_000_000));
  moyskladId = randomUUID();
  const oldCompanyB24 = String(9_300_000_000 + Math.floor(Math.random() * 100_000)); const oldCompanyMs = randomUUID();
  const b24CompanyA = String(9_310_000_000 + Math.floor(Math.random() * 100_000)); const companyAMs = randomUUID();
  const b24CompanyB = String(9_320_000_000 + Math.floor(Math.random() * 100_000)); const companyBMs = randomUUID();
  const b24CompanyC = String(9_330_000_000 + Math.floor(Math.random() * 100_000)); const companyCMs = randomUUID();
  const b24CompanyD = String(9_340_000_000 + Math.floor(Math.random() * 100_000)); const companyDMs = randomUUID();
  for (const [bitrix24Id, moyskladCompanyId] of [[oldCompanyB24, oldCompanyMs], [b24CompanyA, companyAMs], [b24CompanyB, companyBMs], [b24CompanyC, companyCMs], [b24CompanyD, companyDMs]]) {
    await database.entityPair.create({ data: { entityType: 'COMPANY', bitrix24Id, moyskladId: moyskladCompanyId, moyskladType: 'counterparty', source: 'MANUAL', reason: 'client runtime test pair' } });
  }
  const settingsVersion = 950_000 + Math.floor(Math.random() * 10_000);
  await createPairAndSettings(database, settingsVersion, false);
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  process.env.ADMIN_PREVIEW = '0'; process.env.LOCAL_HEADER_EXCHANGE = '0'; process.env.LOCAL_HEADER_EXCHANGE_READY = '0';
  bitrixCompanyId = oldCompanyB24; moyskladAgentId = oldCompanyMs;
  const writesBeforeBaseline = externalRequests.filter(isWrite).length;
  const pairId = (await database.entityPair.findFirstOrThrow({ where: { entityType: 'DEAL', bitrix24Id: bitrixId, moyskladId } })).id;
  const firstResponse = await postB24(bitrixId, bitrixComments, 'client-first-baseline');
  const { eventId: firstEventId } = await firstResponse.json() as { eventId: string };
  await waitForEventStatus(database, firstEventId, 'SUCCEEDED');
  assert.equal(externalRequests.filter(isWrite).length, writesBeforeBaseline, 'first-event baseline only seeds client state');
  const firstState = await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId } });
  assert.equal((firstState.bitrix24Values as Record<string, unknown>)['client:companyId'], oldCompanyB24);
  assert.equal((firstState.moyskladValues as Record<string, unknown>)['client:agentId'], oldCompanyMs);

  bitrixRowPrice = 2; moyskladOrderSum = 2;
  const rowChange = await postB24(bitrixId, bitrixComments, 'no-comments-row-update');
  const { eventId: rowEventId } = await rowChange.json() as { eventId: string };
  await waitUntil(() => moyskladPositionPrice === 200);
  await waitForEventStatus(database, rowEventId, 'SUCCEEDED');
  assert.equal(bitrixOpportunity, '2', 'row-value change bypasses the one-kopeck total-only exception and restores the computed MS sum');
  assert.ok(externalRequests.some((request) => request.method === 'PUT' && request.path.endsWith(`/customerorder/${moyskladId}/positions/${moyskladPositionId}`)), 'row update runs independently of header/comments gate');

  bitrixCompanyId = b24CompanyA;
  const b24Change = await postB24(bitrixId, bitrixComments, 'client-b24-change');
  const { eventId: b24EventId } = await b24Change.json() as { eventId: string };
  await waitUntil(() => moyskladAgentId === companyAMs);
  await waitForEventStatus(database, b24EventId, 'SUCCEEDED');
  assert.equal((await database.entityPair.findUniqueOrThrow({ where: { id: pairId } })).moyskladId, moyskladId, 'client update retains the same document pair');

  moyskladAgentId = companyBMs;
  const msChange = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-webhook-secret?requestId=client-ms-change`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { type: 'customerorder', href: `${fakeBase}/entity/customerorder/${moyskladId}` } }] }) });
  const { eventId: msEventId } = await msChange.json() as { eventId: string };
  await waitUntil(() => bitrixCompanyId === b24CompanyB);
  await waitForEventStatus(database, msEventId, 'SUCCEEDED');

  bitrixCompanyId = b24CompanyC; moyskladAgentId = companyDMs;
  const conflict = await postB24(bitrixId, bitrixComments, 'client-simultaneous-conflict');
  const { eventId: conflictEventId } = await conflict.json() as { eventId: string };
  await waitUntil(() => bitrixCompanyId === b24CompanyD);
  await waitForEventStatus(database, conflictEventId, 'SUCCEEDED');

  bitrixCompanyId = '0';
  const cleared = await postB24(bitrixId, bitrixComments, 'client-clear-to-service-counterparty');
  const { eventId: clearEventId } = await cleared.json() as { eventId: string };
  await waitUntil(() => moyskladAgentId === serviceCounterpartyId);
  await waitForEventStatus(database, clearEventId, 'SUCCEEDED');
  assert.ok(externalRequests.some((request) => request.method === 'GET' && request.path.endsWith(`/entity/counterparty/${serviceCounterpartyId}`)), 'configured service counterparty is confirmed through the provider before assignment');
  assert.equal(externalRequests.some((request) => request.path.includes('/customerorder/create') || request.path.includes('/crm.deal.add')), false);
});

test('document totals retain only B24-origin one-kopeck RUB residue and otherwise restore from MS sum', async () => {
  const database = app.get(DatabaseService);
  bitrixId = String(7_400_000_000 + Math.floor(Math.random() * 1_000_000)); moyskladId = randomUUID();
  const settingsVersion = 960_000 + Math.floor(Math.random() * 10_000);
  const pair = await createConfirmedPairAndSettings(database, settingsVersion);
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  bitrixOpportunity = '1'; moyskladOrderSum = 1; opportunityWrites = 0;
  const initial = await postB24(bitrixId, bitrixComments, 'total-baseline');
  const { eventId: initialEventId } = await initial.json() as { eventId: string };
  await waitForEventStatus(database, initialEventId, 'SUCCEEDED');

  bitrixOpportunity = '1.01';
  const penny = await postB24(bitrixId, bitrixComments, 'total-one-kopeck');
  const { eventId: pennyEventId } = await penny.json() as { eventId: string };
  await waitForEventStatus(database, pennyEventId, 'SUCCEEDED');
  assert.equal(bitrixOpportunity, '1.01');
  assert.equal(opportunityWrites, 0, 'one kopeck from a B24-origin total-only change must not trigger a corrective write');
  const history = await database.operationalLog.findFirst({ where: { referenceId: pennyEventId, message: { contains: 'B24_ONE_KOPECK_RETAINED' } } });
  assert.ok(history, 'the residue is recorded in event history with raw values');

  bitrixOpportunity = '1.03';
  const overTolerance = await postB24(bitrixId, bitrixComments, 'total-over-tolerance');
  const { eventId: overEventId } = await overTolerance.json() as { eventId: string };
  await waitForEventStatus(database, overEventId, 'SUCCEEDED');
  assert.equal(bitrixOpportunity, '1');
  assert.equal(opportunityWrites, 1, 'a divergence greater than one kopeck is restored from the read-only MySklad sum');

  moyskladOrderSum = 1.05;
  const msTotal = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-webhook-secret?requestId=total-ms-change`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { type: 'customerorder', href: `${fakeBase}/entity/customerorder/${moyskladId}` } }] }) });
  const { eventId: msTotalEventId } = await msTotal.json() as { eventId: string };
  await waitUntil(() => bitrixOpportunity === '1.05');
  await waitForEventStatus(database, msTotalEventId, 'SUCCEEDED');
  assert.equal(opportunityWrites, 2, 'only B24 OPPORTUNITY is writable; MS sum remains authoritative and read-only');

  await database.syncDirectionSetting.upsert({ where: { entityKey: 'deals-orders' }, create: { entityKey: 'deals-orders', bitrix24ToMoysklad: false, moyskladToBitrix24: true }, update: { bitrix24ToMoysklad: false, moyskladToBitrix24: true } });
  bitrixOpportunity = '1.08';
  const directionCheck = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-webhook-secret?requestId=total-target-direction`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { type: 'customerorder', href: `${fakeBase}/entity/customerorder/${moyskladId}` } }] }) });
  const { eventId: directionEventId } = await directionCheck.json() as { eventId: string };
  await waitUntil(() => bitrixOpportunity === '1.05');
  await waitForEventStatus(database, directionEventId, 'SUCCEEDED');
  assert.equal(opportunityWrites, 3, 'a B24 target write follows the MS→B24 direction even when B24→MS is disabled');
  await database.syncDirectionSetting.upsert({ where: { entityKey: 'deals-orders' }, create: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: true }, update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } });
});

test('public paired updates normalize native currency and kopecks while refusing ambiguous legacy total snapshots', async () => {
  const database = app.get(DatabaseService);
  bitrixId = String(7_420_000_000 + Math.floor(Math.random() * 1_000_000)); moyskladId = randomUUID();
  const settingsVersion = 990_000 + Math.floor(Math.random() * 1000);
  const pair = await createConfirmedPairAndSettings(database, settingsVersion);
  const settings = await app.get(FieldSettingsService).version(settingsVersion);
  await database.fieldSettingsVersion.update({where:{version:settingsVersion},data:{config:{...settings.config,
    dealOrderRuntime:{currencies:[{bitrix24Code:'RUB',moyskladId:nativeCurrencyId}]}} as any}});
  nativeCurrencyRelation = true;
  const first = await postB24(bitrixId, bitrixComments, 'native-currency-total');
  await waitForEventStatus(database, (await first.json() as {eventId:string}).eventId, 'SUCCEEDED');
  const baseline = await database.entityPairBaseline.findUniqueOrThrow({where:{pairId:pair.id}});
  assert.deepEqual((baseline.moyskladValues as any)['deal-order-total'],{amount:'1',currencyCode:'RUB',amountUnit:'major-v1'});
  bitrixOpportunity = '1.03';
  const next = await postB24(bitrixId, bitrixComments, 'native-currency-correction');
  await waitForEventStatus(database,(await next.json() as {eventId:string}).eventId,'SUCCEEDED');
  assert.equal(bitrixOpportunity,'1','100 kopecks must never become 100 rubles in B24');
  assert.equal(opportunityWrites,1);
  const legacy = {...baseline.moyskladValues as any,'deal-order-total':{amount:100,currencyCode:null}};
  await database.entityPairBaseline.update({where:{pairId:pair.id},data:{moyskladValues:legacy}});
  const held = await postB24(bitrixId, bitrixComments, 'legacy-total-no-guess');
  const heldId = (await held.json() as {eventId:string}).eventId;
  await waitForEventStatus(database,heldId,'MANUAL_REVIEW');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({where:{id:heldId}})).lastErrorCategory,'DEAL_ORDER_TOTAL_LEGACY_BASELINE_REVIEW_REQUIRED');
  assert.equal(opportunityWrites,1);
});

test('deal/order source read failures persist bounded Retry-After; permanent 4xx is held for review', async () => {
  const database = app.get(DatabaseService);
  const writesBefore = externalRequests.filter(isWrite).length;

  bitrixId = String(7_050_000_000 + Math.floor(Math.random() * 1_000_000));
  moyskladId = randomUUID();
  await createConfirmedPairAndSettings(database, 750_000 + Math.floor(Math.random() * 100_000));
  const bitrixRetryAt = new Date(Date.now() + 30_000);
  failNextBitrixRead = { status: 429, retryAfter: bitrixRetryAt.toUTCString() };
  const bitrixResponse = await postB24(bitrixId, 'B24 source', 'b24-read-rate-limit');
  const { eventId: bitrixEventId } = await bitrixResponse.json() as { eventId: string };
  const bitrixEvent = await waitForEventStatus(database, bitrixEventId, 'RETRYABLE_FAILURE');
  assert.ok(bitrixEvent.retryAfter);
  assert.ok(Math.abs(bitrixEvent.retryAfter.getTime() - Date.parse(bitrixRetryAt.toUTCString())) < 1_000);

  bitrixId = String(7_060_000_000 + Math.floor(Math.random() * 1_000_000));
  moyskladId = randomUUID();
  await createConfirmedPairAndSettings(database, 760_000 + Math.floor(Math.random() * 100_000));
  const moyskladRetryAt = new Date(Date.now() + 30_000);
  failNextMoyskladRead = { status: 429, retryAfter: moyskladRetryAt.toUTCString() };
  const moyskladResponse = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-webhook-secret?requestId=ms-read-rate-limit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { type: 'customerorder', href: `${fakeBase}/entity/customerorder/${moyskladId}` } }] }),
  });
  const { eventId: moyskladEventId } = await moyskladResponse.json() as { eventId: string };
  const moyskladEvent = await waitForEventStatus(database, moyskladEventId, 'RETRYABLE_FAILURE');
  assert.ok(moyskladEvent.retryAfter);
  assert.ok(Math.abs(moyskladEvent.retryAfter.getTime() - Date.parse(moyskladRetryAt.toUTCString())) < 1_000);

  bitrixId = String(7_070_000_000 + Math.floor(Math.random() * 1_000_000));
  moyskladId = randomUUID();
  await createConfirmedPairAndSettings(database, 770_000 + Math.floor(Math.random() * 100_000));
  failNextBitrixRead = { status: 400, retryAfter: null };
  const permanentResponse = await postB24(bitrixId, 'permanent source rejection', 'b24-read-client-error');
  const { eventId: permanentEventId } = await permanentResponse.json() as { eventId: string };
  const permanentEvent = await waitForEventStatus(database, permanentEventId, 'MANUAL_REVIEW');
  assert.equal(permanentEvent.retryAfter, null, 'permanent 4xx failures are not scheduled for retry');
  assert.equal(externalRequests.filter(isWrite).length, writesBefore, 'source reads must succeed before any external write');
});

test('baseline database timeout leaves the event recoverable in PROCESSING', async () => {
  const database = app.get(DatabaseService);
  bitrixId = String(7_080_000_000 + Math.floor(Math.random() * 1_000_000));
  moyskladId = randomUUID();
  const pair = await createConfirmedPairAndSettings(database, 780_000 + Math.floor(Math.random() * 100_000));
  const baselineModel = database.entityPairBaseline;
  const originalFindUnique = baselineModel.findUnique.bind(baselineModel);
  let failOnce = true;
  const injectedFindUnique = async (...args: unknown[]) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('synthetic database timeout');
    }
    return originalFindUnique(args[0] as Parameters<typeof baselineModel.findUnique>[0]);
  };
  baselineModel.findUnique = injectedFindUnique as unknown as typeof baselineModel.findUnique;

  try {
    const response = await postB24(bitrixId, 'database retry source', 'baseline-database-timeout');
    const { eventId } = await response.json() as { eventId: string };
    await waitForEventStatus(database, eventId, 'PROCESSING');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const held = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(held.status, 'PROCESSING');
    assert.equal(held.retryAfter, null);
    assert.equal(held.lastErrorCategory, null);
    assert.ok(held.processingStartedAt);

    baselineModel.findUnique = originalFindUnique;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await database.inboundEvent.update({
      where: { id: eventId },
      data: { processingStartedAt: new Date(Date.now() - 120_000) },
    });
    const retryResult = await app.get(PairFirstEventProcessor).process(eventId);
    assert.ok(retryResult, 'stale PROCESSING row is eligible for recovery');
    const recovered = await waitForEventStatus(database, eventId, 'SUCCEEDED');
    assert.equal(recovered.status, 'SUCCEEDED');
    assert.ok(await database.entityPairBaseline.findUnique({ where: { pairId: pair.id } }));
  } finally {
    baselineModel.findUnique = originalFindUnique;
  }
});

test('sequential deal baseline timeouts use increasing bounded fallback backoff', async () => {
  const database = app.get(DatabaseService);
  bitrixId = String(7_090_000_000 + Math.floor(Math.random() * 1_000_000));
  moyskladId = randomUUID();
  await createConfirmedPairAndSettings(database, 790_000 + Math.floor(Math.random() * 100_000));
  failNextBitrixRead = { status: 503, retryAfter: null, skip: 2 };
  const response = await postB24(bitrixId, 'retry one', 'baseline-backoff');
  const { eventId } = await response.json() as { eventId: string };
  const first = await waitForEventAttempt(database, eventId, 1);
  assert.ok(first.retryAfter);
  const firstDelay = first.retryAfter!.getTime() - Date.now();
  assert.ok(firstDelay > 3_000 && firstDelay <= 5_000, `first fallback should be ~5s, got ${firstDelay}ms`);

  failNextBitrixRead = { status: 503, retryAfter: null, skip: 2 };
  await database.inboundEvent.update({ where: { id: eventId }, data: { retryAfter: new Date(Date.now() - 1_000) } });
  const second = await waitForEventAttempt(database, eventId, 2);
  assert.ok(second.retryAfter);
  const secondDelay = second.retryAfter!.getTime() - Date.now();
  assert.ok(secondDelay > 8_000 && secondDelay <= 10_000, `second fallback should grow to ~10s, got ${secondDelay}ms`);
  assert.ok(second.retryAfter!.getTime() > first.retryAfter!.getTime(), 'durable dueAt increases after a repeated timeout');
});

test('first confirmed event captures baseline with header-writer preview flags disabled', async () => {
  const database = app.get(DatabaseService);
  bitrixId = String(7_100_000_000 + Math.floor(Math.random() * 1_000_000));
  moyskladId = randomUUID();
  const settingsVersion = 800_000 + Math.floor(Math.random() * 100_000);
  const pair = await createConfirmedPairAndSettings(database, settingsVersion);
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  process.env.ADMIN_PREVIEW = '0';
  process.env.LOCAL_HEADER_EXCHANGE = '0';
  process.env.LOCAL_HEADER_EXCHANGE_READY = '0';
  const requestsBefore = externalRequests.length;

  const response = await postB24(bitrixId, 'production first event', 'production-baseline-only');
  assert.equal(response.status, 200);
  const { eventId } = await response.json() as { eventId: string };
  await waitForBaseline(database, pair.id);
  await waitForEventStatus(database, eventId, 'SUCCEEDED');
  const baseline = await database.entityPairBaseline.findUnique({ where: { pairId: pair.id } });
  assert.ok(baseline, 'Q26.66 baseline capture is not gated by local preview flags');
  assert.deepEqual(externalRequests.slice(requestsBefore, requestsBefore + 5).map(({ method }) => method), ['POST', 'POST', 'GET', 'GET', 'POST']);
  assert.ok(externalRequests.length > requestsBefore + 4, 'ordinary row/client exchange remains active when only the legacy header writer is disabled');
  assert.equal(externalRequests.slice(requestsBefore).filter(isWrite).length, 0);
  assertPositionReadPaths(requestsBefore);

  process.env.ADMIN_PREVIEW = '1';
  process.env.LOCAL_HEADER_EXCHANGE = '1';
  process.env.LOCAL_HEADER_EXCHANGE_READY = '1';
});

test('pause stores event without provider reads; resume captures current state once without writes', async () => {
  const database = app.get(DatabaseService);
  bitrixId = String(7_200_000_000 + Math.floor(Math.random() * 1_000_000));
  moyskladId = randomUUID();
  const settingsVersion = 900_000 + Math.floor(Math.random() * 100_000);
  const pair = await createConfirmedPairAndSettings(database, settingsVersion);
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'pause' } });
  const requestsBefore = externalRequests.length;
  const writesBefore = externalRequests.filter(isWrite).length;

  const response = await postB24(bitrixId, 'paused first event', 'paused-baseline-only');
  assert.equal(response.status, 200);
  const { eventId } = await response.json() as { eventId: string };
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(externalRequests.length, requestsBefore, 'pause does not perform provider reads');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } })).status, 'RECEIVED');
  bitrixComments = 'current state on resume';
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  await waitForBaseline(database, pair.id);
  await waitForEventStatus(database, eventId, 'SUCCEEDED');
  const baseline = await database.entityPairBaseline.findUniqueOrThrow({ where: { pairId: pair.id } });
  assert.equal((baseline.bitrix24Values as { 'rule:deal-comments'?: string })['rule:deal-comments'], 'current state on resume');
  assert.deepEqual(externalRequests.slice(requestsBefore, requestsBefore + 5).map(({ method }) => method), ['POST', 'POST', 'GET', 'GET', 'POST']);
  assertPositionReadPaths(requestsBefore);
  assert.equal(externalRequests.filter(isWrite).length, writesBefore, 'pause permits baseline source reads but no sync writes');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } })).status, 'SUCCEEDED');
});

test('global off rejects intake before persistence, pair resolution, or upstream reads', async () => {
  const database = app.get(DatabaseService);
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'off' } });
  const requestsBefore = externalRequests.length;
  const eventsBefore = await database.inboundEvent.count();

  const response = await postB24(String(7_300_000_001), 'must not be accepted', 'global-off-reject');
  assert.equal(response.status, 410);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await database.inboundEvent.count(), eventsBefore);
  assert.equal(externalRequests.length, requestsBefore, 'off rejects before queuing any pair/baseline work');

  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
});

test('dry first-event baseline uses the isolated dry database and performs reads only', async () => {
  const applyDatabaseUrl = process.env.BASELINE_TEST_DATABASE_URL ?? 'postgresql://sync:local-only@127.0.0.1:55414/sync?schema=issue14_apply_test';
  await app.close();
  process.env.SYNC_MODE = 'dry';
  process.env.DRY_DATABASE_URL = process.env.BASELINE_DRY_TEST_DATABASE_URL ?? 'postgresql://sync:local-only@127.0.0.1:55414/sync?schema=issue14_test';
  const drySetupDatabase = new PrismaClient({ datasources: { db: { url: process.env.DRY_DATABASE_URL } } });
  await drySetupDatabase.inboundEvent.deleteMany({});
  await drySetupDatabase.entityPairBaseline.deleteMany({});
  await drySetupDatabase.entityPairSyncState.deleteMany({});
  await drySetupDatabase.entityPair.deleteMany({ where: { entityType: 'DEAL' } });
  await drySetupDatabase.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  await drySetupDatabase.syncDirectionSetting.upsert({
    where: { entityKey: 'deals-orders' },
    create: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: true },
    update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
  });
  await drySetupDatabase.$disconnect();
  app = await NestFactory.create(LocalAdminPreviewModule.register(DatabaseService, LocalPreviewFixtureFieldDataProvider), { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  const database = app.get(DatabaseService);
  const recovery = app.get(DatabaseRecoveryService);
  if (!await recovery.assertReady()) await recovery.confirmRecovery({
    previousLaunchBoundary: '2026-01-01T00:00:00.000Z', pairsRestored: true, lostEventsAcknowledged: true,
    acknowledgement: 'Synthetic isolated dry fixture confirms its disposable database state.',
  }, 'BITRIX24_USER:999999');
  bitrixId = String(7_400_000_000 + Math.floor(Math.random() * 1_000_000));
  moyskladId = randomUUID();
  const settingsVersion = 1_000_000 + Math.floor(Math.random() * 100_000);
  const pair = await createConfirmedPairAndSettings(database, settingsVersion);
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  await database.syncDirectionSetting.upsert({
    where: { entityKey: 'deals-orders' },
    create: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: true },
    update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
  });
  const requestsBefore = externalRequests.length;
  const writesBefore = externalRequests.filter(isWrite).length;

  const response = await postB24(bitrixId, 'dry first event', 'dry-baseline-only');
  assert.equal(response.status, 200);
  await waitForBaseline(database, pair.id);
  await waitForEventStatus(database, (await response.json() as { eventId: string }).eventId, 'SUCCEEDED');
  const applyDatabase = new PrismaClient({ datasources: { db: { url: applyDatabaseUrl } } });
  assert.equal(await applyDatabase.entityPairBaseline.findUnique({ where: { pairId: pair.id } }), null);
  await applyDatabase.$disconnect();
  assert.deepEqual(externalRequests.slice(requestsBefore).map(({ method }) => method), ['POST', 'POST', 'GET', 'GET', 'POST']);
  assert.equal(externalRequests.filter(isWrite).length, writesBefore, 'dry mode performs no external synchronization writes');
});

test('public company webhook pairs by unique normalized email and reads back both native records', async () => {
  const database = app.get(DatabaseService);
  runtimeCompanyId = `email-match-${randomUUID()}`;
  runtimeCompanyMoyskladId = randomUUID();
  runtimeCompanyEmail = 'Match.Email@Example.Test';
  const settingsVersion = 1_200_000 + Math.floor(Math.random() * 100_000);
  await database.fieldSettingsVersion.create({ data: { version: settingsVersion, config: {
    schemaVersion: 1, rules: [], groups: [],
    references: { units: [], priceTypes: [], dictionaries: [] }, serviceCounterpartyId,
  } } });
  await database.fieldSettingsState.upsert({ where: { id: 'global' }, create: { id: 'global', version: settingsVersion }, update: { version: settingsVersion } });
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  await database.syncDirectionSetting.upsert({
    where: { entityKey: 'contacts-companies' },
    create: { entityKey: 'contacts-companies', bitrix24ToMoysklad: true, moyskladToBitrix24: true },
    update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
  });

  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMCOMPANYADD', data: { FIELDS: { ID: runtimeCompanyId } }, auth: { application_token: 'synthetic-event-token' } }),
  });
  assert.equal(response.status, 200);
  const { eventId } = await response.json() as { eventId: string };
  await waitForEventStatus(database, eventId, 'UNCHANGED');

  const pair = await database.entityPair.findFirstOrThrow({ where: { entityType: 'COMPANY', bitrix24Id: runtimeCompanyId, active: true } });
  assert.equal(pair.moyskladId, runtimeCompanyMoyskladId);
  assert.match(pair.reason ?? '', /normalized_email/i);
  assert.match(pair.reason ?? '', /no name or phone match was required/i);
  assert.ok(externalRequests.some(({ path }) => {
    const request = new URL(path, fakeBase);
    return request.pathname === '/ms/api/remap/1.2/entity/counterparty' && request.searchParams.get('filter') === 'email=match.email@example.test';
  }));
  assert.ok(externalRequests.some(({ path }) => path === '/b24/rest/crm.company.get.json'));
  assert.ok(externalRequests.some(({ path }) => path === `/ms/api/remap/1.2/entity/counterparty/${runtimeCompanyMoyskladId}`));
  assert.equal(externalRequests.some(isWrite), false, 'the email match must not create a target or issue a field write');
});

test('public V1-pinned event, HTTP V2 save and webhook revision preserve the V2 baseline when an old retry resumes', async () => {
  const database = app.get(DatabaseService);
  bitrixId = String(7_500_000_000 + Math.floor(Math.random() * 1_000_000));
  moyskladId = randomUUID();
  const settingsVersion = 1_350_000 + Math.floor(Math.random() * 10_000);
  const pair = await createPairAndSettings(database, settingsVersion, false);
  await createProductPair(database);
  const testReferences = {
    ...structuredClone(DEFAULT_FIELD_SETTINGS.references),
    units: [...structuredClone(DEFAULT_FIELD_SETTINGS.references.units), { bitrix24Id: 796, bitrix24Code: '796', moyskladId: moyskladUnitId, moyskladCode: '796', status: 'configured' as const }],
  };
  const initialVersion = await app.get(FieldSettingsService).version(settingsVersion);
  await database.fieldSettingsVersion.update({ where: { version: settingsVersion }, data: { config: { ...initialVersion.config, references: testReferences } } });
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  const initialResponse = await postB24(bitrixId, bitrixComments, 'initial-v1-baseline');
  assert.equal(initialResponse.status, 200);
  const { eventId: initialEventId } = await initialResponse.json() as { eventId: string };
  await waitForEventStatus(database, initialEventId, 'SUCCEEDED');
  assert.equal((await database.entityPairBaseline.findUniqueOrThrow({ where: { pairId: pair.id } })).settingsVersion, settingsVersion);

  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'pause' } });

  const oldResponse = await postB24(bitrixId, bitrixComments, 'old-v1-pending');
  assert.equal(oldResponse.status, 200);
  const { eventId: oldEventId } = await oldResponse.json() as { eventId: string };
  assert.equal((await app.get(FieldSettingsService).eventConfig(oldEventId)).version, settingsVersion, 'the durable event keeps its original V1 pin');
  await database.inboundEvent.update({ where: { id: oldEventId }, data: { status: 'RETRYABLE_FAILURE', retryAfter: new Date(Date.now() + 3_600_000), lastErrorCategory: 'SYNTHETIC_DEFERRED_RETRY' } });

  const v1 = await app.get(FieldSettingsService).version(settingsVersion);
  const v2Config = {
    ...v1.config,
    references: testReferences,
    rules: [...v1.config.rules, {
      id: 'deal-title-from-ms', entity: 'deals-orders', sourceField: 'TITLE', targetField: 'name',
      bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } },
    }],
  };
  const saveResponse = await fetch(`${apiUrl}/api/admin/field-settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: v2Config }),
  });
  const savedConfigResponse = await saveResponse.json() as { version?: number; config?: { rules?: Array<{ id: string }> }; message?: string };
  assert.equal(saveResponse.status, 200, savedConfigResponse.message);
  const v2 = savedConfigResponse as { version: number; config: { rules: Array<{ id: string }> } };
  assert.equal(v2.version, settingsVersion + 1);
  assert.ok(v2.config.rules.some((rule) => rule.id === 'deal-title-from-ms'));

  moyskladName = 'MS V2 authority';
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  const newResponse = await postB24(bitrixId, bitrixComments, 'new-v2-webhook');
  assert.equal(newResponse.status, 200);
  const { eventId: newEventId } = await newResponse.json() as { eventId: string };
  await waitForEventStatus(database, newEventId, 'SUCCEEDED');
  assert.equal(bitrixTitle, 'MS V2 authority', 'the new mapping writes MS authority to Bitrix24 and observes it on readback');
  const baselineV2 = await database.entityPairBaseline.findUniqueOrThrow({ where: { pairId: pair.id } });
  assert.equal(baselineV2.settingsVersion, v2.version);
  assert.equal((baselineV2.bitrix24Values as Record<string, unknown>)['rule:deal-title-from-ms'], 'MS V2 authority', 'the V2 mapping was reconciled from MySklad authority and read back');
  assert.equal((await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId: pair.id } })).settingsVersion, v2.version);
  const revision = await database.entityPairSettingsRevision.findUniqueOrThrow({ where: { pairId_toSettingsVersion: { pairId: pair.id, toSettingsVersion: v2.version } } });
  assert.equal(revision.status, 'COMPLETE');

  await database.inboundEvent.update({ where: { id: oldEventId }, data: { retryAfter: new Date(Date.now() - 1_000) } });
  await waitForEventStatus(database, oldEventId, 'UNCHANGED');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: oldEventId } })).lastErrorCategory, 'SETTINGS_PIN_SUPERSEDED');
  const afterOldRetry = await database.entityPairBaseline.findUniqueOrThrow({ where: { pairId: pair.id } });
  assert.equal(afterOldRetry.settingsVersion, v2.version, 'resumed V1 work cannot roll the pair back');
  assert.equal((await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId: pair.id } })).settingsVersion, v2.version);
});

async function createConfirmedPairAndSettings(database: DatabaseService, settingsVersion: number) {
  bitrixCompanyId = '0'; moyskladAgentId = null;
  bitrixOpportunity = '1'; moyskladOrderSum = 1;
  bitrixRowPrice = 1; moyskladPositionPrice = 100;
  moyskladPositionVat = 0; moyskladPositionVatEnabled = false;
  return createPairAndSettings(database, settingsVersion, true);
}

async function createPairAndSettings(database: DatabaseService, settingsVersion: number, includeComments: boolean) {
  const config = {
    schemaVersion: 1,
    rules: includeComments ? [{ id: 'deal-comments', entity: 'deals-orders', sourceField: 'COMMENTS', targetField: 'description',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }] : [],
    groups: [], references: { units: [{ bitrix24Id: 796, bitrix24Code: '796', moyskladId: moyskladUnitId, moyskladCode: '796', status: 'configured' }], priceTypes: [], dictionaries: [] }, serviceCounterpartyId,
  };
  await database.fieldSettingsVersion.create({ data: { version: settingsVersion, config } });
  await database.fieldSettingsState.upsert({ where: { id: 'global' }, create: { id: 'global', version: settingsVersion }, update: { version: settingsVersion } });
  await createProductPair(database);
  return database.entityPair.create({ data: { entityType: 'DEAL', bitrix24Id: bitrixId, moyskladId, source: 'MANUAL', reason: 'first-event baseline boundary fixture' } });
}

async function createProductPair(database: DatabaseService) {
  await database.entityPair.deleteMany({ where: { entityType: 'PRODUCT' } });
  await database.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: bitrixProductId, moyskladId: moyskladProductId, moyskladType: 'product', source: 'MANUAL', reason: 'baseline position fixture prerequisite' } });
}

async function reply(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  const path = request.url ?? '';
  externalRequests.push({ method: request.method ?? '', path });
  response.setHeader('content-type', 'application/json');
  if (path === '/b24/rest/crm.deal.get.json' && request.method === 'POST') {
    if (failNextBitrixRead) {
      if ((failNextBitrixRead.skip ?? 0) > 0) {
        failNextBitrixRead.skip!--;
      } else {
      const failure = failNextBitrixRead;
      failNextBitrixRead = null;
      if (failure.retryAfter) response.setHeader('retry-after', failure.retryAfter);
      response.writeHead(failure.status); response.end(JSON.stringify({ error: 'read failure' }));
      return;
      }
    }
    response.writeHead(200); response.end(JSON.stringify({ result: { ID: bitrixId, COMPANY_ID: bitrixCompanyId, COMMENTS: bitrixComments, TITLE: bitrixTitle, OPPORTUNITY: bitrixOpportunity, CURRENCY_ID: 'RUB', DATE_CREATE: '2026-10-05T10:00:00+00:00', DATE_MODIFY: '2026-10-06T10:00:00+00:00' } }));
  } else if (path === '/b24/rest/crm.company.get.json' && request.method === 'POST') {
    const id = new URLSearchParams(body).get('id') ?? '';
    response.writeHead(200); response.end(JSON.stringify({ result: {
      ID: id, TITLE: id === runtimeCompanyId ? 'Bitrix name intentionally differs' : `Company ${id}`,
      EMAIL: id === runtimeCompanyId ? [{ VALUE: runtimeCompanyEmail.toUpperCase(), VALUE_TYPE: 'WORK' }] : [], PHONE: [],
      DATE_CREATE: '2026-10-05T10:00:00+00:00', DATE_MODIFY: '2026-10-06T10:00:00+00:00',
    } }));
  } else if (path === '/b24/rest/crm.requisite.list' && request.method === 'POST') {
    response.writeHead(200); response.end(JSON.stringify({ result: [], total: 0 }));
  } else if (path === '/b24/rest/crm.company.update.json' && request.method === 'POST') {
    response.writeHead(200); response.end(JSON.stringify({ result: true }));
  } else if (path === '/b24/rest/crm.deal.update.json' && request.method === 'POST') {
    if (failNextBitrixWriteRetryAfter) {
      const retryAfter = failNextBitrixWriteRetryAfter;
      failNextBitrixWriteRetryAfter = null;
      response.setHeader('retry-after', retryAfter);
      response.writeHead(429, { 'content-type': 'text/plain' }); response.end('temporarily rate limited');
      return;
    }
    const form = new URLSearchParams(body);
    bitrixComments = form.get('fields[COMMENTS]') ?? bitrixComments;
    bitrixTitle = form.get('fields[TITLE]') ?? bitrixTitle;
    bitrixCompanyId = form.get('fields[COMPANY_ID]') ?? bitrixCompanyId;
    if (form.has('fields[OPPORTUNITY]')) { bitrixOpportunity = form.get('fields[OPPORTUNITY]') ?? bitrixOpportunity; opportunityWrites++; }
    response.writeHead(200); response.end(JSON.stringify({ result: true }));
  } else if (path === `/ms/api/remap/1.2/entity/customerorder/${moyskladId}` && request.method === 'GET') {
    if (failNextMoyskladRead) {
      const failure = failNextMoyskladRead;
      failNextMoyskladRead = null;
      if (failure.retryAfter) response.setHeader('retry-after', failure.retryAfter);
      response.writeHead(failure.status); response.end(JSON.stringify({ error: 'read failure' }));
      return;
    }
    const order: Record<string, unknown> = { id: moyskladId, meta: { type: 'customerorder' }, name: moyskladName, description: moyskladDescription, sum: Math.round(Number(moyskladOrderSum) * 100),
      ...(nativeCurrencyRelation ? {rate:{currency:{meta:{href:`${fakeBase}/ms/api/remap/1.2/entity/currency/${nativeCurrencyId}`,type:'currency'}}}} : {currency:{isoCode:'RUB'}}),
      vatIncluded: false, created: '2026-10-05 13:00:00', updated: '2026-10-07T10:00:00+00:00' };
    if (moyskladAgentId) order.agent = { id: moyskladAgentId, meta: { href: `${fakeBase}/entity/counterparty/${moyskladAgentId}`, type: 'counterparty' } };
    response.writeHead(200); response.end(JSON.stringify(order));
  } else if (new URL(path, fakeBase).pathname === '/ms/api/remap/1.2/entity/counterparty' && request.method === 'GET') {
    const filter = new URL(path, fakeBase).searchParams.get('filter')?.toLowerCase() ?? '';
    const rows = filter.includes('email=match.email@example.test')
      ? [{ id: runtimeCompanyMoyskladId, meta: { type: 'counterparty' }, companyType: 'legal', name: 'MySklad name intentionally differs', phone: null, email: 'match.email@example.test', created: '2025-01-01 10:00:00' }]
      : [];
    response.writeHead(200); response.end(JSON.stringify({ rows, meta: { size: rows.length, limit: 1000, offset: 0 } }));
  } else if (new URL(path, fakeBase).pathname === '/ms/api/remap/1.2/entity/customerorder' && request.method === 'GET') {
    response.writeHead(200); response.end(JSON.stringify({ rows: [], meta: { size: 0, limit: 1, offset: 0 } }));
  } else if (/^\/ms\/api\/remap\/1\.2\/entity\/counterparty\/[0-9a-f-]+$/i.test(path) && request.method === 'GET') {
    const id = path.split('/').at(-1)!;
    response.writeHead(200); response.end(JSON.stringify({ id, meta: { type: 'counterparty' }, name: id === serviceCounterpartyId ? 'Service counterparty' : 'MySklad name intentionally differs', email: id === runtimeCompanyMoyskladId ? 'match.email@example.test' : undefined, updated: '2026-10-06T10:00:00+00:00' }));
  } else if (new URL(path, 'http://127.0.0.1').pathname === '/b24/rest/crm.item.productrow.list' && request.method === 'POST') {
    response.writeHead(200); response.end(JSON.stringify({ result: { productRows: [{ id: '90000001', productId: bitrixProductId, measureCode: 796, quantity: 1, price: bitrixRowPrice, priceNetto: bitrixRowPrice, discountTypeId: 1, discountRate: 0, discountSum: 0, taxRate: 0, taxIncluded: 'N' }] }, total: 1 }));
  } else if (path === `/ms/api/remap/1.2/entity/customerorder/${moyskladId}/positions/${moyskladPositionId}` && request.method === 'GET') {
    response.writeHead(200); response.end(JSON.stringify({ id: moyskladPositionId, assortment: { meta: { href: `${fakeBase}/entity/product/${moyskladProductId}`, type: 'product' } }, quantity: 1, price: moyskladPositionPrice, discount: 0, vat: moyskladPositionVat, vatEnabled: moyskladPositionVatEnabled }));
  } else if (path === `/ms/api/remap/1.2/entity/customerorder/${moyskladId}/positions/${moyskladPositionId}` && request.method === 'PUT') {
    const payload = JSON.parse(body) as { quantity?: number; price?: number; vat?: number; vatEnabled?: boolean };
    if (typeof payload.price === 'number') moyskladPositionPrice = payload.price;
    if (typeof payload.vat === 'number') moyskladPositionVat = payload.vat;
    if (typeof payload.vatEnabled === 'boolean') moyskladPositionVatEnabled = payload.vatEnabled;
    response.writeHead(200); response.end(JSON.stringify({ id: moyskladPositionId }));
  } else if (path === `/ms/api/remap/1.2/entity/customerorder/${moyskladId}/positions` && request.method === 'GET') {
    response.writeHead(200); response.end(JSON.stringify({ rows: [{ id: moyskladPositionId, assortment: { meta: { href: `${fakeBase}/entity/product/${moyskladProductId}`, type: 'product' } }, quantity: 1, price: moyskladPositionPrice, discount: 0, vat: moyskladPositionVat, vatEnabled: moyskladPositionVatEnabled }], meta: { size: 1 } }));
  } else if (path === `/ms/api/remap/1.2/entity/product/${moyskladProductId}` && request.method === 'GET') {
    response.writeHead(200); response.end(JSON.stringify({ id: moyskladProductId, meta: { type: 'product' }, uom: { id: moyskladUnitId } }));
  } else if (path === `/ms/api/remap/1.2/entity/customerorder/${moyskladId}` && request.method === 'PUT') {
    if (failNextMoyskladWriteRetryAfter) {
      const retryAfter = failNextMoyskladWriteRetryAfter;
      failNextMoyskladWriteRetryAfter = null;
      response.setHeader('retry-after', retryAfter);
      response.writeHead(429, { 'content-type': 'text/plain' }); response.end('temporarily rate limited');
      return;
    }
    const payload = JSON.parse(body) as { name?: string; description?: string; agent?: { meta?: { href?: string } } };
    if (typeof payload.name === 'string') moyskladName = payload.name;
    if (typeof payload.description === 'string') moyskladDescription = payload.description;
    if (payload.agent?.meta?.href) moyskladAgentId = new URL(payload.agent.meta.href).pathname.split('/').at(-1) ?? null;
    response.writeHead(200); response.end(JSON.stringify({ id: moyskladId, meta: { type: 'customerorder' }, description: moyskladDescription }));
  } else {
    response.writeHead(404); response.end(JSON.stringify({ error: 'Unexpected fake API call' }));
  }
}

async function postB24(id: string, comments: string, marker: string) {
  return fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMDEALUPDATE', data: { FIELDS: { ID: id, COMMENTS: comments }, marker }, auth: { application_token: 'synthetic-event-token' } }),
  });
}

async function waitUntil(condition: () => boolean) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(condition(), `timed out waiting for event processor; fake requests: ${JSON.stringify(externalRequests)}; fake values: ${bitrixComments}/${moyskladDescription}`);
}

async function waitForEventStatus(database: DatabaseService, id: string, status: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const event = await database.inboundEvent.findUnique({ where: { id }, select: { status: true, retryAfter: true } });
    if (event?.status === status) {
      await waitForWorkersIdle(database);
      return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const finalState = await database.inboundEvent.findUnique({ where: { id }, select: { status: true, lastErrorCategory: true, retryAfter: true } });
  assert.fail(`timed out waiting for event ${id} to reach ${status}; final=${JSON.stringify(finalState)}; fake requests=${JSON.stringify(externalRequests)}`);
}

async function waitForEventAttempt(database: DatabaseService, id: string, attempts: number) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const event = await database.inboundEvent.findUnique({ where: { id }, select: { status: true, attempts: true, retryAfter: true } });
    if (event?.status === 'RETRYABLE_FAILURE' && event.attempts === attempts) {
      await waitForWorkersIdle(database);
      return event;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for event ${id} at attempt ${attempts}`);
}

async function waitForWorkersIdle(database: DatabaseService) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const active = await database.eventWorkerLease.count({ where: { ownerToken: { not: '' } } });
    if (active === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for background event worker leases to be released');
}

async function waitForBaseline(database: DatabaseService, pairId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await database.entityPairBaseline.findUnique({ where: { pairId } })) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for baseline ${pairId}; fake requests: ${JSON.stringify(externalRequests)}`);
}

function assertPositionReadPaths(startIndex: number) {
  const paths = externalRequests.slice(startIndex).map(({ path }) => new URL(path, 'http://127.0.0.1').pathname)
    .filter((path) => path === '/b24/rest/crm.item.productrow.list' || path.endsWith(`/customerorder/${moyskladId}/positions`) || path === `/ms/api/remap/1.2/entity/product/${moyskladProductId}`).sort();
  assert.deepEqual(paths, [
    '/b24/rest/crm.item.productrow.list',
    `/ms/api/remap/1.2/entity/customerorder/${moyskladId}/positions`,
    `/ms/api/remap/1.2/entity/product/${moyskladProductId}`,
  ].sort());
}

function isWrite(request: { method: string; path: string }) {
  return request.method === 'PUT' || request.path.endsWith('/crm.deal.update.json');
}
