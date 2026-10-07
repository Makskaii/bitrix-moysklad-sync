import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DealOrderBaselineService } from '../src/deals-orders/deal-order-baseline.service';
import { PairFirstEventProcessor } from '../src/pairs/pair-first-event.processor';

const pair = {
  id: 'pair-1', entityType: 'DEAL', bitrix24Id: 'deal-1', moyskladId: 'order-1',
  status: 'MANUAL' as const, source: 'PERSISTED' as const,
};
const currentConfig = { version: 2, config: { rules: [], groups: [] } } as never;

function createDatabase(baselineVersion: number, baselineAppearsAfterCapture = false) {
  const event: {
    id: string; source: string; eventType: string; externalEntityType: string;
    externalEntityId: string; status: string; lastErrorCategory?: string;
  } = {
    id: 'event-1', source: 'BITRIX24', eventType: 'ONCRMDEALUPDATE',
    externalEntityType: 'deal', externalEntityId: 'deal-1', status: 'RECEIVED',
  };
  const baseline = {
    pairId: pair.id, eventId: 'old-event', settingsVersion: baselineVersion,
    capturedAt: new Date('2026-10-01T00:00:00.000Z'), bitrix24UpdatedAt: null, moyskladUpdatedAt: null,
  };
  let baselineReads = 0;
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  return {
    event,
    baseline,
    updates,
    database: {
      inboundEvent: {
        findUnique: async () => event,
        updateMany: async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
          updates.push({ where, data });
          if (event.status === 'RECEIVED') Object.assign(event, data);
          return { count: 1 };
        },
      },
      entityPair: { findFirst: async () => ({ id: pair.id }) },
      entityPairBaseline: {
        findUnique: async () => {
          baselineReads++;
          return baselineAppearsAfterCapture && baselineReads === 1 ? null : baseline;
        },
        createMany: async () => ({ count: 0 }),
      },
    },
  };
}

test('a settings-version drift holds the event for manual review without recapturing the immutable baseline', async () => {
  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  const state = createDatabase(1);
  let sourceReads = 0;
  let headerCalls = 0;
  const processor = new PairFirstEventProcessor(
    state.database as never,
    { resolve: async () => ({ status: 'confirmed', pair }) } as never,
    { eventConfig: async () => currentConfig } as never,
    new DealOrderBaselineService(state.database as never, {
      readBitrix24DealForBaseline: async () => { sourceReads++; return {}; },
      readMoySkladCustomerOrderForBaseline: async () => { sourceReads++; return {}; },
    } as never),
    { process: async () => { headerCalls++; return 'BASELINE_MISSING'; } } as never,
  );

  try {
    await processor.process('event-1');
  } finally {
    if (previousMode === undefined) delete process.env.SYNC_MODE;
    else process.env.SYNC_MODE = previousMode;
  }

  assert.equal(state.event.status, 'MANUAL_REVIEW');
  assert.equal(state.event.lastErrorCategory, 'BASELINE_SETTINGS_VERSION_MISMATCH');
  assert.equal(state.baseline.settingsVersion, 1);
  assert.equal(sourceReads, 0);
  assert.equal(headerCalls, 0);
});

test('a baseline-missing result returned after readiness is durably held for manual review', async () => {
  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  const state = createDatabase(2);
  const processor = new PairFirstEventProcessor(
    state.database as never,
    { resolve: async () => ({ status: 'confirmed', pair }) } as never,
    { eventConfig: async () => currentConfig } as never,
    new DealOrderBaselineService(state.database as never, {
      readBitrix24DealForBaseline: async () => ({}),
      readMoySkladCustomerOrderForBaseline: async () => ({}),
    } as never),
    { process: async () => 'BASELINE_MISSING' } as never,
  );

  try {
    await processor.process('event-1');
  } finally {
    if (previousMode === undefined) delete process.env.SYNC_MODE;
    else process.env.SYNC_MODE = previousMode;
  }

  assert.equal(state.event.status, 'MANUAL_REVIEW');
  assert.equal(state.event.lastErrorCategory, 'DEAL_ORDER_BASELINE_MISSING');
});

test('a concurrent baseline created for another event version is not accepted after readback', async () => {
  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  const state = createDatabase(1, true);
  let sourceReads = 0;
  let headerCalls = 0;
  const processor = new PairFirstEventProcessor(
    state.database as never,
    { resolve: async () => ({ status: 'confirmed', pair }) } as never,
    { eventConfig: async () => currentConfig } as never,
    new DealOrderBaselineService(state.database as never, {
      readBitrix24DealForBaseline: async () => { sourceReads++; return {}; },
      readMoySkladCustomerOrderForBaseline: async () => { sourceReads++; return {}; },
    } as never),
    { process: async () => { headerCalls++; return 'NOOP'; } } as never,
  );

  try {
    await processor.process('event-1');
  } finally {
    if (previousMode === undefined) delete process.env.SYNC_MODE;
    else process.env.SYNC_MODE = previousMode;
  }

  assert.equal(state.event.status, 'MANUAL_REVIEW');
  assert.equal(state.event.lastErrorCategory, 'BASELINE_SETTINGS_VERSION_MISMATCH');
  assert.equal(state.baseline.settingsVersion, 1);
  assert.equal(sourceReads, 2);
  assert.equal(headerCalls, 0);
});
