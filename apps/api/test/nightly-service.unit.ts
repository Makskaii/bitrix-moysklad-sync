import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { ContactSyncProcessor } from '../src/contact-sync.service';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { EventDispatcherService } from '../src/event-dispatcher.service';
import { SyncModeService } from '../src/sync-mode.service';
import { SyncRecoveryService } from '../src/sync-recovery.service';

type NightlyState = Record<string, any>;

class NightlyStore {
  readonly state: NightlyState;
  readonly queued = new Map<string, { id: string; status: string; source: string; deliveryKey: string }>();
  readonly accepted: Array<Record<string, unknown>> = [];
  readonly dispatched: string[] = [];
  readonly providerCalls: string[] = [];
  loseLeaseAfterProviderResponse = false;
  leaseLost = false;
  acceptedRows: Array<Record<string, any>> = [];
  bitrixIds: string[] = [];
  failBitrix = false;
  pairLifecycleStatus = 'ACTIVE';
  pairEntityType = 'CONTACT';
  pairBitrixId = 'contact-1';
  pairMoyskladId = 'ms-contact-1';
  pairMoyskladType = 'counterparty';
  bitrixToMoyskladEnabled = true;
  moyskladToBitrixEnabled = true;
  directionReadCount = 0;
  directionResults: boolean[] = [];

  constructor(mode: 'on' | 'pause' | 'off' = 'on') {
    this.state = {
      id: 'global', serviceMode: mode, offSince: null,
      lastInactiveAt: mode === 'on' ? null : new Date('2026-10-20T21:30:00.000Z'), lastActiveAt: null,
      nightlyScheduledDate: null, nightlyStatus: 'idle', nightlyFrom: null, nightlyThrough: null,
      nightlyProvider: 'BITRIX24', nightlyBitrixStart: 0, nightlyBitrixEntityTypeId: 3, nightlyBitrixLastId: null,
      nightlyMoyskladOffset: 0, nightlyBitrixStatus: 'pending', nightlyMoyskladStatus: 'pending',
      nightlyLeaseToken: null, nightlyLeaseExpiresAt: null, nightlyRetryAfter: null, nightlyAttempts: 0, nightlyError: null,
      resumeStatus: 'idle', resumeFrom: null, resumeThrough: null, resumeProvider: 'BITRIX24',
      resumeBitrixStart: 0, resumeMoyskladOffset: 0, resumeRetryAfter: null, resumeAttempts: 0, resumeError: null,
    };
  }

  readonly syncSetting = {
    findUnique: async () => ({ ...this.state }),
    findFirst: async () => ({ nightlyAttempts: this.state.nightlyAttempts }),
    upsert: async () => ({ ...this.state }),
    updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      if (where.nightlyLeaseToken && where.nightlyLeaseToken !== this.state.nightlyLeaseToken) return { count: 0 };
      if (where.OR && this.state.nightlyScheduledDate === data.nightlyScheduledDate) return { count: 0 };
      if (where.nightlyScheduledDate && where.nightlyScheduledDate !== this.state.nightlyScheduledDate) return { count: 0 };
      if (where.nightlyStatus && where.nightlyStatus !== this.state.nightlyStatus) return { count: 0 };
      Object.assign(this.state, data);
      return { count: 1 };
    },
  };
  readonly syncDirectionSetting = {
    upsert: async () => {
      const result = this.directionResults[this.directionReadCount++] ?? this.bitrixToMoyskladEnabled;
      return { bitrix24ToMoysklad: result, moyskladToBitrix24: this.moyskladToBitrixEnabled };
    },
    findUnique: async () => ({ bitrix24ToMoysklad: this.bitrixToMoyskladEnabled, moyskladToBitrix24: this.moyskladToBitrixEnabled }),
  };
  readonly inboundEvent = {
    count: async ({ where }: { where: { deliveryKey: { startsWith: string }; status: { in: string[] } } }) => [...this.queued.values()]
      .filter((row) => row.deliveryKey.startsWith(where.deliveryKey.startsWith) && where.status.in.includes(row.status)).length,
    findMany: async ({ where, take }: { where: Record<string, any>; take: number }) => {
      const cursor = where.AND?.flatMap((condition: Record<string, any>) => condition.OR ?? []) ?? [];
      const afterDate = cursor.find((condition: Record<string, any>) => condition.receivedAt?.gt)?.receivedAt.gt ??
        cursor.find((condition: Record<string, any>) => condition.receivedAt instanceof Date)?.receivedAt;
      const afterId = cursor.find((condition: Record<string, any>) => condition.id?.gt)?.id.gt ?? where.id?.gt;
      const rows: Array<Record<string, any>> = this.acceptedRows
        .map((row) => ({ ...row, receivedAt: row.receivedAt ?? new Date('2026-10-20T20:00:00.000Z') }));
      return rows
        .filter((row) => !afterDate || row.receivedAt > afterDate || row.receivedAt.getTime() === afterDate.getTime() && row.id > afterId)
        .filter((row) => !where.id?.gt || row.id > where.id.gt)
        .sort((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime() || left.id.localeCompare(right.id))
        .slice(0, take);
    },
    upsert: async ({ where, create }: { where: { source_deliveryKey: { source: string; deliveryKey: string } }; create: Record<string, any> }) => {
      const key = `${where.source_deliveryKey.source}:${where.source_deliveryKey.deliveryKey}`;
      let row = this.queued.get(key);
      if (!row) {
        row = { id: `event-${this.queued.size + 1}`, source: create.source, status: create.status, deliveryKey: create.deliveryKey };
        this.queued.set(key, row);
      }
      return { id: row.id };
    },
  };
  readonly entityPair = {
    findMany: async ({ where }: { where: Record<string, any> }) => {
      const ids: string[] = where.bitrix24Id?.in ?? where.moyskladId?.in ?? [];
      return ids.includes('contact-1') ? [{ entityType: 'CONTACT', bitrix24Id: 'contact-1', moyskladId: 'ms-contact-1', moyskladType: 'counterparty' }] : [];
    },
    findFirst: async ({ where }: { where: Record<string, any> }) => where.entityType === this.pairEntityType &&
      (where.bitrix24Id === this.pairBitrixId || where.moyskladId === this.pairMoyskladId)
      ? { id: 'pair-1', entityType: this.pairEntityType, bitrix24Id: this.pairBitrixId, moyskladId: this.pairMoyskladId, moyskladType: this.pairMoyskladType, lifecycleStatus: this.pairLifecycleStatus }
      : null,
    findUnique: async () => ({ moyskladParentId: 'parent-1' }),
  };
  readonly contactPair = { findMany: async () => [], findFirst: async () => null };
  readonly apiAttempt = { create: async () => ({}) };

  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join('?');
    if (sql.includes('SET "nightlyLeaseToken" =')) {
      if (this.state.nightlyLeaseToken && this.state.nightlyLeaseExpiresAt > new Date()) return 0;
      this.state.nightlyLeaseToken = values[0];
      this.state.nightlyLeaseExpiresAt = new Date(Date.now() + 60_000);
      this.state.nightlyStatus = 'running';
      this.state.nightlyAttempts += 1;
      return 1;
    }
    if (sql.includes('SET "nightlyLeaseExpiresAt" =')) {
      if (this.leaseLost || values[0] !== this.state.nightlyLeaseToken) return 0;
      this.state.nightlyLeaseExpiresAt = new Date(Date.now() + 60_000);
      return 1;
    }
    if (sql.includes('SET "nightlyStatus" =')) this.state.nightlyStatus = 'skipped';
    return 1;
  }
}

async function createHarness(mode: 'on' | 'pause' | 'off' = 'on') {
  mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: new Date('2026-10-20T22:00:00.000Z') });
  const oldMode = process.env.SYNC_MODE;
  const oldB24Url = process.env.BITRIX24_REST_BASE_URL;
  const oldMsUrl = process.env.MOYSKLAD_API_BASE_URL;
  const oldMsToken = process.env.MOYSKLAD_API_TOKEN;
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.example.test/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.example.test/api/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-token';
  const previousFetch = globalThis.fetch;
  const store = new NightlyStore(mode);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    store.providerCalls.push(url);
    if (url.includes('bitrix.example.test')) {
      if (store.loseLeaseAfterProviderResponse) store.leaseLost = true;
      if (store.failBitrix) return new Response('{}', { status: 503, headers: { 'retry-after': '3600' } });
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ result: { items: request.entityTypeId === 3 ? store.bitrixIds.map((id) => ({ id })) : [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ rows: [], meta: { size: 0, limit: 1000, offset: 0 } }), { status: 200 });
  };
  const syncMode = new SyncModeService(store as never);
  const fieldSettings = {
    saveAcceptedEvent: async (event: Record<string, unknown>) => {
      const key = `${event.source}:${event.deliveryKey}`;
      const existing = store.queued.get(key);
      if (existing) return { id: existing.id };
      const row = { id: `event-${store.queued.size + 1}`, source: event.source as string, status: 'RECEIVED', deliveryKey: event.deliveryKey as string };
      store.queued.set(key, row);
      store.accepted.push(event);
      return { id: row.id };
    },
  };
  const dispatcher = { dispatch: async (id: string) => { store.dispatched.push(id); } };
  const service = new SyncRecoveryService(store as never, syncMode, {} as ContactSyncProcessor,
    undefined, fieldSettings as unknown as FieldSettingsService, dispatcher as unknown as EventDispatcherService);
  return {
    store, service,
    close: () => {
      service.onModuleDestroy();
      mock.timers.reset();
      globalThis.fetch = previousFetch;
      if (oldMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = oldMode;
      if (oldB24Url === undefined) delete process.env.BITRIX24_REST_BASE_URL; else process.env.BITRIX24_REST_BASE_URL = oldB24Url;
      if (oldMsUrl === undefined) delete process.env.MOYSKLAD_API_BASE_URL; else process.env.MOYSKLAD_API_BASE_URL = oldMsUrl;
      if (oldMsToken === undefined) delete process.env.MOYSKLAD_API_TOKEN; else process.env.MOYSKLAD_API_TOKEN = oldMsToken;
    },
  };
}

async function settleUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    mock.timers.tick(1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test('nightly scheduler skips OFF and PAUSE and does not catch up after resume in the same Moscow day', async () => {
  for (const mode of ['pause', 'off'] as const) {
    const harness = await createHarness(mode);
    try {
      harness.service.onApplicationBootstrap();
      await settleUntil(() => harness.store.state.nightlyStatus === 'skipped');
      assert.equal(harness.store.state.nightlyScheduledDate, '2026-10-21');
      assert.equal(harness.store.state.nightlyStatus, 'skipped');
      assert.equal(harness.store.state.nightlyFrom, null);
      assert.deepEqual(harness.store.providerCalls, []);

      harness.store.state.serviceMode = 'on';
      mock.timers.tick(5_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(harness.store.providerCalls, []);
      assert.equal(harness.store.state.nightlyStatus, 'skipped');
    } finally {
      harness.close();
    }
  }
});

test('nightly scheduler skips an inactive interval overlapping the window even after resume to On', async () => {
  const harness = await createHarness('on');
  harness.store.state.lastInactiveAt = new Date('2026-10-20T21:30:00.000Z');
  harness.store.state.lastActiveAt = new Date('2026-10-20T21:45:00.000Z');
  try {
    harness.service.onApplicationBootstrap();
    await settleUntil(() => harness.store.state.nightlyStatus === 'skipped');

    assert.equal(harness.store.state.nightlyScheduledDate, '2026-10-21');
    assert.match(harness.store.state.nightlyError, /OFF or PAUSE downtime/i);
    assert.equal(harness.store.state.nightlyFrom, null);
    assert.deepEqual(harness.store.providerCalls, []);
  } finally {
    harness.close();
  }
});

test('nightly scheduler rechecks the previous Moscow 24 hours and deduplicates repeated provider IDs', async () => {
  const harness = await createHarness('on');
  harness.store.bitrixIds = ['contact-1', 'contact-1'];
  try {
    harness.service.onApplicationBootstrap();
    await settleUntil(() => harness.store.state.nightlyStatus === 'awaiting_processing');

    assert.equal(harness.store.state.nightlyScheduledDate, '2026-10-21');
    assert.equal(harness.store.state.nightlyFrom.toISOString(), '2026-10-19T22:00:00.000Z');
    assert.equal(harness.store.state.nightlyThrough.toISOString(), '2026-10-20T22:00:00.000Z');
    assert.equal(harness.store.accepted.length, 1);
    assert.equal(harness.store.accepted[0].deliveryKey, 'nightly:2026-10-21:CONTACT:contact-1');
    assert.equal(harness.store.dispatched.length, 1);

    const providerCallCount = harness.store.providerCalls.length;
    mock.timers.tick(5_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.store.providerCalls.length, providerCallCount);
    assert.equal(harness.store.accepted.length, 1);
    assert.equal(harness.store.state.nightlyStatus, 'awaiting_processing');
  } finally {
    harness.close();
  }
});

test('nightly accepted-event recheck deduplicates one entity represented by multiple successful events', async () => {
  const harness = await createHarness('on');
  harness.store.acceptedRows = [
    { id: 'accepted-a', source: 'BITRIX24', eventType: 'ONCRMCONTACTUPDATE', externalEntityType: 'contact', externalEntityId: 'contact-1' },
    { id: 'accepted-b', source: 'BITRIX24', eventType: 'ONCRMCONTACTUPDATE', externalEntityType: 'contact', externalEntityId: 'contact-1' },
  ];
  try {
    harness.service.onApplicationBootstrap();
    await settleUntil(() => harness.store.state.nightlyStatus === 'awaiting_processing');

    assert.equal(harness.store.accepted.length, 1);
    assert.equal(harness.store.accepted[0].deliveryKey, 'nightly:2026-10-21:CONTACT:ONCRMCONTACTUPDATE:ACTIVE:contact-1');
    assert.equal(harness.store.dispatched.length, 1);
    assert.equal(harness.store.state.nightlyStatus, 'awaiting_processing');
  } finally {
    harness.close();
  }
});

test('nightly accepted-event recheck keeps the latest action when an identity crosses the 500-row page boundary', async (context) => {
  const cases = [
    { name: 'update then delete with timestamp tie', earlierType: 'ONCRMCONTACTUPDATE', laterType: 'ONCRMCONTACTDELETE', earlierId: 'accepted-0000', laterId: 'accepted-0500', earlierAt: new Date('2026-10-20T21:00:00.000Z'), laterAt: new Date('2026-10-20T21:00:00.000Z') },
    { name: 'delete then update with timestamp tie', earlierType: 'ONCRMCONTACTDELETE', laterType: 'ONCRMCONTACTUPDATE', earlierId: 'accepted-0000', laterId: 'accepted-0500', earlierAt: new Date('2026-10-20T21:00:00.000Z'), laterAt: new Date('2026-10-20T21:00:00.000Z') },
    { name: 'timestamp outranks lexical ID', earlierType: 'ONCRMCONTACTUPDATE', laterType: 'ONCRMCONTACTDELETE', earlierId: 'zz-earlier', laterId: 'aa-later', earlierAt: new Date('2026-10-20T21:00:00.000Z'), laterAt: new Date('2026-10-20T21:01:00.000Z') },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const harness = await createHarness('on');
      harness.store.acceptedRows = [
        { id: scenario.earlierId, source: 'BITRIX24', eventType: scenario.earlierType, externalEntityType: 'contact', externalEntityId: 'contact-1', receivedAt: scenario.earlierAt },
        ...Array.from({ length: 499 }, (_, index) => ({
          id: `accepted-${String(index + 1).padStart(4, '0')}`,
          source: 'BITRIX24', eventType: 'ONCRMCONTACTUPDATE', externalEntityType: 'contact',
          externalEntityId: `unpaired-${index}`, receivedAt: scenario.earlierAt,
        })),
        { id: scenario.laterId, source: 'BITRIX24', eventType: scenario.laterType, externalEntityType: 'contact', externalEntityId: 'contact-1', receivedAt: scenario.laterAt },
      ];
      try {
        harness.service.onApplicationBootstrap();
        await settleUntil(() => harness.store.state.nightlyStatus === 'awaiting_processing');

        assert.equal(harness.store.accepted.length, 1);
        assert.equal(harness.store.accepted[0].eventType, scenario.laterType);
        assert.equal(harness.store.accepted[0].externalEntityId, 'contact-1');
        assert.equal(harness.store.accepted[0].deliveryKey, `nightly:2026-10-21:CONTACT:${scenario.laterType}:ACTIVE:contact-1`);
        assert.equal((harness.store.accepted[0].payload as Record<string, unknown>).acceptedEventId, scenario.laterId);
        assert.equal(harness.store.dispatched.length, 1);
      } finally {
        harness.close();
      }
    });
  }
});

test('nightly accepted DELETE stays terminal when its canonical sync direction is disabled', async () => {
  const harness = await createHarness('on');
  harness.store.bitrixToMoyskladEnabled = false;
  harness.store.acceptedRows = [
    { id: 'accepted-delete-disabled', source: 'BITRIX24', eventType: 'ONCRMCONTACTDELETE', externalEntityType: 'contact', externalEntityId: 'contact-1' },
  ];
  try {
    harness.service.onApplicationBootstrap();
    await settleUntil(() => harness.store.state.nightlyStatus === 'awaiting_processing');

    assert.equal(harness.store.accepted.length, 0);
    assert.equal(harness.store.dispatched.length, 0);
    assert.equal(harness.store.queued.size, 0);
  } finally {
    harness.close();
  }
});

test('a latest accepted DELETE observed with its direction disabled suppresses an older enabled UPDATE', async () => {
  const harness = await createHarness('on');
  harness.store.directionResults = [true, true, false, true];
  const receivedAt = new Date('2026-10-20T21:00:00.000Z');
  harness.store.acceptedRows = [
    { id: 'accepted-0000', source: 'BITRIX24', eventType: 'ONCRMCONTACTUPDATE', externalEntityType: 'contact', externalEntityId: 'contact-1', receivedAt },
    ...Array.from({ length: 499 }, (_, index) => ({
      id: `accepted-${String(index + 1).padStart(4, '0')}`,
      source: 'BITRIX24', eventType: 'ONCRMCONTACTUPDATE', externalEntityType: 'contact',
      externalEntityId: `unpaired-${index}`, receivedAt,
    })),
    { id: 'accepted-0500', source: 'BITRIX24', eventType: 'ONCRMCONTACTDELETE', externalEntityType: 'contact', externalEntityId: 'contact-1', receivedAt },
  ];
  try {
    harness.service.onApplicationBootstrap();
    await settleUntil(() => harness.store.state.nightlyStatus === 'awaiting_processing');

    assert.equal(harness.store.directionReadCount, 4);
    assert.deepEqual(harness.store.accepted.map((event) => [event.eventType, event.payload]), []);
    assert.equal(harness.store.dispatched.length, 0);
  } finally {
    harness.close();
  }
});

test('nightly accepted DELETE rechecks active and tombstoned pairs using the exact source ID and original event type', async (context) => {
  const cases = [
    { name: 'Bitrix24 contact', source: 'BITRIX24', eventType: 'ONCRMCONTACTDELETE', externalEntityType: 'contact', entity: 'CONTACT', sourceId: 'contact-1', partnerId: 'ms-contact-1', partnerType: 'counterparty' },
    { name: 'MoySklad counterparty', source: 'MOYSKLAD', eventType: 'DELETE', externalEntityType: 'counterparty', entity: 'COMPANY', sourceId: 'ms-company-1', partnerId: 'b24-company-1', partnerType: 'counterparty' },
  ];
  for (const candidate of cases) {
    for (const lifecycleStatus of ['ACTIVE', 'TOMBSTONED']) {
      await context.test(`${candidate.name}, ${lifecycleStatus} pair`, async () => {
      const harness = await createHarness('on');
      harness.store.pairLifecycleStatus = lifecycleStatus;
      harness.store.pairEntityType = candidate.entity;
      harness.store.pairBitrixId = candidate.source === 'BITRIX24' ? candidate.sourceId : candidate.partnerId;
      harness.store.pairMoyskladId = candidate.source === 'MOYSKLAD' ? candidate.sourceId : candidate.partnerId;
      harness.store.pairMoyskladType = candidate.partnerType;
      harness.store.acceptedRows = [
        { id: `accepted-delete-${candidate.source}-${lifecycleStatus}`, source: candidate.source, eventType: candidate.eventType, externalEntityType: candidate.externalEntityType, externalEntityId: candidate.sourceId },
      ];
      try {
        harness.service.onApplicationBootstrap();
        await settleUntil(() => harness.store.state.nightlyStatus === 'awaiting_processing');

        assert.equal(harness.store.accepted.length, 1);
        assert.equal(harness.store.accepted[0].eventType, candidate.eventType);
        assert.equal(harness.store.accepted[0].externalEntityId, candidate.sourceId);
        assert.equal(harness.store.accepted[0].deliveryKey, `nightly:2026-10-21:${candidate.entity}:${candidate.eventType}:${lifecycleStatus}:${candidate.sourceId}`);
        assert.deepEqual(harness.store.accepted[0].payload, {
          recovery: 'nightly', entity: candidate.entity, acceptedEventId: `accepted-delete-${candidate.source}-${lifecycleStatus}`,
        });
        assert.equal(harness.store.dispatched.length, 1);
      } finally {
        harness.close();
      }
      });
    }
  }
});

test('nightly lease loss after a provider read prevents staging events or advancing the run', async () => {
  const harness = await createHarness('on');
  harness.store.bitrixIds = ['contact-1'];
  harness.store.loseLeaseAfterProviderResponse = true;
  try {
    harness.service.onApplicationBootstrap();
    await settleUntil(() => harness.store.state.nightlyStatus === 'failed');

    assert.equal(harness.store.providerCalls.length, 1);
    assert.equal(harness.store.queued.size, 0);
    assert.equal(harness.store.accepted.length, 0);
    assert.equal(harness.store.state.nightlyBitrixLastId, null);
  } finally {
    harness.close();
  }
});

test('a Bitrix24 nightly outage leaves its retry due while the MoySklad feed completes', async () => {
  const harness = await createHarness('on');
  harness.store.failBitrix = true;
  try {
    harness.service.onApplicationBootstrap();
    await settleUntil(() => harness.store.state.nightlyMoyskladStatus === 'complete');

    assert.equal(harness.store.state.nightlyBitrixStatus, 'failed');
    assert.equal(harness.store.state.nightlyMoyskladStatus, 'complete');
    assert.equal(harness.store.state.nightlyStatus, 'failed');
    assert.ok(harness.store.providerCalls.some((url) => url.includes('moysklad.example.test/api/entity/counterparty')));
    assert.equal(harness.store.state.nightlyRetryAfter.toISOString(), '2026-10-20T23:00:01.000Z');
  } finally {
    harness.close();
  }
});
