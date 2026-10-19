import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { after, before, test } from 'node:test';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientLifecycleService } from '../src/clients/client-lifecycle.service';
import { DatabaseService } from '../src/database.service';
import { EventDispatcherService } from '../src/event-dispatcher.service';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { InvoiceEventProcessor } from '../src/invoices/invoice-event.processor';

type TestPair = {
  id: string;
  entityType: 'INVOICE';
  bitrix24Id: string;
  moyskladId: string;
  moyskladType: 'invoiceout';
  moyskladParentId: null;
  active: boolean;
  lifecycleStatus: 'ACTIVE' | 'TOMBSTONED';
  tombstoneSource: string | null;
  deletionMarkerStatus: string;
  deletionTimelineStatus: string;
};
type TestEvent = {
  id: string;
  source: 'BITRIX24' | 'MOYSKLAD';
  deliveryKey: string;
  eventType: string;
  externalEntityType: string;
  externalEntityId: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  lastErrorCategory: string | null;
  processingStartedAt: Date | null;
};

const events = new Map<string, TestEvent>();
const pairs = new Map<string, TestPair>();
const leases = new Map<string, { ownerToken: string; leaseExpiresAt: Date }>();
const directionsDisabled = new Set<string>();
const providerReads = new Map<string, 'present' | 'deleted'>();
const providerCalls: Array<{ method: string; path: string; fields: Record<string, string> }> = [];
let eventCounter = 0;
let app: INestApplication;
let providerServer: Server;
let providerBase = '';
let webhookUrl = '';
let previousMode: string | undefined;
let previousToken: string | undefined;
let previousSecret: string | undefined;
let previousBitrixBase: string | undefined;
let previousMoyskladBase: string | undefined;
let previousMoyskladToken: string | undefined;

const inboundEvent = {
  upsert: async ({ create }: { create: Omit<TestEvent, 'id' | 'attempts' | 'processingStartedAt'> }) => {
    const existing = [...events.values()].find((event) => event.source === create.source && event.deliveryKey === create.deliveryKey);
    if (existing) return { id: existing.id };
    const id = `invoice-lifecycle-event-${++eventCounter}`;
    events.set(id, { id, ...create, attempts: 0, processingStartedAt: null });
    return { id };
  },
  findUnique: async ({ where }: { where: { id: string } }) => events.get(where.id) ?? null,
  findMany: async () => [],
  updateMany: async ({ where, data }: { where: { id: string; OR?: Array<{ status: string }> }; data: Record<string, unknown> }) => {
    const event = events.get(where.id);
    const allowedStatuses = where.OR?.map((condition) => condition.status) ?? [];
    if (!event || !allowedStatuses.includes(event.status)) return { count: 0 };
    Object.assign(event, data);
    return { count: 1 };
  },
  update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const event = events.get(where.id);
    assert.ok(event);
    Object.assign(event, data);
    return event;
  },
};

const entityPair = {
  findFirst: async ({ where }: { where: Record<string, unknown> }) => findPair(where),
  findUnique: async ({ where }: { where: { id: string } }) => pairs.get(where.id) ?? null,
  findMany: async () => [],
  update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const pair = pairs.get(where.id);
    assert.ok(pair);
    Object.assign(pair, data);
    return pair;
  },
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const pair = [...pairs.values()].find((candidate) => {
      if (typeof where.id === 'string' && candidate.id !== where.id) return false;
      if (typeof where.lifecycleStatus === 'string' && candidate.lifecycleStatus !== where.lifecycleStatus) return false;
      if (typeof where.tombstoneSource === 'string' && candidate.tombstoneSource !== where.tombstoneSource) return false;
      if (isRecord(where.deletionTimelineStatus) && Array.isArray(where.deletionTimelineStatus.in) && !where.deletionTimelineStatus.in.includes(candidate.deletionTimelineStatus)) return false;
      return true;
    });
    if (!pair) return { count: 0 };
    Object.assign(pair, data);
    return { count: 1 };
  },
};

const inboundEntityLock = {
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { ownerToken: string; leaseExpiresAt: Date } }) => {
    const singleKey = typeof where.entityKey === 'string' ? where.entityKey : null;
    const keys = singleKey ? [singleKey] : Array.isArray((where.entityKey as { in?: unknown[] } | undefined)?.in)
      ? (where.entityKey as { in: string[] }).in : [];
    const ownerToken = typeof where.ownerToken === 'string' ? where.ownerToken : null;
    const matches = keys.filter((key) => {
      const lease = leases.get(key);
      if (!lease || (ownerToken && lease.ownerToken !== ownerToken)) return false;
      if (isRecord(where.leaseExpiresAt) && where.leaseExpiresAt.lte instanceof Date && lease.leaseExpiresAt > where.leaseExpiresAt.lte) return false;
      if (isRecord(where.leaseExpiresAt) && where.leaseExpiresAt.gt instanceof Date && lease.leaseExpiresAt <= where.leaseExpiresAt.gt) return false;
      return true;
    });
    for (const key of matches) leases.set(key, data);
    return { count: matches.length };
  },
  create: async ({ data }: { data: { entityKey: string; ownerToken: string; leaseExpiresAt: Date } }) => {
    if (leases.has(data.entityKey)) throw new Error('duplicate lifecycle lease');
    leases.set(data.entityKey, { ownerToken: data.ownerToken, leaseExpiresAt: data.leaseExpiresAt });
    return data;
  },
  deleteMany: async ({ where }: { where: { entityKey: { in: string[] }; ownerToken: string } }) => {
    let count = 0;
    for (const key of where.entityKey.in) {
      if (leases.get(key)?.ownerToken === where.ownerToken) { leases.delete(key); count += 1; }
    }
    return { count };
  },
};

const tx = {
  $queryRaw: async () => [{ locked: 1 }],
  entityPair,
  operationalLog: { create: async () => ({}) },
  inboundEvent,
};
const database = {
  inboundEvent,
  entityPair,
  inboundEntityLock,
  operationalLog: { create: async () => ({}) },
  syncSetting: { findUnique: async () => ({ clientDeletionMarkerFields: null }) },
  $transaction: async <T>(operation: (transaction: typeof tx) => Promise<T>) => operation(tx),
};
const syncMode = {
  read: async () => ({ mode: 'on' }),
  isDirectionEnabled: async (entity: string, direction: string) => !directionsDisabled.has(`${entity}:${direction}`),
};
const fieldSettings = {
  saveAcceptedEvent: async (input: Omit<TestEvent, 'id' | 'attempts' | 'processingStartedAt'> & { directionDisabled: boolean }) => {
    const id = `invoice-lifecycle-event-${++eventCounter}`;
    events.set(id, {
      id,
      source: input.source,
      deliveryKey: input.deliveryKey,
      eventType: input.eventType,
      externalEntityType: input.externalEntityType,
      externalEntityId: input.externalEntityId,
      payload: input.payload,
      status: input.directionDisabled ? 'SKIPPED_DIRECTION_DISABLED' : 'RECEIVED',
      lastErrorCategory: input.directionDisabled ? 'DIRECTION_DISABLED' : null,
      attempts: 0,
      processingStartedAt: null,
    });
    return { id };
  },
};
const intake = new EventIntakeService(database as never, syncMode as never, undefined, fieldSettings as never);
const invoiceProcessor = new InvoiceEventProcessor({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
const lifecycle = new ClientLifecycleService(database as never, undefined, syncMode as never);
const dispatcher = new EventDispatcherService(
  database as never,
  { enqueue: () => assert.fail('invoice delete events must not route to client sync') } as never,
  { enqueue: () => assert.fail('invoice delete events must not route to deal/order sync') } as never,
  [invoiceProcessor, lifecycle],
);

@Module({
  controllers: [EventsController],
  providers: [
    { provide: EventIntakeService, useValue: intake },
    { provide: EventDispatcherService, useValue: dispatcher },
  ],
})
class InvoiceLifecycleWebhookTestModule {}

before(async () => {
  previousMode = process.env.SYNC_MODE;
  previousToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
  previousSecret = process.env.MOYSKLAD_WEBHOOK_SECRET;
  previousBitrixBase = process.env.BITRIX24_REST_BASE_URL;
  previousMoyskladBase = process.env.MOYSKLAD_API_BASE_URL;
  previousMoyskladToken = process.env.MOYSKLAD_API_TOKEN;
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'invoice-lifecycle-fixture-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'invoice-lifecycle-fixture-secret';
  providerServer = createServer((request, response) => { void respondToProvider(request, response); });
  await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const address = providerServer.address();
  assert.ok(address && typeof address !== 'string');
  providerBase = `http://127.0.0.1:${address.port}/`;
  process.env.BITRIX24_REST_BASE_URL = new URL('rest/', providerBase).href;
  process.env.MOYSKLAD_API_BASE_URL = new URL('api/remap/1.2/', providerBase).href;
  process.env.MOYSKLAD_API_TOKEN = 'fixture-token-only';
  app = await NestFactory.create(InvoiceLifecycleWebhookTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  webhookUrl = await app.getUrl();
});

after(async () => {
  await app.close();
  await new Promise<void>((resolve) => providerServer.close(() => resolve()));
  restoreEnv('SYNC_MODE', previousMode);
  restoreEnv('BITRIX24_EVENT_APPLICATION_TOKEN', previousToken);
  restoreEnv('MOYSKLAD_WEBHOOK_SECRET', previousSecret);
  restoreEnv('BITRIX24_REST_BASE_URL', previousBitrixBase);
  restoreEnv('MOYSKLAD_API_BASE_URL', previousMoyskladBase);
  restoreEnv('MOYSKLAD_API_TOKEN', previousMoyskladToken);
});

test('enabled smart-invoice delete webhooks route through dispatcher and lifecycle current-read validation', async () => {
  const scenarios = [
    { source: 'BITRIX24' as const, nativeId: 'B24-INVOICE-PRESENT', counterpartId: 'MS-INVOICE-PRESENT', state: 'present' as const, expected: 'UNCHANGED' },
    { source: 'BITRIX24' as const, nativeId: 'B24-INVOICE-DELETED', counterpartId: 'MS-FROM-B24-DELETED', state: 'deleted' as const, expected: 'SUCCEEDED' },
    { source: 'MOYSKLAD' as const, nativeId: 'MS-INVOICE-PRESENT', counterpartId: 'B24-INVOICE-PRESENT', state: 'present' as const, expected: 'UNCHANGED' },
    { source: 'MOYSKLAD' as const, nativeId: 'MS-INVOICE-DELETED', counterpartId: 'B24-FROM-MS-DELETED', state: 'deleted' as const, expected: 'SUCCEEDED' },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const bitrix24Id = scenario.source === 'BITRIX24' ? scenario.nativeId : scenario.counterpartId;
    const moyskladId = scenario.source === 'MOYSKLAD' ? scenario.nativeId : scenario.counterpartId;
    const pair = addPair(`invoice-lifecycle-pair-${index}`, bitrix24Id, moyskladId);
    providerReads.set(`${scenario.source}:${scenario.nativeId}`, scenario.state);
    const eventId = await deliverDelete(scenario.source, scenario.nativeId);
    const event = await waitForEvent(eventId, scenario.expected);

    assert.equal(event.externalEntityId, scenario.nativeId, 'the webhook native ID remains the event identity');
    if (scenario.expected === 'UNCHANGED') {
      assert.equal(pair.lifecycleStatus, 'ACTIVE', 'a current provider read prevents tombstoning');
      assert.equal(pair.active, true);
    } else {
      assert.equal(pair.lifecycleStatus, 'TOMBSTONED', 'only a confirmed provider 404 tombstones the pair');
      assert.equal(pair.active, false);
      assert.equal(pair.bitrix24Id, bitrix24Id);
      assert.equal(pair.moyskladId, moyskladId);
    }
  }

  const bitrixReadCalls = providerCalls.filter((call) => call.path === '/rest/crm.item.get.json');
  assert.deepEqual(bitrixReadCalls.map((call) => [call.fields.id, call.fields.entityTypeId]), [
    ['B24-INVOICE-PRESENT', '31'], ['B24-INVOICE-DELETED', '31'],
  ], 'Bitrix24 invoice reads use the exact native ID and entityTypeId 31');
  const moyskladReadCalls = providerCalls.filter((call) => call.path.includes('/entity/invoiceout/'));
  assert.deepEqual(moyskladReadCalls.map((call) => call.path.split('/').at(-1)), ['MS-INVOICE-PRESENT', 'MS-INVOICE-DELETED']);
  assert.equal(providerCalls.some((call) => call.method === 'DELETE' || call.path.includes('.delete.json')), false,
    'delete webhooks validate provider state and never physically delete a partner record');
});

test('disabled invoice delete directions are terminal skips and never reach lifecycle provider reads', async () => {
  const b24Pair = addPair('invoice-lifecycle-disabled-b24', 'B24-INVOICE-DISABLED', 'MS-INVOICE-DISABLED-B24');
  const msPair = addPair('invoice-lifecycle-disabled-ms', 'B24-INVOICE-DISABLED-MS', 'MS-INVOICE-DISABLED');
  const readsBefore = providerCalls.length;
  directionsDisabled.add('invoices:bitrix24ToMoysklad');
  directionsDisabled.add('invoices:moyskladToBitrix24');

  const b24EventId = await deliverDelete('BITRIX24', 'B24-INVOICE-DISABLED');
  const msEventId = await deliverDelete('MOYSKLAD', 'MS-INVOICE-DISABLED');
  const [b24Event, msEvent] = await Promise.all([
    waitForEvent(b24EventId, 'SKIPPED_DIRECTION_DISABLED'),
    waitForEvent(msEventId, 'SKIPPED_DIRECTION_DISABLED'),
  ]);
  await new Promise<void>((resolve) => setTimeout(resolve, 25));

  assert.equal(b24Event.lastErrorCategory, 'DIRECTION_DISABLED');
  assert.equal(msEvent.lastErrorCategory, 'DIRECTION_DISABLED');
  assert.equal(providerCalls.length, readsBefore, 'terminally skipped deletes do not issue current-state reads');
  assert.equal(b24Pair.lifecycleStatus, 'ACTIVE');
  assert.equal(msPair.lifecycleStatus, 'ACTIVE');
});

function addPair(id: string, bitrix24Id: string, moyskladId: string): TestPair {
  const pair: TestPair = {
    id, entityType: 'INVOICE', bitrix24Id, moyskladId, moyskladType: 'invoiceout', moyskladParentId: null,
    active: true, lifecycleStatus: 'ACTIVE', tombstoneSource: null, deletionMarkerStatus: 'NOT_REQUIRED',
    deletionTimelineStatus: 'NOT_REQUIRED',
  };
  pairs.set(id, pair);
  return pair;
}

async function deliverDelete(source: 'BITRIX24' | 'MOYSKLAD', nativeId: string): Promise<string> {
  const response = source === 'BITRIX24'
    ? await fetch(`${webhookUrl}/webhooks/bitrix24`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        event: 'ONCRMDYNAMICITEMDELETE', data: { FIELDS: { ID: nativeId, ENTITY_TYPE_ID: 31 } },
        auth: { application_token: 'invoice-lifecycle-fixture-token' },
      }),
    })
    : await fetch(`${webhookUrl}/webhooks/moysklad/invoice-lifecycle-fixture-secret?requestId=${encodeURIComponent(nativeId)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [{
        action: 'DELETE', meta: { type: 'invoiceout', href: `https://fake.invalid/api/remap/1.2/entity/invoiceout/${nativeId}` },
      }] }),
    });
  assert.equal(response.status, 200);
  const acknowledgement = await response.json() as { eventId: string };
  return acknowledgement.eventId;
}

async function waitForEvent(eventId: string, status: string): Promise<TestEvent> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const event = events.get(eventId);
    if (event?.status === status) return event;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`event ${eventId} did not reach ${status}; current=${events.get(eventId)?.status}; providerCalls=${JSON.stringify(providerCalls)}`);
}

async function respondToProvider(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks).toString('utf8');
  const fields = Object.fromEntries(new URLSearchParams(rawBody).entries());
  const path = new URL(request.url ?? '/', providerBase).pathname;
  providerCalls.push({ method: request.method ?? 'GET', path, fields });
  if (request.method === 'POST' && path === '/rest/crm.item.get.json') {
    const state = providerReads.get(`BITRIX24:${fields.id}`);
    if (state === 'deleted') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'NOT_FOUND', error_description: 'Not found' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result: { item: { ID: fields.id } } }));
    return;
  }
  if (request.method === 'POST' && path === '/rest/crm.timeline.comment.list.json') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result: [] }));
    return;
  }
  if (request.method === 'POST' && path === '/rest/crm.timeline.comment.add.json') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result: 1 }));
    return;
  }
  const invoiceMatch = /^\/api\/remap\/1\.2\/entity\/invoiceout\/([^/]+)$/.exec(path);
  if (request.method === 'GET' && invoiceMatch) {
    const id = decodeURIComponent(invoiceMatch[1]);
    if (providerReads.get(`MOYSKLAD:${id}`) === 'deleted') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'UNEXPECTED_FIXTURE_REQUEST' }));
}

function findPair(where: Record<string, unknown>): TestPair | null {
  return [...pairs.values()].find((pair) => pair.entityType === where.entityType &&
    (where.bitrix24Id === undefined || pair.bitrix24Id === where.bitrix24Id) &&
    (where.moyskladId === undefined || pair.moyskladId === where.moyskladId)) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
