import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LocalAdminPreviewModule } from '../src/admin/local-preview.module';
import { DatabaseService } from '../src/database.service';

let app: INestApplication;
let apiUrl = '';
let fakeApi: Server;
let fakeBase = '';
const externalRequests: Array<{ method: string; path: string }> = [];
let bitrixId = '';
let moyskladId = '';
const oldEnv = new Map<string, string | undefined>();
let bitrixComments = 'B24 initial';
let moyskladDescription = 'MS initial';

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

  app = await NestFactory.create(LocalAdminPreviewModule.register(), { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  const database = app.get(DatabaseService);
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  await database.inboundEvent.deleteMany({});
  await database.entityPairBaseline.deleteMany({});
  await database.entityPairSyncState.deleteMany({});
  await database.entityPair.deleteMany({ where: { entityType: 'DEAL' } });
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
    groups: [], references: { units: [], priceTypes: [], dictionaries: [] },
  };
  await database.fieldSettingsVersion.create({ data: { version: settingsVersion, config } });
  await database.fieldSettingsState.upsert({ where: { id: 'global' }, create: { id: 'global', version: settingsVersion }, update: { version: settingsVersion } });
  await database.entityPair.create({ data: { entityType: 'DEAL', bitrix24Id: bitrixId, moyskladId, source: 'MANUAL', reason: 'public integration fixture' } });

  const intake = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMDEALUPDATE', data: { FIELDS: { ID: bitrixId } }, auth: { application_token: 'synthetic-event-token' } }),
  });
  assert.equal(intake.status, 200);
  const { eventId } = await intake.json() as { eventId: string };

  for (let attempt = 0; attempt < 50 && externalRequests.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(externalRequests.map(({ method, path }) => [method, path]), [
    ['GET', `/ms/api/remap/1.2/entity/customerorder/${moyskladId}`],
    ['POST', '/b24/rest/crm.deal.get.json'],
  ]);
  assert.equal(externalRequests.filter(isWrite).length, 0, 'baseline capture must not write either system');
  assert.equal(moyskladDescription, 'MS initial');

  process.env.LOCAL_HEADER_EXCHANGE_READY = '0';
  bitrixComments = 'blocked while entity readiness gate is closed';
  const readinessGated = await postB24(bitrixId, bitrixComments, 'entity-not-ready');
  assert.equal(readinessGated.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(externalRequests.filter(isWrite).length, 0, 'global mode and mapping alone do not bypass entity readiness');
  process.env.LOCAL_HEADER_EXCHANGE_READY = '1';

  bitrixComments = 'B24 changed'; // source system state changes before its webhook is delivered
  const changedB24 = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMDEALUPDATE', data: { FIELDS: { ID: bitrixId, COMMENTS: 'B24 changed' }, marker: 'b24-change-1' }, auth: { application_token: 'synthetic-event-token' } }),
  });
  assert.equal(changedB24.status, 200);
  await waitUntil(() => moyskladDescription === 'B24 changed');
  const b24UpdateCount = externalRequests.filter((request) => request.path.endsWith('/crm.deal.update.json')).length;
  assert.equal(b24UpdateCount, 0);
  assert.equal(externalRequests.filter((request) => request.method === 'PUT').length, 1);

  // Re-delivery of the same value is an echo/no-op, not another write.
  const echoB24 = await postB24(bitrixId, 'B24 changed', 'b24-echo');
  assert.equal(echoB24.status, 200);
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
  await waitUntil(() => bitrixComments === 'MS wins');
  assert.equal(externalRequests.filter((request) => request.path.endsWith('/crm.deal.update.json')).length, 1);

  const writesBeforeEcho = externalRequests.filter(isWrite).length;
  const echoMs = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-webhook-secret?requestId=ms-echo-1`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { type: 'customerorder', href: `${fakeBase}/entity/customerorder/${moyskladId}` } }] }),
  });
  assert.equal(echoMs.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(externalRequests.filter(isWrite).length, writesBeforeEcho, 'matching bilateral values are not rewritten');

  const requestsBeforeGate = externalRequests.length;
  const base24BeforeGate = process.env.BITRIX24_REST_BASE_URL;
  process.env.LOCAL_HEADER_EXCHANGE = '0';
  bitrixComments = 'must not write while disabled';
  const disabled = await postB24(bitrixId, bitrixComments, 'local-gate-off');
  assert.equal(disabled.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(externalRequests.filter(isWrite).length, writesBeforeEcho, 'the local exchange gate defaults closed');

  process.env.LOCAL_HEADER_EXCHANGE = '1';
  process.env.BITRIX24_REST_BASE_URL = 'https://external.example/rest/';
  const remoteTarget = await postB24(bitrixId, bitrixComments, 'loopback-gate');
  assert.equal(remoteTarget.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(externalRequests.length, requestsBeforeGate, 'non-loopback upstreams are rejected before any HTTP request');
  process.env.BITRIX24_REST_BASE_URL = base24BeforeGate;

  const baseMsBeforeGate = process.env.MOYSKLAD_API_BASE_URL;
  process.env.MOYSKLAD_API_BASE_URL = 'http://remote.example/api/';
  const remoteMoySklad = await postB24(bitrixId, bitrixComments, 'remote-ms-gate');
  assert.equal(remoteMoySklad.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(externalRequests.length, requestsBeforeGate, 'non-loopback MySklad upstreams are rejected before any HTTP request');
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

async function reply(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  const path = request.url ?? '';
  externalRequests.push({ method: request.method ?? '', path });
  response.setHeader('content-type', 'application/json');
  if (path === '/b24/rest/crm.deal.get.json' && request.method === 'POST') {
    response.writeHead(200); response.end(JSON.stringify({ result: { ID: bitrixId, COMMENTS: bitrixComments, DATE_MODIFY: '2026-10-06T10:00:00+00:00' } }));
  } else if (path === '/b24/rest/crm.deal.update.json' && request.method === 'POST') {
    const form = new URLSearchParams(body);
    bitrixComments = form.get('fields[COMMENTS]') ?? bitrixComments;
    response.writeHead(200); response.end(JSON.stringify({ result: true }));
  } else if (path === `/ms/api/remap/1.2/entity/customerorder/${moyskladId}` && request.method === 'GET') {
    response.writeHead(200); response.end(JSON.stringify({ id: moyskladId, meta: { type: 'customerorder' }, description: moyskladDescription, updated: '2026-10-07T10:00:00+00:00' }));
  } else if (path === `/ms/api/remap/1.2/entity/customerorder/${moyskladId}` && request.method === 'PUT') {
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

function isWrite(request: { method: string; path: string }) {
  return request.method === 'PUT' || request.path.endsWith('/crm.deal.update.json');
}
