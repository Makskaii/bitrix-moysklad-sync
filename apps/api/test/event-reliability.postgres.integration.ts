import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { EventDispatcherService, InboundEventProcessor } from '../src/event-dispatcher.service';
import { EventWorkerLeaseService } from '../src/event-worker-lease.service';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { SyncModeService } from '../src/sync-mode.service';
import { SyncRecoveryService } from '../src/sync-recovery.service';

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
  let deniedByCapacity = 0;
  let release!: () => void;
  let releaseOldLease = () => {};
  let releaseNewLease = () => {};
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

    const tasks = Array.from({ length: 12 }, (_, index) => {
      const eventId = `pg-concurrent-${index + 1}`;
      const service = index % 2 === 0 ? firstLeaseService : secondLeaseService;
      return service.run(eventId, () => work(eventId)).then((result) => {
        if (result === null) deniedByCapacity++;
        return result;
      });
    });
    const settledTasks = Promise.allSettled(tasks);
    for (let attempt = 0; attempt < 100 && deniedByCapacity < 8; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    const heldSlots = await firstDatabase.eventWorkerLease.findMany({
      where: { ownerToken: { not: '' } }, select: { slot: true, eventId: true, leaseExpiresAt: true },
    });
    assert.equal(active, 4, `four PostgreSQL leases should be concurrently held; callbacks=${active}, slots=${JSON.stringify(heldSlots)}`);
    assert.equal(heldSlots.length, 4, 'each active callback must correspond to one persisted lease slot');
    const ownerTokens = await firstDatabase.eventWorkerLease.findMany({
      where: { ownerToken: { not: '' } }, select: { ownerToken: true },
    });
    assert.equal(new Set(ownerTokens.map((slot) => slot.ownerToken)).size, 4, 'each held slot must have a distinct current owner token');
    assert.equal(await secondLeaseService.run('pg-5', () => work('pg-5')), null, 'a fifth worker must not exceed the shared DB semaphore');
    release();
    const outcomes = await settledTasks;
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 0, 'concurrent first claims must not leak unique-slot conflicts');
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value !== null).length, 4);
    assert.equal(maximum, 4, 'only one worker may own each of the four slots');

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

    let expiredOwnerWriteReached = false;
    await assert.rejects(firstLeaseService.run('pg-expired-owner', async (lease) => {
      const ownedRow = await firstDatabase.eventWorkerLease.findFirst({ where: { eventId: 'pg-expired-owner' } });
      assert.ok(ownedRow);
      await secondDatabase.eventWorkerLease.updateMany({
        where: { slot: ownedRow.slot, ownerToken: ownedRow.ownerToken }, data: { leaseExpiresAt: new Date(0) },
      });
      await lease.assertOwned();
      expiredOwnerWriteReached = true;
    }), /EVENT_WORKER_LEASE_LOST/);
    assert.equal(expiredOwnerWriteReached, false, 'an expired lease cannot be revived before a side effect');

    let oldLeaseStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => { oldLeaseStarted = resolve; });
    const holdOld = new Promise<void>((resolve) => { releaseOldLease = resolve; });
    const oldRun = firstLeaseService.run('pg-stale-old', async () => {
      oldLeaseStarted();
      await holdOld;
      return 'old-owner';
    });
    const oldOutcome = Promise.allSettled([oldRun]);
    await oldStarted;
    const oldRow = await firstDatabase.eventWorkerLease.findFirst({ where: { eventId: 'pg-stale-old' } });
    assert.ok(oldRow);
    await secondDatabase.eventWorkerLease.updateMany({
      where: { slot: oldRow.slot, ownerToken: oldRow.ownerToken }, data: { leaseExpiresAt: new Date(0) },
    });

    let newLeaseStarted!: () => void;
    const newStarted = new Promise<void>((resolve) => { newLeaseStarted = resolve; });
    const holdNew = new Promise<void>((resolve) => { releaseNewLease = resolve; });
    const newRun = secondLeaseService.run('pg-stale-new', async () => {
      newLeaseStarted();
      await holdNew;
      return 'new-owner';
    });
    const newOutcome = Promise.allSettled([newRun]);
    await newStarted;
    releaseOldLease();
    const [oldResult] = await oldOutcome;
    assert.equal(oldResult.status, 'rejected');
    assert.match(String(oldResult.status === 'rejected' ? oldResult.reason : ''), /EVENT_WORKER_LEASE_LOST/);
    const currentOwner = await firstDatabase.eventWorkerLease.findUnique({ where: { slot: oldRow.slot } });
    assert.equal(currentOwner?.ownerToken === oldRow.ownerToken, false, 'expired ownership can be reclaimed by a fresh worker');
    assert.equal(currentOwner?.eventId, 'pg-stale-new', 'the stale owner cannot release or overwrite the replacement lease');
    releaseNewLease();
    const [newResult] = await newOutcome;
    assert.deepEqual(newResult, { status: 'fulfilled', value: 'new-owner' });
  } finally {
    release();
    releaseOldLease();
    releaseNewLease();
    await firstDatabase.eventWorkerLease.updateMany({
      where: { eventId: 'pg-fenced' }, data: { ownerToken: '', eventId: '', leaseExpiresAt: new Date(0) },
    });
    await firstDatabase.inboundEvent.deleteMany({ where: { id: eventId } });
    await Promise.all([firstDatabase.$disconnect(), secondDatabase.$disconnect()]);
  }
});

test('nightly PostgreSQL scan preserves the latest accepted DELETE when it crosses the 500-row boundary', {
  skip: process.env.ISSUE57_EVENT_RELIABILITY_POSTGRES !== '1',
}, async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, 'Set DATABASE_URL to a disposable PostgreSQL test database');
  const parsedUrl = new URL(databaseUrl);
  assert.match(parsedUrl.hostname, /^(localhost|127\.0\.0\.1)$/i, 'Refusing a non-local test database');
  assert.match(parsedUrl.pathname, /(test|issue57)/i, 'Database name must identify a disposable test database');

  const oldMode = process.env.SYNC_MODE;
  const oldB24Url = process.env.BITRIX24_REST_BASE_URL;
  const oldMsUrl = process.env.MOYSKLAD_API_BASE_URL;
  const oldMsToken = process.env.MOYSKLAD_API_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_REST_BASE_URL = 'http://bitrix-nightly.test/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'http://moysklad-nightly.test/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-nightly-test-token';
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.ok(['bitrix-nightly.test', 'moysklad-nightly.test'].includes(url.hostname), 'nightly provider access must use fake test hosts');
    if (url.hostname === 'bitrix-nightly.test') {
      return new Response(JSON.stringify({ result: { items: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ rows: [], meta: { size: 0, limit: 1000, offset: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const database = new DatabaseService();
  await database.$connect();
  const sourceId = `nightly-delete-${randomUUID()}`;
  const pairId = `nightly-delete-pair-${randomUUID()}`;
  const eventPrefix = `accepted-${randomUUID()}-`;
  const deletedEventId = `${eventPrefix}0500`;
  const createdEventIds = Array.from({ length: 501 }, (_, index) => `${eventPrefix}${String(index).padStart(4, '0')}`);
  const now = new Date();
  const scheduledDate = now.toISOString().slice(0, 10);
  const activeFrom = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const receivedAt = new Date(now.getTime() - 60 * 60 * 1000);
  const settings = new SyncModeService(database);
  const fieldSettings = new FieldSettingsService(database, {} as never, {} as never);
  const service = new SyncRecoveryService(database, settings, {} as never, undefined, fieldSettings, undefined);

  try {
    await database.syncSetting.upsert({
      where: { id: 'global' },
      create: { id: 'global', serviceMode: 'on', modeHistoryTrackedFrom: activeFrom },
      update: { serviceMode: 'on', modeHistoryTrackedFrom: activeFrom },
    });
    await database.syncModeTransition.create({ data: {
      id: `nightly-test-on-${randomUUID()}`, fromMode: 'unknown', toMode: 'on', transitionedAt: activeFrom,
    } });
    await database.syncSetting.update({
      where: { id: 'global' },
      data: {
        nightlyScheduledDate: scheduledDate, nightlyStatus: 'running', nightlyFrom: activeFrom,
        nightlyThrough: new Date(now.getTime() + 60_000), nightlyProvider: 'BITRIX24', nightlyBitrixStatus: 'pending',
        nightlyMoyskladStatus: 'pending', nightlyBitrixEntityTypeId: 3, nightlyBitrixStart: 0, nightlyBitrixLastId: null,
        nightlyMoyskladOffset: 0, nightlyRetryAfter: null, nightlyAttempts: 0, nightlyError: null,
        nightlyLeaseToken: null, nightlyLeaseExpiresAt: null,
      },
    });
    await database.syncDirectionSetting.upsert({
      where: { entityKey: 'contacts-companies' },
      create: { entityKey: 'contacts-companies', bitrix24ToMoysklad: true, moyskladToBitrix24: false },
      update: { bitrix24ToMoysklad: true, moyskladToBitrix24: false },
    });
    await database.entityPair.create({ data: {
      id: pairId, entityType: 'CONTACT', bitrix24Id: sourceId, moyskladId: randomUUID(),
      moyskladType: 'counterparty', source: 'MANUAL', active: true,
    } });
    await database.inboundEvent.createMany({ data: createdEventIds.map((id, index) => ({
      id, source: 'BITRIX24', deliveryKey: `nightly-pg-source-${id}`,
      eventType: id === deletedEventId ? 'ONCRMCONTACTDELETE' : 'ONCRMCONTACTUPDATE',
      externalEntityType: 'contact', externalEntityId: index === 0 || id === deletedEventId ? sourceId : `unpaired-${id}`,
      payload: { synthetic: true }, status: 'SUCCEEDED', receivedAt,
    })) });

    service.onApplicationBootstrap();
    let finalState = null as Awaited<ReturnType<typeof database.syncSetting.findUnique>>;
    for (let attempt = 0; attempt < 150; attempt++) {
      finalState = await database.syncSetting.findUnique({ where: { id: 'global' } });
      if (finalState?.nightlyStatus === 'awaiting_processing' || finalState?.nightlyStatus === 'failed' || finalState?.nightlyStatus === 'skipped') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(finalState?.nightlyStatus, 'awaiting_processing', finalState?.nightlyError ?? 'nightly run did not finish');
    const nightlyRows = await database.inboundEvent.findMany({
      where: { deliveryKey: { startsWith: `nightly:${finalState?.nightlyScheduledDate}:segment:` }, externalEntityId: sourceId },
      select: { eventType: true, externalEntityId: true, externalEntityType: true, deliveryKey: true, payload: true, status: true },
    });
    assert.equal(nightlyRows.length, 1, 'the cross-page identity must stage only its last accepted action');
    assert.deepEqual(nightlyRows[0], {
      eventType: 'ONCRMCONTACTDELETE', externalEntityId: sourceId, externalEntityType: 'contact',
      deliveryKey: `nightly:${finalState?.nightlyScheduledDate}:segment:0:CONTACT:ONCRMCONTACTDELETE:ACTIVE:${sourceId}`,
      payload: { recovery: 'nightly', entity: 'CONTACT', acceptedEventId: deletedEventId }, status: 'RECEIVED',
    });
  } finally {
    service.onModuleDestroy();
    await database.$disconnect();
    globalThis.fetch = originalFetch;
    if (oldMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = oldMode;
    if (oldB24Url === undefined) delete process.env.BITRIX24_REST_BASE_URL; else process.env.BITRIX24_REST_BASE_URL = oldB24Url;
    if (oldMsUrl === undefined) delete process.env.MOYSKLAD_API_BASE_URL; else process.env.MOYSKLAD_API_BASE_URL = oldMsUrl;
    if (oldMsToken === undefined) delete process.env.MOYSKLAD_API_TOKEN; else process.env.MOYSKLAD_API_TOKEN = oldMsToken;
  }
});
