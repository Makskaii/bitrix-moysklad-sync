import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { createServer, Server } from 'node:http';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { EventDispatcherService } from '../src/event-dispatcher.service';
import { ProductCardEventProcessor } from '../src/products/product-card-event.processor';
import { ProductCardHttpApi } from '../src/products/product-card-api';
import { ProductCardRuntimeService } from '../src/products/product-card-runtime.service';
import { DryRunWriteJournal } from '../src/dry-run-write-journal';

const productId = '12345678-1234-1234-1234-123456789abc';
const bitrixProductId = '101';
const pair = {
  id: 'fake-e2e-product-pair', entityType: 'PRODUCT', bitrix24Id: bitrixProductId, moyskladId: productId,
  active: true, source: 'MANUAL', reason: null, createdAt: new Date('2026-10-01T00:00:00Z'),
};
const productSettings = {
  rules: [{ entity: 'catalog', sourceField: 'name', targetField: 'name',
    bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }],
  references: { units: [], priceTypes: [] },
};

type FakeState = ReturnType<typeof makeHarness>;
const activeApps: INestApplication[] = [];
const activeMocks: Server[] = [];

function makeHarness(mode: 'apply' | 'dry') {
  const events = new Map<string, Record<string, any>>();
  const proposals = new Map<string, Record<string, any>>();
  const states = new Map<string, Record<string, any>>([[pair.id, {
    settingsVersion: 1,
    bitrix24Values: { name: 'Before', description: null, unitId: null, prices: [] },
    moyskladValues: { name: 'Before', description: null, unitId: null, prices: [] },
  }]]);
  const locks = new Map<string, Record<string, any>>();
  const logs: Array<Record<string, any>> = [];
  const entityPair = {
    findMany: async () => [pair],
    findFirst: async () => pair,
  };
  const database: any = {
    inboundEvent: {
      findUnique: async ({ where }: any) => events.get(where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        const event = events.get(where.id);
        if (!event) return { count: 0 };
        const conditions = where.OR ?? [];
        if (!conditions.some((condition: any) => condition.status === event.status) && where.status !== event.status) return { count: 0 };
        if (data.attempts?.increment) event.attempts += data.attempts.increment;
        const { attempts, ...updates } = data;
        Object.assign(event, updates);
        return { count: 1 };
      },
      findMany: async () => [...events.values()],
    },
    entityPair,
    entityPairSyncState: {
      findUnique: async () => states.get(pair.id) ?? null,
      upsert: async ({ create, update }: any) => {
        const existing = states.get(pair.id);
        const next = { ...(existing ?? create), ...update };
        states.set(pair.id, next);
        return next;
      },
    },
    inboundEntityLock: {
      updateMany: async ({ where, data }: any) => {
        const lock = locks.get(where.entityKey);
        if (!lock || (where.ownerToken && lock.ownerToken !== where.ownerToken)) return { count: 0 };
        Object.assign(lock, data);
        return { count: 1 };
      },
      create: async ({ data }: any) => { locks.set(data.entityKey, data); return data; },
      deleteMany: async ({ where }: any) => ({ count: locks.delete(where.entityKey) ? 1 : 0 }),
    },
    dryRunWriteProposal: {
      upsert: async ({ where, create, update }: any) => {
        const existing = proposals.get(where.id);
        const next = { ...(existing ?? create), ...update };
        proposals.set(where.id, next);
        return next;
      },
      findMany: async ({ where }: any) => [...proposals.values()].filter((item) =>
        item.provider === where.provider && item.entityType === where.entityType && item.entityId === where.entityId),
      findFirst: async ({ where }: any) => [...proposals.values()].find((item) =>
        item.provider === where.provider && item.entityType === where.entityType && item.entityId === where.entityId && item.operation === where.operation) ?? null,
    },
    operationalLog: { create: async ({ data }: any) => { logs.push(data); return data; } },
    manualReviewCase: { updateMany: async () => ({ count: 0 }) },
    $transaction: async (operation: (transaction: any) => Promise<unknown>) => operation(database),
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('');
      if (query.includes('InboundEntityLock')) {
        const lock = locks.get(String(values[0]));
        return lock ? [{ ownerToken: lock.ownerToken, leaseExpiresAt: lock.leaseExpiresAt }] : [];
      }
      if (query.includes('SyncSetting')) return [{ serviceMode: 'on' }];
      if (query.includes('SyncDirectionSetting')) return [{ moyskladToBitrix24: true }];
      return [];
    },
  };
  const settings: any = {
    saveAcceptedEvent: async (input: any) => {
      const id = `fake-event-${events.size + 1}`;
      events.set(id, { id, ...input, settingsVersion: 1, status: input.directionDisabled ? 'SKIPPED_DIRECTION_DISABLED' : 'RECEIVED', attempts: 0, retryAfter: null, processingStartedAt: null });
      return { id };
    },
    eventConfig: async (eventId: string) => {
      if (events.get(eventId)?.settingsVersion !== 1) throw new Error('event settings version was not pinned at intake');
      return { version: 1, config: productSettings };
    },
    version: async () => ({ version: 1, config: productSettings }),
  };
  const syncMode: any = {
    read: async () => ({ mode: 'on' }),
    isDirectionEnabled: async () => true,
  };
  const dryJournal = new DryRunWriteJournal(database);
  const api = new ProductCardHttpApi(dryJournal);
  const runtime = new ProductCardRuntimeService(database, api, settings, syncMode);
  const processor = new ProductCardEventProcessor(database, api, settings, runtime);
  let processing: Promise<unknown> | null = null;
  let signalProcessingStarted!: () => void;
  const processingStarted = new Promise<void>((resolve) => { signalProcessingStarted = resolve; });
  const dispatcher: any = {
    dispatch: async (eventId: string) => { processing = processor.process(eventId); signalProcessingStarted(); void processing.catch(() => undefined); },
  };
  const intake = new EventIntakeService(database, syncMode, undefined, settings);
  return {
    mode, database, events, proposals, states, logs, processor, intake, dispatcher,
    waitForProcessing: async () => { await processingStarted; await processing; },
  };
}

function startMock(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('mock server did not bind TCP'));
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function json(response: import('node:http').ServerResponse, value: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function makeProviderMocks() {
  const trace: string[] = [];
  const bitrixState = { name: 'Before', detailText: '' };
  const moyskladState = { name: 'After', description: '' };
  const writes: string[] = [];
  const bitrix = await startMock((request, response) => {
    void readBody(request).then((body) => {
      const form = new URLSearchParams(body);
      const method = new URL(request.url ?? '/', 'http://local').pathname;
      trace.push(`BITRIX24:${method}`);
      if (method === '/rest/catalog.product.get.json') return json(response, { result: { product: { id: bitrixProductId, type: 1, ...bitrixState } } });
      if (method === '/rest/catalog.price.list.json') return json(response, { result: { prices: [] } });
      if (method === '/rest/catalog.product.update.json') {
        writes.push('BITRIX24');
        const fields = new URLSearchParams(form.toString());
        const name = fields.get('fields[name]');
        if (name !== null) bitrixState.name = name;
        return json(response, { result: true });
      }
      response.writeHead(404).end();
    });
  });
  const moysklad = await startMock((request, response) => {
    void readBody(request).then((body) => {
      const path = new URL(request.url ?? '/', 'http://local').pathname;
      trace.push(`MOYSKLAD:${request.method}:${path}`);
      if (request.method === 'GET' && path === `/api/remap/1.2/entity/product/${productId}`) {
        return json(response, { id: productId, meta: { type: 'product' }, name: moyskladState.name, description: moyskladState.description, updated: '2026-10-14T08:00:00Z', salePrices: [] });
      }
      if (request.method === 'PUT' && path === `/api/remap/1.2/entity/product/${productId}`) {
        writes.push('MOYSKLAD');
        const fields = JSON.parse(body) as Record<string, unknown>;
        if (typeof fields.name === 'string') moyskladState.name = fields.name;
        return json(response, { id: productId, meta: { type: 'product' }, ...moyskladState });
      }
      response.writeHead(404).end();
    });
  });
  return { bitrix, moysklad, trace, writes, bitrixState, moyskladState };
}

async function createWebhookApp(harness: FakeState): Promise<INestApplication> {
  @Module({
    controllers: [EventsController],
    providers: [
      { provide: EventIntakeService, useValue: harness.intake },
      { provide: EventDispatcherService, useValue: harness.dispatcher },
    ],
  })
  class FakeProviderE2eModule {}
  const app = await NestFactory.create(FakeProviderE2eModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  activeApps.push(app);
  return app;
}

async function runProductWebhook(mode: 'apply' | 'dry') {
  const harness = makeHarness(mode);
  const mocks = await makeProviderMocks();
  activeMocks.push(mocks.bitrix.server, mocks.moysklad.server);
  process.env.SYNC_MODE = mode;
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'fake-e2e-bitrix-event-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'fake-e2e-moysklad-webhook-secret';
  process.env.BITRIX24_REST_BASE_URL = new URL('rest/', mocks.bitrix.url).href;
  process.env.MOYSKLAD_API_BASE_URL = new URL('api/remap/1.2/', mocks.moysklad.url).href;
  process.env.MOYSKLAD_API_TOKEN = 'fake-e2e-moysklad-api-token';

  const app = await createWebhookApp(harness);
  const appUrl = await app.getUrl();
  const response = await fetch(`${appUrl}/webhooks/moysklad/fake-e2e-moysklad-webhook-secret?requestId=product-e2e-${mode}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{
      meta: { type: 'product', href: `https://online.moysklad.ru/api/remap/1.2/entity/product/${productId}` }, action: 'UPDATE',
    }] }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { accepted: boolean; eventId: string };
  assert.equal(ack.accepted, true);
  assert.ok(harness.events.has(ack.eventId), 'the event is durably accepted before the webhook ACK');
  await harness.waitForProcessing();
  assert.equal(harness.events.get(ack.eventId)?.status, 'SUCCEEDED');
  assert.ok(mocks.trace.some((item) => item.includes('/entity/product/')), 'worker rereads current MoySklad state');
  assert.ok(mocks.trace.some((item) => item.includes('/catalog.product.get.json')), 'worker reads current Bitrix24 state');
  assert.equal(harness.states.get(pair.id)?.bitrix24Values?.name, 'After', 'confirmed readback advances the pair baseline');
  assert.ok(harness.logs.some((log) => log.category === 'EVENT' && log.referenceId === ack.eventId), 'intake is recorded in the operational journal');

  return { harness, mocks, ack };
}

after(async () => {
  for (const app of activeApps) {
    (app.getHttpServer() as Server).closeAllConnections();
    await app.close();
  }
  for (const server of activeMocks) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('fake provider E2E applies an accepted MoySklad product event through pair reconciliation and HTTP readback', async () => {
  const { mocks } = await runProductWebhook('apply');
  assert.equal(mocks.bitrixState.name, 'After');
  assert.deepEqual(mocks.writes, ['BITRIX24']);
});

test('fake provider E2E dry mode stores a virtual write proposal and stops before provider writes', async () => {
  const { harness, mocks, ack } = await runProductWebhook('dry');
  assert.equal(mocks.bitrixState.name, 'Before');
  assert.deepEqual(mocks.writes, []);
  const proposals = [...harness.proposals.values()];
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0]?.fields, { name: 'After' });
  assert.equal(proposals[0]?.provider, 'BITRIX24');
  assert.equal(proposals[0]?.entityType, 'product');
  assert.equal(proposals[0]?.entityId, bitrixProductId);
  assert.ok(mocks.trace.some((item) => item.includes('/catalog.product.get.json')), 'dry execution still reads both current providers');
  assert.ok(harness.logs.some((log) => log.category === 'EVENT' && log.referenceId === ack.eventId));
});
