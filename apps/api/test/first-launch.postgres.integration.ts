import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { DatabaseRecoveryService } from '../src/database-recovery.service';
import { SyncModeService } from '../src/sync-mode.service';

test('first launch is exclusive, audited, restart-safe and cannot reset an occupied database', {
  skip: process.env.FIRST_LAUNCH_POSTGRES !== '1',
}, async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /_test$/);
  assert.match(url.searchParams.get('schema') ?? '', /^first_launch_.*_test$/);
  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  const db = new DatabaseService();
  const service = new DatabaseRecoveryService(db);
  try {
    assert.equal(await db.databaseRecoveryState.count(), 0);
    assert.equal(await db.inboundEvent.count(), 0);
    await db.syncSetting.create({ data: { id: 'global', serviceMode: 'off' } });
    const input = { confirmed: true, acknowledgement: 'Explicit first launch on new empty database; previous history is not imported.' };
    // An occupied trial database must not be silently cleared or acknowledged.
    const event = await db.inboundEvent.create({ data: {
      source: 'BITRIX24', deliveryKey: 'first-launch-occupied-fixture', eventType: 'ONCRMCOMPANYUPDATE', externalEntityId: '999',
      payload: {}, status: 'RECEIVED',
    } });
    await assert.rejects(service.confirmFirstLaunch(input, 'BITRIX24_USER:3664'), /empty exchange database/);
    assert.equal(await db.databaseRecoveryAudit.count(), 0);
    assert.equal(await db.inboundEvent.count(), 1);
    // Delete only this locally-created disposable fixture, never production history.
    await db.inboundEvent.delete({ where: { id: event.id } });
    const transition = await db.syncModeTransition.create({ data: { fromMode: 'on', toMode: 'off', transitionedAt: new Date() } });
    await assert.rejects(service.confirmFirstLaunch(input, 'BITRIX24_USER:3664'), /empty exchange database/);
    await db.syncModeTransition.delete({ where: { id: transition.id } });
    await db.syncSetting.update({ where: { id: 'global' }, data: { lastActiveAt: new Date() } });
    await assert.rejects(service.confirmFirstLaunch(input, 'BITRIX24_USER:3664'), /prior activation history/);
    await db.syncSetting.update({ where: { id: 'global' }, data: { lastActiveAt: null } });
    const before = Date.now();
    const result = await Promise.allSettled([
      service.confirmFirstLaunch(input, 'BITRIX24_USER:3664'),
      service.confirmFirstLaunch(input, 'BITRIX24_USER:3664'),
    ]);
    assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(await db.databaseRecoveryAudit.count(), 1);
    const status = await service.readStatus();
    assert.equal(status.status, 'READY_FRESH');
    assert.equal(status.pairsRestored, false);
    assert.equal(status.lostEventsAcknowledged, false);
    assert.ok(status.previousLaunchBoundary!.getTime() >= before);
    const audit = await db.databaseRecoveryAudit.findFirstOrThrow();
    assert.equal(audit.action, 'FIRST_LAUNCH_CONFIRMED');
    assert.equal(audit.actorId, 'BITRIX24_USER:3664');
    assert.equal(audit.boundaryAt.getTime(), status.previousLaunchBoundary!.getTime());
    assert.equal((await db.syncSetting.findUniqueOrThrow({ where: { id: 'global' } })).serviceMode, 'off');
    const restarted = new DatabaseRecoveryService(db);
    await restarted.initialize();
    assert.equal(await restarted.assertReady(), true);
    await new SyncModeService(db, restarted).setMode('on');
    await restarted.initialize();
    assert.equal((await db.syncSetting.findUniqueOrThrow({ where: { id: 'global' } })).serviceMode, 'on');
    assert.equal(await db.inboundEvent.count(), 0);
    await assert.rejects(restarted.confirmFirstLaunch(input, 'BITRIX24_USER:3664'), /boundary already exists/);
    assert.equal(await db.databaseRecoveryAudit.count(), 1);
  } finally {
    process.env.SYNC_MODE = previousMode;
    await db.$disconnect();
  }
});
