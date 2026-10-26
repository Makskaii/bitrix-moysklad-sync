import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../src/database.service';
import { DryRunDocumentReader } from '../src/dry-run-document-reader';
import { DealOrderHeaderSyncProcessor } from '../src/deals-orders/deal-order-header-sync.processor';
import { SyncModeService } from '../src/sync-mode.service';

process.env.SYNC_MODE ??= 'apply';
const db = new PrismaClient();
const database = new DatabaseService();
const suffix = randomUUID();
const bitrix24DealId = `79${Date.now()}`;
const moyskladOrderId = randomUUID();
let server: Server;
let base = '';
let holdFirst = false;
let firstArrived!: () => void;
let releaseFirst!: () => void;
let firstStarted: Promise<void>;
let firstReleased: Promise<void>;
let requests: string[] = [];

before(async () => {
  const target = new URL(process.env.DATABASE_URL ?? '');
  assert.match(target.hostname, /^(127\.0\.0\.1|localhost)$/i);
  assert.match(target.pathname, /test/i, 'test database name must identify an isolated database');
  assert.equal(target.searchParams.get('schema'), 'issue79_deal_header_mode_gate_test');
  assert.equal(process.env.DEAL_ORDER_HEADER_MODE_GATE_TEST_ISOLATED, '1');
  await db.$connect();
  await database.$connect();
  await db.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  server = createServer((request, response) => { void reply(request, response); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}/`;
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_REST_BASE_URL = `${base}rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${base}api/remap/1.2/`;
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-only';
});

after(async () => {
  await db.entityPair.deleteMany({ where: { id: { startsWith: `header-mode-${suffix}` } } });
  await db.inboundEvent.deleteMany({ where: { deliveryKey: `header-mode-${suffix}` } });
  await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  await db.$disconnect();
  await database.$disconnect();
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('OFF acknowledged after the first client-header read prevents the next provider request; ON completes both reads', async () => {
  const pairId = `header-mode-${suffix}`;
  const event = await db.inboundEvent.create({ data: {
    source: 'BITRIX24', deliveryKey: `header-mode-${suffix}`, eventType: 'ONCRMDEALUPDATE',
    externalEntityId: bitrix24DealId, externalEntityType: 'deal', payload: { event: 'ONCRMDEALUPDATE' },
  } });
  await db.entityPair.create({ data: {
    id: pairId, entityType: 'DEAL', bitrix24Id: bitrix24DealId, moyskladId: moyskladOrderId,
    active: true, lifecycleStatus: 'ACTIVE', source: 'MANUAL',
  } });
  await db.entityPairBaseline.create({ data: {
    pairId, eventId: event.id, settingsVersion: 1,
    bitrix24Values: { 'client:companyId': null, 'rule:deal-comment': 'same' },
    moyskladValues: { 'client:agentId': moyskladOrderId, 'rule:deal-comment': 'same' },
  } });
  await db.entityPairSyncState.create({ data: {
    pairId, settingsVersion: 1,
    bitrix24Values: { 'client:companyId': null, 'deal-order-comments': 'same' },
    moyskladValues: { 'client:agentId': moyskladOrderId, 'deal-order-comments': 'same' },
  } });
  const processor = new DealOrderHeaderSyncProcessor(database, new DryRunDocumentReader(undefined, database), new SyncModeService(database));
  const pair = { id: pairId, entityType: 'DEAL', bitrix24Id: bitrix24DealId, moyskladId: moyskladOrderId, status: 'CONFIRMED', source: 'MANUAL' } as any;
  const eventConfig = { version: 1, config: { serviceCounterpartyId: null, rules: [{
    id: 'deal-comment', entity: 'deals-orders', sourceField: 'COMMENTS', targetField: 'description',
    bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } },
  }] } } as any;
  const previousMode = (await db.syncSetting.findUniqueOrThrow({ where: { id: 'global' } })).serviceMode;
  const previousFlags = ['ADMIN_PREVIEW', 'LOCAL_HEADER_EXCHANGE', 'LOCAL_HEADER_EXCHANGE_READY'].map((key) => process.env[key]);
  try {
    const input = { eventId: event.id, pair, eventConfig, baselineId: pairId };
    await assertOffBarrier(() => processor.processClient(input), event.id, pairId);

    await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
    requests = [];
    const enabled = await processor.processClient(input);
    assert.equal(enabled, 'NOOP');
    assert.deepEqual(requests, [
      '/api/remap/1.2/entity/customerorder/' + moyskladOrderId,
      '/rest/crm.deal.get.json',
    ]);

    process.env.ADMIN_PREVIEW = '1';
    process.env.LOCAL_HEADER_EXCHANGE = '1';
    process.env.LOCAL_HEADER_EXCHANGE_READY = '1';
    await assertOffBarrier(() => processor.process(input), event.id, pairId);
    await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
    requests = [];
    assert.equal(await processor.process(input), 'NOOP');
    assert.deepEqual(requests, [
      '/api/remap/1.2/entity/customerorder/' + moyskladOrderId,
      '/rest/crm.deal.get.json',
    ]);
  } finally {
    holdFirst = false;
    releaseFirst?.();
    await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: previousMode } });
    for (const [key, value] of ['ADMIN_PREVIEW', 'LOCAL_HEADER_EXCHANGE', 'LOCAL_HEADER_EXCHANGE_READY'].map((name, index) => [name, previousFlags[index]] as const)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

async function assertOffBarrier(run: () => Promise<unknown>, eventId: string, pairId: string) {
  await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  requests = [];
  holdFirst = true;
  firstStarted = new Promise<void>((resolve) => { firstArrived = resolve; });
  firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const processing = run();
  await firstStarted;
  const off = db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'off' } });
  releaseFirst();
  await off;
  assert.equal(await processing, 'DISABLED');
  assert.deepEqual(requests, ['/api/remap/1.2/entity/customerorder/' + moyskladOrderId]);
  assert.equal((await db.inboundEvent.findUniqueOrThrow({ where: { id: eventId } })).status, 'RECEIVED');
  const stateWhileOff = await db.entityPairSyncState.findUniqueOrThrow({ where: { pairId } });
  assert.deepEqual(stateWhileOff.bitrix24Values, { 'client:companyId': null, 'deal-order-comments': 'same' });
  assert.deepEqual(stateWhileOff.moyskladValues, { 'client:agentId': moyskladOrderId, 'deal-order-comments': 'same' });
}

async function reply(request: IncomingMessage, response: ServerResponse) {
  const pathname = new URL(request.url ?? '/', base).pathname;
  requests.push(pathname);
  if (holdFirst && requests.length === 1) {
    firstArrived();
    await firstReleased;
    holdFirst = false;
  }
  if (pathname.startsWith('/api/remap/1.2/entity/customerorder/')) {
    assert.equal(request.headers.accept, 'application/json;charset=utf-8');
    assert.equal(request.headers['accept-encoding'], 'gzip');
    return send(response, { id: moyskladOrderId, meta: { type: 'customerorder' }, agent: { id: moyskladOrderId }, description: 'same' });
  }
  if (pathname === '/rest/crm.deal.get.json') {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return send(response, { result: { ID: bitrix24DealId, COMPANY_ID: '0', COMMENTS: 'same' } });
  }
  response.writeHead(404); response.end('{}');
}

function send(response: ServerResponse, body: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
