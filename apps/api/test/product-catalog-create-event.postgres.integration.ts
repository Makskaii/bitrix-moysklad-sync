import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { LocalAdminPreviewModule } from '../src/admin/local-preview.module';
import { DatabaseRecoveryService } from '../src/database-recovery.service';
import { DatabaseService } from '../src/database.service';

const databaseUrl = process.env.PRODUCT_CREATE_EVENT_TEST_DATABASE_URL;
const activeApps: INestApplication[] = [];
let app: INestApplication | undefined;
let fakeApi: Server | undefined;
let apiUrl = '';
let fakeBase = '';
const requests: Array<{ method: string; path: string; body: string }> = [];
const createdCards = new Map<string, Record<string, unknown>>();
let sourceRecords = new Map<string, Record<string, unknown>>();
let nextCardId = 80_000_000 + Math.floor(Math.random() * 10_000_000);
const oldEnv = new Map<string, string | undefined>();

before(async () => {
  if (!databaseUrl) return;
  for (const key of ['DATABASE_URL', 'SYNC_MODE', 'ADMIN_PREVIEW', 'BITRIX24_EVENT_APPLICATION_TOKEN', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN', 'MOYSKLAD_WEBHOOK_SECRET']) oldEnv.set(key, process.env[key]);
  const target = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(target.hostname), 'refusing to run product-create event integration against a non-local database');
  assert.equal(target.pathname, '/aerosystems_offline_acceptance_test', 'requires the dedicated disposable offline acceptance database');
  assert.match(target.searchParams.get('schema') ?? '', /^issue61_create_event_[a-z0-9_]+$/, 'requires a fresh issue61_create_event_* schema');
  process.env.DATABASE_URL = databaseUrl;
  process.env.SYNC_MODE = 'apply';
  process.env.ADMIN_PREVIEW = '1';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-b24-event-token';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-only-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'synthetic-product-create-secret';
  fakeApi = createServer((request, response) => { void reply(request, response); });
  await new Promise<void>((resolve) => fakeApi!.listen(0, '127.0.0.1', resolve));
  const address = fakeApi.address();
  assert.ok(address && typeof address !== 'string');
  fakeBase = `http://127.0.0.1:${address.port}/`;
  process.env.BITRIX24_REST_BASE_URL = `${fakeBase}b24/rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${fakeBase}ms/api/remap/1.2/`;

  app = await NestFactory.create(LocalAdminPreviewModule.register(), { logger: false });
  await app.listen(0, '127.0.0.1');
  activeApps.push(app);
  apiUrl = await app.getUrl();
  const database = app.get(DatabaseService);
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on', offSince: null } });
  await database.syncDirectionSetting.upsert({
    where: { entityKey: 'products-variations' },
    create: { entityKey: 'products-variations', bitrix24ToMoysklad: false, moyskladToBitrix24: true },
    update: { bitrix24ToMoysklad: false, moyskladToBitrix24: true },
  });
  if (!await app.get(DatabaseRecoveryService).assertReady()) {
    await app.get(DatabaseRecoveryService).confirmRecovery({
      previousLaunchBoundary: '2026-01-01T00:00:00.000Z', pairsRestored: true, lostEventsAcknowledged: true,
      acknowledgement: 'Synthetic fixture confirms the isolated disposable schema and synthetic event history.',
    }, 'BITRIX24_USER:999999');
  }
  // Recovery confirmation intentionally leaves service mode OFF; enable only this
  // synthetic integration fixture after the isolated readiness acknowledgement.
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on', offSince: null } });
});

after(async () => {
  for (const activeApp of activeApps) {
    (activeApp.getHttpServer() as Server).closeAllConnections();
    await activeApp.close();
  }
  if (fakeApi) await new Promise<void>((resolve, reject) => fakeApi!.close((error) => error ? reject(error) : resolve()));
  for (const [key, value] of oldEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('post-boundary product and service CREATE intake creates/readbacks one card and durable native-kind pair; repeats and pre-boundary events do not duplicate', { skip: !databaseUrl }, async () => {
  assert.ok(app);
  requests.length = 0;
  const database = app.get(DatabaseService);
  const settingsVersion = 910_000 + Math.floor(Math.random() * 80_000);
  const config = {
    schemaVersion: 1,
    productCatalogRuntime: { bitrix24CatalogId: '77', moyskladFields: ['name', 'code', 'description'] },
    rules: [{ id: 'catalog-name', entity: 'catalog', sourceField: 'name', targetField: 'name',
      bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }],
    groups: [], references: { units: [], priceTypes: [], dictionaries: [], namedPairs: [] }, serviceCounterpartyId: null,
  };
  await database.fieldSettingsVersion.create({ data: { version: settingsVersion, config } });
  await database.fieldSettingsState.upsert({ where: { id: 'global' }, create: { id: 'global', version: settingsVersion }, update: { version: settingsVersion } });

  for (const kind of ['product', 'service'] as const) {
    const id = randomUUID();
    sourceRecords.set(id, { id, meta: { type: kind }, name: `${kind}-after-boundary`, code: `${kind}-code`, description: `${kind} description`, created: '2026-02-01T00:00:00.000Z', updated: '2026-10-18T00:00:00.000Z' });
    const first = await sendCreate(kind, id, `post-boundary-${kind}-1`);
    assert.equal(first.status, 200);
    const firstId = oneEventId(await first.json());
    await waitForStatus(database, firstId, 'SUCCEEDED');

    const pair = await database.entityPair.findFirstOrThrow({ where: { entityType: 'PRODUCT', moyskladId: id, active: true } });
    assert.equal(pair.moyskladType, kind, 'durable pair records the native MySklad type');
    assert.equal(pair.source, 'AUTO');
    const operation = await database.dealOrderReverseProductOperation.findUniqueOrThrow({ where: { moyskladProductId: id } });
    assert.equal(operation.status, 'SUCCEEDED');
    assert.equal(operation.bitrix24ProductId, pair.bitrix24Id);
    assert.equal(createdCards.get(pair.bitrix24Id)?.xmlId, `MOYSKLAD_${kind.toUpperCase()}_${id}`);

    const addsBeforeRepeat = requests.filter(({ path }) => isCreatePath(path, kind)).length;
    const repeated = await sendCreate(kind, id, `post-boundary-${kind}-2`);
    assert.equal(repeated.status, 200);
    await waitForStatus(database, oneEventId(await repeated.json()), 'SUCCEEDED');
    assert.equal((await database.entityPair.count({ where: { entityType: 'PRODUCT', moyskladId: id, active: true } })), 1);
    assert.equal(requests.filter(({ path }) => isCreatePath(path, kind)).length, addsBeforeRepeat, 'a repeated CREATE resolves the established pair without another B24 card create');

    const staleId = randomUUID();
    sourceRecords.set(staleId, { id: staleId, meta: { type: kind }, name: `${kind}-before-boundary`, code: `${kind}-old`, created: '2025-12-31T23:59:59.000Z' });
    const addsBeforeStale = requests.filter(({ path }) => isCreatePath(path, kind)).length;
    const stale = await sendCreate(kind, staleId, `pre-boundary-${kind}`);
    assert.equal(stale.status, 200);
    await waitForStatus(database, oneEventId(await stale.json()), 'SKIPPED_PRE_LAUNCH');
    assert.equal(await database.entityPair.count({ where: { entityType: 'PRODUCT', moyskladId: staleId } }), 0);
    assert.equal(requests.filter(({ path }) => isCreatePath(path, kind)).length, addsBeforeStale, 'pre-boundary CREATE cannot write a B24 card');

    const repeatStale = await sendCreate(kind, staleId, `pre-boundary-${kind}-repeat`);
    assert.equal(repeatStale.status, 200);
    await waitForStatus(database, oneEventId(await repeatStale.json()), 'SKIPPED_PRE_LAUNCH');
    assert.equal(await database.entityPair.count({ where: { entityType: 'PRODUCT', moyskladId: staleId } }), 0);
    assert.equal(requests.filter(({ path }) => isCreatePath(path, kind)).length, addsBeforeStale);
  }

  const providerCallsBeforeDisabledPrice = requests.length;
  const priceUpdate = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'CATALOG.PRICE.ON.UPDATE', data: { FIELDS: { ID: '99001' } }, auth: { application_token: 'synthetic-b24-event-token' } }),
  });
  assert.equal(priceUpdate.status, 200);
  await waitForStatus(database, oneEventId(await priceUpdate.json()), 'SKIPPED_DIRECTION_DISABLED');
  assert.equal(requests.length, providerCallsBeforeDisabledPrice, 'the disabled Bitrix24 price direction cannot read or write catalog/document APIs');

  assert.equal(requests.some(({ path }) => /crm\.deal|customerorder|invoiceout|document/i.test(path)), false, 'catalog create and retries do not touch document APIs');
});

async function sendCreate(kind: 'product' | 'service', id: string, requestId: string) {
  return fetch(`${apiUrl}/webhooks/moysklad/synthetic-product-create-secret?requestId=${encodeURIComponent(requestId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'CREATE', meta: { type: kind, href: `${fakeBase}entity/${kind}/${id}` } }] }),
  });
}

function oneEventId(value: unknown): string {
  assert.ok(typeof value === 'object' && value !== null && 'eventId' in value && typeof value.eventId === 'string');
  return value.eventId;
}

function isCreatePath(path: string, kind: 'product' | 'service') {
  const method = new URL(path, fakeBase).pathname.replace(/\.json$/i, '');
  return method.endsWith(kind === 'product' ? 'catalog.product.add' : 'catalog.product.service.add');
}

async function waitForStatus(database: DatabaseService, eventId: string, status: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const event = await database.inboundEvent.findUnique({ where: { id: eventId }, select: { status: true, lastErrorCategory: true } });
    if (event?.status === status) return;
    if (event && ['MANUAL_REVIEW', 'RETRYABLE_FAILURE', 'SKIPPED_UNSUPPORTED_ENTITY'].includes(event.status)) {
      assert.equal(event.status, status, `event stopped as ${event.status}: ${event.lastErrorCategory}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const event = await database.inboundEvent.findUnique({ where: { id: eventId }, select: { status: true, lastErrorCategory: true } });
  assert.fail(`event ${eventId} did not reach ${status}: ${JSON.stringify(event)}`);
}

async function reply(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  const path = request.url ?? '';
  requests.push({ method: request.method ?? '', path, body });
  response.setHeader('content-type', 'application/json');
  const pathname = new URL(path, fakeBase).pathname;
  const method = pathname.replace(/\.json$/i, '');
  if (pathname.includes('/entity/product/') || pathname.includes('/entity/service/')) {
    const id = pathname.split('/').at(-1)!;
    const record = sourceRecords.get(id);
    if (record) { response.writeHead(200); response.end(JSON.stringify(record)); return; }
  }
  if (method.endsWith('catalog.product.getFieldsByFilter') || method.endsWith('catalog.product.service.getFieldsByFilter')) {
    const kind = method.includes('.service.') ? 'service' : 'product';
    const definitions = Object.fromEntries(['name', 'code', 'detailText'].map((key) => [key, { type: 'string', isReadOnly: false }]));
    response.writeHead(200); response.end(JSON.stringify({ result: { [kind]: definitions } })); return;
  }
  if (method.endsWith('catalog.product.list') || method.endsWith('catalog.product.service.list')) {
    const kind = method.includes('.service.') ? 'service' : 'product';
    const payload = parseProviderBody(body) as { filter?: { xmlId?: string }; start?: number };
    const rows = [...createdCards.values()].filter((card) => card.type === (kind === 'service' ? 7 : 1) && card.xmlId === payload.filter?.xmlId);
    response.writeHead(200); response.end(JSON.stringify({ result: { [kind === 'service' ? 'services' : 'products']: rows.slice(payload.start ?? 0), total: rows.length } })); return;
  }
  if (method.endsWith('catalog.product.add') || method.endsWith('catalog.product.service.add')) {
    const kind = method.includes('.service.') ? 'service' : 'product';
    const payload = parseProviderBody(body) as { fields: Record<string, unknown> };
    const id = String(nextCardId++);
    const card = { id: Number(id), type: kind === 'service' ? 7 : 1, ...payload.fields };
    createdCards.set(id, card);
    response.writeHead(200); response.end(JSON.stringify({ result: { [kind === 'service' ? 'service' : 'element']: card } })); return;
  }
  if (method.endsWith('catalog.product.get') || method.endsWith('catalog.product.service.get')) {
    const kind = method.includes('.service.') ? 'service' : 'product';
    const payload = parseProviderBody(body) as { id: string };
    const card = createdCards.get(String(payload.id));
    if (!card) { response.writeHead(404); response.end(JSON.stringify({ error: 'not found' })); return; }
    response.writeHead(200); response.end(JSON.stringify({ result: { [kind]: card } })); return;
  }
  if (method.endsWith('catalog.price.list')) { response.writeHead(200); response.end(JSON.stringify({ result: { prices: [], total: 0 } })); return; }
  response.writeHead(404); response.end(JSON.stringify({ error: 'unexpected fake API call' }));
}

function parseProviderBody(body: string): Record<string, unknown> {
  try { return JSON.parse(body) as Record<string, unknown>; }
  catch { return Object.fromEntries(new URLSearchParams(body)); }
}
