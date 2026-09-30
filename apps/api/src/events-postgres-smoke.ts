import { strict as assert } from 'node:assert';
import { PrismaClient } from '@prisma/client';

const api = process.env.API_URL ?? 'http://localhost:3001';
const bitrixToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
const moyskladSecret = process.env['MOYSKLAD_WEBHOOK_SECRET'];
const database = new PrismaClient();

async function verifyPostgresEventIntake() {
  if (!bitrixToken || !moyskladSecret) throw new Error('Event smoke credentials are required');

  const marker = `intake-smoke-${Date.now()}`;
  const bitrixBody = new URLSearchParams({
    event: 'ONCRMDEALADD',
    ts: String(Date.now()),
    'auth[application_token]': bitrixToken,
    'data[FIELDS][ID]': marker,
  });
  const firstBitrix = await fetch(`${api}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: bitrixBody,
  });
  assert.equal(firstBitrix.status, 200);
  const firstBitrixAck = (await firstBitrix.json()) as { accepted: boolean; eventId: string };
  assert.equal(firstBitrixAck.accepted, true);

  const storedBitrix = await database.inboundEvent.findUnique({ where: { id: firstBitrixAck.eventId } });
  assert.ok(storedBitrix, 'the event row must be committed before the successful ACK');
  assert.equal(storedBitrix.source, 'BITRIX24');
  assert.equal(storedBitrix.externalEntityId, marker);
  assert.equal((storedBitrix.payload as Record<string, unknown>).auth, undefined, 'the app token must not be persisted');

  const repeatedBitrix = await fetch(`${api}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: bitrixBody,
  });
  assert.equal(repeatedBitrix.status, 200);
  const repeatedBitrixAck = (await repeatedBitrix.json()) as { eventId: string };
  assert.equal(repeatedBitrixAck.eventId, firstBitrixAck.eventId);
  assert.equal(await database.inboundEvent.count({ where: { id: firstBitrixAck.eventId } }), 1);

  const requestId = `${marker}-ms`;
  const moyskladUrl = `${api}/webhooks/moysklad/${encodeURIComponent(moyskladSecret)}?requestId=${requestId}&type=CustomerOrder&id=${marker}`;
  const moyskladBody = JSON.stringify({
    events: [{
      meta: { type: 'customerorder', href: `https://online.moysklad.ru/api/remap/1.1/entity/customerorder/${marker}` },
      action: 'UPDATE',
    }],
  });
  const firstMoysklad = await fetch(moyskladUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: moyskladBody,
  });
  assert.equal(firstMoysklad.status, 200);
  const firstMoyskladAck = (await firstMoysklad.json()) as { eventId: string };
  const storedMoysklad = await database.inboundEvent.findUnique({ where: { id: firstMoyskladAck.eventId } });
  assert.ok(storedMoysklad, 'the MoySklad notification must be committed before the successful ACK');
  assert.equal(storedMoysklad.source, 'MOYSKLAD');
  assert.equal(storedMoysklad.eventType, 'UPDATE');
  assert.equal(storedMoysklad.externalEntityId, marker);

  const repeatedMoysklad = await fetch(moyskladUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: moyskladBody,
  });
  assert.equal(repeatedMoysklad.status, 200);
  const repeatedMoyskladAck = (await repeatedMoysklad.json()) as { eventId: string };
  assert.equal(repeatedMoyskladAck.eventId, firstMoyskladAck.eventId);
  assert.equal(await database.inboundEvent.count({ where: { id: firstMoyskladAck.eventId } }), 1);

  const unkeyedId = `${marker}-without-request-id`;
  const unkeyedBody = JSON.stringify({
    events: [{
      meta: { type: 'product', href: `https://online.moysklad.ru/api/remap/1.1/entity/product/${unkeyedId}` },
      action: 'UPDATE',
    }],
  });
  const unkeyedUrl = `${api}/webhooks/moysklad/${encodeURIComponent(moyskladSecret)}`;
  const postUnkeyed = () => fetch(unkeyedUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: unkeyedBody,
  });
  const unkeyedFirst = await postUnkeyed();
  assert.equal(unkeyedFirst.status, 200);
  const unkeyedFirstAck = (await unkeyedFirst.json()) as { eventId: string };
  const unkeyedStored = await database.inboundEvent.findUnique({ where: { id: unkeyedFirstAck.eventId } });
  assert.ok(unkeyedStored, 'a native envelope without query parameters must also be durably accepted');
  assert.equal(unkeyedStored.externalEntityId, unkeyedId);

  const unkeyedRepeat = await postUnkeyed();
  assert.equal(unkeyedRepeat.status, 200);
  const unkeyedRepeatAck = (await unkeyedRepeat.json()) as { eventId: string };
  assert.notEqual(unkeyedRepeatAck.eventId, unkeyedFirstAck.eventId);
  assert.equal(await database.inboundEvent.count({ where: { id: { in: [unkeyedFirstAck.eventId, unkeyedRepeatAck.eventId] } } }), 2);

  process.stdout.write('PostgreSQL event intake persisted authenticated B24 and MoySklad events idempotently.\n');
}

void verifyPostgresEventIntake()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => database.$disconnect());
