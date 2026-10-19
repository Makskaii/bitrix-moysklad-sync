import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { EventDispatcherService } from '../src/event-dispatcher.service';
import { InvoiceEventProcessor } from '../src/invoices/invoice-event.processor';

const events = new Map<string, Record<string, unknown>>();
const enqueued: string[] = [];
const disabledDirections = new Set<string>();
let nextId = 0;
let app: INestApplication;
let apiUrl: string;
let previousToken: string | undefined;
let previousSecret: string | undefined;
let previousMode: string | undefined;

const database = {
  inboundEvent: {
    findUnique: async ({ where }: { where: { id: string } }) => events.get(where.id) ?? null,
    upsert: async ({ create }: { create: Record<string, unknown> }) => {
      const id = `invoice-intake-${++nextId}`;
      events.set(id, { id, ...create });
      return { id };
    },
  },
  operationalLog: { create: async () => undefined },
};
const syncMode = { read: async () => ({ mode: 'on' }), isDirectionEnabled: async (entity: string, direction: string) => !disabledDirections.has(`${entity}:${direction}`) };
const fieldSettings = {
  saveAcceptedEvent: async (input: Record<string, unknown>) => {
    const id = `invoice-intake-${++nextId}`;
    events.set(id, { id, ...input, status: input.directionDisabled === true ? 'SKIPPED_DIRECTION_DISABLED' : 'RECEIVED',
      lastErrorCategory: input.directionDisabled === true ? 'DIRECTION_DISABLED' : null });
    return { id };
  },
};
const recovery = { assertReady: async () => true };
const intake = new EventIntakeService(database as never, syncMode as never, undefined, fieldSettings as never, recovery as never);
const invoiceProcessor = new InvoiceEventProcessor({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
invoiceProcessor.enqueue = (eventId) => { enqueued.push(eventId); };
const dispatcher = new EventDispatcherService(
  database as never,
  { enqueue: () => assert.fail('invoice events must not route to client sync') } as never,
  { enqueue: () => assert.fail('invoice events must not route to deal/order sync') } as never,
  [invoiceProcessor],
);

@Module({
  controllers: [EventsController],
  providers: [
    { provide: EventIntakeService, useValue: intake },
    { provide: EventDispatcherService, useValue: dispatcher },
  ],
})
class InvoiceWebhookTestModule {}

before(async () => {
  previousToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
  previousSecret = process.env.MOYSKLAD_WEBHOOK_SECRET;
  previousMode = process.env.SYNC_MODE;
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'invoice-intake-test-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'invoice-intake-test-secret';
  process.env.SYNC_MODE = 'apply';
  app = await NestFactory.create(InvoiceWebhookTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
});

after(async () => {
  await app.close();
  restoreEnv('BITRIX24_EVENT_APPLICATION_TOKEN', previousToken);
  restoreEnv('MOYSKLAD_WEBHOOK_SECRET', previousSecret);
  restoreEnv('SYNC_MODE', previousMode);
});

test('HTTP invoice intake durably queues type 31 then dispatches it to the invoice processor', async () => {
  const deliver = async (id: string, entityTypeId: number) => {
    const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      event: 'ONCRMDYNAMICITEMADD',
      data: { FIELDS: { ID: id, ENTITY_TYPE_ID: entityTypeId } },
      auth: { application_token: 'invoice-intake-test-token' },
      }),
    });
    assert.equal(response.status, 200);
    const acknowledgement = await response.json() as { eventId: string };
    await new Promise<void>((resolve) => setImmediate(resolve));
    return acknowledgement.eventId;
  };

  const invoiceEventId = await deliver('8101', 31);
  assert.equal(events.get(invoiceEventId)?.externalEntityType, 'invoice');
  assert.equal(events.get(invoiceEventId)?.externalEntityId, '8101');
  assert.deepEqual(enqueued, [invoiceEventId]);

  const legacyEventId = await deliver('8102', 5);
  assert.equal(events.get(legacyEventId)?.externalEntityType, null);
  assert.deepEqual(enqueued, [invoiceEventId], 'legacy invoice type 5 must not reach the invoice processor');

  const beforeRejected = events.size;
  const rejected = await fetch(`${apiUrl}/webhooks/moysklad/wrong-secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'CREATE', meta: { type: 'invoiceout', href: 'https://fake.invalid/entity/invoiceout/11111111-1111-4111-8111-111111111111' } }] }),
  });
  assert.equal(rejected.status, 401);
  assert.equal(events.size, beforeRejected, 'bad MySklad secret must not persist invoice events');

  const batchIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const batch = await fetch(`${apiUrl}/webhooks/moysklad/invoice-intake-test-secret?requestId=invoice-batch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: batchIds.map((id) => ({ action: 'CREATE', meta: { type: 'invoiceout', href: `https://fake.invalid/entity/invoiceout/${id}` } })) }),
  });
  assert.equal(batch.status, 200);
  const batchAck = await batch.json() as { eventIds: string[] };
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(batchAck.eventIds.length, 2);
  assert.deepEqual(batchAck.eventIds.map((id) => events.get(id)?.externalEntityId), batchIds);
  assert.deepEqual(enqueued, [invoiceEventId, ...batchAck.eventIds], 'each batched invoiceout event must dispatch independently');

  disabledDirections.add('invoices:moyskladToBitrix24');
  const deleteId = '33333333-3333-4333-8333-333333333333';
  const disabledDelete = await fetch(`${apiUrl}/webhooks/moysklad/invoice-intake-test-secret?requestId=disabled-invoice-delete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'DELETE', meta: { type: 'invoiceout', href: `https://fake.invalid/entity/invoiceout/${deleteId}` } }] }),
  });
  assert.equal(disabledDelete.status, 200);
  const disabledDeleteAck = await disabledDelete.json() as { eventId: string };
  const skippedDelete = events.get(disabledDeleteAck.eventId)!;
  assert.equal(skippedDelete.status, 'SKIPPED_DIRECTION_DISABLED');
  assert.equal(skippedDelete.lastErrorCategory, 'DIRECTION_DISABLED');
  assert.deepEqual(enqueued, [invoiceEventId, ...batchAck.eventIds], 'disabled-direction deletes are terminal skips under #57 and must not reach lifecycle processing');
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
