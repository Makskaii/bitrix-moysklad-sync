import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LocalAdminPreviewModule } from '../src/admin/local-preview.module';
import { DatabaseService } from '../src/database.service';

const nativeFetch = globalThis.fetch;
const originalEnv = new Map<string, string | undefined>();
let app: INestApplication;
let apiUrl: string;

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to an isolated PostgreSQL test schema');
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') ?? '';
  assert.match(schema, /test|issue23/i, 'refusing to run retention against a schema not named for testing');
  for (const key of ['ADMIN_PREVIEW', 'SYNC_MODE', 'BITRIX24_EVENT_APPLICATION_TOKEN', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN']) originalEnv.set(key, process.env[key]);
  process.env.ADMIN_PREVIEW = '1';
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-monitoring-event-token';
  app = await NestFactory.create(LocalAdminPreviewModule.register(), { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
});

after(async () => {
  if (app) await app.close();
  globalThis.fetch = nativeFetch;
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('a real manual-review incident survives PostgreSQL cleanup of its expired inbound event', async () => {
  const database = app.get(DatabaseService);
  const entityId = `monitoring-${randomUUID()}`;
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { serviceMode: 'on' }, update: { serviceMode: 'on' } });

  const received = await nativeFetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: entityId } },
      auth: { application_token: 'synthetic-monitoring-event-token' },
    }),
  });
  const acknowledgement = await received.text();
  assert.equal(received.status, 200, acknowledgement);
  const { eventId } = JSON.parse(acknowledgement) as { eventId: string };

  let event = await database.inboundEvent.findUnique({ where: { id: eventId } });
  let incident = await database.manualReviewCase.findUnique({ where: { eventId } });
  for (let attempt = 0; attempt < 100 && (event?.status !== 'MANUAL_REVIEW' || incident?.status !== 'OPEN'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    event = await database.inboundEvent.findUnique({ where: { id: eventId } });
    incident = await database.manualReviewCase.findUnique({ where: { eventId } });
  }
  assert.equal(event?.status, 'MANUAL_REVIEW');
  assert.equal(incident?.status, 'OPEN');

  const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
  await database.inboundEvent.update({ where: { id: eventId }, data: { receivedAt: expiredAt } });
  const { RetentionService } = await import('../src/retention.service');
  const retention = app.get(RetentionService);
  const cleaned = await retention.cleanupExpired();
  assert.ok(cleaned.eventsDeleted >= 1);
  assert.equal(await database.inboundEvent.findUnique({ where: { id: eventId } }), null);

  const monitor = await nativeFetch(`${apiUrl}/api/admin/monitoring/incidents?status=OPEN`);
  const monitorBody = await monitor.text();
  assert.equal(monitor.status, 200, monitorBody);
  const cases = JSON.parse(monitorBody) as { cases: Array<{ id: string; eventId: string; reason: string; status: string }> };
  assert.ok(cases.cases.some((row) => row.id === incident?.id && row.eventId === eventId && row.reason === 'REVIEW_REQUIRED' && row.status === 'OPEN'));
});

test('external API attempts are listed through the monitoring endpoint without request bodies or credentials', async () => {
  const database = app.get(DatabaseService);
  const suffix = randomUUID();
  const contactId = `monitoring-contact-${suffix}`;
  const counterpartyId = `monitoring-counterparty-${suffix}`;
  const pair = await database.contactPair.create({ data: { bitrix24ContactId: contactId, moyskladCounterpartyId: counterpartyId } });
  await database.contactSnapshot.create({
    data: {
      pairId: pair.id,
      bitrix24Email: 'before@example.test',
      moyskladEmail: 'before@example.test',
      bitrix24UpdatedAt: new Date('2026-10-01T09:00:00.000Z'),
      moyskladUpdatedAt: new Date('2026-10-01T09:00:00.000Z'),
      revision: 1,
    },
  });
  process.env.BITRIX24_REST_BASE_URL = 'https://b24-monitoring.invalid/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://ms-monitoring.invalid/api/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-monitoring-api-token';

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/rest/crm.contact.get.json')) {
      return Response.json({ result: { ID: contactId, EMAIL: [{ ID: 'email-1', VALUE: 'after@example.test', VALUE_TYPE: 'WORK' }], DATE_MODIFY: '2026-10-05T12:00:01Z' } });
    }
    if (url.endsWith(`/api/entity/counterparty/${counterpartyId}`)) {
      if (init?.method === 'PUT') return Response.json({ id: counterpartyId, email: 'after@example.test', updated: '2026-10-05 12:00:02.000' });
      return Response.json({ id: counterpartyId, email: 'before@example.test', updated: '2026-10-01 09:00:00.000' });
    }
    return nativeFetch(input, init);
  }) as typeof fetch;

  try {
    const received = await nativeFetch(`${apiUrl}/webhooks/bitrix24`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'ONCRMCONTACTUPDATE',
        data: { FIELDS: { ID: contactId } },
        auth: { application_token: 'synthetic-monitoring-event-token' },
      }),
    });
    const acknowledgement = await received.json() as { eventId: string };
    const event = await waitForEvent(database, acknowledgement.eventId, 'SUCCEEDED');
    assert.ok(event, 'the accepted event must remain available for monitoring');
    assert.equal(event.status, 'SUCCEEDED');

    const history = await nativeFetch(`${apiUrl}/api/admin/monitoring/api-attempts`);
    assert.equal(history.status, 200);
    const attemptPage = await history.json() as { attempts: Array<{ eventId: string | null; provider: string; operation: string; succeeded: boolean }> };
    const forEvent = attemptPage.attempts.filter((attempt) => attempt.eventId === acknowledgement.eventId);
    assert.deepEqual(forEvent.map(({ provider, operation, succeeded }) => [provider, operation, succeeded]).sort(), [
      ['BITRIX24', 'crm.contact.get', true],
      ['MOYSKLAD', 'entity/counterparty/{id}', true],
      ['MOYSKLAD', 'entity/counterparty/{id}', true],
    ].sort());
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

async function waitForEvent(database: DatabaseService, eventId: string, status: string) {
  let event = await database.inboundEvent.findUnique({ where: { id: eventId } });
  for (let attempt = 0; attempt < 100 && event?.status !== status; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    event = await database.inboundEvent.findUnique({ where: { id: eventId } });
  }
  return event;
}
