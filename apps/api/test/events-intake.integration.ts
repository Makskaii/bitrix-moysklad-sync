import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DatabaseService } from '../src/database.service';
import { EventIntakeService, EventsController } from '../src/events.controller';

type StoredEvent = {
  id: string;
  source: string;
  deliveryKey: string;
  eventType: string | null;
  externalEntityId: string | null;
  payload: unknown;
};
const rows = new Map<string, StoredEvent>();
let upsertCalls = 0;

const inboundEvent = {
  upsert: async (args: {
    where: { source_deliveryKey: { source: string; deliveryKey: string } };
    create: {
      source: string;
      deliveryKey: string;
      eventType: string | null;
      externalEntityId: string | null;
      payload: unknown;
    };
  }) => {
    upsertCalls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const { source, deliveryKey } = args.where.source_deliveryKey;
    const key = `${source}:${deliveryKey}`;
    let row = rows.get(key);
    if (!row) {
      row = { id: `event-${rows.size + 1}`, ...args.create };
      rows.set(key, row);
    }
    return { id: row.id };
  },
};

@Module({
  controllers: [EventsController],
  providers: [EventIntakeService, { provide: DatabaseService, useValue: { inboundEvent } }],
})
class EventsIntakeTestModule {}

let app: INestApplication;
let apiUrl: string;

before(async () => {
  process.env.SYNC_MODE = 'apply';
  process.env.SYNC_STATE = 'on';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'bitrix-test-application-token';
  process.env['MOYSKLAD_WEBHOOK_SECRET'] = 'moysklad-test-path-secret';
  app = await NestFactory.create(EventsIntakeTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
});

after(async () => {
  await app.close();
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
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(rejected.status, 401);
  assert.equal(rows.size, 2);
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

  const repeated = await post();
  assert.equal(repeated.status, 200);
  const repeatedAck = (await repeated.json()) as { eventId: string };
  assert.notEqual(repeatedAck.eventId, firstAck.eventId, 'without a source delivery ID, do not collapse potentially distinct updates');
  assert.equal(rows.size, 2);
});

test('pause stores verified events and off declines intake without storing', async () => {
  rows.clear();
  process.env.SYNC_STATE = 'pause';
  const body = JSON.stringify({ event: 'ONCRMDEALADD', auth: { application_token: 'bitrix-test-application-token' } });
  const paused = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  assert.equal(paused.status, 200);
  assert.equal(rows.size, 1);

  process.env.SYNC_STATE = 'off';
  const off = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  assert.equal(off.status, 410);
  assert.equal(rows.size, 1);
  process.env.SYNC_STATE = 'on';
});
