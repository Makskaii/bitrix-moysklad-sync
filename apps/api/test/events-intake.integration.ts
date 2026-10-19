import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DatabaseService } from '../src/database.service';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { EventDispatcherService } from '../src/event-dispatcher.service';
import { SyncModeService } from '../src/sync-mode.service';
import { WebhookDiagnosticsController } from '../src/webhook-diagnostics.controller';
import { AdminAccessGuard, LOCAL_ADMIN_PREVIEW_ACCESS } from '../src/admin/admin-access.guard';
import { WebhookDiagnosticLog } from '../src/webhook-diagnostic-log';
import { ContactSyncProcessor } from '../src/contact-sync.service';
import { PAIR_RESOLVER, PairResolutionInput, PairResolutionResult } from '../src/pairs/pair-resolver';
import { PairFirstEventProcessor } from '../src/pairs/pair-first-event.processor';

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
const disabledDirections = new Set<string>();
const resolvedPairInputs: PairResolutionInput[] = [];
let pairResolution: PairResolutionResult = { status: 'manual_review', reason: 'NO_APPROVED_MATCH_KEY', entityType: 'DEAL', sourceSystem: 'BITRIX24', sourceEntityId: 'fixture', reviewCaseId: 'review-test' };
const inboundEvent = {
  findUnique: async ({ where }: { where: { id: string } }) => [...rows.values()].find((row) => row.id === where.id) ?? null,
  updateMany: async ({ where, data }: { where: { id: string; status?: string; OR?: Array<{ status: string }> }; data: Record<string, unknown> }) => {
    const statuses = where.status ? [where.status] : where.OR?.map((condition) => condition.status) ?? [];
    const row = [...rows.values()].find((candidate) => candidate.id === where.id && statuses.includes(candidate.status));
    if (!row) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  },
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

const fakeDatabase: {
  inboundEvent: typeof inboundEvent;
  entityPair: { findFirst: () => Promise<null> };
  $queryRaw: (strings?: TemplateStringsArray) => Promise<Array<{ serviceMode: string }>>;
  $transaction: <T>(operation: (transaction: unknown) => Promise<T>) => Promise<T>;
  syncSetting: { upsert: () => Promise<{ serviceMode: string }> };
  syncDirectionSetting: { findUnique: (args: { where: { entityKey: string } }) => Promise<{ bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean }> };
} = {
  inboundEvent,
  entityPair: { findFirst: async () => null },
  $queryRaw: async (strings?: TemplateStringsArray) => strings?.join('').includes('FROM "SyncSetting"')
    ? [{ serviceMode: intakeMode }]
    : [],
  $transaction: async <T>(operation: (transaction: unknown) => Promise<T>) => operation(fakeDatabase as unknown),
  syncSetting: { upsert: async () => ({ serviceMode: intakeMode }) },
  syncDirectionSetting: { findUnique: async ({ where }) => ({
    bitrix24ToMoysklad: !disabledDirections.has(`${where.entityKey}:bitrix24ToMoysklad`),
    moyskladToBitrix24: !disabledDirections.has(`${where.entityKey}:moyskladToBitrix24`),
  }) },
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
    { provide: PAIR_RESOLVER, useValue: { resolve: async (input: PairResolutionInput): Promise<PairResolutionResult> => {
      resolvedPairInputs.push(input);
      return pairResolution.status === 'manual_review'
        ? { ...pairResolution, entityType: input.entityType, sourceSystem: input.sourceSystem, sourceEntityId: input.externalId }
        : pairResolution;
    } } },
    PairFirstEventProcessor,
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

test('Bitrix24 event is stored before acknowledgement and identical deliveries are preserved without a stable event ID', async () => {
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
  assert.notEqual(repeatedAck.eventId, firstAck.eventId);
  assert.equal(rows.size, 2, 'a later identical envelope must not be collapsed as a false duplicate');
  assert.equal(upsertCalls, 2, 'both deliveries are durably accepted');
});

test('Bitrix24 and MoySklad acknowledge durable intake without waiting for worker completion', async () => {
  const persisted: string[] = [];
  const dispatched: string[] = [];
  const dispatchStarted = new Map<string, () => void>();
  const dispatchStartedPromises = new Map<string, Promise<void>>();
  const workerReleasePromises = new Map<string, Promise<void>>();
  const workerReleases = new Map<string, () => void>();

  for (const eventId of ['quick-ack-bitrix', 'quick-ack-moysklad']) {
    dispatchStartedPromises.set(eventId, new Promise<void>((resolve) => dispatchStarted.set(eventId, resolve)));
    workerReleasePromises.set(eventId, new Promise<void>((resolve) => workerReleases.set(eventId, resolve)));
  }

  const intake = {
    receiveBitrix24: async () => {
      persisted.push('quick-ack-bitrix');
      return { accepted: true, eventId: 'quick-ack-bitrix' };
    },
    receiveMoySklad: async () => {
      persisted.push('quick-ack-moysklad');
      return {
        accepted: true,
        eventId: 'quick-ack-moysklad',
        eventIds: ['quick-ack-moysklad'],
        contactEventIds: [],
        pairEventIds: [],
      };
    },
  };
  const dispatcher = {
    dispatch: async (eventId: string) => {
      dispatched.push(eventId);
      dispatchStarted.get(eventId)?.();
      await workerReleasePromises.get(eventId);
    },
  };

  @Module({
    controllers: [EventsController],
    providers: [
      { provide: EventIntakeService, useValue: intake },
      { provide: EventDispatcherService, useValue: dispatcher },
    ],
  })
  class DeferredWorkerModule {}

  const deferredWorkerApp = await NestFactory.create(DeferredWorkerModule, { logger: false });
  try {
    await deferredWorkerApp.listen(0, '127.0.0.1');
    const deferredApiUrl = await deferredWorkerApp.getUrl();

    const bitrixResponse = await fetch(`${deferredApiUrl}/webhooks/bitrix24`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'ONCRMDEALUPDATE' }),
    });
    assert.equal(bitrixResponse.status, 200);
    assert.deepEqual(await bitrixResponse.json(), { accepted: true, eventId: 'quick-ack-bitrix' });
    await dispatchStartedPromises.get('quick-ack-bitrix');
    assert.deepEqual(persisted, ['quick-ack-bitrix']);
    assert.deepEqual(dispatched, ['quick-ack-bitrix']);

    const moyskladResponse = await fetch(`${deferredApiUrl}/webhooks/moysklad/test-secret?requestId=quick-ack`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [{ action: 'UPDATE' }] }),
    });
    assert.equal(moyskladResponse.status, 200);
    assert.deepEqual(await moyskladResponse.json(), { accepted: true, eventId: 'quick-ack-moysklad' });
    await dispatchStartedPromises.get('quick-ack-moysklad');
    assert.deepEqual(persisted, ['quick-ack-bitrix', 'quick-ack-moysklad']);
    assert.deepEqual(dispatched, ['quick-ack-bitrix', 'quick-ack-moysklad']);
  } finally {
    for (const release of workerReleases.values()) release();
    await deferredWorkerApp.close();
  }
});

test('unverified sources and credentials from the other provider are rejected without a database write', async () => {
  rows.clear();
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMDEALUPDATE', auth: { application_token: 'wrong-token' } }),
  });
  assert.equal(response.status, 401);

  const moyskladSecretAtBitrixEndpoint = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMDEALUPDATE', auth: { application_token: 'moysklad-test-path-secret' } }),
  });
  assert.equal(moyskladSecretAtBitrixEndpoint.status, 401);

  const bitrixTokenAtMoyskladEndpoint = await fetch(`${apiUrl}/webhooks/moysklad/bitrix-test-application-token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(bitrixTokenAtMoyskladEndpoint.status, 401);

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

test('MoySklad webhook uses the secret URL and fingerprints event payloads for idempotent persistence', async () => {
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

  const laterUpdate = await fetch(url.replace('id=entity-456', 'id=entity-789'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(laterUpdate.status, 200);
  const laterUpdateAck = (await laterUpdate.json()) as { eventId: string };
  assert.notEqual(laterUpdateAck.eventId, firstAck.eventId);
  assert.equal(rows.size, 2, 'a different entity is a distinct queued event');

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

test('native MoySklad event envelope without requestId preserves identical notifications', async () => {
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
  assert.notEqual(repeatedAck.eventId, firstAck.eventId, 'without a provider delivery ID, preserving events is safer than false deduplication');
  assert.equal(rows.size, 2);
});

test('MoySklad event fingerprint distinguishes changed payloads even when requestId and batch index are reused', async () => {
  rows.clear();
  const url = `${apiUrl}/webhooks/moysklad/moysklad-test-path-secret?requestId=reused-request`;
  const post = (description: string) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{
      meta: { type: 'product', href: 'https://online.moysklad.ru/api/remap/1.2/entity/product/native-id' },
      action: 'UPDATE', description,
    }] }),
  });

  const first = await post('first version');
  const firstAck = await first.json() as { eventId: string };
  const changed = await post('second version');
  const changedAck = await changed.json() as { eventId: string };
  const repeated = await post('second version');
  const repeatedAck = await repeated.json() as { eventId: string };

  assert.equal(first.status, 200);
  assert.equal(changed.status, 200);
  assert.equal(repeated.status, 200);
  assert.notEqual(changedAck.eventId, firstAck.eventId);
  assert.equal(repeatedAck.eventId, changedAck.eventId);
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

test('MoySklad requestId plus batch position deduplicates retries while distinct request IDs remain separate', async () => {
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
  const repeatedSingle = await send('another-id', [event('first')]);
  const repeatedSingleAck = await repeatedSingle.json() as { eventId: string };
  const independent = await send('foo%3A1', [event('independent')]);
  const independentAck = await independent.json() as { eventId: string };

  assert.equal(batch.status, 200);
  assert.equal(repeatedSingle.status, 200);
  assert.equal(independent.status, 200);
  assert.equal(rows.size, 4);
  assert.notEqual(repeatedSingleAck.eventId, batchAck.eventIds[0]);
  assert.notEqual(independentAck.eventId, batchAck.eventIds[1]);
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
  resolvedPairInputs.length = 0;
  pairResolution = { status: 'manual_review', reason: 'NO_APPROVED_MATCH_KEY', entityType: 'DEAL', sourceSystem: 'BITRIX24', sourceEntityId: 'fixture', reviewCaseId: 'review-test' };
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
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok([...rows.values()].every((row) => row.status === 'MANUAL_REVIEW'));
  assert.equal(resolvedPairInputs.length, 6);
  assert.ok(resolvedPairInputs.every((input) => input.entityType === 'DEAL'));
  assert.deepEqual(resolvedPairInputs.map((input) => input.sourceSystem).sort(), ['BITRIX24', 'BITRIX24', 'BITRIX24', 'MOYSKLAD', 'MOYSKLAD', 'MOYSKLAD']);
  assert.ok([...rows.values()].every((row) => !JSON.stringify(row.payload).includes('bitrix-test-application-token')));
  assert.deepEqual(queuedContactEventIds, []);
  process.env.SYNC_MODE = 'apply';
});

test('intake routes invoice events and terminally skips disabled entity directions', async () => {
  rows.clear();
  disabledDirections.clear();

  const accepted = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMDYNAMICITEMADD',
      data: { FIELDS: { ID: 'invoice-8101', ENTITY_TYPE_ID: 31 } },
      auth: { application_token: 'bitrix-test-application-token' },
    }),
  });
  assert.equal(accepted.status, 200);
  const { eventId: acceptedEventId } = await accepted.json() as { eventId: string };
  const acceptedEvent = [...rows.values()].find((row) => row.id === acceptedEventId)!;
  assert.equal(acceptedEvent.externalEntityType, 'invoice');
  assert.equal(acceptedEvent.externalEntityId, 'invoice-8101');
  assert.equal((acceptedEvent.payload as Record<string, unknown>).auth, undefined);

  const deletedInvoice = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMDYNAMICITEMDELETE', data: { FIELDS: { ID: 'invoice-8103', ENTITY_TYPE_ID: '31' } },
      auth: { application_token: 'bitrix-test-application-token' },
    }),
  });
  assert.equal(deletedInvoice.status, 200);
  const { eventId: deletedInvoiceEventId } = await deletedInvoice.json() as { eventId: string };
  assert.equal([...rows.values()].find((row) => row.id === deletedInvoiceEventId)?.externalEntityType, 'invoice');

  const nonInvoice = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMDYNAMICITEMUPDATE', data: { FIELDS: { ID: 'dynamic-5', ENTITY_TYPE_ID: 5 } },
      auth: { application_token: 'bitrix-test-application-token' },
    }),
  });
  assert.equal(nonInvoice.status, 200);
  const { eventId: nonInvoiceEventId } = await nonInvoice.json() as { eventId: string };
  assert.equal([...rows.values()].find((row) => row.id === nonInvoiceEventId)?.externalEntityType, null);

  disabledDirections.add('invoices:bitrix24ToMoysklad');
  const disabledBitrix = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMDYNAMICITEMUPDATE', data: { FIELDS: { ID: 'invoice-8102', ENTITY_TYPE_ID: 31 } },
      auth: { application_token: 'bitrix-test-application-token' },
    }),
  });
  assert.equal(disabledBitrix.status, 200);
  const { eventId: disabledBitrixEventId } = await disabledBitrix.json() as { eventId: string };
  const skippedBitrix = [...rows.values()].find((row) => row.id === disabledBitrixEventId)!;
  assert.equal(skippedBitrix.status, 'SKIPPED_DIRECTION_DISABLED');
  assert.equal(skippedBitrix.lastErrorCategory, 'DIRECTION_DISABLED');

  const moyskladInvoiceBatch = await fetch(`${apiUrl}/webhooks/moysklad/moysklad-test-path-secret?requestId=invoiceout-actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: ['CREATE', 'UPDATE', 'DELETE'].map((action, index) => ({
      meta: { type: 'invoiceout', href: `https://online.moysklad.ru/api/remap/1.2/entity/invoiceout/${index + 1}` },
      action,
    })) }),
  });
  assert.equal(moyskladInvoiceBatch.status, 200);
  const { eventIds: moyskladInvoiceEventIds } = await moyskladInvoiceBatch.json() as { eventIds: string[] };
  assert.deepEqual(moyskladInvoiceEventIds.map((id) => {
    const event = [...rows.values()].find((row) => row.id === id)!;
    return [event.eventType, event.externalEntityType];
  }), [['CREATE', 'invoiceout'], ['UPDATE', 'invoiceout'], ['DELETE', 'invoiceout']]);

  disabledDirections.add('invoices:moyskladToBitrix24');
  const disabledMoysklad = await fetch(`${apiUrl}/webhooks/moysklad/moysklad-test-path-secret?requestId=invoice-out-disabled`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{
      meta: { type: 'invoiceout', href: 'https://online.moysklad.ru/api/remap/1.2/entity/invoiceout/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      action: 'UPDATE',
    }] }),
  });
  assert.equal(disabledMoysklad.status, 200);
  const { eventId: disabledMoyskladEventId } = await disabledMoysklad.json() as { eventId: string };
  const skippedMoysklad = [...rows.values()].find((row) => row.id === disabledMoyskladEventId)!;
  assert.equal(skippedMoysklad.externalEntityType, 'invoiceout');
  assert.equal(skippedMoysklad.status, 'SKIPPED_DIRECTION_DISABLED');
  assert.equal(skippedMoysklad.lastErrorCategory, 'DIRECTION_DISABLED');

  disabledDirections.add('deals-orders:moyskladToBitrix24');
  const disabledOrder = await fetch(`${apiUrl}/webhooks/moysklad/moysklad-test-path-secret?requestId=disabled-order-direction`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{
      meta: { type: 'customerorder', href: 'https://online.moysklad.ru/api/remap/1.2/entity/customerorder/order-991' },
      action: 'CREATE',
    }] }),
  });
  assert.equal(disabledOrder.status, 200);
  const { eventId: disabledOrderEventId } = await disabledOrder.json() as { eventId: string };
  assert.equal([...rows.values()].find((row) => row.id === disabledOrderEventId)?.status, 'SKIPPED_DIRECTION_DISABLED');

  disabledDirections.add('contacts-companies:moyskladToBitrix24');
  const disabledClientDelete = await fetch(`${apiUrl}/webhooks/moysklad/moysklad-test-path-secret?requestId=disabled-client-delete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{
      meta: { type: 'counterparty', href: 'https://online.moysklad.ru/api/remap/1.2/entity/counterparty/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
      action: 'DELETE',
    }] }),
  });
  assert.equal(disabledClientDelete.status, 200);
  const { eventId: disabledClientDeleteEventId } = await disabledClientDelete.json() as { eventId: string };
  assert.equal([...rows.values()].find((row) => row.id === disabledClientDeleteEventId)?.status, 'SKIPPED_DIRECTION_DISABLED');

  const unsupportedBitrixProduct = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'CATALOG.PRODUCT.ON.UPDATE', data: { FIELDS: { ID: 900 } },
      auth: { application_token: 'bitrix-test-application-token' },
    }),
  });
  assert.equal(unsupportedBitrixProduct.status, 200);
  const { eventId: unsupportedProductEventId } = await unsupportedBitrixProduct.json() as { eventId: string };
  const skippedProduct = [...rows.values()].find((row) => row.id === unsupportedProductEventId)!;
  assert.equal(skippedProduct.externalEntityType, 'product');
  assert.equal(skippedProduct.status, 'SKIPPED_DIRECTION_DISABLED');
  assert.equal(skippedProduct.lastErrorCategory, 'DIRECTION_DISABLED');

  disabledDirections.clear();
});

test('first-event intake recognizes persisted confirmed identity without conflating baseline readiness', async () => {
  rows.clear();
  resolvedPairInputs.length = 0;
  pairResolution = { status: 'confirmed', pair: { id: 'pair-fixture', entityType: 'DEAL', bitrix24Id: 'deal-confirmed', moyskladId: 'order-confirmed', status: 'MANUAL', source: 'PERSISTED' } };
  process.env.SYNC_MODE = 'dry';
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ event: 'ONCRMDEALADD', 'auth[application_token]': 'bitrix-test-application-token', 'data[FIELDS][ID]': 'deal-confirmed' }),
  });
  assert.equal(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const event = [...rows.values()][0];
  assert.ok(event);
  assert.equal(event.status, 'SUCCEEDED', 'the claim-safe resolver completes the event when no downstream stage is registered');
  assert.equal(event.lastErrorCategory, null);
  assert.equal(resolvedPairInputs.length, 1);
  assert.equal(resolvedPairInputs[0].entityType, 'DEAL');
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

test('the transactional Off recheck closes the mode-change race after preflight', async () => {
  rows.clear();
  upsertCalls = 0;
  intakeMode = 'on';
  const syncMode = app.get(SyncModeService);
  const originalRead = syncMode.read.bind(syncMode);
  syncMode.read = async () => {
    intakeMode = 'off';
    return { mode: 'on' };
  };
  try {
    const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'ONCRMDEALUPDATE', auth: { application_token: 'bitrix-test-application-token' } }),
    });
    assert.equal(response.status, 410);
    assert.equal(upsertCalls, 0);
    assert.equal(rows.size, 0);
  } finally {
    syncMode.read = originalRead;
    intakeMode = 'on';
  }
});
