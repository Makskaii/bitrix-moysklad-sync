import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SyncModeService } from '../src/sync-mode.service';
import { SyncRecoveryService } from '../src/sync-recovery.service';

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

test('implemented scopes stay visible to readiness checks but remain disabled until preflight is complete', async () => {
  const settings = new Map<string, { bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean }>();
  const database = {
    syncDirectionSetting: {
      upsert: async ({ where, create }: { where: { entityKey: string }; create: { entityKey: string } }) => {
        const current = settings.get(where.entityKey) ?? { bitrix24ToMoysklad: true, moyskladToBitrix24: true };
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
  assert.equal(products.ready, false);
  assert.equal(products.bitrix24ToMoysklad, false);
  assert.equal(products.moyskladToBitrix24, false);
  await assert.rejects(service.setEntityDirections('products-variations', {
    bitrix24ToMoysklad: false, moyskladToBitrix24: true,
  }), /not ready/i);
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
