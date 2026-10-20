import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
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

const databaseName = 'sync_issue79_scoped_ingress_route_20261020_test';
const schemaName = 'issue79_scoped_ingress_route_20261020_test';
const providerNamespace = {
  bitrix24PortalOrigin: 'https://test.bitrix.example',
  bitrix24UserId: '3664',
  moyskladAccountId: '11111111-1111-4111-8111-111111111111',
};

test('controlled live ingress enforces exact manifest gates through public routes and PostgreSQL', {
  skip: process.env.ISSUE79_INGRESS_POSTGRES_ISOLATED !== '1',
}, async () => {
  const connectionString = process.env.DATABASE_URL;
  assert.ok(connectionString, 'set DATABASE_URL to the dedicated issue-79 ingress test database');
  const connection = new URL(connectionString);
  assert.match(connection.hostname, /^(127\.0\.0\.1|localhost)$/i, 'refusing non-loopback PostgreSQL');
  assert.equal(decodeURIComponent(connection.pathname.slice(1)), databaseName, 'refusing any other database');
  assert.equal(connection.searchParams.get('schema'), schemaName, 'refusing any other schema');

  const savedEnvironment = new Map<string, string | undefined>();
  const environment = {
    SYNC_MODE: 'apply',
    CONTROLLED_LIVE_TEST_MODE: 'enabled',
    CONTROLLED_LIVE_TEST_INSTANCE: 'isolated',
    DATABASE_URL: connectionString,
    BITRIX24_EVENT_APPLICATION_TOKEN: 'postgres-ingress-test-token',
    MOYSKLAD_WEBHOOK_SECRET: 'postgres-ingress-test-secret',
    BITRIX24_REST_BASE_URL: 'https://bitrix-provider.invalid/rest/',
    MOYSKLAD_API_BASE_URL: 'https://moysklad-provider.invalid/api/remap/1.2/',
  };
  for (const key of [...Object.keys(environment), 'DRY_DATABASE_URL', 'CONTROLLED_LIVE_TEST_MANIFEST']) {
    savedEnvironment.set(key, process.env[key]);
  }
  Object.assign(process.env, environment);

  const tempDirectory = await mkdtemp(join(tmpdir(), 'controlled-ingress-pg-'));
  const manifestPath = join(tempDirectory, 'manifest.json');
  const runId = `LIVE-TEST-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  await writeFile(manifestPath, JSON.stringify({
    runId,
    testDatabaseName: databaseName,
    testSchemaName: schemaName,
    providerNamespace,
    records: [
      {
        entity: 'catalog-product', direction: 'MOYSKLAD_TO_BITRIX24', name: `тест ${runId} product`, syntheticOnly: true,
        sourceSystem: 'MOYSKLAD', sourceNativeId: 'ms-product-pg-exact', targetSystem: 'BITRIX24', targetNativeId: null,
        createdAfterUtc: '2026-10-20T00:00:00Z', allowedActions: ['UPDATE'],
      },
      {
        entity: 'deal-order', direction: 'BOTH', name: `тест ${runId} pair`, syntheticOnly: true,
        sourceSystem: 'BITRIX24', sourceNativeId: 'b24-deal-pg-exact', targetSystem: 'MOYSKLAD', targetNativeId: 'ms-order-pg-exact',
        createdAfterUtc: '2026-10-20T00:00:00Z', allowedActions: ['UPDATE'],
      },
      {
        entity: 'client:COMPANY', direction: 'MOYSKLAD_TO_BITRIX24', name: `тест ${runId} company collision`, syntheticOnly: true,
        sourceSystem: 'MOYSKLAD', sourceNativeId: 'ms-counterparty-pg-collision', targetSystem: 'BITRIX24', targetNativeId: 'b24-company-pg',
        createdAfterUtc: '2026-10-20T00:00:00Z', allowedActions: ['UPDATE'],
      },
      {
        entity: 'client:CONTACT', direction: 'MOYSKLAD_TO_BITRIX24', name: `тест ${runId} contact collision`, syntheticOnly: true,
        sourceSystem: 'MOYSKLAD', sourceNativeId: 'ms-counterparty-pg-collision', targetSystem: 'BITRIX24', targetNativeId: 'b24-contact-pg',
        createdAfterUtc: '2026-10-20T00:00:00Z', allowedActions: ['UPDATE'],
      },
      {
        entity: 'catalog-product', direction: 'MOYSKLAD_TO_BITRIX24', name: `тест ${runId} no action list`, syntheticOnly: true,
        sourceSystem: 'MOYSKLAD', sourceNativeId: 'ms-product-pg-no-actions', targetSystem: 'BITRIX24', targetNativeId: null,
        createdAfterUtc: '2026-10-20T00:00:00Z',
      },
    ],
  }), 'utf8');
  process.env.CONTROLLED_LIVE_TEST_MANIFEST = manifestPath;
  setVerifiedControlledLiveProviderNamespace(providerNamespace);

  let app: INestApplication | undefined;
  let database: DatabaseService | undefined;
  const enqueued: string[] = [];
  const providerCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  try {
    database = new DatabaseService();
    await database.$connect();
    await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
    await database.syncDirectionSetting.upsert({ where: { entityKey: 'products-variations' }, create: { entityKey: 'products-variations', bitrix24ToMoysklad: false, moyskladToBitrix24: true }, update: { bitrix24ToMoysklad: false, moyskladToBitrix24: true } });
    await database.syncDirectionSetting.upsert({ where: { entityKey: 'deals-orders' }, create: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: true }, update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } });

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.origin === 'https://bitrix-provider.invalid' || url.origin === 'https://moysklad-provider.invalid') providerCalls.push(url.href);
      return originalFetch(input, init);
    }) as typeof fetch;

    @Module({
      controllers: [EventsController],
      providers: [
        EventIntakeService,
        SyncModeService,
        ControlledLiveTestAdmissionService,
        { provide: DatabaseService, useValue: database },
        {
          provide: EventDispatcherService,
          useFactory: (db: DatabaseService) => new EventDispatcherService(
            db,
            { enqueue: () => undefined } as any,
            { enqueue: () => undefined } as any,
            [{ supports: () => true, enqueue: (id: string) => { enqueued.push(id); } }],
          ),
          inject: [DatabaseService],
        },
      ],
    })
    class PostgresControlledIngressTestModule {}

    app = await NestFactory.create(PostgresControlledIngressTestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const apiUrl = await app.getUrl();
    const beforeCount = await database.inboundEvent.count();

    const productResponse = await fetch(`${apiUrl}/webhooks/moysklad/postgres-ingress-test-secret?requestId=${runId}-product`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/product/ms-product-pg-exact' } }] }),
    });
    assert.equal(productResponse.status, 200);
    const productAck = await productResponse.json() as { accepted: boolean; eventId: string };
    assert.equal(productAck.accepted, true);
    const productRow = await database.inboundEvent.findUniqueOrThrow({ where: { id: productAck.eventId } });
    assert.equal(productRow.externalEntityId, 'ms-product-pg-exact');
    await waitFor(() => enqueued.includes(productAck.eventId));
    assert.deepEqual(enqueued, [productAck.eventId]);

    const rejectedBefore = await database.inboundEvent.count();
    const queueBefore = enqueued.length;
    const rejected = await fetch(`${apiUrl}/webhooks/moysklad/postgres-ingress-test-secret`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [
        { action: 'UPDATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/product/foreign-product' } },
        { action: 'DELETE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/product/ms-product-pg-exact' } },
        { action: 'CREATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/product/ms-product-pg-exact' } },
        { action: 'UPDATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/service/ms-product-pg-exact' } },
        { action: 'UPDATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/product/ms-product-pg-no-actions' } },
        { action: 'UPDATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/counterparty/ms-counterparty-pg-collision' } },
        null,
      ] }),
    });
    assert.equal(rejected.status, 200);
    const rejectedAck = await rejected.json() as { accepted: boolean; rejectedCount: number };
    assert.equal(rejectedAck.accepted, false);
    assert.equal(rejectedAck.rejectedCount, 7);
    assert.equal(await database.inboundEvent.count(), rejectedBefore);
    assert.equal(enqueued.length, queueBefore);

    const mixed = await fetch(`${apiUrl}/webhooks/moysklad/postgres-ingress-test-secret?requestId=${runId}-mixed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [
        { action: 'UPDATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/customerorder/ms-order-pg-exact' } },
        { action: 'UPDATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/customerorder/foreign-order' } },
      ] }),
    });
    assert.equal(mixed.status, 200);
    const mixedAck = await mixed.json() as { accepted: boolean; eventId: string; rejectedCount: number };
    assert.equal(mixedAck.accepted, true);
    assert.equal(mixedAck.rejectedCount, 1);
    const mixedRow = await database.inboundEvent.findUniqueOrThrow({ where: { id: mixedAck.eventId } });
    assert.equal(mixedRow.externalEntityId, 'ms-order-pg-exact');
    await waitFor(() => enqueued.includes(mixedAck.eventId));
    assert.deepEqual(enqueued.slice(queueBefore), [mixedAck.eventId]);

    const bitrixResponse = await fetch(`${apiUrl}/webhooks/bitrix24`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ event: 'ONCRMDEALUPDATE', 'auth[application_token]': 'postgres-ingress-test-token', 'data[FIELDS][ID]': 'b24-deal-pg-exact' }),
    });
    assert.equal(bitrixResponse.status, 200);
    const bitrixAck = await bitrixResponse.json() as { accepted: boolean; eventId: string };
    assert.equal(bitrixAck.accepted, true);
    assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: bitrixAck.eventId } })).externalEntityId, 'b24-deal-pg-exact');
    await waitFor(() => enqueued.includes(bitrixAck.eventId));
    assert.deepEqual(enqueued.slice(queueBefore + 1), [bitrixAck.eventId]);

    const bitrixWrongId = await fetch(`${apiUrl}/webhooks/bitrix24`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ event: 'ONCRMDEALUPDATE', 'auth[application_token]': 'postgres-ingress-test-token', 'data[FIELDS][ID]': 'foreign-b24-deal' }),
    });
    assert.equal(bitrixWrongId.status, 200);
    assert.equal((await bitrixWrongId.json() as { accepted: boolean }).accepted, false);

    const reverseWrongId = await fetch(`${apiUrl}/webhooks/moysklad/postgres-ingress-test-secret?requestId=${runId}-reverse-wrong`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { href: 'https://online.moysklad.ru/api/remap/1.2/entity/customerorder/not-ms-order-pg-exact' } }] }),
    });
    assert.equal(reverseWrongId.status, 200);
    assert.equal((await reverseWrongId.json() as { accepted: boolean }).accepted, false);
    assert.equal(await database.inboundEvent.count(), beforeCount + 3);
    assert.deepEqual(enqueued, [productAck.eventId, mixedAck.eventId, bitrixAck.eventId]);
    assert.deepEqual(providerCalls, []);
  } finally {
    await app?.close();
    if (database) await database.$disconnect();
    globalThis.fetch = originalFetch;
    await rm(tempDirectory, { recursive: true, force: true });
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(predicate(), true, 'public route did not complete downstream dispatch in time');
}
