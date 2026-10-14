import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { DatabaseRecoveryService } from '../src/database-recovery.service';
import { assertApplyExternalWrite } from '../src/external-write-guard';
import { readBitrixAdministratorIdentity } from '../src/admin/admin-access.guard';
import { SyncModeService } from '../src/sync-mode.service';
import { EventIntakeService } from '../src/events.controller';

test('empty database fails closed; an admin recovery acknowledgement survives restart without replay', {
  skip: process.env.ISSUE57_DB_RECOVERY_POSTGRES !== '1',
}, async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, 'Set DATABASE_URL to a disposable PostgreSQL test schema');
  const parsedUrl = new URL(databaseUrl);
  assert.match(parsedUrl.hostname, /^(localhost|127\.0\.0\.1)$/i, 'Refusing a non-local test database');
  assert.match(parsedUrl.pathname, /(test|issue57)/i, 'Database name must identify a disposable test database');

  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  const database = new DatabaseService();
  const recovery = new DatabaseRecoveryService(database);
  try {
    const encoding = await database.$queryRaw<Array<{ encoding: string }>>`SELECT current_setting('server_encoding') AS encoding`;
    assert.equal(encoding[0]?.encoding, 'UTF8');

    assert.equal(await database.databaseRecoveryAudit.count(), 0, 'Use a fresh disposable database; audit rows are intentionally immutable');
    assert.equal(await database.databaseRecoveryState.count(), 0, 'This scenario starts from an empty migrated database');
    assert.equal(await database.inboundEvent.count(), 0, 'This scenario must not reuse a database with prior events');
    await database.syncSetting.upsert({
      where: { id: 'global' }, create: { serviceMode: 'on' }, update: { serviceMode: 'on' },
    });
    await recovery.initialize();
    assert.equal((await database.syncSetting.findUnique({ where: { id: 'global' } }))?.serviceMode, 'off');
    assert.equal((await recovery.readStatus()).status, 'RECOVERY_REQUIRED');
    assert.throws(() => assertApplyExternalWrite('MOYSKLAD', 'TEST_WRITE'), /BLOCKED_DATABASE_RECOVERY_REQUIRED/);

    process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'fake-b24-event-token';
    const syncMode = new SyncModeService(database, recovery);
    await assert.rejects(syncMode.setMode('on'), /Database loss recovery must be explicitly confirmed/);
    const intake = new EventIntakeService(database, syncMode, undefined, undefined, recovery);
    await assert.rejects(intake.receiveBitrix24({
      event: 'ONCRMCONTACTUPDATE', auth: { application_token: 'fake-b24-event-token' }, data: { FIELDS: { ID: '123' } },
    }), /Database loss recovery is required/);

    const fakeAdminApi = async () => new Response(JSON.stringify({ result: { ID: '42' } }), { status: 200 });
    const actorId = await readBitrixAdministratorIdentity('fake-valid-admin-token', fakeAdminApi);
    assert.equal(actorId, 'BITRIX24_USER:42');
    const boundary = '2026-09-01T10:00:00.000Z';
    await recovery.confirmRecovery({
      previousLaunchBoundary: boundary, pairsRestored: true, lostEventsAcknowledged: true,
      acknowledgement: 'Events, snapshots, audit, and manual decisions stored only in the lost database are unrecoverable.',
    }, actorId!);
    const audit = await database.databaseRecoveryAudit.findFirst({ orderBy: { occurredAt: 'desc' } });
    assert.equal(audit?.actorId, 'BITRIX24_USER:42');
    assert.equal(audit?.boundaryAt.toISOString(), boundary);
    assert.equal(audit?.pairsRestored, true);
    assert.equal(audit?.lostEventsAcknowledged, true);
    assert.equal((await database.syncSetting.findUnique({ where: { id: 'global' } }))?.serviceMode, 'off');

    await syncMode.setMode('pause');
    const accepted = await intake.receiveBitrix24({
      event: 'ONCRMCONTACTUPDATE', auth: { application_token: 'fake-b24-event-token' }, data: { FIELDS: { ID: '123' } },
    });
    assert.equal((await database.inboundEvent.findUnique({ where: { id: accepted.eventId } }))?.status, 'RECEIVED');

    const eventCountBeforeRestart = await database.inboundEvent.count();
    await syncMode.setMode('on');
    const activationTime = (await database.syncSetting.findUnique({ where: { id: 'global' } }))?.lastActiveAt?.getTime();
    await syncMode.setMode('on');
    assert.equal((await database.syncSetting.findUnique({ where: { id: 'global' } }))?.lastActiveAt?.getTime(), activationTime, 'Repeated activation must preserve the current launch state');
    const restarted = new DatabaseRecoveryService(database);
    await restarted.initialize();
    assert.equal((await restarted.readStatus()).previousLaunchBoundary?.toISOString(), boundary);
    assert.equal((await database.syncSetting.findUnique({ where: { id: 'global' } }))?.serviceMode, 'on');
    assert.equal(await database.inboundEvent.count(), eventCountBeforeRestart, 'Recovery must not synthesize or replay events');
    assert.doesNotThrow(() => assertApplyExternalWrite('BITRIX24', 'TEST_WRITE'));
  } finally {
    await database.$disconnect();
    if (previousMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = previousMode;
  }
});
