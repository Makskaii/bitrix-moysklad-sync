import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { LocalAdminPreviewModule } from '../src/admin/local-preview.module';
import { DatabaseService } from '../src/database.service';
import { DealOrderHeaderSyncProcessor } from '../src/deals-orders/deal-order-header-sync.processor';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { PairFirstEventProcessor } from '../src/pairs/pair-first-event.processor';

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
let moyskladDescription = 'MS initial';
let failNextMoyskladWriteRetryAfter: string | null = null;
let failNextBitrixWriteRetryAfter: string | null = null;
let failNextBitrixRead: { status: number; retryAfter: string | null } | null = null;
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

  app = await NestFactory.create(LocalAdminPreviewModule.register(), { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  const database = app.get(DatabaseService);
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
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
  assert.deepEqual(externalRequests.slice(0, 4).map(({ method, path }) => [method, path]), [
    ['POST', '/b24/rest/crm.deal.get.json'], // dependency discovery reads the deal before baseline capture
    ['GET', `/ms/api/remap/1.2/entity/counterparty/${serviceCounterpartyId}`],
    ['GET', `/ms/api/remap/1.2/entity/customerorder/${moyskladId}`],
    ['POST', '/b24/rest/crm.deal.get.json'],
  ]);
  assertPositionReadPaths(4);
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
  await waitForEventStatus(database, readinessGatedEventId, 'SKIPPED_DISABLED');
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
  await waitForEventStatus(database, disabledEventId, 'SKIPPED_DISABLED');
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
  failNextBitrixRead = { status: 503, retryAfter: null };
  const response = await postB24(bitrixId, 'retry one', 'baseline-backoff');
  const { eventId } = await response.json() as { eventId: string };
  const first = await waitForEventAttempt(database, eventId, 1);
  assert.ok(first.retryAfter);
  const firstDelay = first.retryAfter!.getTime() - Date.now();
  assert.ok(firstDelay > 3_000 && firstDelay <= 5_000, `first fallback should be ~5s, got ${firstDelay}ms`);

  failNextBitrixRead = { status: 503, retryAfter: null };
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
  const baseline = await database.entityPairBaseline.findUnique({ where: { pairId: pair.id } });
  assert.ok(baseline, 'Q26.66 baseline capture is not gated by local preview flags');
  assert.deepEqual(externalRequests.slice(requestsBefore, requestsBefore + 4).map(({ method }) => method), ['POST', 'GET', 'GET', 'POST']);
  assert.equal(externalRequests.length, requestsBefore + 4, 'disabled header exchange captures baseline without starting position sync');
  assert.equal(externalRequests.slice(requestsBefore).filter(isWrite).length, 0);
  await waitForEventStatus(database, eventId, 'SKIPPED_DISABLED');

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
  assert.deepEqual(externalRequests.slice(requestsBefore, requestsBefore + 4).map(({ method }) => method), ['POST', 'GET', 'GET', 'POST']);
  assertPositionReadPaths(requestsBefore + 4);
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
  await drySetupDatabase.$disconnect();
  app = await NestFactory.create(LocalAdminPreviewModule.register(), { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  const database = app.get(DatabaseService);
  bitrixId = String(7_400_000_000 + Math.floor(Math.random() * 1_000_000));
  moyskladId = randomUUID();
  const settingsVersion = 1_000_000 + Math.floor(Math.random() * 100_000);
  const pair = await createConfirmedPairAndSettings(database, settingsVersion);
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  const requestsBefore = externalRequests.length;
  const writesBefore = externalRequests.filter(isWrite).length;

  const response = await postB24(bitrixId, 'dry first event', 'dry-baseline-only');
  assert.equal(response.status, 200);
  await waitForBaseline(database, pair.id);
  await waitForEventStatus(database, (await response.json() as { eventId: string }).eventId, 'SUCCEEDED');
  const applyDatabase = new PrismaClient({ datasources: { db: { url: applyDatabaseUrl } } });
  assert.equal(await applyDatabase.entityPairBaseline.findUnique({ where: { pairId: pair.id } }), null);
  await applyDatabase.$disconnect();
  assert.deepEqual(externalRequests.slice(requestsBefore).map(({ method }) => method), ['POST', 'GET', 'GET', 'POST']);
  assert.equal(externalRequests.filter(isWrite).length, writesBefore, 'dry mode performs no external synchronization writes');
});

async function createConfirmedPairAndSettings(database: DatabaseService, settingsVersion: number) {
  const config = {
    schemaVersion: 1,
    rules: [{ id: 'deal-comments', entity: 'deals-orders', sourceField: 'COMMENTS', targetField: 'description',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }],
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
      const failure = failNextBitrixRead;
      failNextBitrixRead = null;
      if (failure.retryAfter) response.setHeader('retry-after', failure.retryAfter);
      response.writeHead(failure.status); response.end(JSON.stringify({ error: 'read failure' }));
      return;
    }
    response.writeHead(200); response.end(JSON.stringify({ result: { ID: bitrixId, COMMENTS: bitrixComments, DATE_MODIFY: '2026-10-06T10:00:00+00:00' } }));
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
    response.writeHead(200); response.end(JSON.stringify({ result: true }));
  } else if (path === `/ms/api/remap/1.2/entity/customerorder/${moyskladId}` && request.method === 'GET') {
    if (failNextMoyskladRead) {
      const failure = failNextMoyskladRead;
      failNextMoyskladRead = null;
      if (failure.retryAfter) response.setHeader('retry-after', failure.retryAfter);
      response.writeHead(failure.status); response.end(JSON.stringify({ error: 'read failure' }));
      return;
    }
    response.writeHead(200); response.end(JSON.stringify({ id: moyskladId, meta: { type: 'customerorder' }, description: moyskladDescription, vatIncluded: false, updated: '2026-10-07T10:00:00+00:00' }));
  } else if (path === `/ms/api/remap/1.2/entity/counterparty/${serviceCounterpartyId}` && request.method === 'GET') {
    response.writeHead(200); response.end(JSON.stringify({ id: serviceCounterpartyId, meta: { type: 'counterparty' } }));
  } else if (new URL(path, 'http://127.0.0.1').pathname === '/b24/rest/crm.item.productrow.list' && request.method === 'POST') {
    response.writeHead(200); response.end(JSON.stringify({ result: { productRows: [{ id: '90000001', productId: bitrixProductId, measureCode: 796, quantity: 1, price: 1, priceNetto: 1, discountTypeId: 1, discountRate: 0, discountSum: 0, taxRate: 0, taxIncluded: 'N' }] }, total: 1 }));
  } else if (path === `/ms/api/remap/1.2/entity/customerorder/${moyskladId}/positions` && request.method === 'GET') {
    response.writeHead(200); response.end(JSON.stringify({ rows: [{ id: moyskladPositionId, assortment: { meta: { href: `${fakeBase}/entity/product/${moyskladProductId}`, type: 'product' } }, quantity: 1, price: 100, discount: 0, vat: 0, vatEnabled: false }], meta: { size: 1 } }));
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
    const payload = JSON.parse(body) as { description?: string };
    if (typeof payload.description === 'string') moyskladDescription = payload.description;
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
  assert.fail(`timed out waiting for event ${id} to reach ${status}; final=${JSON.stringify(finalState)}`);
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
  const paths = externalRequests.slice(startIndex).map(({ path }) => new URL(path, 'http://127.0.0.1').pathname).sort();
  assert.deepEqual(paths, [
    '/b24/rest/crm.item.productrow.list',
    `/ms/api/remap/1.2/entity/customerorder/${moyskladId}`,
    `/ms/api/remap/1.2/entity/customerorder/${moyskladId}/positions`,
    `/ms/api/remap/1.2/entity/product/${moyskladProductId}`,
  ].sort());
}

function isWrite(request: { method: string; path: string }) {
  return request.method === 'PUT' || request.path.endsWith('/crm.deal.update.json');
}
