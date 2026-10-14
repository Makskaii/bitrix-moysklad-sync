import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventWorkerLeaseService } from '../src/event-worker-lease.service';

test('worker leases enforce four shared slots across service instances', async () => {
  const slots = new Map<number, { ownerToken: string; eventId: string; leaseExpiresAt: Date }>();
  const database = {
    eventWorkerLease: {
      upsert: async ({ where, create }: { where: { slot: number }; create: { ownerToken: string; eventId: string; leaseExpiresAt: Date } }) => {
        if (!slots.has(where.slot)) slots.set(where.slot, { ...create });
      },
      updateMany: async ({ where, data }: {
        where: { slot: number; leaseExpiresAt?: { lte: Date }; ownerToken?: string };
        data: { ownerToken?: string; eventId?: string; leaseExpiresAt: Date };
      }) => {
        const slot = slots.get(where.slot);
        if (!slot) return { count: 0 };
        if (where.ownerToken !== undefined && slot.ownerToken !== where.ownerToken) return { count: 0 };
        if (where.leaseExpiresAt && slot.leaseExpiresAt > where.leaseExpiresAt.lte) return { count: 0 };
        Object.assign(slot, data);
        return { count: 1 };
      },
    },
  };
  const firstService = new EventWorkerLeaseService(database as never);
  const secondService = new EventWorkerLeaseService(database as never);
  let active = 0;
  let maximum = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const work = (eventId: string) => (active++, maximum = Math.max(maximum, active), barrier.then(() => { active--; return eventId; }));

  const first = firstService.run('event-1', () => work('event-1'));
  const second = secondService.run('event-2', () => work('event-2'));
  const third = firstService.run('event-3', () => work('event-3'));
  const fourth = secondService.run('event-4', () => work('event-4'));
  const fifth = await secondService.run('event-5', () => work('event-5'));
  assert.equal(fifth, null);
  assert.equal(maximum, 4);
  release();
  assert.deepEqual(await Promise.all([first, second, third, fourth]), ['event-1', 'event-2', 'event-3', 'event-4']);
  assert.equal([...slots.values()].filter((slot) => slot.ownerToken !== '').length, 0);
});

test('worker callback can detect a stolen lease before an external side-effect boundary', async () => {
  const slots = new Map<number, { ownerToken: string; eventId: string; leaseExpiresAt: Date }>();
  const database = {
    eventWorkerLease: {
      upsert: async ({ where, create }: { where: { slot: number }; create: { ownerToken: string; eventId: string; leaseExpiresAt: Date } }) => {
        if (!slots.has(where.slot)) slots.set(where.slot, { ...create });
      },
      updateMany: async ({ where, data }: {
        where: { slot: number; leaseExpiresAt?: { lte: Date }; ownerToken?: string };
        data: { ownerToken?: string; eventId?: string; leaseExpiresAt: Date };
      }) => {
        const slot = slots.get(where.slot);
        if (!slot || (where.ownerToken !== undefined && slot.ownerToken !== where.ownerToken)) return { count: 0 };
        if (where.leaseExpiresAt && slot.leaseExpiresAt > where.leaseExpiresAt.lte) return { count: 0 };
        Object.assign(slot, data);
        return { count: 1 };
      },
    },
  };
  const service = new EventWorkerLeaseService(database as never);
  let externalWriteReached = false;
  await assert.rejects(service.run('event-fenced', async (lease) => {
    const slot = slots.get(0)!;
    slot.ownerToken = 'new-owner';
    await lease.assertOwned();
    externalWriteReached = true;
  }), /EVENT_WORKER_LEASE_LOST/);
  assert.equal(externalWriteReached, false);
});
