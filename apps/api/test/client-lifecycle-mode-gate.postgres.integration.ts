import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Controller, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DatabaseService } from '../src/database.service';
import { ClientLifecycleService, CLIENT_LIFECYCLE_GATEWAY } from '../src/clients/client-lifecycle.service';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { SyncModeService } from '../src/sync-mode.service';
import { EventDispatcherService, ADDITIONAL_EVENT_PROCESSORS } from '../src/event-dispatcher.service';
import { ContactSyncProcessor } from '../src/contact-sync.service';
import { PairFirstEventProcessor } from '../src/pairs/pair-first-event.processor';

const suffix = randomUUID();
const pairId = `lifecycle-mode-${suffix}`;
const b24Id = `79${Date.now()}`;
const eventPrefix = `lifecycle-mode-${suffix}-`;
let database: DatabaseService;
let oldFetch: typeof fetch;
let oldSyncMode: string | undefined;
let oldApplicationToken: string | undefined;
let oldBitrixBase: string | undefined;
let providerReads = 0;
const providerPaths: string[] = [];
let nextReadBarrier: { started(): void; release(): void } | undefined;

@Controller()
class LifecycleModeTestController {}

@Module({
  controllers: [EventsController, LifecycleModeTestController],
  providers: [
    DatabaseService,
    SyncModeService,
    EventIntakeService,
    ClientLifecycleService,
    {
      provide: CLIENT_LIFECYCLE_GATEWAY,
      useValue: {
        readBitrix: async (_entity: string, id: string) => ({ ID: id }),
        readMoysklad: async (_entity: string, id: string) => ({ id }),
      },
    },
    { provide: ContactSyncProcessor, useValue: { supports: () => false, enqueue: () => undefined } },
    { provide: PairFirstEventProcessor, useValue: { supports: () => false, enqueue: () => undefined } },
    {
      provide: ADDITIONAL_EVENT_PROCESSORS,
      useFactory: (lifecycle: ClientLifecycleService) => [lifecycle],
      inject: [ClientLifecycleService],
    },
    EventDispatcherService,
  ],
})
class LifecycleModeTestModule {}

async function createApp() {
  const app = await NestFactory.create(LifecycleModeTestModule, { logger: false });
  await app.init();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  assert.ok(address && typeof address === 'object');
  return { app, apiUrl: `http://127.0.0.1:${address.port}` };
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 4_000;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
}

before(async () => {
  assert.equal(process.env.CLIENT_LIFECYCLE_MODE_GATE_TEST_ISOLATED, '1', 'explicit opt-in is required for this disposable PostgreSQL test schema');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.match(url.hostname, /^(localhost|127\.0\.0\.1)$/i, 'test database must be local');
  assert.equal(url.searchParams.get('schema'), 'issue79_lifecycle_mode_gate_test', 'test must use its dedicated schema');
  oldFetch = globalThis.fetch;
  oldSyncMode = process.env.SYNC_MODE;
  oldApplicationToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
  oldBitrixBase = process.env.BITRIX24_REST_BASE_URL;
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-lifecycle-mode-gate-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix-fixture.invalid/rest/test/';
  providerReads = 0;
  providerPaths.length = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://bitrix-fixture.invalid/')) return oldFetch(input, init);
    providerReads += 1;
    providerPaths.push(new URL(url).pathname);
    assert.match(url, /\/crm\.company\.get\.json$/, 'only the exact synthetic Bitrix current-state read is allowed');
    assert.equal(init?.method, 'POST');
    if (nextReadBarrier) {
      const barrier = nextReadBarrier;
      nextReadBarrier = undefined;
      barrier.started();
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          signal?.removeEventListener('abort', onAbort);
          reject(signal?.reason ?? new Error('provider request aborted'));
        };
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
        barrier.release = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
      });
    }
    return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
  database = new DatabaseService();
  await database.$connect();
});

after(async () => {
  if (database) {
    await database.inboundEvent.deleteMany({ where: { deliveryKey: { startsWith: eventPrefix } } });
    await database.entityPair.deleteMany({ where: { id: { startsWith: pairId } } });
    await database.$disconnect();
  }
  globalThis.fetch = oldFetch;
  if (oldSyncMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = oldSyncMode;
  if (oldApplicationToken === undefined) delete process.env.BITRIX24_EVENT_APPLICATION_TOKEN; else process.env.BITRIX24_EVENT_APPLICATION_TOKEN = oldApplicationToken;
  if (oldBitrixBase === undefined) delete process.env.BITRIX24_REST_BASE_URL; else process.env.BITRIX24_REST_BASE_URL = oldBitrixBase;
});

test('OFF and PAUSE startup recovery leave lifecycle events and tombstone work untouched', async () => {
  for (const mode of ['off', 'pause'] as const) {
    await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: mode }, update: { serviceMode: mode } });
    const event = await database.inboundEvent.create({ data: {
      source: 'BITRIX24', deliveryKey: `${eventPrefix}${mode}`, eventType: 'ONCRMCOMPANYDELETE',
      externalEntityType: 'company', externalEntityId: b24Id, payload: {}, status: 'RECEIVED',
    } });
    const tombstone = await database.entityPair.create({ data: {
      id: `${pairId}-${mode}`, entityType: 'COMPANY', bitrix24Id: `${b24Id}-${mode}`, moyskladId: randomUUID(),
      moyskladType: 'counterparty', active: false, lifecycleStatus: 'TOMBSTONED', tombstonedAt: new Date(),
      tombstoneSource: 'MOYSKLAD', tombstoneReason: 'TEST_FIXTURE', deletionMarkerStatus: 'PENDING',
      deletionTimelineStatus: 'PENDING',
    } });
    const readsBefore = providerReads;
    const { app } = await createApp();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await app.close(); // waits for the real Nest application-bootstrap recovery scan to finish
    const afterEvent = await database.inboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    const afterPair = await database.entityPair.findUniqueOrThrow({ where: { id: tombstone.id } });
    assert.equal(afterEvent.status, 'RECEIVED', `${mode} must not claim a queued delete`);
    assert.equal(afterEvent.attempts, 0, `${mode} must not change the retry counter`);
    assert.equal(afterPair.deletionMarkerStatus, 'PENDING', `${mode} must not claim marker work`);
    assert.equal(afterPair.deletionTimelineStatus, 'PENDING', `${mode} must not claim timeline work`);
    assert.equal(providerReads, readsBefore, `${mode} recovery must not read either provider`);
    await database.inboundEvent.delete({ where: { id: event.id } });
    await database.entityPair.delete({ where: { id: tombstone.id } });
  }
});

test('a durable mode-store read failure during bootstrap cannot claim lifecycle work', async () => {
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  const event = await database.inboundEvent.create({ data: {
    source: 'BITRIX24', deliveryKey: `${eventPrefix}mode-read-failure`, eventType: 'ONCRMCOMPANYDELETE',
    externalEntityType: 'company', externalEntityId: b24Id, payload: {}, status: 'RECEIVED',
  } });
  const tombstone = await database.entityPair.create({ data: {
    id: `${pairId}-mode-read-failure`, entityType: 'COMPANY', bitrix24Id: `${b24Id}-failure`, moyskladId: randomUUID(),
    moyskladType: 'counterparty', active: false, lifecycleStatus: 'TOMBSTONED', tombstonedAt: new Date(),
    tombstoneSource: 'MOYSKLAD', tombstoneReason: 'TEST_FIXTURE', deletionMarkerStatus: 'PENDING',
    deletionTimelineStatus: 'PENDING',
  } });
  const readsBefore = providerReads;
  await database.$executeRawUnsafe('ALTER TABLE "SyncSetting" RENAME TO "SyncSetting_lifecycle_gate_unavailable"');
  try {
    const { app } = await createApp();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await app.close();
  } finally {
    await database.$executeRawUnsafe('ALTER TABLE "SyncSetting_lifecycle_gate_unavailable" RENAME TO "SyncSetting"');
  }
  const afterEvent = await database.inboundEvent.findUniqueOrThrow({ where: { id: event.id } });
  const afterPair = await database.entityPair.findUniqueOrThrow({ where: { id: tombstone.id } });
  assert.equal(afterEvent.status, 'RECEIVED');
  assert.equal(afterEvent.attempts, 0);
  assert.equal(afterPair.deletionMarkerStatus, 'PENDING');
  assert.equal(afterPair.deletionTimelineStatus, 'PENDING');
  assert.equal(providerReads, readsBefore);
  await database.inboundEvent.delete({ where: { id: event.id } });
  await database.entityPair.delete({ where: { id: tombstone.id } });
});

test('manual restore in OFF fails before provider identity reads or tombstone mutation', async () => {
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'off' }, update: { serviceMode: 'off' } });
  const tombstone = await database.entityPair.create({ data: {
    id: `${pairId}-restore-off`, entityType: 'COMPANY', bitrix24Id: `${b24Id}-restore`, moyskladId: randomUUID(),
    moyskladType: 'counterparty', active: false, lifecycleStatus: 'TOMBSTONED', tombstonedAt: new Date(),
    tombstoneSource: 'BITRIX24', tombstoneReason: 'TEST_FIXTURE', deletionMarkerStatus: 'NOT_REQUIRED',
    deletionTimelineStatus: 'NOT_REQUIRED',
  } });
  const readsBefore = providerReads;
  const { app } = await createApp();
  try {
    await assert.rejects(
      () => app.get(ClientLifecycleService).restore(tombstone.id, true, 'BITRIX24_USER:42'),
      /durable service mode to be on/,
    );
  } finally {
    await app.close();
  }
  const afterPair = await database.entityPair.findUniqueOrThrow({ where: { id: tombstone.id } });
  assert.equal(afterPair.lifecycleStatus, 'TOMBSTONED');
  assert.equal(afterPair.active, false);
  assert.equal(providerReads, readsBefore);
  await database.entityPair.delete({ where: { id: tombstone.id } });
});

test('enabled lifecycle webhook dispatches through Nest and tombstones only its exact provider-confirmed pair', async () => {
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  await database.entityPair.create({ data: {
    id: pairId, entityType: 'COMPANY', bitrix24Id: b24Id, moyskladId: randomUUID(),
    moyskladType: 'counterparty', active: true, lifecycleStatus: 'ACTIVE',
  } });
  const { app, apiUrl } = await createApp();
  try {
    const response = await fetch(`${apiUrl}/webhooks/bitrix24`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'ONCRMCOMPANYDELETE',
        auth: { application_token: 'synthetic-lifecycle-mode-gate-token' },
        data: { FIELDS: { ID: b24Id } },
      }),
    });
    assert.equal(response.status, 200);
    const ack = await response.json() as { accepted: boolean; eventId: string };
    assert.equal(ack.accepted, true);
    const event = await waitFor(() => database.inboundEvent.findUniqueOrThrow({ where: { id: ack.eventId } }), (row) => row.status === 'SUCCEEDED');
    const pair = await database.entityPair.findUniqueOrThrow({ where: { id: pairId } });
    assert.equal(event.status, 'SUCCEEDED', JSON.stringify({ lastErrorCategory: event.lastErrorCategory, attempts: event.attempts, providerReads, providerPaths }));
    assert.equal(pair.lifecycleStatus, 'TOMBSTONED');
    assert.equal(pair.active, false);
    assert.equal(pair.bitrix24Id, b24Id);
    assert.equal(providerReads, 1, providerPaths.join(', '));
  } finally {
    await app.close();
  }
});

test('an OFF flip between a bounded source read and tombstone prevents the next provider/DB operation and recovers once ON', async () => {
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  const racePairId = `${pairId}-mode-flip`;
  const raceEventKey = `${eventPrefix}mode-flip`;
  const racePair = await database.entityPair.create({ data: {
    id: racePairId, entityType: 'COMPANY', bitrix24Id: `${b24Id}-flip`, moyskladId: randomUUID(),
    moyskladType: 'counterparty', active: true, lifecycleStatus: 'ACTIVE',
  } });
  const event = await database.inboundEvent.create({ data: {
    source: 'BITRIX24', deliveryKey: raceEventKey, eventType: 'ONCRMCOMPANYDELETE',
    externalEntityType: 'company', externalEntityId: racePair.bitrix24Id, payload: {}, status: 'RECEIVED',
  } });
  const readsBefore = providerReads;
  let started!: () => void;
  const sourceReadStarted = new Promise<void>((resolve) => { started = resolve; });
  const barrier: { started(): void; release(): void } = { started, release: () => {} };
  nextReadBarrier = barrier;
  const { app } = await createApp();
  try {
    await sourceReadStarted;
    const offUpdate = database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'off' } }).then(() => undefined);
    // The bounded provider operation holds the mode row lock; turn OFF waits
    // for that single request, then wins before the next independently gated step.
    const lockDeadline = Date.now() + 2_000;
    let offWriterWaiting = false;
    while (!offWriterWaiting && Date.now() < lockDeadline) {
      const waiters = await database.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SyncSetting%'
      `;
      offWriterWaiting = Number(waiters[0]?.count ?? 0) > 0;
      if (!offWriterWaiting) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(offWriterWaiting, true, 'OFF update must be queued against the active provider-read gate before releasing it');
    barrier.release();
    await offUpdate;
    const afterOff = await database.inboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    const pairAfterOff = await database.entityPair.findUniqueOrThrow({ where: { id: racePairId } });
    assert.equal(afterOff.status, 'PROCESSING');
    assert.equal(pairAfterOff.lifecycleStatus, 'ACTIVE');
    assert.equal(providerReads, readsBefore + 1, 'OFF must prevent a second provider operation before restart');
    await database.inboundEvent.update({ where: { id: event.id }, data: { processingStartedAt: new Date(Date.now() - 120_000) } });
    await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
    const recovered = await waitFor(() => database.inboundEvent.findUniqueOrThrow({ where: { id: event.id } }), (row) => row.status === 'SUCCEEDED');
    const finalPair = await database.entityPair.findUniqueOrThrow({ where: { id: racePairId } });
    assert.equal(recovered.status, 'SUCCEEDED');
    assert.equal(finalPair.lifecycleStatus, 'TOMBSTONED');
    assert.equal(providerReads, readsBefore + 2, 'ON recovery repeats the single bounded source read exactly once');
  } finally {
    await app.close();
    await database.inboundEvent.deleteMany({ where: { id: event.id } });
    await database.entityPair.deleteMany({ where: { id: racePairId } });
  }
});

test('an aborted bounded provider read leaves work recoverable and does not start another request before retry', async () => {
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  const timeoutPairId = `${pairId}-timeout`;
  const timeoutEvent = await database.inboundEvent.create({ data: {
    source: 'BITRIX24', deliveryKey: `${eventPrefix}timeout`, eventType: 'ONCRMCOMPANYDELETE',
    externalEntityType: 'company', externalEntityId: `${b24Id}-timeout`, payload: {}, status: 'RECEIVED',
  } });
  const timeoutPair = await database.entityPair.create({ data: {
    id: timeoutPairId, entityType: 'COMPANY', bitrix24Id: `${b24Id}-timeout`, moyskladId: randomUUID(),
    moyskladType: 'counterparty', active: true, lifecycleStatus: 'ACTIVE',
  } });
  const readsBefore = providerReads;
  let started!: () => void;
  const providerStarted = new Promise<void>((resolve) => { started = resolve; });
  const barrier: { started(): void; release(): void } = { started, release: () => {} };
  nextReadBarrier = barrier;
  const { app } = await createApp();
  try {
    await providerStarted;
    const deadline = Date.now() + 12_000;
    let event = await database.inboundEvent.findUniqueOrThrow({ where: { id: timeoutEvent.id } });
    while (event.status !== 'RETRYABLE_FAILURE' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      event = await database.inboundEvent.findUniqueOrThrow({ where: { id: timeoutEvent.id } });
    }
    assert.equal(event.status, 'RETRYABLE_FAILURE', 'the 10-second transport AbortSignal must return the single provider callback before the 15-second transaction deadline');
    assert.equal(providerReads, readsBefore + 1, 'only one provider operation may start before the failure is durably recorded');
    assert.equal((await database.entityPair.findUniqueOrThrow({ where: { id: timeoutPairId } })).lifecycleStatus, 'ACTIVE');
    await database.inboundEvent.update({ where: { id: timeoutEvent.id }, data: { status: 'PROCESSING', retryAfter: null, processingStartedAt: new Date(Date.now() - 120_000) } });
    const recovered = await waitFor(() => database.inboundEvent.findUniqueOrThrow({ where: { id: timeoutEvent.id } }), (row) => row.status === 'SUCCEEDED');
    assert.equal(recovered.status, 'SUCCEEDED');
    assert.equal((await database.entityPair.findUniqueOrThrow({ where: { id: timeoutPairId } })).lifecycleStatus, 'TOMBSTONED');
    assert.equal(providerReads, readsBefore + 2, 'only ON recovery may perform the second source read');
  } finally {
    barrier.release();
    await app.close();
    await database.inboundEvent.deleteMany({ where: { id: timeoutEvent.id } });
    await database.entityPair.deleteMany({ where: { id: timeoutPairId } });
  }
});
