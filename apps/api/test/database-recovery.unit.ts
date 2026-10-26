import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { isBitrixAdministrator, readBitrixAdministratorIdentity } from '../src/admin/admin-access.guard';
import { DatabaseRecoveryService } from '../src/database-recovery.service';
import { assertApplyExternalWrite, setDatabaseRecoveryReady } from '../src/external-write-guard';

function fakeDatabase(initialMode: 'on' | 'off' = 'off', initialState: Record<string, unknown> | null = null, initialAudits: Record<string, unknown>[] = []) {
  const mode = { serviceMode: initialMode };
  let state = initialState;
  const audits = [...initialAudits];
  const database: Record<string, any> = {
    syncSetting: {
      findUnique: async () => mode,
      upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => { Object.assign(mode, update ?? create); return mode; },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(mode, data); return { count: 1 }; },
    },
    databaseRecoveryState: {
      findUnique: async () => state,
      upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        state = { ...(state ?? create), ...update };
        return state;
      },
    },
    databaseRecoveryAudit: {
      create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; },
      findMany: async () => audits,
      findFirst: async () => audits[0] ?? null,
    },
    $queryRaw: async (query: TemplateStringsArray) => query.join('').includes('AS occupied') ? [{ occupied: false }] : [{ locked: '' }],
    $transaction: async (callback: (transaction: unknown) => unknown) => callback(database),
  };
  return { database, mode, audits, get state() { return state; } };
}

const confirmed = {
  previousLaunchBoundary: '2026-09-01T10:00:00.000Z',
  pairsRestored: true,
  lostEventsAcknowledged: true,
  acknowledgement: 'Queue, snapshots, audit, and manual decisions held only in the lost database are unrecoverable.',
};

test('missing/recreated state fails closed, forces persisted mode Off, and needs explicit recovery', async () => {
  const store = fakeDatabase('on');
  const recovery = new DatabaseRecoveryService(store.database as never);
  await recovery.initialize();
  assert.equal(store.mode.serviceMode, 'off');
  assert.equal((await recovery.readStatus()).status, 'RECOVERY_REQUIRED');
  assert.equal(await recovery.assertReady(), false);
  process.env.SYNC_MODE = 'apply';
  assert.throws(() => assertApplyExternalWrite('MOYSKLAD', 'TEST_WRITE'), /BLOCKED_DATABASE_RECOVERY_REQUIRED/);

  const status = await recovery.confirmRecovery(confirmed, 'BITRIX24_USER:123');
  assert.equal(status.status, 'READY');
  assert.equal(store.mode.serviceMode, 'off');
  assert.equal(await recovery.assertReady(), true);
  assert.equal(store.audits.length, 1);
  assert.equal(store.audits[0].actorId, 'BITRIX24_USER:123');
  assert.equal(new Date(String(store.audits[0].boundaryAt)).toISOString(), confirmed.previousLaunchBoundary);
});

test('restart preserves acknowledged boundary and duplicate recovery confirmation cannot move it', async () => {
  const store = fakeDatabase();
  const recovery = new DatabaseRecoveryService(store.database as never);
  await recovery.confirmRecovery(confirmed, 'BITRIX24_USER:123');
  const firstBoundary = (store.state as { previousLaunchBoundary: Date }).previousLaunchBoundary.getTime();

  await new DatabaseRecoveryService(store.database as never).initialize();
  assert.equal((store.state as { previousLaunchBoundary: Date }).previousLaunchBoundary.getTime(), firstBoundary);
  await assert.rejects(recovery.confirmRecovery({ ...confirmed, previousLaunchBoundary: '2026-09-02T10:00:00.000Z' }, 'BITRIX24_USER:123'), ConflictException);
  assert.equal((store.state as { previousLaunchBoundary: Date }).previousLaunchBoundary.getTime(), firstBoundary);
  assert.equal(store.audits.length, 1);
});

test('restart with valid evidence resumes the persisted mode without another confirmation', async () => {
  const existing = {
    id: 'global', status: 'READY', previousLaunchBoundary: new Date(confirmed.previousLaunchBoundary),
    pairsRestored: true, lostEventsAcknowledged: true, acknowledgedAt: new Date(), acknowledgement: confirmed.acknowledgement,
  };
  const existingAudit = { actorId: 'BITRIX24_USER:123', action: 'DATABASE_LOSS_RECOVERY_CONFIRMED', actorType: 'VERIFIED_BITRIX24_ADMIN', boundaryAt: existing.previousLaunchBoundary, pairsRestored: true, lostEventsAcknowledged: true };
  const store = fakeDatabase('on', existing, [existingAudit]);
  await new DatabaseRecoveryService(store.database as never).initialize();
  assert.equal(store.mode.serviceMode, 'on');
  assert.equal(await new DatabaseRecoveryService(store.database as never).assertReady(), true);
});

test('a READY state without its matching audit is corrupt and does not enable apply', async () => {
  const existing = {
    id: 'global', status: 'READY', previousLaunchBoundary: new Date(confirmed.previousLaunchBoundary),
    pairsRestored: true, lostEventsAcknowledged: true, acknowledgedAt: new Date(), acknowledgement: confirmed.acknowledgement,
  };
  const store = fakeDatabase('on', existing);
  const recovery = new DatabaseRecoveryService(store.database as never);
  await recovery.initialize();
  assert.equal(store.mode.serviceMode, 'off');
  assert.equal(await recovery.assertReady(), false);
});

test('recovery requires all acknowledgements and a verified admin identity', async () => {
  const recovery = new DatabaseRecoveryService(fakeDatabase().database as never);
  await assert.rejects(recovery.confirmRecovery({ ...confirmed, lostEventsAcknowledged: false }, 'BITRIX24_USER:123'));
  await assert.rejects(recovery.confirmRecovery(confirmed, ''));
  await assert.rejects(recovery.confirmRecovery({ ...confirmed, previousLaunchBoundary: 'bad-date' }, 'BITRIX24_USER:123'));
  await assert.rejects(recovery.confirmRecovery({ ...confirmed, previousLaunchBoundary: '2026-09-01' }, 'BITRIX24_USER:123'));
  await assert.rejects(recovery.confirmRecovery({ ...confirmed, previousLaunchBoundary: '2026-09-01T10:00:00' }, 'BITRIX24_USER:123'));
});

test('stale Bitrix credentials do not pass the admin check (fake provider)', async () => {
  const staleResponse = new Response(JSON.stringify({ result: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  const validResponse = new Response(JSON.stringify({ result: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  const stale = await isBitrixAdministrator('stale-token', async () => staleResponse.clone());
  const valid = await isBitrixAdministrator('current-token', async () => validResponse.clone());
  assert.equal(stale, false);
  assert.equal(valid, true);
  const identity = await readBitrixAdministratorIdentity('current-token', async () => new Response(JSON.stringify({ result: { ID: '123' } }), { status: 200 }));
  assert.equal(identity, 'BITRIX24_USER:123');
  const staleIdentity = await readBitrixAdministratorIdentity('stale-token', async () => new Response(JSON.stringify({ result: {} }), { status: 200 }));
  assert.equal(staleIdentity, null);
});

test('dry mode still blocks writes even after database recovery is acknowledged', () => {
  setDatabaseRecoveryReady(true);
  process.env.SYNC_MODE = 'dry';
  assert.throws(() => assertApplyExternalWrite('BITRIX24', 'TEST_WRITE'), /WRITE_REQUIRES_APPLY_MODE/);
});

test('admin audit identity uses base-scope profile without widening application permissions', async () => {
  const calls: string[] = [];
  const identity = await readBitrixAdministratorIdentity('test-admin-token', async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ result: { ID: '3664', ADMIN: true } }), { status: 200 });
  });
  assert.equal(identity, 'BITRIX24_USER:3664');
  assert.deepEqual(calls, ['https://aerosystems.bitrix24.ru/rest/profile.json']);
  assert.equal(await readBitrixAdministratorIdentity('nonadmin', async () => new Response(JSON.stringify({ result: { ID: '7', ADMIN: false } }), { status: 200 })), null);
  assert.equal(await readBitrixAdministratorIdentity('inactive', async () => new Response(JSON.stringify({ result: [] }), { status: 200 })), null);
});

test('clean first launch uses server time without false recovery declarations and survives restart', async () => {
  const store = fakeDatabase();
  const service = new DatabaseRecoveryService(store.database as never);
  const before = Date.now();
  const status = await service.confirmFirstLaunch({ confirmed: true, acknowledgement: 'Explicit clean first production launch; old history is excluded.' }, 'BITRIX24_USER:3664');
  assert.equal(status.status, 'READY_FRESH');
  assert.equal(status.pairsRestored, false);
  assert.equal(status.lostEventsAcknowledged, false);
  assert.ok(status.previousLaunchBoundary!.getTime() >= before);
  assert.ok(status.previousLaunchBoundary!.getTime() <= Date.now());
  assert.equal(store.mode.serviceMode, 'off');
  assert.equal(store.audits[0]?.action, 'FIRST_LAUNCH_CONFIRMED');
  await service.initialize();
  assert.equal(await service.assertReady(), true);
  await assert.rejects(service.confirmFirstLaunch({ confirmed: true, acknowledgement: 'Attempt to replace the already recorded first launch boundary.' }, 'BITRIX24_USER:3664'), ConflictException);
  await assert.rejects(service.confirmRecovery(confirmed, 'BITRIX24_USER:3664'), ConflictException);
});

test('first launch rejects existing exchange history, unverified actors, absent consent and On mode', async () => {
  const store = fakeDatabase();
  const service = new DatabaseRecoveryService(store.database as never);
  const input = { confirmed: true, acknowledgement: 'New clean first launch without any previous exchange history.' };
  await assert.rejects(service.confirmFirstLaunch(input, ''));
  await assert.rejects(service.confirmFirstLaunch({ ...input, confirmed: false }, 'BITRIX24_USER:3664'));
  store.database.$queryRaw = async (query: TemplateStringsArray) => query.join('').includes('AS occupied') ? [{ occupied: true }] : [];
  await assert.rejects(service.confirmFirstLaunch(input, 'BITRIX24_USER:3664'), /empty exchange database/);
  assert.equal(store.audits.length, 0);
  store.database.$queryRaw = async () => [{ occupied: false }];
  store.mode.serviceMode = 'on';
  await assert.rejects(service.confirmFirstLaunch(input, 'BITRIX24_USER:3664'), /mode Off/);
});
