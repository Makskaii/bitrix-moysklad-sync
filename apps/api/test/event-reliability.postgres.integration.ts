import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { EventDispatcherService, InboundEventProcessor } from '../src/event-dispatcher.service';
import { EventWorkerLeaseService } from '../src/event-worker-lease.service';

test('PostgreSQL shares worker fencing slots across instances and dispatches a durable accepted event', {
  skip: process.env.ISSUE57_EVENT_RELIABILITY_POSTGRES !== '1',
}, async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, 'Set DATABASE_URL to a disposable PostgreSQL test database');
  const parsedUrl = new URL(databaseUrl);
  assert.match(parsedUrl.hostname, /^(localhost|127\.0\.0\.1)$/i, 'Refusing a non-local test database');
  assert.match(parsedUrl.pathname, /(test|issue57)/i, 'Database name must identify a disposable test database');

  const firstDatabase = new DatabaseService();
  const secondDatabase = new DatabaseService();
  const firstLeaseService = new EventWorkerLeaseService(firstDatabase);
  const secondLeaseService = new EventWorkerLeaseService(secondDatabase);
  const eventId = `issue57-acceptance-${randomUUID()}`;
  let active = 0;
  let maximum = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const work = async (id: string) => {
    active++;
    maximum = Math.max(maximum, active);
    try { await barrier; return id; } finally { active--; }
  };
  try {
    await firstDatabase.inboundEvent.create({ data: {
      id: eventId, source: 'BITRIX24', deliveryKey: eventId, eventType: 'ONCRMDEALUPDATE',
      externalEntityType: 'deal', externalEntityId: 'acceptance-deal-id', payload: { acceptance: true }, status: 'RECEIVED',
    } });
    const received = await secondDatabase.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(received.status, 'RECEIVED');

    const deliveries: string[] = [];
    const owner: InboundEventProcessor = {
      supports: (event) => event.source === 'BITRIX24' && event.externalEntityType === 'deal',
      enqueue: (id) => { deliveries.push(id); },
    };
    const dispatcher = new EventDispatcherService(
      secondDatabase,
      { enqueue: () => assert.fail('deal event must not route to contact processor') } as never,
      { enqueue: () => assert.fail('explicit deal owner should take precedence') } as never,
      [owner],
    );
    await dispatcher.dispatch(eventId);
    assert.deepEqual(deliveries, [eventId]);

    const tasks = [
      firstLeaseService.run('pg-1', () => work('pg-1')),
      secondLeaseService.run('pg-2', () => work('pg-2')),
      firstLeaseService.run('pg-3', () => work('pg-3')),
      secondLeaseService.run('pg-4', () => work('pg-4')),
    ];
    for (let attempt = 0; attempt < 100 && active < 4; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(active, 4, 'four PostgreSQL leases should be concurrently held');
    assert.equal(await secondLeaseService.run('pg-5', () => work('pg-5')), null, 'a fifth worker must not exceed the shared DB semaphore');
    release();
    assert.deepEqual(await Promise.all(tasks), ['pg-1', 'pg-2', 'pg-3', 'pg-4']);

    let externalWriteReached = false;
    await assert.rejects(firstLeaseService.run('pg-fenced', async (lease) => {
      const stolen = await secondDatabase.eventWorkerLease.updateMany({
        where: { eventId: 'pg-fenced' }, data: { ownerToken: 'replacement-owner' },
      });
      assert.equal(stolen.count, 1);
      await lease.assertOwned();
      externalWriteReached = true;
    }), /EVENT_WORKER_LEASE_LOST/);
    assert.equal(externalWriteReached, false, 'a stale worker cannot pass its persisted owner-token fence');
  } finally {
    release();
    await firstDatabase.eventWorkerLease.updateMany({
      where: { eventId: 'pg-fenced' }, data: { ownerToken: '', eventId: '', leaseExpiresAt: new Date(0) },
    });
    await firstDatabase.inboundEvent.deleteMany({ where: { id: eventId } });
    await Promise.all([firstDatabase.$disconnect(), secondDatabase.$disconnect()]);
  }
});
