import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DealOrderBaselineService } from '../src/deals-orders/deal-order-baseline.service';
import { PairFirstEventProcessor } from '../src/pairs/pair-first-event.processor';
import { ControlledLiveTestAdmissionService } from '../src/controlled-live-test-admission.service';
import { setVerifiedControlledLiveProviderNamespace } from '../src/controlled-live-test-namespace';

const pair = {
  id: 'pair-1', entityType: 'DEAL', bitrix24Id: 'deal-1', moyskladId: 'order-1',
  status: 'MANUAL' as const, source: 'PERSISTED' as const,
};
const currentConfig = { version: 2, config: { rules: [], groups: [] } } as never;

function createDatabase(baselineVersion: number, baselineAppearsAfterCapture = false) {
  const event: {
    id: string; source: string; eventType: string; externalEntityType: string;
    externalEntityId: string; status: string; lastErrorCategory?: string; processingStartedAt?: Date | null; retryAfter?: Date | null; attempts?: number;
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
  const database = {
    inboundEvent: {
      findUnique: async () => event,
      updateMany: async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
        updates.push({ where, data });
        if (event.status === 'RECEIVED' || event.status === 'PROCESSING' || event.status === 'RETRYABLE_FAILURE') Object.assign(event, data);
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
    $queryRaw: async () => [{ serviceMode: 'on' }],
    $transaction: async (work: (transaction: unknown) => Promise<unknown>) => work(database),
  };
  return {
    event,
    baseline,
    updates,
    database,
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
    { processClient: async () => { headerCalls++; return 'UNSUPPORTED'; }, process: async () => { headerCalls++; return 'BASELINE_MISSING'; } } as never,
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
    { processClient: async () => 'UNSUPPORTED', process: async () => 'BASELINE_MISSING' } as never,
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

test('a pre-boundary deal event received after recovery and later On stays terminally skipped', async () => {
  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  const state = createDatabase(2);
  let resolverCalls = 0;
  const processor = new PairFirstEventProcessor(
    state.database as never,
    { resolve: async () => { resolverCalls++; return { status: 'confirmed', pair }; } } as never,
    undefined, undefined, undefined, undefined,
    { read: async () => ({ mode: 'on' }) } as never,
    undefined,
    { readDealOrderCreationTimestamp: async () => new Date('2026-08-31T10:00:00.000Z') } as never,
    { launchBoundary: async () => new Date('2026-09-01T10:00:00.000Z') } as never,
  );

  try {
    await processor.process('event-1');
  } finally {
    if (previousMode === undefined) delete process.env.SYNC_MODE;
    else process.env.SYNC_MODE = previousMode;
  }

  assert.equal(state.event.status, 'SKIPPED_PRE_LAUNCH');
  assert.equal(state.event.lastErrorCategory, 'PRE_LAUNCH_DOCUMENT');
  assert.equal(resolverCalls, 0);
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

test('pair-first workers leave durable events unclaimed while paused', async () => {
  let reads = 0;
  let claims = 0;
  let resolutions = 0;
  const event = {
    id: 'event-paused', source: 'BITRIX24', eventType: 'ONCRMDEALUPDATE', externalEntityType: 'deal',
    externalEntityId: 'deal-paused', status: 'RECEIVED', attempts: 0, processingStartedAt: null, retryAfter: null,
  };
  const processor = new PairFirstEventProcessor(
    { inboundEvent: {
      findUnique: async () => { reads++; return event; },
      updateMany: async () => { claims++; return { count: 1 }; },
    },
      $queryRaw: async () => [{ serviceMode: 'on' }],
      $transaction: async (work: (transaction: unknown) => Promise<unknown>) => work({ $queryRaw: async () => [{ serviceMode: 'on' }] }),
    } as never,
    { resolve: async () => { resolutions++; return { status: 'unavailable', reason: 'unused' }; } } as never,
    undefined, undefined, undefined, undefined,
    { read: async () => ({ mode: 'pause' }) } as never,
  );
  assert.equal(await processor.process('event-paused'), null);
  assert.equal(reads, 1, 'the worker may load durable queue metadata while paused');
  assert.equal(claims, 0, 'the worker must leave the queued event unclaimed');
  assert.equal(resolutions, 0, 'the worker must not resolve a pair while paused');
  assert.equal(event.status, 'RECEIVED');
});

test('a deal event resolves its pinned company and contact dependencies before baseline processing', async () => {
  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  const state = createDatabase(2);
  const calls: Array<{ eventId: string; sourceSystem: string; entity: string; sourceId: string; primaryCompanySourceId?: string | null; lease?: unknown }> = [];
  const processor = new PairFirstEventProcessor(
    state.database as never,
    { resolve: async () => ({ status: 'confirmed', pair }) } as never,
    { eventConfig: async () => currentConfig } as never,
    new DealOrderBaselineService(state.database as never, {
      readBitrix24DealForBaseline: async () => ({ COMPANY_ID: 'company-8', CONTACT_ID: 'contact-9' }),
      readMoySkladCustomerOrderForBaseline: async () => ({}),
    } as never),
    { processClient: async () => 'UNSUPPORTED', process: async () => 'NOOP' } as never,
    undefined,
    { read: async () => ({ mode: 'on' }) } as never,
    { resolveForDocument: async (input: typeof calls[number]) => { calls.push(input); return { status: 'RESOLVED', pair, selectedSourceId: input.sourceId, reason: 'PERSISTED_PAIR' }; } } as never,
    { readBitrix24DealForBaseline: async () => ({ COMPANY_ID: 'company-8', CONTACT_ID: 'contact-9' }) } as never,
  );

  try {
    await processor.process('event-1');
  } finally {
    if (previousMode === undefined) delete process.env.SYNC_MODE;
    else process.env.SYNC_MODE = previousMode;
  }

  assert.deepEqual(calls.map(({ entity, sourceId, primaryCompanySourceId }) => ({ entity, sourceId, primaryCompanySourceId })), [
    { entity: 'COMPANY', sourceId: 'company-8', primaryCompanySourceId: null },
    { entity: 'CONTACT', sourceId: 'contact-9', primaryCompanySourceId: 'company-8' },
  ]);
  assert.ok(calls.every((call) => call.eventId === 'event-1' && call.sourceSystem === 'BITRIX24'));
  assert.equal(state.event.status, 'SUCCEEDED');
});

test('an optional contact dependency failure is queued separately and does not block the company-backed document', async () => {
  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  const state = createDatabase(2);
  const scheduled: Array<{ eventId: string; sourceSystem: string; entity: string; sourceId: string; primaryCompanySourceId?: string | null; reason: string }> = [];
  const processor = new PairFirstEventProcessor(
    state.database as never,
    { resolve: async () => ({ status: 'confirmed', pair }) } as never,
    { eventConfig: async () => currentConfig } as never,
    new DealOrderBaselineService(state.database as never, {
      readBitrix24DealForBaseline: async () => ({ COMPANY_ID: 'company-8', CONTACT_ID: 'contact-9' }),
      readMoySkladCustomerOrderForBaseline: async () => ({}),
    } as never),
    { processClient: async () => 'UNSUPPORTED', process: async () => 'NOOP' } as never,
    undefined,
    { read: async () => ({ mode: 'on' }) } as never,
    {
      resolveForDocument: async (input: typeof scheduled[number]) => input.entity === 'CONTACT'
        ? { status: 'REVIEW', reason: 'CLIENT_PROVIDER_REJECTED' }
        : { status: 'RESOLVED', pair, selectedSourceId: input.sourceId, reason: 'PERSISTED_PAIR' },
      scheduleOptionalContactRetry: async (input: typeof scheduled[number], reason: string) => { scheduled.push({ ...input, reason }); },
    } as never,
    { readBitrix24DealForBaseline: async () => ({ COMPANY_ID: 'company-8', CONTACT_ID: 'contact-9' }) } as never,
  );

  try { await processor.process('event-1'); }
  finally {
    if (previousMode === undefined) delete process.env.SYNC_MODE;
    else process.env.SYNC_MODE = previousMode;
  }

  assert.equal(state.event.status, 'SUCCEEDED');
  assert.equal(scheduled.length, 1);
  assert.deepEqual({ entity: scheduled[0]?.entity, sourceId: scheduled[0]?.sourceId, primaryCompanySourceId: scheduled[0]?.primaryCompanySourceId, reason: scheduled[0]?.reason }, {
    entity: 'CONTACT', sourceId: 'contact-9', primaryCompanySourceId: 'company-8', reason: 'CLIENT_PROVIDER_REJECTED',
  });
});

test('a document with no client is held only when no service counterparty is configured', async () => {
  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  const state = createDatabase(2);
  const processor = new PairFirstEventProcessor(
    state.database as never,
    { resolve: async () => ({ status: 'confirmed', pair }) } as never,
    { eventConfig: async () => currentConfig } as never,
    new DealOrderBaselineService(state.database as never, {
      readBitrix24DealForBaseline: async () => ({}), readMoySkladCustomerOrderForBaseline: async () => ({}),
    } as never),
    { processClient: async () => 'UNSUPPORTED', process: async () => 'NOOP' } as never,
    undefined,
    { read: async () => ({ mode: 'on' }) } as never,
    { resolveForDocument: async () => { assert.fail('no explicit client should not invoke client resolution'); } } as never,
    { readBitrix24DealForBaseline: async () => ({}) } as never,
  );
  try { await processor.process('event-1'); }
  finally {
    if (previousMode === undefined) delete process.env.SYNC_MODE;
    else process.env.SYNC_MODE = previousMode;
  }
  assert.equal(state.event.status, 'MANUAL_REVIEW');
  assert.equal(state.event.lastErrorCategory, 'SERVICE_COUNTERPARTY_NOT_CONFIGURED');
});

test('controlled deal event verifies the current source, persists admission, then rehydrates scope for worker dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue60-deal-event-'));
  const manifestPath = join(directory, 'manifest.json');
  const runId = 'LIVE-TEST-20261019T120000Z-deal01';
  const name = `тест ${runId} deal`;
  const providerNamespace = { bitrix24PortalOrigin: 'https://issue60-b24-test.invalid', bitrix24UserId: '42', moyskladAccountId: 'b0b309ee-13e3-11e9-9109-f8fc0001f188' };
  const now = new Date();
  const previous = { mode: process.env.CONTROLLED_LIVE_TEST_MODE, instance: process.env.CONTROLLED_LIVE_TEST_INSTANCE,
    manifest: process.env.CONTROLLED_LIVE_TEST_MANIFEST, database: process.env.DATABASE_URL, sync: process.env.SYNC_MODE };
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled'; process.env.CONTROLLED_LIVE_TEST_INSTANCE = 'isolated';
  process.env.CONTROLLED_LIVE_TEST_MANIFEST = manifestPath; process.env.DATABASE_URL = 'postgres://localhost/sync_issue60_test?schema=issue60_harness_test'; process.env.SYNC_MODE = 'apply';
  await writeFile(manifestPath, JSON.stringify({ runId, testDatabaseName: 'sync_issue60_test', testSchemaName: 'issue60_harness_test', providerNamespace, records: [{
    entity: 'deal-order', direction: 'BOTH', name, syntheticOnly: true, sourceSystem: 'BITRIX24', sourceNativeId: 'deal-1',
    targetSystem: 'MOYSKLAD', targetNativeId: 'order-1', createdAfterUtc: new Date(now.getTime() - 10_000).toISOString(),
  }] }), 'utf8');
  const event: any = { id: 'event-1', source: 'BITRIX24', eventType: 'ONCRMDEALUPDATE', externalEntityType: 'deal', externalEntityId: 'deal-1', status: 'RECEIVED', attempts: 0 };
  const admissions = new Map<string, any>();
  const database: any = {
    inboundEvent: { findUnique: async () => event, updateMany: async ({ data }: any) => { Object.assign(event, data); return { count: 1 }; } },
    $queryRaw: async () => [{ serviceMode: 'on' }],
    $transaction: async (work: (transaction: unknown) => Promise<unknown>) => work(database),
    controlledTestAdmission: {
      findMany: async ({ where }: any) => [...admissions.values()].filter((row) => row.runId === where.runId && row.entity === where.entity),
      findUnique: async ({ where }: any) => admissions.get(where.eventId) ?? null,
      findFirst: async () => null,
      upsert: async ({ where, create }: any) => { if (!admissions.has(where.eventId)) admissions.set(where.eventId, { ...create }); return admissions.get(where.eventId); },
      updateMany: async () => ({ count: 0 }),
    },
  };
  try {
    setVerifiedControlledLiveProviderNamespace(providerNamespace);
    const admission = new ControlledLiveTestAdmissionService(database);
    let resolves = 0;
    const processor = new PairFirstEventProcessor(database, { resolve: async () => { resolves += 1; return { status: 'confirmed', pair }; } } as never,
      undefined, undefined, undefined, undefined, { read: async () => ({ mode: 'on' }) } as never, undefined,
      { readDealOrderForControlledAdmission: async () => ({ nativeId: 'deal-1', name, createdAt: now }), readDealOrderCreationTimestamp: async () => now } as never,
      { launchBoundary: async () => new Date(now.getTime() - 1_000) } as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, admission);
    const result = await processor.process('event-1');
    assert.equal(result?.status, 'confirmed');
    assert.equal(resolves, 1);
    assert.equal(admissions.get('event-1')?.entity, 'deal-order');
    assert.equal(admissions.get('event-1')?.sourceNativeId, 'deal-1');
    assert.equal(admissions.get('event-1')?.targetNativeId, 'order-1');
  } finally {
    for (const [key, value] of [['CONTROLLED_LIVE_TEST_MODE', previous.mode], ['CONTROLLED_LIVE_TEST_INSTANCE', previous.instance], ['CONTROLLED_LIVE_TEST_MANIFEST', previous.manifest], ['DATABASE_URL', previous.database], ['SYNC_MODE', previous.sync]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
