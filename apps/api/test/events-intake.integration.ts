import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DatabaseService } from '../src/database.service';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { SyncModeService } from '../src/sync-mode.service';
import { WebhookDiagnosticsController } from '../src/webhook-diagnostics.controller';
import { AdminAccessGuard, LOCAL_ADMIN_PREVIEW_ACCESS } from '../src/admin/admin-access.guard';
import { WebhookDiagnosticLog } from '../src/webhook-diagnostic-log';
import { ContactSyncProcessor } from '../src/contact-sync.service';

type StoredEvent = {
  id: string;
  source: string;
  deliveryKey: string;
  eventType: string | null;
  externalEntityId: string | null;
  externalEntityType: string | null;
  payload: unknown;
  status: string;
  receivedAt: Date;
  lastErrorCategory: string | null;
};
const rows = new Map<string, StoredEvent>();
let upsertCalls = 0;
let failNextWrite = false;
const queuedContactEventIds: string[] = [];
let intakeMode: 'on' | 'pause' | 'off' = 'on';
const inboundEvent = {
  findMany: async () => [...rows.values()].map(({ id, source, eventType, externalEntityType, externalEntityId, status, receivedAt, lastErrorCategory }) => ({
    id, source, eventType, externalEntityType, externalEntityId, status, receivedAt, lastErrorCategory,
  })),
  upsert: async (args: {
    where: { source_deliveryKey: { source: string; deliveryKey: string } };
    create: {
      source: string;
      deliveryKey: string;
      eventType: string | null;
      externalEntityId: string | null;
      externalEntityType: string | null;
      payload: unknown;
      status?: string;
      lastErrorCategory?: string | null;
    };
  }) => {
    upsertCalls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('private persistence detail');
    }
    const { source, deliveryKey } = args.where.source_deliveryKey;
    const key = `${source}:${deliveryKey}`;
    let row = rows.get(key);
    if (!row) {
      row = { id: `event-${rows.size + 1}`, status: 'RECEIVED', receivedAt: new Date(), lastErrorCategory: null, ...args.create };
      rows.set(key, row);
    }
    return { id: row.id };
  },
};

const fakeDatabase = {
  inboundEvent,
  syncSetting: { upsert: async () => ({ serviceMode: intakeMode }) },
  syncDirectionSetting: { findUnique: async () => ({ bitrix24ToMoysklad: true, moyskladToBitrix24: true }) },
};

@Module({
  controllers: [EventsController, WebhookDiagnosticsController],
  providers: [
    EventIntakeService,
    { provide: DatabaseService, useValue: fakeDatabase },
    SyncModeService,
    { provide: LOCAL_ADMIN_PREVIEW_ACCESS, useValue: true },
    WebhookDiagnosticLog,
    { provide: ContactSyncProcessor, useValue: { enqueue: (id: string) => queuedContactEventIds.push(id) } },
  ],
})
class EventsIntakeTestModule {}

let app: INestApplication;
let apiUrl: string;
let webhookDiagnostics: WebhookDiagnosticLog;

before(async () => {
  process.env.SYNC_MODE = 'apply';
  process.env.SYNC_STATE = 'on';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'bitrix-test-application-token';
  process.env['MOYSKLAD_WEBHOOK_SECRET'] = 'moysklad-test-path-secret';
  process.env.ADMIN_PREVIEW = '1';
  app = await NestFactory.create(EventsIntakeTestModule, { logger: false });
  webhookDiagnostics = app.get(WebhookDiagnosticLog);
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
});

after(async () => {
  await app.close();
});

test('dry webhook diagnostics initially report all deal and customer-order subscriptions as unchecked', async () => {
  rows.clear();
  webhookDiagnostics.clear();
  process.env.SYNC_MODE = 'dry';
  const response = await fetch(`${apiUrl}/api/admin/dry-webhooks`);
  assert.equal(response.status, 200);
  const report = await response.json() as {
    subscriptions: Array<{ status: string }>;
    targets: { bitrix24: string; moysklad: string };
  };
  assert.equal(report.subscriptions.length, 6);
  assert.ok(report.subscriptions.every((subscription) => subscription.status === 'not_checked'));
  assert.equal(report.targets.bitrix24, '/webhooks/bitrix24');
  assert.equal(report.targets.moysklad, '/webhooks/moysklad/{MOYSKLAD_WEBHOOK_SECRET}');
  process.env.SYNC_MODE = 'apply';
});

test('Bitrix24 event is stored before acknowledgement and repeat delivery is idempotent', async () => {
  rows.clear();
  upsertCalls = 0;
  const body = 'event=ONCRMDEALUPDATE&ts=1770000000&auth%5Bapplication_token%5D=bitrix-test-application-token&data%5BFIELDS%5D%5BID%5D=42';

  const first = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  assert.equal(first.status, 200);
  const firstAck = (await first.json()) as { accepted: boolean; eventId: string };
  assert.equal(firstAck.accepted, true);
  assert.equal(rows.size, 1, 'the durable-store call completed before the HTTP acknowledgement');
  assert.equal((rows.values().next().value?.payload as Record<string, unknown>).auth, undefined);

  const repeated = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  assert.equal(repeated.status, 200);
  const repeatedAck = (await repeated.json()) as { eventId: string };
  assert.equal(repeatedAck.eventId, firstAck.eventId);
  assert.equal(rows.size, 1, 'the same delivery key must not create another event');
  assert.equal(upsertCalls, 2, 'both deliveries reach the idempotent database operation');
});

test('unverified sources are rejected without a database write', async () => {
  rows.clear();
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMDEALUPDATE', auth: { application_token: 'wrong-token' } }),
  });
  assert.equal(response.status, 401);
  assert.equal(rows.size, 0);
  process.env.SYNC_MODE = 'dry';
  const reportResponse = await fetch(`${apiUrl}/api/admin/dry-webhooks`);
  const report = await reportResponse.json() as {
    subscriptions: Array<{ source: string; eventType: string; status: string; reason?: string }>;
    diagnostics: Array<{ status: string; reason: string; eventType: string; externalEntityId: string | null }>;
  };
  assert.equal(report.subscriptions.find((item) => item.eventType === 'ONCRMDEALUPDATE')?.status, 'rejected_validation');
  assert.equal(report.diagnostics[0].reason, 'invalid_application_token');
  assert.equal(report.diagnostics[0].externalEntityId, null);
  process.env.SYNC_MODE = 'apply';
});

test('dry diagnostics report a safe processing error when event persistence fails', async () => {
  rows.clear();
  process.env.SYNC_MODE = 'dry';
  failNextWrite = true;
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'event=ONCRMDEALUPDATE&auth%5Bapplication_token%5D=bitrix-test-application-token&data%5BFIELDS%5D%5BID%5D=77',
  });
  assert.equal(response.status, 503);
  assert.equal(rows.size, 0);
  const reportResponse = await fetch(`${apiUrl}/api/admin/dry-webhooks`);
  const report = await reportResponse.json() as { diagnostics: Array<{ status: string; reason: string; externalEntityId: string | null }> };
  assert.equal(report.diagnostics[0].status, 'processing_error');
  assert.equal(report.diagnostics[0].reason, 'event_persistence_failed');
  assert.equal(report.diagnostics[0].externalEntityId, '77');
  assert.equal(JSON.stringify(report).includes('private persistence detail'), false);
  process.env.SYNC_MODE = 'apply';
});

test('MoySklad webhook uses the secret URL and requestId for idempotent persistence', async () => {
  rows.clear();
  const url = `${apiUrl}/webhooks/moysklad/moysklad-test-path-secret?requestId=delivery-123&id=entity-456&type=CustomerOrder`;
  const first = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(first.status, 200);
  const firstAck = (await first.json()) as { eventId: string };
  assert.equal(rows.size, 1);

  const repeated = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(repeated.status, 200);
  const repeatedAck = (await repeated.json()) as { eventId: string };
  assert.equal(repeatedAck.eventId, firstAck.eventId);
  assert.equal(rows.size, 1);

  const laterUpdate = await fetch(url.replace('delivery-123', 'delivery-124'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(laterUpdate.status, 200);
  const laterUpdateAck = (await laterUpdate.json()) as { eventId: string };
  assert.notEqual(laterUpdateAck.eventId, firstAck.eventId);
  assert.equal(rows.size, 2, 'different source delivery IDs must remain separate even for the same entity');

  const rejected = await fetch(url.replace('moysklad-test-path-secret', 'wrong-secret'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [
      { meta: { type: 'customerorder', href: 'https://online.moysklad.ru/api/remap/1.2/entity/customerorder/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, action: 'DELETE' },
    ] }),
  });
  assert.equal(rejected.status, 401);
  assert.equal(rows.size, 2);
  process.env.SYNC_MODE = 'dry';
  const reportResponse = await fetch(`${apiUrl}/api/admin/dry-webhooks`);
  const report = await reportResponse.json() as { diagnostics: Array<{ source: string; status: string; reason: string; eventType: string; externalEntityId: string | null }> };
  const rejection = report.diagnostics.find((item) => item.source === 'MOYSKLAD');
  assert.equal(rejection?.status, 'rejected_validation');
  assert.equal(rejection?.reason, 'invalid_secret');
  assert.equal(rejection?.eventType, 'DELETE');
  assert.equal(rejection?.externalEntityId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  process.env.SYNC_MODE = 'apply';
});

test('native MoySklad event envelope is accepted without query parameters and keeps each arrival', async () => {
  rows.clear();
  const payload = {
    events: [{
      meta: { type: 'product', href: 'https://online.moysklad.ru/api/remap/1.1/entity/product/native-id' },
      action: 'UPDATE',
    }],
  };
  const url = `${apiUrl}/webhooks/moysklad/moysklad-test-path-secret`;
  const post = () => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });

  const first = await post();
  assert.equal(first.status, 200);
  const firstAck = (await first.json()) as { eventId: string };
  const stored = [...rows.values()][0];
  assert.ok(stored);
  assert.equal(stored.eventType, 'UPDATE');
  assert.equal(stored.externalEntityId, 'native-id');
  assert.equal(stored.externalEntityType, 'product');

  const repeated = await post();
  assert.equal(repeated.status, 200);
  const repeatedAck = (await repeated.json()) as { eventId: string };
  assert.notEqual(repeatedAck.eventId, firstAck.eventId, 'without a source delivery ID, do not collapse potentially distinct updates');
  assert.equal(rows.size, 2);
});

test('MoySklad delivery stores every customer-order event and deduplicates a repeated batch requestId', async () => {
  rows.clear();
  const url = `${apiUrl}/webhooks/moysklad/moysklad-test-path-secret?requestId=batch-123`;
  const body = JSON.stringify({
    events: [
      { meta: { type: 'customerorder', href: 'https://online.moysklad.ru/api/remap/1.2/entity/customerorder/order-a' }, action: 'CREATE' },
      { meta: { type: 'customerorder', href: 'https://online.moysklad.ru/api/remap/1.2/entity/customerorder/order-b' }, action: 'DELETE' },
    ],
  });
  const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  const first = await post();
  assert.equal(first.status, 200);
  const firstAck = (await first.json()) as { accepted: boolean; eventIds: string[] };
  assert.equal(firstAck.accepted, true);
  assert.equal(firstAck.eventIds.length, 2);
  assert.equal(rows.size, 2);
  assert.deepEqual([...rows.values()].map((row) => [row.eventType, row.externalEntityType, row.externalEntityId]), [
    ['CREATE', 'customerorder', 'order-a'],
    ['DELETE', 'customerorder', 'order-b'],
  ]);

  const repeated = await post();
  assert.equal(repeated.status, 200);
  const repeatedAck = (await repeated.json()) as { eventIds: string[] };
  assert.deepEqual(repeatedAck.eventIds, firstAck.eventIds);
  assert.equal(rows.size, 2);
});

test('MoySklad requestId and batch index cannot collide across separate deliveries', async () => {
  rows.clear();
  const url = `${apiUrl}/webhooks/moysklad/moysklad-test-path-secret`;
  const event = (id: string) => ({
    meta: { type: 'customerorder', href: `https://online.moysklad.ru/api/remap/1.2/entity/customerorder/${id}` },
    action: 'UPDATE',
  });
  const send = (requestId: string, events: unknown[]) => fetch(`${url}?requestId=${requestId}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }),
  });

  const batch = await send('foo', [event('first'), event('second')]);
  const batchAck = await batch.json() as { eventIds: string[] };
  const single = await send('foo%3A1', [event('independent')]);
  const singleAck = await single.json() as { eventId: string };

  assert.equal(batch.status, 200);
  assert.equal(single.status, 200);
  assert.equal(rows.size, 3);
  assert.notEqual(singleAck.eventId, batchAck.eventIds[1]);
});

test('MoySklad does not acknowledge a malformed events array as fully stored', async () => {
  rows.clear();
  const response = await fetch(`${apiUrl}/webhooks/moysklad/moysklad-test-path-secret?requestId=malformed-batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [null] }),
  });
  assert.equal(response.status, 400);
  assert.equal(rows.size, 0);
});

test('dry deal and customer-order webhook matrix accepts create, update, and delete without dispatching writers', async () => {
  rows.clear();
  queuedContactEventIds.length = 0;
  process.env.SYNC_MODE = 'dry';
  const bitrixEvents = ['ONCRMDEALADD', 'ONCRMDEALUPDATE', 'ONCRMDEALDELETE'];
  for (const [index, eventType] of bitrixEvents.entries()) {
    const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        event: eventType,
        'auth[application_token]': 'bitrix-test-application-token',
        'data[FIELDS][ID]': `deal-${index + 1}`,
      }),
    });
    assert.equal(response.status, 200);
  }
  for (const [index, action] of ['CREATE', 'UPDATE', 'DELETE'].entries()) {
    const response = await fetch(`${apiUrl}/webhooks/moysklad/moysklad-test-path-secret?requestId=matrix-${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{
        meta: { type: 'customerorder', href: `https://online.moysklad.ru/api/remap/1.2/entity/customerorder/order-${index + 1}` },
        action,
      }] }),
    });
    assert.equal(response.status, 200);
  }
  assert.equal(rows.size, 6);
  assert.ok([...rows.values()].every((row) => row.status === 'RECEIVED'));
  assert.ok([...rows.values()].every((row) => !JSON.stringify(row.payload).includes('bitrix-test-application-token')));
  assert.deepEqual(queuedContactEventIds, []);
  process.env.SYNC_MODE = 'apply';
});

test('dry webhook diagnostics show deal and customer-order delivery state without payload data', async () => {
  rows.clear();
  process.env.SYNC_MODE = 'dry';
  const mostRecentEventAt = new Date(Date.now() + 60_000);
  rows.set('BITRIX24:diagnostic', {
    id: 'event-safe-id', source: 'BITRIX24', deliveryKey: 'diagnostic', eventType: 'ONCRMDEALUPDATE',
    externalEntityId: '42', externalEntityType: 'deal', payload: { email: 'private@example.test', auth: { application_token: 'secret' } },
    status: 'RECEIVED', receivedAt: mostRecentEventAt, lastErrorCategory: null,
  });

  const response = await fetch(`${apiUrl}/api/admin/dry-webhooks`);
  assert.equal(response.status, 200);
  const report = await response.json() as {
    mode: string;
    subscriptions: Array<{ source: string; eventType: string; status: string }>;
    events: Array<Record<string, unknown>>;
  };
  assert.equal(report.mode, 'dry');
  assert.equal(report.subscriptions.length, 6);
  assert.equal(report.subscriptions.find((item) => item.eventType === 'ONCRMDEALUPDATE')?.status, 'event_received');
  assert.equal(report.subscriptions.find((item) => item.eventType === 'DELETE' && item.source === 'MOYSKLAD')?.status, 'rejected_validation');
  assert.equal(report.events[0].externalEntityId, '42');
  assert.equal(report.events[0].receivedAt, mostRecentEventAt.toISOString());
  assert.equal(JSON.stringify(report).includes('private@example.test'), false);
  assert.equal(JSON.stringify(report).includes('moysklad-test-path-secret'), false);
  assert.equal(JSON.stringify(report).includes('bitrix-test-application-token'), false);
  process.env.SYNC_MODE = 'apply';
});

test('pause stores verified events and off declines intake without storing', async () => {
  rows.clear();
  intakeMode = 'pause';
  const body = JSON.stringify({ event: 'ONCRMDEALADD', auth: { application_token: 'bitrix-test-application-token' } });
  const paused = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  assert.equal(paused.status, 200);
  assert.equal(rows.size, 1);

  intakeMode = 'off';
  const off = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  assert.equal(off.status, 410);
  assert.equal(rows.size, 1);
  intakeMode = 'on';
});
