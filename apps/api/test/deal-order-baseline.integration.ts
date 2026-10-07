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

before(async () => {
  for (const key of ['SYNC_MODE', 'DATABASE_URL', 'DRY_DATABASE_URL', 'ADMIN_PREVIEW', 'BITRIX24_EVENT_APPLICATION_TOKEN', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_WEBHOOK_SECRET', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN']) oldEnv.set(key, process.env[key]);
  process.env.DATABASE_URL = process.env.BASELINE_TEST_DATABASE_URL ?? 'postgresql://sync:local-only@127.0.0.1:55414/sync?schema=issue14_apply_test';
  process.env.DRY_DATABASE_URL = process.env.BASELINE_DRY_TEST_DATABASE_URL ?? 'postgresql://sync:local-only@127.0.0.1:55414/sync?schema=issue14_test';
  process.env.SYNC_MODE = 'dry';
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

test('public deal webhook captures bilateral immutable baseline before dry plan and performs no external writes', async () => {
  const database = app.get(DatabaseService);
  bitrixId = String(7_000_000_000 + Math.floor(Math.random() * 1_000_000));
  moyskladId = '12345678-1234-1234-1234-123456789abc';
  const settingsVersion = 700_000 + Math.floor(Math.random() * 100_000);
  const config = {
    schemaVersion: 1,
    rules: [{ id: 'deal-title', entity: 'deals-orders', sourceField: 'TITLE', targetField: 'name',
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

  const repeated = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMDEALUPDATE', data: { FIELDS: { ID: bitrixId } }, auth: { application_token: 'synthetic-event-token' } }),
  });
  assert.equal(repeated.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(externalRequests.length, 2, 'an existing baseline is not overwritten or re-read on a repeated event');
  assert.ok(externalRequests.every((request) => ['GET', 'POST'].includes(request.method)));
  assert.ok(externalRequests.every((request) => !/update|create|positions/i.test(request.path)));
});

async function reply(request: IncomingMessage, response: ServerResponse) {
  for await (const _chunk of request) { /* consume the request body */ }
  const path = request.url ?? '';
  externalRequests.push({ method: request.method ?? '', path });
  response.writeHead(200, { 'content-type': 'application/json' });
  if (path === '/b24/rest/crm.deal.get.json') {
    response.end(JSON.stringify({ result: { ID: bitrixId, TITLE: 'B24 older', DATE_MODIFY: '2026-10-06T10:00:00+00:00' } }));
  } else if (path.includes('/entity/customerorder/')) {
    response.end(JSON.stringify({ id: moyskladId, meta: { type: 'customerorder' }, name: 'MS newer than B24', updated: '2026-10-07T10:00:00+00:00' }));
  } else {
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'Unexpected fake API call' }));
  }
}
