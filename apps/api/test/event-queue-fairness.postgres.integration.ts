import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { EventWorkerLeaseService } from '../src/event-worker-lease.service';
import { PairFirstEventProcessor } from '../src/pairs/pair-first-event.processor';
import { ProductCardEventProcessor } from '../src/products/product-card-event.processor';
import { ClientSyncProcessor } from '../src/clients/client-sync.processor';
import { ContactSyncProcessor } from '../src/contact-sync.service';

let database: DatabaseService;
before(async () => {
  assert.equal(process.env.QUEUE_FAIRNESS_TEST_ISOLATED, '1');
  const target = new URL(process.env.DATABASE_URL!);
  assert.match(target.hostname, /^(localhost|127\.0\.0\.1)$/);
  assert.match(target.pathname, /_test$/);
  assert.match(target.searchParams.get('schema') ?? '', /^root22_queue_/);
  process.env.SYNC_MODE = 'apply';
  database = new DatabaseService();
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
});
after(async () => { await database?.$disconnect(); });

async function eventually(check: () => boolean, milliseconds = 4_500) {
  const deadline = Date.now() + milliseconds;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'public recovery timer must discover all pages without claiming/resetting fixtures');
}

for (const kind of ['deals', 'products', 'clients', 'legacy'] as const) {
  test(`${kind} recovery visits more than 100 durable rows without starving the tail or changing them`, { timeout: 8_000 }, async () => {
    const eventType = kind === 'deals' ? 'ONCRMDEALUPDATE' : kind === 'products' ? 'ONCRMPRODUCTUPDATE' : kind === 'clients' ? 'ONCRMCOMPANYUPDATE' : 'ONCRMCONTACTUPDATE';
    const entity = kind === 'deals' ? 'deal' : kind === 'products' ? 'product' : kind === 'clients' ? 'company' : 'contact';
    if (kind === 'legacy') await database.contactPair.createMany({ data: Array.from({ length: 205 }, (_, index) => ({ bitrix24ContactId: String(900000 + index), moyskladCounterpartyId: `synthetic-legacy-${index}` })) });
    await database.inboundEvent.createMany({ data: Array.from({ length: 207 }, (_, index) => ({
      id: `queue-${kind}-${String(index).padStart(4, '0')}`, source: 'BITRIX24', deliveryKey: `queue-${kind}-${index}`,
      externalEntityId: String(900000 + index), externalEntityType: entity, eventType, payload: {},
      status: index < 205 ? 'RECEIVED' : index === 205 ? 'RETRYABLE_FAILURE' : 'MANUAL_REVIEW',
      attempts: index < 205 ? 0 : 6, retryAfter: index === 205 ? new Date(Date.now() + 3_600_000) : null,
    })) });
    const beforeRows = await database.inboundEvent.findMany({ where: { id: { startsWith: `queue-${kind}-` } }, orderBy: { id: 'asc' } });
    const settings = { current: async () => ({ config: {} }) };
    const processor = kind === 'deals' ? new PairFirstEventProcessor(database, {} as never)
      : kind === 'products' ? new ProductCardEventProcessor(database, {} as never, settings as never, {} as never)
        : kind === 'clients' ? new ClientSyncProcessor(database, settings as never, {} as never)
          : new ContactSyncProcessor(database, {} as never, settings as never);
    const seen = new Set<string>();
    processor.enqueue = (id: string) => { seen.add(id); };
    if (processor instanceof ClientSyncProcessor) {
      for (let page = 0; page < 3; page++) await processor.recoverPending();
    } else {
      processor.onApplicationBootstrap();
      try { await eventually(() => seen.size >= 205); }
      finally { await processor.onModuleDestroy(); }
    }
    assert.equal(seen.size, 205);
    assert.ok(seen.has(`queue-${kind}-0204`));
    assert.deepEqual(await database.inboundEvent.findMany({ where: { id: { startsWith: `queue-${kind}-` } }, orderBy: { id: 'asc' } }), beforeRows);
  });
}

test('two actual PostgreSQL lease services retain queued work and never exceed four durable workers', { timeout: 10_000 }, async () => {
  const first = new EventWorkerLeaseService(database);
  const second = new EventWorkerLeaseService(database);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let active = 0; let maximum = 0;
  const work = async () => { active++; maximum = Math.max(maximum, active); await barrier; active--; return 'done'; };
  const occupied = Array.from({ length: 4 }, (_, index) => first.run(`pg-block-${index}`, work, 'deals-orders'));
  await eventually(() => active === 4);
  let queuedStarted = false;
  const pending = second.run('pg-new-invoice', async () => { queuedStarted = true; return 'invoice'; }, 'invoices');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(queuedStarted, false);
  assert.equal(await database.eventWorkerLease.count({ where: { leaseExpiresAt: { gt: new Date() } } }), 4);
  release();
  await Promise.all(occupied);
  const keepAlive = setTimeout(() => undefined, 2_000);
  try { assert.equal(await pending, 'invoice'); }
  finally { clearTimeout(keepAlive); first.onModuleDestroy(); second.onModuleDestroy(); }
  assert.equal(maximum, 4);
  assert.equal(await database.eventWorkerLease.count({ where: { ownerToken: { not: '' } } }), 0);
});
