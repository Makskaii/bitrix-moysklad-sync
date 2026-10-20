import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DatabaseService } from '../src/database.service';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { ADDITIONAL_EVENT_PROCESSORS, EventDispatcherService } from '../src/event-dispatcher.service';
import { SyncModeService } from '../src/sync-mode.service';
import { ControlledLiveTestAdmissionService } from '../src/controlled-live-test-admission.service';
import { setVerifiedControlledLiveProviderNamespace } from '../src/controlled-live-test-namespace';

const providerNamespace = {
  bitrix24PortalOrigin: 'https://test.bitrix.example',
  bitrix24UserId: '3664',
  moyskladAccountId: '11111111-1111-4111-8111-111111111111',
};
const stored: Array<Record<string, unknown>> = [];
const processorEnqueued: string[] = [];
const providerRequests: string[] = [];
let app: INestApplication;
let apiUrl: string;
let manifestPath: string;
let tempDirectory: string;
let originalFetch: typeof fetch;
const previousEnvironment = new Map<string, string | undefined>();

const fakeDatabase = {
  inboundEvent: {
    findUnique: async ({ where }: { where: { id: string } }) => stored.find((row) => row.id === where.id) ?? null,
    upsert: async (args: { create: Record<string, unknown> }) => {
      const row = { id: `ingress-${stored.length + 1}`, ...args.create };
      stored.push(row);
      return { id: row.id };
    },
  },
  syncSetting: { upsert: async () => ({ serviceMode: 'on' }) },
  syncDirectionSetting: { findUnique: async () => ({ bitrix24ToMoysklad: true, moyskladToBitrix24: true }) },
  $queryRaw: async () => [{ serviceMode: 'on' }],
  $transaction: async <T>(operation: (transaction: unknown) => Promise<T>) => operation(fakeDatabase),
};

@Module({
  controllers: [EventsController],
  providers: [
    EventIntakeService,
    SyncModeService,
    ControlledLiveTestAdmissionService,
    { provide: DatabaseService, useValue: fakeDatabase },
    {
      provide: EventDispatcherService,
      useFactory: (database: DatabaseService) => new EventDispatcherService(
        database,
        { enqueue: () => undefined } as any,
        { enqueue: () => undefined } as any,
        [{ supports: () => true, enqueue: (id: string) => { processorEnqueued.push(id); } }],
      ),
      inject: [DatabaseService],
    },
  ],
})
class ControlledIngressTestModule {}

before(async () => {
  for (const key of ['SYNC_MODE', 'CONTROLLED_LIVE_TEST_MODE', 'CONTROLLED_LIVE_TEST_INSTANCE', 'CONTROLLED_LIVE_TEST_MANIFEST', 'DATABASE_URL', 'BITRIX24_EVENT_APPLICATION_TOKEN', 'MOYSKLAD_WEBHOOK_SECRET', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL']) {
    previousEnvironment.set(key, process.env[key]);
  }
  tempDirectory = await mkdtemp(join(tmpdir(), 'controlled-ingress-'));
  manifestPath = join(tempDirectory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({
    runId: 'LIVE-TEST-20261020T120000Z-a1b2c3',
    testDatabaseName: 'sync_issue79_test_ingress',
    testSchemaName: 'issue79_test_ingress',
    providerNamespace,
    records: [
      {
        entity: 'catalog-product', direction: 'MOYSKLAD_TO_BITRIX24', name: 'тест LIVE-TEST-20261020T120000Z-a1b2c3 product', syntheticOnly: true,
        sourceSystem: 'MOYSKLAD', sourceNativeId: 'ms-product-1', targetSystem: 'BITRIX24', targetNativeId: null,
        createdAfterUtc: '2026-10-20T12:00:00Z', allowedActions: ['UPDATE'],
      },
      {
        entity: 'deal-order', direction: 'BOTH', name: 'тест LIVE-TEST-20261020T120000Z-a1b2c3 deal', syntheticOnly: true,
        sourceSystem: 'BITRIX24', sourceNativeId: 'b24-deal-1', targetSystem: 'MOYSKLAD', targetNativeId: 'ms-order-1',
        createdAfterUtc: '2026-10-20T12:00:00Z', allowedActions: ['UPDATE'],
      },
      {
        entity: 'deal-order', direction: 'BOTH', name: 'тест LIVE-TEST-20261020T120000Z-a1b2c3 incomplete pair', syntheticOnly: true,
        sourceSystem: 'BITRIX24', sourceNativeId: 'b24-deal-no-target', targetSystem: 'MOYSKLAD', targetNativeId: null,
        createdAfterUtc: '2026-10-20T12:00:00Z', allowedActions: ['UPDATE'],
      },
      {
        entity: 'deal-order', direction: 'BITRIX24_TO_MOYSKLAD', name: 'тест LIVE-TEST-20261020T120000Z-a1b2c3 one-way deal', syntheticOnly: true,
        sourceSystem: 'BITRIX24', sourceNativeId: 'b24-deal-2', targetSystem: 'MOYSKLAD', targetNativeId: 'ms-order-2',
        createdAfterUtc: '2026-10-20T12:00:00Z', allowedActions: ['UPDATE'],
      },
      {
        entity: 'deal-order', direction: 'BITRIX24_TO_MOYSKLAD', name: 'тест LIVE-TEST-20261020T120000Z-a1b2c3 null source', syntheticOnly: true,
        sourceSystem: 'BITRIX24', sourceNativeId: null, targetSystem: 'MOYSKLAD', targetNativeId: null,
        createdAfterUtc: '2026-10-20T12:00:00Z', allowedActions: ['CREATE'],
      },
      {
        entity: 'deal-order', direction: 'BITRIX24_TO_MOYSKLAD', name: 'тест LIVE-TEST-20261020T120000Z-a1b2c3 action required', syntheticOnly: true,
        sourceSystem: 'BITRIX24', sourceNativeId: 'b24-deal-no-action', targetSystem: 'MOYSKLAD', targetNativeId: 'ms-order-no-action',
        createdAfterUtc: '2026-10-20T12:00:00Z',
      },
    ],
  }), 'utf8');
  process.env.SYNC_MODE = 'apply';
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
  process.env.CONTROLLED_LIVE_TEST_INSTANCE = 'isolated';
  process.env.CONTROLLED_LIVE_TEST_MANIFEST = manifestPath;
  process.env.DATABASE_URL = 'postgresql://localhost/sync_issue79_test_ingress?schema=issue79_test_ingress';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'bitrix-ingress-test-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'moysklad-ingress-test-secret';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix-provider.invalid/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad-provider.invalid/api/remap/1.2/';
  setVerifiedControlledLiveProviderNamespace(providerNamespace);
  app = await NestFactory.create(ControlledIngressTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin === 'https://bitrix-provider.invalid' || url.origin === 'https://moysklad-provider.invalid') providerRequests.push(url.href);
    return originalFetch(input, init);
  }) as typeof fetch;
});

after(async () => {
  await app?.close();
  if (originalFetch) globalThis.fetch = originalFetch;
  await rm(tempDirectory, { recursive: true, force: true });
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('controlled webhook routes persist and dispatch an exact manifest UPDATE', async () => {
  const response = await fetch(`${apiUrl}/webhooks/moysklad/moysklad-ingress-test-secret?requestId=run-update`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/product/ms-product-1' } }] }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { accepted: boolean; eventId: string };
  assert.equal(ack.accepted, true);
  assert.equal(stored.length, 1);
  assert.deepEqual(processorEnqueued, [ack.eventId]);
  assert.deepEqual(providerRequests, []);
});

test('controlled webhook routes acknowledge unmatched, malformed, wrong-action and wrong-direction events without persistence or dispatch', async () => {
  const beforeRows = stored.length;
  const beforeDispatch = processorEnqueued.length;
  const sendBitrix = async (event: string, id: string | null) => fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      event,
      'auth[application_token]': 'bitrix-ingress-test-token',
      ...(id ? { 'data[FIELDS][ID]': id } : {}),
    }),
  });
  const cases = [
    await sendBitrix('ONCRMDEALUPDATE', 'foreign-deal'),
    await sendBitrix('ONCRMDEALDELETE', 'b24-deal-1'),
    await sendBitrix('ONCRMDEALADD', 'b24-deal-new'),
    await sendBitrix('ONCRMPRODUCTUPDATE', 'b24-deal-1'),
    await sendBitrix('ONCRMDEALUPDATE', 'b24-deal-no-action'),
    await sendBitrix('ONCRMDEALUPDATE', 'b24-deal-no-target'),
    await sendBitrix('ONCRMDEALUPDATE', null),
    await sendBitrix('ONCRMDYNAMICITEMUPDATE', 'b24-deal-1'),
    await fetch(`${apiUrl}/webhooks/moysklad/moysklad-ingress-test-secret?requestId=one-way-reverse`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/customerorder/ms-order-2' } }] }),
    }),
  ];
  for (const response of cases) {
    assert.equal(response.status, 200);
    const ack = await response.json() as { accepted: boolean; reason?: string };
    assert.equal(ack.accepted, false);
    assert.equal(ack.reason, 'controlled_scope_rejected');
  }
  assert.equal(stored.length, beforeRows);
  assert.equal(processorEnqueued.length, beforeDispatch);
  assert.deepEqual(providerRequests, []);
});

test('controlled BOTH direction requires the exact opposite native ID and retains only allowed mixed-batch items', async () => {
  const beforeRows = stored.length;
  const beforeDispatch = processorEnqueued.length;
  const response = await fetch(`${apiUrl}/webhooks/moysklad/moysklad-ingress-test-secret?requestId=mixed-run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [
      { action: 'UPDATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/customerorder/ms-order-1' } },
      { action: 'UPDATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/customerorder/foreign-order' } },
      null,
    ] }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { accepted: boolean; eventId: string; rejectedCount: number };
  assert.equal(ack.accepted, true);
  assert.equal(ack.rejectedCount, 2);
  assert.equal(stored.length, beforeRows + 1);
  assert.deepEqual(processorEnqueued.slice(beforeDispatch), [ack.eventId]);
  assert.deepEqual(providerRequests, []);
});

test('controlled MoySklad malformed and empty batches are acknowledged without persistence or dispatch', async () => {
  const beforeRows = stored.length;
  const beforeDispatch = processorEnqueued.length;
  for (const { body, suffix, expectedRejected } of [
    { body: { events: [] }, suffix: '', expectedRejected: 1 },
    { body: { events: [null, 'malformed'] }, suffix: '', expectedRejected: 2 },
    { body: { events: [] }, suffix: '?requestId=', expectedRejected: 1 },
  ]) {
    const response = await fetch(`${apiUrl}/webhooks/moysklad/moysklad-ingress-test-secret${suffix}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const ack = await response.json() as { accepted: boolean; rejectedCount: number; reason: string };
    assert.equal(ack.accepted, false);
    assert.equal(ack.reason, 'controlled_scope_rejected');
    assert.equal(ack.rejectedCount, expectedRejected);
  }
  assert.equal(stored.length, beforeRows);
  assert.equal(processorEnqueued.length, beforeDispatch);
  assert.deepEqual(providerRequests, []);
});

test('controlled BOTH reverse event with a different target ID is not admitted', async () => {
  const beforeRows = stored.length;
  const beforeDispatch = processorEnqueued.length;
  const response = await fetch(`${apiUrl}/webhooks/moysklad/moysklad-ingress-test-secret?requestId=wrong-target`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/customerorder/other-order' } }] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: false, rejectedCount: 1, reason: 'controlled_scope_rejected' });
  assert.equal(stored.length, beforeRows);
  assert.equal(processorEnqueued.length, beforeDispatch);
  assert.deepEqual(providerRequests, []);
});
