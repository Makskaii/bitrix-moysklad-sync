import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, test } from 'node:test';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AdminAccessGuard } from '../src/admin/admin-access.guard';
import { AdminController } from '../src/admin/admin.controller';
import { ContactSyncStatusController } from '../src/admin/contact-sync-status.controller';
import { ContactSyncProcessor, ContactSyncStatusReader } from '../src/contact-sync.service';
import { DatabaseService } from '../src/database.service';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { SyncModeService } from '../src/sync-mode.service';

type HttpState = { email: string; updatedAt: string };
type StoredEvent = {
  id: string;
  source: string;
  deliveryKey: string;
  eventType: string | null;
  externalEntityId: string | null;
  externalEntityType: string | null;
  payload: unknown;
  status: string;
  attempts: number;
  processingStartedAt: Date | null;
  direction: string | null;
  snapshotRevision: number;
  lastSuccessfulAt: Date | null;
  lastErrorCategory: string | null;
};

const events = new Map<string, StoredEvent>();
const entityLocks = new Map<string, string>();
const manualReviewCases = new Map<string, Record<string, unknown>>();
type SnapshotFixture = {
  pairId: string;
  bitrix24Email: string;
  moyskladEmail: string;
  bitrix24UpdatedAt: Date;
  moyskladUpdatedAt: Date;
  revision: number;
  lastSuccessfulAt: Date;
};
type PairFixture = {
  id: string;
  bitrix24ContactId: string;
  moyskladCounterpartyId: string;
  moyskladType: string;
  active: boolean;
};
const pairs = new Map<string, PairFixture>();
const snapshots = new Map<string, SnapshotFixture>();
const bitrixState: HttpState = { email: 'after@example.test', updatedAt: '2026-10-02T10:00:02Z' };
const moyskladState: HttpState = { email: 'before@example.test', updatedAt: '2026-10-02T09:00:00Z' };
let nextEventId = 0;
let app: INestApplication;
let apiUrl: string;
let bitrixUrl: string;
let moyskladUrl: string;
let bitrixMock: Server;
let moyskladMock: Server;
let originalFetch: typeof fetch;
let externalWrites: string[];
let failNextMoyskladWrite = false;
let bitrixHasMultipleEmails = false;
let moyskladMissingEmail = false;
let serviceMode: 'on' | 'pause' = 'on';

const database = {
  $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(database),
  $queryRaw: async (_query: TemplateStringsArray, ...values: unknown[]) => {
    const ownerToken = entityLocks.get(String(values[0]));
    return ownerToken ? [{ ownerToken, leaseExpiresAt: new Date(Date.now() + 60_000) }] : [];
  },
  syncSetting: { upsert: async () => ({ serviceMode }) },
  syncDirectionSetting: { findUnique: async () => ({ bitrix24ToMoysklad: true, moyskladToBitrix24: true }) },
  inboundEntityLock: {
    updateMany: async () => ({ count: 0 }),
    findUnique: async (args: { where: { entityKey: string } }) => {
      const ownerToken = entityLocks.get(args.where.entityKey);
      return ownerToken ? { ownerToken, leaseExpiresAt: new Date(Date.now() + 60_000) } : null;
    },
    create: async (args: { data: { entityKey: string; ownerToken: string } }) => {
      if ([...entityLocks.keys()].includes(args.data.entityKey)) throw Object.assign(new Error('lock exists'), { code: 'P2002' });
      entityLocks.set(args.data.entityKey, args.data.ownerToken);
      return args.data;
    },
    deleteMany: async (args: { where: { entityKey: string; ownerToken: string } }) => {
      if (entityLocks.get(args.where.entityKey) !== args.where.ownerToken) return { count: 0 };
      entityLocks.delete(args.where.entityKey);
      return { count: 1 };
    },
  },
  manualReviewCase: {
    upsert: async ({ where, create, update }: { where: { eventId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const existing = manualReviewCases.get(where.eventId);
      if (existing) return Object.assign(existing, update);
      const row = { id: `incident-${manualReviewCases.size + 1}`, status: 'OPEN', ...create };
      manualReviewCases.set(where.eventId, row);
      return row;
    },
    updateMany: async ({ where, data }: { where: { eventId: string; status: string }; data: Record<string, unknown> }) => {
      const row = manualReviewCases.get(where.eventId);
      if (!row || row.status !== where.status) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  },
  inboundEvent: {
    upsert: async (args: { where: { source_deliveryKey: { source: string; deliveryKey: string } }; create: Omit<StoredEvent, 'id' | 'status' | 'attempts' | 'processingStartedAt' | 'direction' | 'snapshotRevision' | 'lastSuccessfulAt' | 'lastErrorCategory'> }) => {
      const { source, deliveryKey } = args.where.source_deliveryKey;
      const key = `${source}:${deliveryKey}`;
      let event = [...events.values()].find((row) => `${row.source}:${row.deliveryKey}` === key);
      if (!event) {
        event = {
          ...args.create,
          id: `event-${++nextEventId}`,
          status: 'RECEIVED',
          attempts: 0,
          processingStartedAt: null,
          direction: null,
          snapshotRevision: 1,
          lastSuccessfulAt: null,
          lastErrorCategory: null,
        };
        events.set(event.id, event);
      }
      return { id: event.id };
    },
    findMany: async (args?: { where?: {
      source?: string; externalEntityId?: string;
      eventType?: string | { startsWith?: string };
      externalEntityType?: string;
    } }) => [...events.values()].filter((event) => {
      const where = args?.where;
      if (where?.source && event.source !== where.source) return false;
      if (where?.externalEntityId && event.externalEntityId !== where.externalEntityId) return false;
      if (typeof where?.eventType === 'string' && event.eventType !== where.eventType) return false;
      if (where?.eventType && typeof where.eventType === 'object' &&
          !event.eventType?.startsWith(where.eventType.startsWith ?? '')) return false;
      if (where?.externalEntityType && event.externalEntityType !== where.externalEntityType) return false;
      return (event.source === 'BITRIX24' && event.eventType?.startsWith('ONCRMCONTACT')) ||
        (event.source === 'MOYSKLAD' && event.eventType === 'UPDATE' && event.externalEntityType === 'counterparty');
    }),
    updateMany: async (args: {
      where: { id: string; OR?: Array<Record<string, unknown>>; status?: { in: string[] } };
      data: { status: string; processingStartedAt?: Date | null; attempts?: { increment: number }; lastErrorCategory: null };
    }) => {
      const event = events.get(args.where.id);
      if (!event) return { count: 0 };
      const matchesStatuses = args.where.status?.in.includes(event.status) ?? false;
      const claimable = matchesStatuses || (args.where.OR?.some((clause) => {
        if (typeof clause.status === 'object' && clause.status !== null && 'in' in clause.status) {
          return ((clause.status as { in: string[] }).in).includes(event.status);
        }
        if (typeof clause.status === 'string' && clause.status === event.status) return true;
        if (clause.status !== 'PROCESSING' || event.status !== 'PROCESSING') return false;
        if (clause.processingStartedAt === null) return event.processingStartedAt === null;
        const cutoff = (clause.processingStartedAt as { lt: Date }).lt;
        return event.processingStartedAt !== null && event.processingStartedAt < cutoff;
      }) ?? false);
      if (!claimable) return { count: 0 };
      event.status = args.data.status;
      if (args.data.processingStartedAt !== undefined) event.processingStartedAt = args.data.processingStartedAt;
      if (args.data.attempts) event.attempts += args.data.attempts.increment;
      event.lastErrorCategory = null;
      return { count: 1 };
    },
    findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const event = events.get(args.where.id);
      if (!event || !args.select) return event ?? null;
      return Object.fromEntries(Object.keys(args.select).map((field) => [field, event[field as keyof StoredEvent]]));
    },
    update: async (args: { where: { id: string }; data: Partial<StoredEvent> }) => {
      const event = events.get(args.where.id);
      if (!event) throw new Error('event fixture not found');
      Object.assign(event, args.data);
      return event;
    },
  },
  contactPair: {
    findUnique: async (args: { where: { bitrix24ContactId?: string; moyskladCounterpartyId?: string } }) => {
      const pair = args.where.bitrix24ContactId
        ? pairs.get(args.where.bitrix24ContactId)
        : [...pairs.values()].find((candidate) => candidate.moyskladCounterpartyId === args.where.moyskladCounterpartyId);
      return pair ? { ...pair, snapshot: snapshots.get(pair.id) } : null;
    },
  },
  contactSnapshot: {
    findUnique: async (args: { where: { pairId: string } }) => snapshots.get(args.where.pairId) ?? null,
    update: async (args: { where: { pairId: string }; data: Record<string, unknown> }) => {
      const prior = snapshots.get(args.where.pairId);
      if (!prior) throw new Error('snapshot fixture not found');
      const next = { ...prior, ...args.data };
      snapshots.set(args.where.pairId, next as typeof prior);
      return next;
    },
  },
};

@Module({
  controllers: [EventsController, AdminController, ContactSyncStatusController],
  providers: [
    EventIntakeService,
    ContactSyncProcessor,
    ContactSyncStatusReader,
    AdminAccessGuard,
    { provide: DatabaseService, useValue: database },
    SyncModeService,
  ],
})
class ContactSyncTestModule {}

before(async () => {
  process.env.SYNC_MODE = 'apply';
  process.env.SYNC_STATE = 'on';
  serviceMode = 'on';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-b24-event-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'synthetic-ms-webhook-secret';
  process.env.BITRIX24_REST_BASE_URL = 'pending';
  process.env.MOYSKLAD_API_BASE_URL = 'pending';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-ms-api-token';

  bitrixMock = await startMock((request, response) => {
    if (request.method === 'POST' && request.url === '/rest/crm.contact.get.json') {
      return readForm(request).then((form) => {
        assert.equal(form.get('id'), 'contact-42');
        return json(response, 200, { result: {
          ID: 'contact-42',
          EMAIL: [
            { ID: 'email-field-17', VALUE: bitrixState.email, VALUE_TYPE: 'WORK' },
            ...(bitrixHasMultipleEmails ? [{ ID: 'email-field-18', VALUE: 'second@example.test', VALUE_TYPE: 'HOME' }] : []),
          ],
          DATE_MODIFY: bitrixState.updatedAt,
        } });
      });
    }
    if (request.method === 'POST' && request.url === '/rest/crm.contact.update.json') {
      return readForm(request).then((form) => {
        assert.equal(form.get('id'), 'contact-42');
        if (form.get('fields[EMAIL][0][ID]') !== 'email-field-17') {
          return json(response, 400, { error: 'existing EMAIL multifield ID required' });
        }
        bitrixState.email = String(form.get('fields[EMAIL][0][VALUE]'));
        externalWrites.push('BITRIX24');
        return json(response, 200, { result: true });
      });
    }
    return json(response, 404, {});
  });
  moyskladMock = await startMock((request, response) => {
    if (request.method === 'GET' && request.url === '/api/entity/counterparty/counterparty-uuid') {
      return json(response, 200, { id: 'counterparty-uuid', email: moyskladMissingEmail ? null : moyskladState.email, updated: moyskladState.updatedAt });
    }
    if (request.method === 'PUT' && request.url === '/api/entity/counterparty/counterparty-uuid') {
      return readJson(request).then((body) => {
        if (failNextMoyskladWrite) {
          failNextMoyskladWrite = false;
          return json(response, 503, { error: 'synthetic temporary failure' });
        }
        moyskladState.email = String(body.email);
        moyskladState.updatedAt = '2026-10-02T10:00:03Z';
        externalWrites.push('MOYSKLAD');
        return json(response, 200, { id: 'counterparty-uuid', email: moyskladState.email, updated: moyskladState.updatedAt });
      });
    }
    return json(response, 404, {});
  });
  bitrixUrl = await serverUrl(bitrixMock);
  moyskladUrl = await serverUrl(moyskladMock);
  process.env.BITRIX24_REST_BASE_URL = `${bitrixUrl}/rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${moyskladUrl}/api/`;

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://aerosystems.bitrix24.ru/rest/user.admin.json') {
      const body = init?.body?.toString() ?? '';
      const isAdmin = new URLSearchParams(body).get('auth') === 'synthetic-admin-token';
      return new Response(JSON.stringify({ result: isAdmin }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  };

  app = await NestFactory.create(ContactSyncTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
});

beforeEach(() => {
  events.clear();
  entityLocks.clear();
  manualReviewCases.clear();
  pairs.clear();
  snapshots.clear();
  nextEventId = 0;
  process.env.SYNC_MODE = 'apply';
  process.env.SYNC_STATE = 'on';
  serviceMode = 'on';
  externalWrites = [];
  failNextMoyskladWrite = false;
  bitrixHasMultipleEmails = false;
  moyskladMissingEmail = false;
  pairs.set('contact-42', {
    id: 'pair-1',
    bitrix24ContactId: 'contact-42',
    moyskladCounterpartyId: 'counterparty-uuid',
    moyskladType: 'COUNTERPARTY',
    active: true,
  });
  bitrixState.email = 'after@example.test';
  bitrixState.updatedAt = '2026-10-02T10:00:02Z';
  moyskladState.email = 'before@example.test';
  moyskladState.updatedAt = '2026-10-02T09:00:00Z';
  snapshots.set('pair-1', {
    pairId: 'pair-1',
    bitrix24Email: 'before@example.test',
    moyskladEmail: 'before@example.test',
    bitrix24UpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
    moyskladUpdatedAt: new Date('2026-10-02T09:00:00.000Z'),
    revision: 1,
    lastSuccessfulAt: new Date('2026-10-02T09:00:00.000Z'),
  });
});

after(async () => {
  (app.getHttpServer() as Server).closeAllConnections();
  await app.close();
  globalThis.fetch = originalFetch;
  bitrixMock.closeAllConnections();
  moyskladMock.closeAllConnections();
  await closeServer(bitrixMock);
  await closeServer(moyskladMock);
});

test('Bitrix24 email change reaches its confirmed standalone counterparty through HTTP', async () => {
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: 'contact-42' } },
      auth: { application_token: 'synthetic-b24-event-token' },
    }),
  });
  assert.equal(response.status, 200);
  const ack = (await response.json()) as { accepted: boolean; eventId: string };
  assert.deepEqual(ack, { accepted: true, eventId: 'event-1' }, 'webhook ACK retains the durable intake contract');

  const statusResponse = await waitForStatus(ack.eventId);
  assert.equal(statusResponse.status, 200);
  const result = (await statusResponse.json()) as {
    status: string;
    attempts: number;
    direction: string;
    snapshotRevision: number;
    lastSuccessfulAt: string | null;
    lastErrorCategory: string | null;
  };
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.attempts, 1);
  assert.equal(result.direction, 'BITRIX24_TO_MOYSKLAD');
  assert.equal(result.snapshotRevision, 2);
  assert.ok(result.lastSuccessfulAt && Number.isFinite(Date.parse(result.lastSuccessfulAt)));
  assert.equal(result.lastErrorCategory, null);
  assert.deepEqual(Object.keys(result).sort(), [
    'attempts', 'direction', 'id', 'lastErrorCategory', 'lastSuccessfulAt', 'snapshotRevision', 'status',
  ]);
  assert.equal(JSON.stringify(result).includes('after@example.test'), false, 'status output contains no email or payload');
  assert.equal(moyskladState.email, 'after@example.test');
  assert.deepEqual(externalWrites, ['MOYSKLAD']);
});

test('MoySklad reflection of a successful email write does not start a second write cycle', async () => {
  bitrixState.email = 'after@example.test';
  moyskladState.email = 'after@example.test';
  snapshots.set('pair-1', {
    ...snapshots.get('pair-1')!,
    bitrix24Email: 'after@example.test',
    moyskladEmail: 'after@example.test',
    revision: 2,
  });
  const response = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-ms-webhook-secret?requestId=echo-delivery-1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{
      meta: { href: 'https://example.test/api/remap/1.2/entity/counterparty/counterparty-uuid' },
      action: 'UPDATE',
    }] }),
  });
  assert.equal(response.status, 200);
  const ack = (await response.json()) as { accepted: boolean; eventId: string };
  assert.deepEqual(ack, { accepted: true, eventId: 'event-1' }, 'MoySklad webhook ACK remains unchanged');

  const statusResponse = await waitForStatus(ack.eventId, 'UNCHANGED');
  assert.equal(statusResponse.status, 200);
  const result = await statusResponse.json() as { status: string; snapshotRevision: number; attempts: number };
  assert.equal(result.status, 'UNCHANGED');
  assert.equal(result.snapshotRevision, 2);
  assert.equal(result.attempts, 1);
  assert.equal(bitrixState.email, 'after@example.test');
  assert.equal(moyskladState.email, 'after@example.test');
  assert.deepEqual(externalWrites, []);
});

test('pause accepts the webhook but does not write to either external system', async () => {
  serviceMode = 'pause';
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: 'contact-42' } },
      auth: { application_token: 'synthetic-b24-event-token' },
    }),
  });
  assert.equal(response.status, 200);
  const ack = (await response.json()) as { eventId: string };
  await new Promise((resolve) => setTimeout(resolve, 100));
  const statusResponse = await fetch(`${apiUrl}/api/admin/contact-sync/events/${ack.eventId}`, {
    headers: { authorization: 'Bearer synthetic-admin-token' },
  });
  const status = await statusResponse.json() as { status: string };
  assert.equal(status.status, 'RECEIVED');
  assert.deepEqual(externalWrites, []);
  assert.equal(moyskladState.email, 'before@example.test');
});

test('unrelated accepted Bitrix events remain durable but stay out of contact recovery scans', async () => {
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMLEADUPDATE',
      data: { FIELDS: { ID: 'contact-42' } },
      auth: { application_token: 'synthetic-b24-event-token' },
    }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { eventId: string };
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const statusResponse = await fetch(`${apiUrl}/api/admin/contact-sync/events/${ack.eventId}`, {
    headers: { authorization: 'Bearer synthetic-admin-token' },
  });
  const status = await statusResponse.json() as { status: string; attempts: number };
  assert.equal(status.status, 'RECEIVED');
  assert.equal(status.attempts, 0);
  assert.deepEqual(externalWrites, []);

  const contactResponse = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: 'contact-42' } },
      auth: { application_token: 'synthetic-b24-event-token' },
    }),
  });
  assert.equal(contactResponse.status, 200);
  const contactAck = await contactResponse.json() as { eventId: string };
  const contactStatus = await waitForStatus(contactAck.eventId, 'SUCCEEDED');
  assert.equal(contactStatus.status, 200);
  assert.deepEqual(externalWrites, ['MOYSKLAD']);
  const leadStatus = await fetch(`${apiUrl}/api/admin/contact-sync/events/${ack.eventId}`, {
    headers: { authorization: 'Bearer synthetic-admin-token' },
  }).then((response) => response.json()) as { status: string; attempts: number };
  assert.equal(leadStatus.status, 'RECEIVED');
  assert.equal(leadStatus.attempts, 0);

  const moyskladResponse = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-ms-webhook-secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{
      meta: { type: 'product', href: 'https://online.moysklad.ru/api/remap/1.2/entity/product/product-42' },
      action: 'UPDATE',
    }] }),
  });
  assert.equal(moyskladResponse.status, 200);
  const moyskladAck = await moyskladResponse.json() as { eventId: string };
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const moyskladStatusResponse = await fetch(`${apiUrl}/api/admin/contact-sync/events/${moyskladAck.eventId}`, {
    headers: { authorization: 'Bearer synthetic-admin-token' },
  });
  const moyskladStatus = await moyskladStatusResponse.json() as { status: string; attempts: number };
  assert.equal(moyskladStatus.status, 'RECEIVED');
  assert.equal(moyskladStatus.attempts, 0);
  assert.deepEqual(externalWrites, ['MOYSKLAD']);
});

test('dry mode preserves intake without performing an external write', async () => {
  process.env.SYNC_MODE = 'dry';
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: 'contact-42' } },
      auth: { application_token: 'synthetic-b24-event-token' },
    }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { eventId: string };
  await new Promise((resolve) => setTimeout(resolve, 100));
  const statusResponse = await fetch(`${apiUrl}/api/admin/contact-sync/events/${ack.eventId}`, {
    headers: { authorization: 'Bearer synthetic-admin-token' },
  });
  const status = await statusResponse.json() as { status: string };
  assert.equal(status.status, 'RECEIVED');
  assert.deepEqual(externalWrites, []);
  assert.equal(moyskladState.email, 'before@example.test');
});

test('temporary destination failure keeps the prior snapshot and a repeated webhook retries the same event', async () => {
  failNextMoyskladWrite = true;
  const body = JSON.stringify({
    event: 'ONCRMCONTACTUPDATE',
    data: { FIELDS: { ID: 'contact-42' } },
    auth: { application_token: 'synthetic-b24-event-token' },
  });
  const post = () => fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const first = await post();
  assert.equal(first.status, 200);
  const firstAck = await first.json() as { eventId: string };
  const failedStatus = await waitForStatus(firstAck.eventId, 'RETRYABLE_FAILURE');
  const failed = await failedStatus.json() as { attempts: number; snapshotRevision: number; lastErrorCategory: string | null };
  assert.equal(failed.attempts, 1);
  assert.equal(failed.snapshotRevision, 1);
  assert.equal(failed.lastErrorCategory, 'EXTERNAL_API_FAILURE');
  assert.equal(moyskladState.email, 'before@example.test');
  assert.deepEqual(externalWrites, []);

  const repeated = await post();
  assert.equal(repeated.status, 200);
  const repeatedAck = await repeated.json() as { eventId: string };
  assert.equal(repeatedAck.eventId, firstAck.eventId);
  const succeededStatus = await waitForStatus(firstAck.eventId, 'SUCCEEDED');
  const succeeded = await succeededStatus.json() as { attempts: number; snapshotRevision: number };
  assert.equal(succeeded.attempts, 2);
  assert.equal(succeeded.snapshotRevision, 2);
  assert.equal(moyskladState.email, 'after@example.test');
  assert.deepEqual(externalWrites, ['MOYSKLAD']);
});

test('the background recovery scan retries a failed contact event without another webhook delivery', async () => {
  failNextMoyskladWrite = true;
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: 'contact-42' } },
      auth: { application_token: 'synthetic-b24-event-token' },
    }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { eventId: string };
  const succeededStatus = await waitForStatus(ack.eventId, 'SUCCEEDED');
  const succeeded = await succeededStatus.json() as { attempts: number; snapshotRevision: number };
  assert.equal(succeeded.attempts, 2);
  assert.equal(succeeded.snapshotRevision, 2);
  assert.equal(moyskladState.email, 'after@example.test');
  assert.deepEqual(externalWrites, ['MOYSKLAD']);
});

test('MoySklad email-only change updates the same confirmed Bitrix24 contact', async () => {
  bitrixState.email = 'before@example.test';
  bitrixState.updatedAt = '2026-10-02T09:00:00Z';
  moyskladState.email = 'from-ms@example.test';
  moyskladState.updatedAt = '2026-10-02T10:01:00Z';
  const response = await fetch(`${apiUrl}/webhooks/moysklad/synthetic-ms-webhook-secret?requestId=ms-email-change-1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{
      meta: { href: 'https://example.test/api/remap/1.2/entity/counterparty/counterparty-uuid' },
      action: 'UPDATE',
    }] }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { eventId: string };
  const statusResponse = await waitForStatus(ack.eventId);
  const result = await statusResponse.json() as { status: string; direction: string; snapshotRevision: number };
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.direction, 'MOYSKLAD_TO_BITRIX24');
  assert.equal(result.snapshotRevision, 2);
  assert.equal(bitrixState.email, 'from-ms@example.test');
  assert.equal(moyskladState.email, 'from-ms@example.test');
  assert.deepEqual(externalWrites, ['BITRIX24']);
});

test('when both copies changed, the email with the newest source timestamp wins', async () => {
  bitrixState.email = 'b24-conflict@example.test';
  bitrixState.updatedAt = '2026-10-02T10:00:04Z';
  moyskladState.email = 'ms-conflict@example.test';
  moyskladState.updatedAt = '2026-10-02T10:00:06Z';
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: 'contact-42' } },
      auth: { application_token: 'synthetic-b24-event-token' },
    }),
  });
  const ack = await response.json() as { eventId: string };
  const statusResponse = await waitForStatus(ack.eventId);
  const result = await statusResponse.json() as { status: string; direction: string; snapshotRevision: number };
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.direction, 'MOYSKLAD_TO_BITRIX24');
  assert.equal(result.snapshotRevision, 2);
  assert.equal(bitrixState.email, 'ms-conflict@example.test');
  assert.equal(moyskladState.email, 'ms-conflict@example.test');
  assert.deepEqual(externalWrites, ['BITRIX24']);
});

test('a same-second timestamp conflict is resolved in favor of MoySklad', async () => {
  bitrixState.email = 'b24-same-second@example.test';
  bitrixState.updatedAt = '2026-10-02T10:00:05.900Z';
  moyskladState.email = 'ms-same-second@example.test';
  moyskladState.updatedAt = '2026-10-02T10:00:05.100Z';
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: 'contact-42' } },
      auth: { application_token: 'synthetic-b24-event-token' },
    }),
  });
  const ack = await response.json() as { eventId: string };
  const statusResponse = await waitForStatus(ack.eventId);
  const result = await statusResponse.json() as { status: string; direction: string; snapshotRevision: number };
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.direction, 'MOYSKLAD_TO_BITRIX24');
  assert.equal(result.snapshotRevision, 2);
  assert.equal(bitrixState.email, 'ms-same-second@example.test');
  assert.equal(moyskladState.email, 'ms-same-second@example.test');
  assert.deepEqual(externalWrites, ['BITRIX24']);
});

test('repeated successful delivery keeps the same event and does not write twice', async () => {
  const body = JSON.stringify({
    event: 'ONCRMCONTACTUPDATE',
    data: { FIELDS: { ID: 'contact-42' } },
    auth: { application_token: 'synthetic-b24-event-token' },
  });
  const post = () => fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const first = await post();
  assert.equal(first.status, 200);
  const firstAck = await first.json() as { eventId: string };
  await waitForStatus(firstAck.eventId);

  const repeated = await post();
  assert.equal(repeated.status, 200);
  const repeatedAck = await repeated.json() as { eventId: string };
  assert.equal(repeatedAck.eventId, firstAck.eventId);
  const statusResponse = await fetch(`${apiUrl}/api/admin/contact-sync/events/${firstAck.eventId}`, {
    headers: { authorization: 'Bearer synthetic-admin-token' },
  });
  const result = await statusResponse.json() as { status: string; attempts: number; snapshotRevision: number };
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.attempts, 1);
  assert.equal(result.snapshotRevision, 2);
  assert.equal(moyskladState.email, 'after@example.test');
  assert.deepEqual(externalWrites, ['MOYSKLAD']);
});

test('contact processing status is not readable without administrator authentication', async () => {
  const response = await fetch(`${apiUrl}/api/admin/contact-sync/events/unknown-event`);
  assert.equal(response.status, 403);
});

test('a Bitrix24 contact with multiple email values is not silently reduced to one', async () => {
  bitrixHasMultipleEmails = true;
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: 'contact-42' } },
      auth: { application_token: 'synthetic-b24-event-token' },
    }),
  });
  const ack = await response.json() as { eventId: string };
  const statusResponse = await waitForStatus(ack.eventId, 'MANUAL_REVIEW');
  const result = await statusResponse.json() as { status: string; attempts: number; snapshotRevision: number; lastErrorCategory: string | null };
  assert.equal(result.status, 'MANUAL_REVIEW');
  assert.equal(result.attempts, 1);
  assert.equal(result.snapshotRevision, 1);
  assert.equal(result.lastErrorCategory, 'REVIEW_REQUIRED');
  const reviewCase = manualReviewCases.get(ack.eventId);
  assert.equal(reviewCase?.reason, 'SYNC_EMAIL_MISSING');
  assert.deepEqual(reviewCase?.diagnostic, {
    bitrixEmailPresent: false,
    moyskladEmailPresent: true,
    bitrixEmailFieldCount: 2,
    snapshotRevision: 1,
  });
  assert.deepEqual(externalWrites, []);
  assert.equal(moyskladState.email, 'before@example.test');
});

test('a valid counterparty with no email opens a durable manual-review incident', async () => {
  moyskladMissingEmail = true;
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: 'contact-42' } },
      auth: { application_token: 'synthetic-b24-event-token' },
    }),
  });
  const ack = await response.json() as { eventId: string };
  await waitForStatus(ack.eventId, 'MANUAL_REVIEW');
  const incident = manualReviewCases.get(ack.eventId);
  assert.equal(incident?.reason, 'SYNC_EMAIL_MISSING');
  assert.deepEqual(incident?.diagnostic, {
    bitrixEmailPresent: true,
    moyskladEmailPresent: false,
    bitrixEmailFieldCount: 1,
    snapshotRevision: 1,
  });
});

async function waitForStatus(eventId: string, expectedStatus = 'SUCCEEDED'): Promise<Response> {
  const deadline = Date.now() + 2_000;
  let response: Response | undefined;
  while (Date.now() < deadline) {
    response = await fetch(`${apiUrl}/api/admin/contact-sync/events/${eventId}`, {
      headers: { authorization: 'Bearer synthetic-admin-token' },
    });
    if (response.ok) {
      const body = await response.clone().json() as { status?: string };
      if (body.status === expectedStatus) return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return response ?? new Response(null, { status: 0 });
}

function startMock(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => { void handler(request, response); });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serverUrl(server: Server): Promise<string> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server has no TCP address');
  return Promise.resolve(`http://127.0.0.1:${address.port}`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      try { resolve(JSON.parse(body) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => resolve(new URLSearchParams(body)));
    request.on('error', reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
