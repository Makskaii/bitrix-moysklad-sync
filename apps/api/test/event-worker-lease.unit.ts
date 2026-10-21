import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventWorkerLeaseService } from '../src/event-worker-lease.service';

function modeOnDatabase(database: Record<string, any>): Record<string, any> {
  return { ...database, $transaction: (work: (transaction: any) => Promise<unknown>) => work({ ...database, $queryRaw: async () => [{ serviceMode: 'on' }] }) };
}

test('durable OFF does not initialize or claim a worker-lease slot', async () => {
  let callbackCalls = 0;
  let leaseDbWrites = 0;
  const database = {
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
      $queryRaw: async () => [{ serviceMode: 'off' }],
      $executeRaw: async () => { leaseDbWrites += 1; },
      eventWorkerLease: { updateMany: async () => { leaseDbWrites += 1; return { count: 1 }; } },
    }),
  };
  const service = new EventWorkerLeaseService(database as never);
  const result = await service.run('off-event', async () => { callbackCalls += 1; return 'processed'; });
  assert.equal(result, null);
  assert.equal(callbackCalls, 0);
  assert.equal(leaseDbWrites, 0);
});

test('durable PAUSE or a missing mode row does not initialize or claim a worker-lease slot', async () => {
  for (const modeRows of [[{ serviceMode: 'paused' }], []]) {
    let leaseDbWrites = 0;
    const database = {
      $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
        $queryRaw: async () => modeRows,
        $executeRaw: async () => { leaseDbWrites += 1; },
        eventWorkerLease: { updateMany: async () => { leaseDbWrites += 1; return { count: 1 }; } },
      }),
    };
    const service = new EventWorkerLeaseService(database as never);
    const result = await service.run('disabled-event', async () => 'processed');
    assert.equal(result, null);
    assert.equal(leaseDbWrites, 0);
  }
});

test('mode-row read failure prevents worker-lease writes and propagates', async () => {
  let leaseDbWrites = 0;
  const database = {
    $transaction: async (work: (transaction: any) => Promise<unknown>) => work({
      $queryRaw: async () => { throw new Error('mode database unavailable'); },
      $executeRaw: async () => { leaseDbWrites += 1; },
      eventWorkerLease: { updateMany: async () => { leaseDbWrites += 1; return { count: 1 }; } },
    }),
  };
  const service = new EventWorkerLeaseService(database as never);
  await assert.rejects(service.run('unavailable-event', async () => 'processed'), /mode database unavailable/);
  assert.equal(leaseDbWrites, 0);
});

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
    $executeRaw: async (_query: TemplateStringsArray, slot: number, _expiresAt: Date) => {
      if (!slots.has(slot)) slots.set(slot, { ownerToken: '', eventId: '', leaseExpiresAt: new Date(0) });
      return 1;
    },
  };
  const firstService = new EventWorkerLeaseService(modeOnDatabase(database) as never);
  const secondService = new EventWorkerLeaseService(modeOnDatabase(database) as never);
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
    $executeRaw: async (_query: TemplateStringsArray, slot: number, _expiresAt: Date) => {
      if (!slots.has(slot)) slots.set(slot, { ownerToken: '', eventId: '', leaseExpiresAt: new Date(0) });
      return 1;
    },
  };
  const service = new EventWorkerLeaseService(modeOnDatabase(database) as never);
  let externalWriteReached = false;
  await assert.rejects(service.run('event-fenced', async (lease) => {
    const slot = slots.get(0)!;
    slot.ownerToken = 'new-owner';
    await lease.assertOwned();
    externalWriteReached = true;
  }), /EVENT_WORKER_LEASE_LOST/);
  assert.equal(externalWriteReached, false);
});

test('two service instances racing on the first empty slot return normally instead of leaking a unique conflict', async () => {
  const slots = new Map<number, { ownerToken: string; eventId: string; leaseExpiresAt: Date }>();
  const database = {
    eventWorkerLease: {
      upsert: async ({ where, create }: { where: { slot: number }; create: { ownerToken: string; eventId: string; leaseExpiresAt: Date } }) => {
        if (slots.has(where.slot)) return;
        await Promise.resolve();
        if (slots.has(where.slot)) throw Object.assign(new Error('Unique constraint failed on EventWorkerLease.slot'), { code: 'P2002' });
        slots.set(where.slot, { ...create });
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
    $executeRaw: async (_query: TemplateStringsArray, slot: number, _lease: Date) => {
      if (!slots.has(slot)) slots.set(slot, { ownerToken: '', eventId: '', leaseExpiresAt: new Date(0) });
      return 1;
    },
  };
  const firstService = new EventWorkerLeaseService(modeOnDatabase(database) as never);
  const secondService = new EventWorkerLeaseService(modeOnDatabase(database) as never);
  const outcomes = await Promise.allSettled([
    firstService.run('first', async () => 'first'),
    secondService.run('second', async () => 'second'),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 0);
  assert.deepEqual(outcomes.filter((outcome) => outcome.status === 'fulfilled').map((outcome) => outcome.status === 'fulfilled' ? outcome.value : null), ['first', 'second']);
});

test('an expired owner cannot renew its lease and cross a side-effect boundary', async () => {
  const slots = new Map<number, { ownerToken: string; eventId: string; leaseExpiresAt: Date }>();
  const database = {
    eventWorkerLease: {
      updateMany: async ({ where, data }: {
        where: { slot: number; leaseExpiresAt?: { lte?: Date; gt?: Date }; ownerToken?: string };
        data: { ownerToken?: string; eventId?: string; leaseExpiresAt: Date };
      }) => {
        const slot = slots.get(where.slot);
        if (!slot || (where.ownerToken !== undefined && slot.ownerToken !== where.ownerToken)) return { count: 0 };
        if (where.leaseExpiresAt?.lte && slot.leaseExpiresAt > where.leaseExpiresAt.lte) return { count: 0 };
        if (where.leaseExpiresAt?.gt && slot.leaseExpiresAt <= where.leaseExpiresAt.gt) return { count: 0 };
        Object.assign(slot, data);
        return { count: 1 };
      },
    },
    $executeRaw: async (_query: TemplateStringsArray, slot: number) => {
      if (!slots.has(slot)) slots.set(slot, { ownerToken: '', eventId: '', leaseExpiresAt: new Date(0) });
      return 1;
    },
  };
  const service = new EventWorkerLeaseService(modeOnDatabase(database) as never);
  let externalWriteReached = false;
  await assert.rejects(service.run('expired-owner', async (lease) => {
    slots.get(0)!.leaseExpiresAt = new Date(0);
    await lease.assertOwned();
    externalWriteReached = true;
  }), /EVENT_WORKER_LEASE_LOST/);
  assert.equal(externalWriteReached, false);
});
