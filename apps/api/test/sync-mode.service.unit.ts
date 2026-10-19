import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SyncModeService } from '../src/sync-mode.service';
import { SyncRecoveryService } from '../src/sync-recovery.service';
import { DatabaseRecoveryService } from '../src/database-recovery.service';

test('leaving OFF never schedules or retains an OFF-period replay job', async () => {
  const state: Record<string, unknown> = {
    serviceMode: 'on',
    offSince: null,
    resumeStatus: 'idle',
  };
  const database = {
    syncSetting: {
      upsert: async () => ({ ...state }),
      update: async ({ data, select }: { data: Record<string, unknown>; select: Record<string, boolean> }) => {
        Object.assign(state, data);
        return Object.fromEntries(Object.keys(select).map((key) => [key, state[key]]));
      },
    },
  };
  const service = new SyncModeService(database as never);

  await service.setMode('off');
  assert.equal(state.serviceMode, 'off');
  assert.equal(state.resumeStatus, 'skipped');
  assert.match(String(state.resumeError), /not replayed/i);
  const lastInactiveAt = state.lastInactiveAt;
  assert.ok(lastInactiveAt instanceof Date);

  await service.setMode('on');
  assert.equal(state.serviceMode, 'on');
  assert.equal(state.offSince, null);
  assert.equal(state.resumeStatus, 'skipped');
  assert.equal(state.resumeFrom, null);
  assert.equal(state.resumeThrough, null);
  assert.equal(state.lastInactiveAt, lastInactiveAt);
});

test('test ON, pause, and resume never establish or move the separately confirmed launch boundary', async () => {
  const boundary = new Date('2026-10-01T08:00:00.000Z');
  const recoveryState = {
    id: 'global', status: 'READY', previousLaunchBoundary: boundary, pairsRestored: true,
    lostEventsAcknowledged: true, acknowledgedAt: new Date('2026-10-01T08:05:00.000Z'),
    acknowledgement: 'Independent operations record confirmed for this launch.',
  };
  const modeState: Record<string, unknown> = { serviceMode: 'off', offSince: null, resumeStatus: 'idle' };
  const database = {
    databaseRecoveryState: { findUnique: async () => recoveryState },
    databaseRecoveryAudit: { findFirst: async () => ({ actorId: 'BITRIX24_USER:123' }) },
    syncSetting: {
      upsert: async () => ({ ...modeState }),
      update: async ({ data, select }: { data: Record<string, unknown>; select: Record<string, boolean> }) => {
        Object.assign(modeState, data);
        return Object.fromEntries(Object.keys(select).map((key) => [key, modeState[key]]));
      },
    },
  };
  const recovery = new DatabaseRecoveryService(database as never);
  const syncMode = new SyncModeService(database as never, recovery);

  assert.equal((await recovery.launchBoundary())?.toISOString(), boundary.toISOString());
  await syncMode.setMode('on');
  await syncMode.setMode('pause');
  await syncMode.setMode('on');
  assert.equal((await recovery.launchBoundary())?.toISOString(), boundary.toISOString());
  assert.equal(modeState.serviceMode, 'on');
});

test('implemented scopes are visible with independent directions disabled until explicitly enabled', async () => {
  const settings = new Map<string, { bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean }>();
  const database = {
    syncDirectionSetting: {
      upsert: async ({ where, create }: { where: { entityKey: string }; create: { entityKey: string; bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean } }) => {
        const current = settings.get(where.entityKey) ?? { bitrix24ToMoysklad: create.bitrix24ToMoysklad, moyskladToBitrix24: create.moyskladToBitrix24 };
        settings.set(where.entityKey, current);
        return current;
      },
      findUnique: async ({ where }: { where: { entityKey: string } }) => settings.get(where.entityKey) ?? null,
      update: async ({ where, data }: { where: { entityKey: string }; data: { bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean } }) => {
        settings.set(where.entityKey, data);
        return data;
      },
    },
  };
  const service = new SyncModeService(database as never);

  const scopes = await service.readEntitySettings();
  const invoices = scopes.find((scope) => scope.key === 'invoices')!;
  const products = scopes.find((scope) => scope.key === 'products-variations')!;
  const deals = scopes.find((scope) => scope.key === 'deals-orders')!;

  assert.equal(invoices.implementation, 'implemented');
  assert.equal(products.implementation, 'implemented');
  assert.equal(deals.implementation, 'implemented');
  assert.ok(products.directionScope);
  assert.ok(deals.directionScope);
  assert.equal(invoices.ready, true);
  assert.equal(products.ready, true);
  assert.equal(deals.ready, true);
  assert.equal(invoices.bitrix24ToMoysklad, false);
  assert.equal(invoices.moyskladToBitrix24, false);
  assert.equal(scopes.find((scope) => scope.key === 'contacts-companies')?.bitrix24ToMoysklad, true);
  assert.equal(products.bitrix24ToMoysklad, false);
  assert.equal(products.moyskladToBitrix24, false);
  assert.equal(deals.bitrix24ToMoysklad, false);
  assert.equal(deals.moyskladToBitrix24, false);
  assert.deepEqual([...settings.keys()].sort(), ['contacts-companies', 'deals-orders', 'invoices', 'products-variations']);
});

test('a missing new-scope direction row is never treated as enabled', async () => {
  const service = new SyncModeService({ syncDirectionSetting: { findUnique: async () => null } } as never);
  assert.equal(await service.isDirectionEnabled('deals-orders', 'bitrix24ToMoysklad'), false);
  assert.equal(await service.isDirectionEnabled('invoices', 'moyskladToBitrix24'), false);
  assert.equal(await service.isDirectionEnabled('products-variations', 'moyskladToBitrix24'), false);
  assert.equal(await service.isDirectionEnabled('contacts-companies', 'bitrix24ToMoysklad'), true);
});

test('an enabled direction is blocked until its own read-only API and webhook-auth preflight passes', async () => {
  const state = { bitrix24ToMoysklad: false, moyskladToBitrix24: false };
  let updates = 0;
  const database = {
    syncDirectionSetting: {
      upsert: async () => state,
      findUnique: async () => state,
      update: async ({ data }: { data: typeof state }) => { updates++; Object.assign(state, data); return state; },
    },
  };
  const fieldSettings = { active: async () => ({ version: 3, config: { rules: [], references: { namedPairs: [] } } }) };
  const fieldData = { fieldCatalogs: async (_token: string, _entity: string) => ({ bitrix24: [], moysklad: [] }) };
  const service = new SyncModeService(database as never, undefined, undefined, fieldSettings as never, fieldData as never);
  const oldSecret = process.env.MOYSKLAD_WEBHOOK_SECRET;
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'test-only-secret';
  try {
    await assert.rejects(
      service.setEntityDirections('invoices', { bitrix24ToMoysklad: false, moyskladToBitrix24: true }),
      (error: unknown) => error instanceof Error && error.message.includes('SYNC_PREFLIGHT_BLOCKED'),
    );
    assert.equal(updates, 0);
    const report = await service.preflightEntityDirection('invoices', 'moyskladToBitrix24', 'admin-token');
    assert.equal(report.canEnable, true);
    await service.setEntityDirections('invoices', { bitrix24ToMoysklad: false, moyskladToBitrix24: true }, 'admin-token');
    assert.equal(updates, 1);
    assert.equal(state.bitrix24ToMoysklad, false);
    assert.equal(state.moyskladToBitrix24, true);
  } finally {
    if (oldSecret === undefined) delete process.env.MOYSKLAD_WEBHOOK_SECRET;
    else process.env.MOYSKLAD_WEBHOOK_SECRET = oldSecret;
  }
});

test('PAUSE timestamps the recovery window without scheduling an OFF replay', async () => {
  const state: Record<string, unknown> = {
    serviceMode: 'on', offSince: null, resumeStatus: 'idle',
  };
  const database = {
    syncSetting: {
      upsert: async () => ({ ...state }),
      update: async ({ data, select }: { data: Record<string, unknown>; select: Record<string, boolean> }) => {
        Object.assign(state, data);
        return Object.fromEntries(Object.keys(select).map((key) => [key, state[key]]));
      },
    },
  };
  const service = new SyncModeService(database as never);

  await service.setMode('pause');
  assert.equal(state.serviceMode, 'pause');
  assert.ok(state.lastInactiveAt instanceof Date);
  assert.equal(state.resumeStatus, 'idle');
  const lastInactiveAt = state.lastInactiveAt;

  await service.setMode('on');
  assert.ok(state.lastActiveAt instanceof Date);
  assert.equal(state.lastInactiveAt, lastInactiveAt);
});

test('nightly execution skips if an inactive interval touched the window after scheduling', async () => {
  const now = new Date();
  const state = {
    lastInactiveAt: new Date(now.getTime() - 60_000),
    lastActiveAt: new Date(now.getTime() - 30_000),
  };
  const syncMode = { read: async () => ({ mode: 'on' }) };
  const recovery = new SyncRecoveryService({} as never, syncMode as never, {} as never);
  const oldMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  try {
    const mustSkip = await (recovery as unknown as {
      nightlyMustSkip: (setting: typeof state, at: Date) => Promise<boolean>;
    }).nightlyMustSkip(state, now);
    assert.equal(mustSkip, true);
  } finally {
    if (oldMode === undefined) delete process.env.SYNC_MODE;
    else process.env.SYNC_MODE = oldMode;
  }
});

test('deal/order provider mutation remains inside the active-pair lifecycle lease', async () => {
  let locked = false;
  let activeChecks = 0;
  const database = {
    syncSetting: { findUnique: async () => ({ serviceMode: 'on' }) },
    syncDirectionSetting: { findUnique: async () => ({ bitrix24ToMoysklad: true, moyskladToBitrix24: true }) },
  };
  const lifecycle = {
    withPairActiveLock: async <T>(_pairId: string, _type: string, work: () => Promise<T>) => {
      assert.equal(locked, false);
      locked = true;
      try { return await work(); } finally { locked = false; }
    },
    assertPairActive: async () => { activeChecks += 1; assert.equal(locked, true); },
  };
  const service = new SyncModeService(database as never, undefined, lifecycle as never);
  const oldMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  try {
    const result = await service.runDealOrderExternalWrite('moyskladToBitrix24', async () => true,
      { id: 'pair-1', entityType: 'DEAL' }, async () => {
        assert.equal(locked, true);
        return 'written';
      });
    assert.equal(result, 'written');
    assert.equal(activeChecks, 1);
    assert.equal(locked, false);
  } finally {
    if (oldMode === undefined) delete process.env.SYNC_MODE;
    else process.env.SYNC_MODE = oldMode;
  }
});
