import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LocalAdminPreviewModule } from '../src/admin/local-preview.module';
import { DatabaseService } from '../src/database.service';
import { EventIntakeService } from '../src/events.controller';
import { RetentionService } from '../src/retention.service';

const nativeFetch = globalThis.fetch;
const eventRows = new Map<string, Record<string, unknown>>();
const incidentRows = new Map<string, Record<string, unknown>>();
const attemptRows = new Map<string, Record<string, unknown>>();
const logRows = new Map<string, Record<string, unknown>>();
let id = 0;
let app: INestApplication;
let apiUrl: string;
const now = new Date('2026-10-05T12:00:00.000Z');

const database = {
  syncSetting: { upsert: async () => ({ serviceMode: 'off' }), findUnique: async () => ({ serviceMode: 'off' }) },
  syncDirectionSetting: { findUnique: async () => ({ bitrix24ToMoysklad: true, moyskladToBitrix24: true }) },
  inboundEvent: {
    findMany: async ({ where = {}, orderBy, take = 50 }: { where?: Record<string, unknown>; orderBy?: Record<string, unknown>; take?: number }) => {
      const filter = where.status;
      const status = typeof filter === 'string' ? filter : (filter as { equals?: string } | undefined)?.equals;
      return [...eventRows.values()]
        .filter((row) => !status || row.status === status)
        .sort((a, b) => (b.receivedAt as Date).getTime() - (a.receivedAt as Date).getTime())
        .slice(0, take);
    },
    groupBy: async () => {
      const counts = new Map<string, number>();
      for (const row of eventRows.values()) counts.set(String(row.status), (counts.get(String(row.status)) ?? 0) + 1);
      return [...counts].map(([status, count]) => ({ status, _count: { _all: count } }));
    },
    deleteMany: async ({ where }: { where: { receivedAt: { lt: Date } } }) => {
      let count = 0;
      for (const [key, row] of eventRows) if ((row.receivedAt as Date) < where.receivedAt.lt) { eventRows.delete(key); count++; }
      return { count };
    },
    upsert: async ({ where, create }: { where: { source_deliveryKey: { source: string; deliveryKey: string } }; create: Record<string, unknown> }) => {
      const existing = [...eventRows.values()].find((row) => row.source === where.source_deliveryKey.source && row.deliveryKey === where.source_deliveryKey.deliveryKey);
      if (existing) return existing;
      const row = { id: `event-${++id}`, status: 'MANUAL_REVIEW', attempts: 1, receivedAt: now, ...create };
      eventRows.set(row.id, row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => eventRows.get(where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = eventRows.get(where.id);
      if (!row) throw new Error('event fixture not found');
      Object.assign(row, data);
      return row;
    },
  },
  manualReviewCase: {
    findUnique: async ({ where }: { where: { id: string } }) => [...incidentRows.values()].find((row) => row.id === where.id) ?? null,
    findMany: async ({ where = {}, take = 50 }: { where?: Record<string, unknown>; take?: number }) => {
      const filter = where.status;
      const status = typeof filter === 'string' ? filter : (filter as { equals?: string } | undefined)?.equals;
      return [...incidentRows.values()].filter((row) => !status || row.status === status).slice(0, take);
    },
    upsert: async ({ where, create, update }: { where: { eventId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const existing = [...incidentRows.values()].find((row) => row.eventId === where.eventId);
      if (existing) return Object.assign(existing, update);
      const row = { id: `incident-${++id}`, status: 'OPEN', openedAt: now, ...create };
      incidentRows.set(row.id, row);
      return row;
    },
    updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
      const row = incidentRows.get(where.id);
      if (!row || row.status !== where.status) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  },
  apiAttempt: {
    findMany: async ({ take = 50 }: { take?: number }) => [...attemptRows.values()].slice(0, take),
    deleteMany: async ({ where }: { where: { occurredAt: { lt: Date } } }) => {
      let count = 0;
      for (const [key, row] of attemptRows) if ((row.occurredAt as Date) < where.occurredAt.lt) { attemptRows.delete(key); count++; }
      return { count };
    },
  },
  operationalLog: {
    findMany: async ({ where = {}, take = 50 }: { where?: Record<string, unknown>; take?: number }) => {
      const filter = where.category;
      const category = typeof filter === 'string' ? filter : (filter as { equals?: string } | undefined)?.equals;
      return [...logRows.values()].filter((row) => !category || row.category === category).slice(0, take);
    },
    deleteMany: async ({ where }: { where: { occurredAt: { lt: Date }; category?: { in: string[] } } }) => {
      let count = 0;
      for (const [key, row] of logRows) {
        if ((row.occurredAt as Date) < where.occurredAt.lt && (!where.category || where.category.in.includes(String(row.category)))) { logRows.delete(key); count++; }
      }
      return { count };
    },
  },
};

before(async () => {
  process.env.ADMIN_PREVIEW = '1';
  process.env.SYNC_MODE = 'apply';
  app = await NestFactory.create(LocalAdminPreviewModule.register({ provide: DatabaseService, useValue: database }), { logger: false });
  app.get(EventIntakeService);
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
});

after(async () => {
  globalThis.fetch = nativeFetch;
  await app?.close();
  delete process.env.ADMIN_PREVIEW;
  delete process.env.SYNC_MODE;
});

test('administrator can inspect queue states, durable incidents, and separated operational log categories', async () => {
  eventRows.set('event-live', { id: 'event-live', source: 'BITRIX24', eventType: 'ONCRMCONTACTUPDATE', externalEntityId: '42', status: 'RETRYABLE_FAILURE', attempts: 2, receivedAt: now });
  incidentRows.set('incident-live', { id: 'incident-live', eventId: 'event-expired', source: 'BITRIX24', reason: 'REVIEW_REQUIRED', status: 'OPEN', openedAt: now });
  attemptRows.set('attempt-live', { id: 'attempt-live', provider: 'BITRIX24', operation: 'crm.contact.get', method: 'POST', succeeded: false, occurredAt: now });
  logRows.set('log-event', { id: 'log-event', category: 'EVENT', message: 'Inbound event accepted', occurredAt: now });
  logRows.set('log-admin', { id: 'log-admin', category: 'ADMIN', message: 'Service mode changed', occurredAt: now });

  const queue = await (await nativeFetch(`${apiUrl}/api/admin/monitoring/queue`)).json() as { counts: Record<string, number>; events: Array<{ status: string }> };
  assert.equal(queue.counts.RETRYABLE_FAILURE, 1);
  assert.equal(queue.events[0].status, 'RETRYABLE_FAILURE');

  const incidents = await (await nativeFetch(`${apiUrl}/api/admin/monitoring/incidents`)).json() as { cases: Array<{ status: string; eventId: string }> };
  assert.deepEqual(incidents.cases.map(({ status, eventId }) => [status, eventId]), [['OPEN', 'event-expired']]);

  const eventLogs = await (await nativeFetch(`${apiUrl}/api/admin/monitoring/logs?category=EVENT`)).json() as { entries: Array<{ category: string }> };
  assert.deepEqual(eventLogs.entries.map(({ category }) => category), ['EVENT']);
  const attempts = await (await nativeFetch(`${apiUrl}/api/admin/monitoring/api-attempts`)).json() as { attempts: Array<{ operation: string }> };
  assert.deepEqual(attempts.attempts.map(({ operation }) => operation), ['crm.contact.get']);
});

test('administrator can queue an open manual-review event for retry', async () => {
  eventRows.set('event-retry', { id: 'event-retry', status: 'MANUAL_REVIEW', receivedAt: now });
  incidentRows.set('incident-retry', { id: 'incident-retry', eventId: 'event-retry', reason: 'REVIEW_REQUIRED', status: 'OPEN', openedAt: now });
  const response = await nativeFetch(`${apiUrl}/api/admin/monitoring/incidents/incident-retry/retry`, { method: 'POST' });
  assert.equal(response.status, 201, await response.text());
  assert.equal(eventRows.get('event-retry')?.status, 'RECEIVED');
  const resolved = await nativeFetch(`${apiUrl}/api/admin/monitoring/incidents/incident-retry/resolve`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(resolved.status, 200, await resolved.text());
  assert.equal(incidentRows.get('incident-retry')?.status, 'RESOLVED');
});

test('expired short-lived events and API history are deleted while their unresolved manual-review incident remains available', async () => {
  const old = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1_000);
  eventRows.set('event-expired', { id: 'event-expired', source: 'BITRIX24', eventType: 'ONCRMCONTACTUPDATE', externalEntityId: '42', status: 'MANUAL_REVIEW', receivedAt: old });
  incidentRows.set('incident-expired', { id: 'incident-expired', eventId: 'event-expired', source: 'BITRIX24', reason: 'REVIEW_REQUIRED', status: 'OPEN', openedAt: old });
  attemptRows.set('attempt-expired', { id: 'attempt-expired', occurredAt: old });
  logRows.set('log-event-expired', { id: 'log-event-expired', category: 'EVENT', occurredAt: old });
  logRows.set('log-scheduled-expired', { id: 'log-scheduled-expired', category: 'SCHEDULED', occurredAt: old });
  logRows.set('log-error-retained', { id: 'log-error-retained', category: 'ERROR', occurredAt: old });
  logRows.set('log-admin-retained', { id: 'log-admin-retained', category: 'ADMIN', occurredAt: old });

  const retention = new RetentionService(database as unknown as DatabaseService);
  const result = await retention.cleanupExpired(now);
  assert.equal(result.eventsDeleted, 1);
  assert.equal(result.apiAttemptsDeleted, 1);
  assert.equal(eventRows.has('event-expired'), false);
  assert.equal(attemptRows.has('attempt-expired'), false);
  assert.equal(logRows.has('log-event-expired'), false);
  assert.equal(logRows.has('log-scheduled-expired'), false);
  assert.equal(logRows.has('log-error-retained'), true, 'unresolved error-log retention remains configurable');
  assert.equal(logRows.has('log-admin-retained'), true, 'admin-log retention remains configurable');
  const response = await nativeFetch(`${apiUrl}/api/admin/monitoring/incidents`);
  const remaining = await response.json() as { cases: Array<{ eventId: string; status: string }> };
  assert.ok(remaining.cases.some(({ eventId, status }) => eventId === 'event-expired' && status === 'OPEN'));
  const retry = await nativeFetch(`${apiUrl}/api/admin/monitoring/incidents/incident-expired/retry`, { method: 'POST' });
  assert.equal(retry.status, 409, 'expired event history remains visible but cannot be retried');
});

test('dry history expires after seven days while an unresolved incident remains durable', async () => {
  process.env.SYNC_MODE = 'dry';
  const old = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1_000);
  eventRows.set('dry-expired', { id: 'dry-expired', status: 'SUCCEEDED', receivedAt: old });
  incidentRows.set('dry-incident', { id: 'dry-incident', eventId: 'dry-expired', reason: 'REVIEW_REQUIRED', status: 'OPEN', openedAt: old });
  logRows.set('dry-log-expired', { id: 'dry-log-expired', category: 'ADMIN', occurredAt: old });
  const retention = new RetentionService(database as unknown as DatabaseService);
  await retention.cleanupExpired(now);
  assert.equal(eventRows.has('dry-expired'), false);
  assert.equal(incidentRows.has('dry-incident'), true);
  assert.equal(logRows.has('dry-log-expired'), false, 'dry data is removed after seven days in its isolated database');
  process.env.SYNC_MODE = 'apply';
});
