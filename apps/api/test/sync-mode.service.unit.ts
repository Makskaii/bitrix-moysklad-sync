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
