import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ClientLifecycleService } from '../src/clients/client-lifecycle.service';
import { EventIntakeService } from '../src/events.controller';

function mockLifecycleLocks() {
  const locks = new Map<string, string>();
  return {
    inboundEntityLock: {
      updateMany: async ({ where }: { where: { entityKey: string | { in?: string[] }; ownerToken?: string } }) => {
        const keys = typeof where.entityKey === 'string' ? [where.entityKey] : where.entityKey.in ?? [];
        return { count: where.ownerToken ? keys.filter((key) => locks.get(key) === where.ownerToken).length : 0 };
      },
      create: async ({ data }: { data: { entityKey: string; ownerToken: string } }) => { locks.set(data.entityKey, data.ownerToken); },
      deleteMany: async ({ where }: { where: { entityKey: { in: string[] }; ownerToken: string } }) => {
        for (const key of where.entityKey.in) if (locks.get(key) === where.ownerToken) locks.delete(key);
        return { count: where.entityKey.in.length };
      },
    },
  };
}

test('delete processor supports each enabled durable pair entity and only explicit deletion events', () => {
  const service = new ClientLifecycleService({} as never);
  for (const [source, eventType, externalEntityType] of [
    ['BITRIX24', 'ONCRMCOMPANYDELETE', 'company'],
    ['BITRIX24', 'ONCRMCONTACTDELETE', 'contact'],
    ['BITRIX24', 'ONCRMDEALDELETE', 'deal'],
    ['BITRIX24', 'CATALOG.PRODUCT.ON.DELETE', 'product'],
    ['BITRIX24', 'ONCRMDYNAMICITEMDELETE', 'invoice'],
    ['MOYSKLAD', 'DELETE', 'counterparty'],
    ['MOYSKLAD', 'DELETE', 'contactperson'],
    ['MOYSKLAD', 'DELETE', 'customerorder'],
    ['MOYSKLAD', 'DELETE', 'product'],
    ['MOYSKLAD', 'DELETE', 'invoiceout'],
    ['MOYSKLAD', 'DELETE', 'service'],
  ] as const) {
    assert.equal(service.supports({ id: 'event', source, eventType, externalEntityType, externalEntityId: 'native-id' }), true);
  }
  assert.equal(service.supports({ id: 'event', source: 'MOYSKLAD', eventType: 'UPDATE', externalEntityType: 'product', externalEntityId: 'native-id' }), false);
});

test('Bitrix catalog deletion webhook persists the exact product event identity', async () => {
  const oldToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
  const oldMode = process.env.SYNC_MODE;
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'fixture-app-token';
  process.env.SYNC_MODE = 'apply';
  let persisted: Record<string, unknown> | undefined;
  const intake = new EventIntakeService(
    {} as never,
    { read: async () => ({ mode: 'on' }), isDirectionEnabled: async () => true } as never,
    undefined,
    { saveAcceptedEvent: async (input: Record<string, unknown>) => { persisted = input; return { id: 'event-product-delete' }; } } as never,
  );
  try {
    const acknowledgement = await intake.receiveBitrix24({
      event: 'CATALOG.PRODUCT.ON.DELETE',
      auth: { application_token: 'fixture-app-token' },
      data: { FIELDS: { ID: 123, TYPE: 1 } },
    });
    assert.deepEqual(acknowledgement, { accepted: true, eventId: 'event-product-delete' });
    assert.equal(persisted?.source, 'BITRIX24');
    assert.equal(persisted?.eventType, 'CATALOG.PRODUCT.ON.DELETE');
    assert.equal(persisted?.externalEntityType, 'product');
    assert.equal(persisted?.externalEntityId, '123');
  } finally {
    if (oldToken === undefined) delete process.env.BITRIX24_EVENT_APPLICATION_TOKEN; else process.env.BITRIX24_EVENT_APPLICATION_TOKEN = oldToken;
    if (oldMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = oldMode;
  }
});

test('tombstone targets one entity-type/native-ID pair and repeats idempotently', async () => {
  const records = [
    { id: 'company-pair', entityType: 'COMPANY', bitrix24Id: '42', moyskladId: 'ms-company', active: true, lifecycleStatus: 'ACTIVE' },
    { id: 'contact-pair', entityType: 'CONTACT', bitrix24Id: '42', moyskladId: 'ms-contact', active: true, lifecycleStatus: 'ACTIVE' },
    { id: 'invoice-pair', entityType: 'INVOICE', bitrix24Id: '42', moyskladId: 'ms-invoice', active: true, lifecycleStatus: 'ACTIVE' },
  ];
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const tx = {
    $queryRaw: async () => [{ locked: 1 }],
    entityPair: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => records.find((row) =>
        row.entityType === where.entityType && (row.bitrix24Id === where.bitrix24Id || row.moyskladId === where.moyskladId)) ?? null,
      update: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(input);
        const row = records.find((candidate) => candidate.id === input.where.id)!;
        Object.assign(row, input.data);
        return row;
      },
    },
    operationalLog: { create: async () => ({}) },
  };
  const database = { $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx) };
  const service = new ClientLifecycleService(database as never);

  const first = await service.tombstoneByNativeId('BITRIX24', 'COMPANY', '42', 'DELETE_CONFIRMED');
  const repeated = await service.tombstoneByNativeId('BITRIX24', 'COMPANY', '42', 'DELETE_CONFIRMED');

  assert.deepEqual(first, { status: 'TOMBSTONED', pairId: 'company-pair', changed: true });
  assert.deepEqual(repeated, { status: 'TOMBSTONED', pairId: 'company-pair', changed: false });
  assert.equal(updates.length, 1);
  assert.equal(records[0]?.active, false);
  assert.equal(records[0]?.lifecycleStatus, 'TOMBSTONED');
  assert.equal(records[1]?.active, true);
  assert.equal(records[1]?.lifecycleStatus, 'ACTIVE');

  const invoice = await service.tombstoneByNativeId('MOYSKLAD', 'INVOICE', 'ms-invoice', 'CONFIRMED_PROVIDER_DELETION');
  assert.deepEqual(invoice, { status: 'TOMBSTONED', pairId: 'invoice-pair', changed: true });
  assert.equal(records[2]?.bitrix24Id, '42');
  assert.equal(records[2]?.moyskladId, 'ms-invoice');
  assert.equal(records[2]?.active, false, 'invoice tombstones preserve both native invoice IDs and only deactivate the exact pair');
});

test('pair write gate refuses tombstoned pairs and leaves unrelated active pairs usable', async () => {
  const states: Record<string, { active: boolean; lifecycleStatus: string; entityType: string }> = {
    gone: { active: false, lifecycleStatus: 'TOMBSTONED', entityType: 'COMPANY' },
    live: { active: true, lifecycleStatus: 'ACTIVE', entityType: 'COMPANY' },
  };
  const database = { entityPair: { findUnique: async ({ where }: { where: { id: string } }) => states[where.id] ?? null } };
  const service = new ClientLifecycleService(database as never);

  await assert.rejects(() => service.assertPairActive('gone', 'COMPANY'), /PAIR_TOMBSTONED/);
  await service.assertPairActive('live', 'COMPANY');
  await assert.rejects(() => service.assertPairActive('live', 'CONTACT'), /PAIR_NOT_AVAILABLE/);
});

test('provider write lease excludes a concurrent deletion lease on the same native pair', async () => {
  const leaseRows = new Map<string, string>();
  const pair = { id: 'pair-deal', entityType: 'DEAL', bitrix24Id: '42', moyskladId: 'ms-deal', active: true, lifecycleStatus: 'ACTIVE' };
  const database = {
    entityPair: { findUnique: async () => pair },
    inboundEntityLock: {
      updateMany: async ({ where }: { where: { entityKey: string | { in?: string[] }; ownerToken?: string } }) => {
        const keys = typeof where.entityKey === 'string' ? [where.entityKey] : where.entityKey.in ?? [];
        return { count: where.ownerToken ? keys.filter((key) => leaseRows.has(key) && leaseRows.get(key) === where.ownerToken).length : 0 };
      },
      create: async ({ data }: { data: { entityKey: string; ownerToken: string } }) => {
        if (leaseRows.has(data.entityKey)) throw new Error('unique entity lease conflict');
        leaseRows.set(data.entityKey, data.ownerToken);
      },
      deleteMany: async ({ where }: { where: { entityKey: { in: string[] }; ownerToken: string } }) => {
        for (const key of where.entityKey.in) if (leaseRows.get(key) === where.ownerToken) leaseRows.delete(key);
        return { count: 3 };
      },
    },
  };
  const service = new ClientLifecycleService(database as never);
  const result = await service.withPairActiveLock('pair-deal', 'DEAL', async () => {
    assert.equal(leaseRows.size, 3);
    await assert.rejects(() => (service as unknown as { acquireEntityPairLease(pair: { id: string; bitrix24Id: string; moyskladId: string }, source: 'MOYSKLAD', entity: 'DEAL', id: string): Promise<unknown> })
      .acquireEntityPairLease(pair, 'MOYSKLAD', 'DEAL', pair.moyskladId), /CLIENT_ENTITY_LOCK_BUSY/);
    assert.equal(leaseRows.size, 3);
    return 'provider-write';
  });
  assert.equal(result, 'provider-write');
  assert.equal(leaseRows.size, 0);
});

test('MoySklad DELETE is tombstoned only after an exact native-ID read returns 404', async () => {
  const oldFetch = globalThis.fetch;
  const oldMode = process.env.SYNC_MODE;
  const oldBase = process.env.MOYSKLAD_API_BASE_URL;
  const oldToken = process.env.MOYSKLAD_API_TOKEN;
  process.env.SYNC_MODE = 'dry';
  process.env.MOYSKLAD_API_BASE_URL = 'https://fixture.invalid/api/remap/1.2';
  process.env.MOYSKLAD_API_TOKEN = 'fixture-token';
  const updates: Record<string, unknown>[] = [];
  const pair = { id: 'pair-1', entityType: 'COMPANY', bitrix24Id: 'b24-1', moyskladId: 'ms-1', moyskladType: 'counterparty', moyskladParentId: null, active: true, lifecycleStatus: 'ACTIVE', deletionMarkerStatus: 'NOT_CONFIGURED', deletionTimelineStatus: 'NOT_REQUIRED', tombstoneSource: null, tombstonedAt: null };
  const event = { id: 'event-1', source: 'MOYSKLAD', eventType: 'DELETE', externalEntityType: 'counterparty', externalEntityId: 'ms-1', payload: {}, status: 'RECEIVED', attempts: 0 };
  const leaseRows = new Map<string, string>();
  const tx = {
    $queryRaw: async () => [{ locked: 1 }],
    entityPair: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => where.entityType === 'COMPANY' && where.moyskladId === 'ms-1' ? pair : null,
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(pair, data); updates.push(data); return pair; },
    },
    inboundEvent: { update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(event, data); return event; } },
    operationalLog: { create: async () => ({}) },
  };
  const database = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    entityPair: {
      findUnique: async () => pair,
      findFirst: async () => pair,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(pair, data); return { count: 1 }; },
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(pair, data); return pair; },
    },
    inboundEntityLock: {
      updateMany: async ({ where }: { where: { entityKey: string | { in?: string[] }; ownerToken?: string } }) => {
        const keys = typeof where.entityKey === 'string' ? [where.entityKey] : where.entityKey.in ?? [];
        return { count: where.ownerToken ? keys.filter((key) => leaseRows.has(key) && leaseRows.get(key) === where.ownerToken).length : 0 };
      },
      create: async ({ data }: { data: { entityKey: string; ownerToken: string } }) => { leaseRows.set(data.entityKey, data.ownerToken); },
      deleteMany: async ({ where }: { where: { entityKey: { in: string[] }; ownerToken: string } }) => {
        for (const key of where.entityKey.in) if (leaseRows.get(key) === where.ownerToken) leaseRows.delete(key);
        return { count: where.entityKey.in.length };
      },
    },
    inboundEvent: {
      findUnique: async () => event,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(event, data); return { count: 1 }; },
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(event, data); return event; },
    },
    syncSetting: { findUnique: async () => null },
    operationalLog: { create: async () => ({}) },
  };
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    const service = new ClientLifecycleService(database as never);
    await (service as unknown as { processDeleteEvent(id: string): Promise<void> }).processDeleteEvent('event-1');
    assert.equal(pair.lifecycleStatus, 'TOMBSTONED');
    assert.equal(pair.active, false);
    assert.equal(pair.deletionMarkerStatus, 'NOT_CONFIGURED');
    assert.equal(pair.moyskladId, 'ms-1');
    assert.equal(event.status, 'SUCCEEDED');
    assert.equal(updates.length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = oldMode;
    if (oldBase === undefined) delete process.env.MOYSKLAD_API_BASE_URL; else process.env.MOYSKLAD_API_BASE_URL = oldBase;
    if (oldToken === undefined) delete process.env.MOYSKLAD_API_TOKEN; else process.env.MOYSKLAD_API_TOKEN = oldToken;
  }
});

test('deletion marker uses configured entity field code, is idempotent, and rejects guessed/invalid codes', async () => {
  const oldMode = process.env.SYNC_MODE;
  const oldBase = process.env.BITRIX24_REST_BASE_URL;
  const oldFetch = globalThis.fetch;
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_REST_BASE_URL = 'https://fixture.invalid/rest/test/';
  const pair = { id: 'pair-marker', entityType: 'COMPANY', bitrix24Id: 'b24-9', moyskladId: 'ms-9', active: false, lifecycleStatus: 'TOMBSTONED', tombstoneSource: 'MOYSKLAD', deletionMarkerStatus: 'PENDING' };
  let writes = 0;
  let submitted = '';
  let storedFields: Record<string, string> = {};
  globalThis.fetch = async (input, init) => {
    writes++;
    submitted = String(init?.body);
    return Response.json({ result: true });
  };
  const database = {
    entityPair: {
      findUnique: async () => pair,
      findMany: async () => [],
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(pair, data); return { count: 1 }; },
    },
    syncSetting: {
      findUnique: async () => ({ clientDeletionMarkerFields: storedFields }),
      upsert: async ({ create, update }: { create: { clientDeletionMarkerFields: Record<string, string> }; update: { clientDeletionMarkerFields: Record<string, string> } }) => {
        storedFields = create.clientDeletionMarkerFields ?? update.clientDeletionMarkerFields;
        return { clientDeletionMarkerFields: storedFields };
      },
    },
  };
  const service = new ClientLifecycleService(database as never, undefined, { read: async () => ({ mode: 'on' }) } as never);
  try {
    assert.deepEqual(await service.saveDeletionMarkerFields({ COMPANY: 'UF_ARCHIVE_STATE' }), { fields: { COMPANY: 'UF_ARCHIVE_STATE' } });
    assert.deepEqual(await service.deletionMarkerFields(), { fields: { COMPANY: 'UF_ARCHIVE_STATE' } });
    await (service as unknown as { ensureDeletionMarker(id: string, entity: 'COMPANY'): Promise<void> }).ensureDeletionMarker(pair.id, 'COMPANY');
    await (service as unknown as { ensureDeletionMarker(id: string, entity: 'COMPANY'): Promise<void> }).ensureDeletionMarker(pair.id, 'COMPANY');
    assert.equal(pair.deletionMarkerStatus, 'MARKED');
    assert.equal(writes, 1);
    const form = new URLSearchParams(submitted);
    assert.equal(form.get('id'), 'b24-9');
    assert.equal(form.get('fields[UF_ARCHIVE_STATE]'), 'Удалён');
    await assert.rejects(() => service.saveDeletionMarkerFields({ COMPANY: 'DELETED' }), /DELETION_MARKER_FIELDS_INVALID/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = oldMode;
    if (oldBase === undefined) delete process.env.BITRIX24_REST_BASE_URL; else process.env.BITRIX24_REST_BASE_URL = oldBase;
  }
});

test('MoySklad provider outage remains retryable and does not tombstone the pair', async () => {
  const oldFetch = globalThis.fetch;
  const oldBase = process.env.MOYSKLAD_API_BASE_URL;
  const oldToken = process.env.MOYSKLAD_API_TOKEN;
  process.env.MOYSKLAD_API_BASE_URL = 'https://fixture.invalid/api/remap/1.2';
  process.env.MOYSKLAD_API_TOKEN = 'fixture-token';
  const pair = { id: 'pair-1', entityType: 'COMPANY', bitrix24Id: 'b24-1', moyskladId: 'ms-1', active: true, lifecycleStatus: 'ACTIVE' };
  const event = { id: 'event-2', source: 'MOYSKLAD', eventType: 'DELETE', externalEntityType: 'counterparty', externalEntityId: 'ms-1', payload: {}, status: 'RECEIVED', attempts: 0 };
  const database = {
    entityPair: { findUnique: async () => pair, findFirst: async () => pair },
    inboundEntityLock: {
      updateMany: async () => ({ count: 0 }), create: async () => ({}), deleteMany: async () => ({ count: 1 }),
    },
    inboundEvent: {
      findUnique: async () => event,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(event, data); return { count: 1 }; },
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(event, data); return event; },
    },
  };
  globalThis.fetch = async () => new Response(null, { status: 503 });
  try {
    const service = new ClientLifecycleService(database as never);
    await (service as unknown as { processDeleteEvent(id: string): Promise<void> }).processDeleteEvent('event-2');
    assert.equal(pair.lifecycleStatus, 'ACTIVE');
    assert.equal(pair.active, true);
    assert.equal(event.status, 'RETRYABLE_FAILURE');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldBase === undefined) delete process.env.MOYSKLAD_API_BASE_URL; else process.env.MOYSKLAD_API_BASE_URL = oldBase;
    if (oldToken === undefined) delete process.env.MOYSKLAD_API_TOKEN; else process.env.MOYSKLAD_API_TOKEN = oldToken;
  }
});

test('restore keeps the same native IDs and requires verified provider identity plus confirmation', async () => {
  const pair = { id: 'pair-restore', entityType: 'COMPANY', bitrix24Id: 'b24-restore', moyskladId: 'ms-restore', moyskladType: 'counterparty', moyskladParentId: null, active: false, lifecycleStatus: 'TOMBSTONED', tombstonedAt: null, tombstoneSource: null, tombstoneReason: null, deletionMarkerStatus: 'NOT_CONFIGURED' };
  const tx = {
    $queryRaw: async () => [{ locked: 1 }],
    entityPair: {
      findUnique: async () => pair,
      findFirst: async () => null,
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(pair, data); return pair; },
    },
    adminAuditEntry: { create: async ({ data }: { data: Record<string, unknown> }) => { auditEntries.push(data); } },
  };
  const auditEntries: Record<string, unknown>[] = [];
  const database = {
    entityPair: { findUnique: async () => pair },
    ...mockLifecycleLocks(),
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const gateway = {
    readBitrix: async (_entity: string, id: string) => ({ ID: id }),
    readMoysklad: async (_type: string, id: string) => ({ id }),
  };
  const service = new ClientLifecycleService(database as never, gateway as never);
  await assert.rejects(() => service.restore('pair-restore', false, 'BITRIX24_USER:42'), /EXPLICIT_RESTORE_CONFIRMATION_REQUIRED/);
  const result = await service.restore('pair-restore', true, 'BITRIX24_USER:42');
  assert.deepEqual(result, { status: 'RESTORED', pairId: 'pair-restore' });
  assert.equal(pair.id, 'pair-restore');
  assert.equal(pair.bitrix24Id, 'b24-restore');
  assert.equal(pair.moyskladId, 'ms-restore');
  assert.equal(pair.active, true);
  assert.equal(pair.lifecycleStatus, 'ACTIVE');
  assert.deepEqual(await service.restore('pair-restore', true, 'BITRIX24_USER:42'), { status: 'ALREADY_ACTIVE', pairId: 'pair-restore' });
  assert.equal(auditEntries.length, 1);
  assert.deepEqual(auditEntries[0], {
    actorId: 'BITRIX24_USER:42', action: 'CLIENT_LIFECYCLE_RESTORED', targetType: 'COMPANY', targetId: 'pair-restore',
    reason: 'VERIFIED_BOTH_NATIVE_IDS',
    before: { lifecycleStatus: 'TOMBSTONED', tombstonedAt: null, tombstoneSource: null, tombstoneReason: null },
    after: { lifecycleStatus: 'ACTIVE', bitrix24Id: 'b24-restore', moyskladId: 'ms-restore' },
  });
});

test('restore refuses when a provider read returns another identity', async () => {
  const pair = { id: 'pair-restore', entityType: 'COMPANY', bitrix24Id: 'b24-restore', moyskladId: 'ms-restore', moyskladType: 'counterparty', moyskladParentId: null, active: false, lifecycleStatus: 'TOMBSTONED', deletionMarkerStatus: 'NOT_CONFIGURED' };
  let transactionStarted = false;
  const database = {
    entityPair: { findUnique: async () => pair },
    ...mockLifecycleLocks(),
    $transaction: async () => { transactionStarted = true; throw new Error('unexpected transaction'); },
  };
  const gateway = {
    readBitrix: async () => ({ ID: 'different-b24-id' }),
    readMoysklad: async (_type: string, id: string) => ({ id }),
  };
  const service = new ClientLifecycleService(database as never, gateway as never);
  await assert.rejects(() => service.restore('pair-restore', true, 'BITRIX24_USER:42'), /PAIR_IDENTITY_VERIFICATION_FAILED/);
  assert.equal(transactionStarted, false);
  assert.equal(pair.lifecycleStatus, 'TOMBSTONED');
});

test('restore clears the configured Bitrix24 marker before reactivating the exact pair', async () => {
  const oldMode = process.env.SYNC_MODE;
  const oldBase = process.env.BITRIX24_REST_BASE_URL;
  const oldFetch = globalThis.fetch;
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_REST_BASE_URL = 'https://fixture.invalid/rest/test/';
  const pair = { id: 'pair-clear', entityType: 'COMPANY', bitrix24Id: 'b24-clear', moyskladId: 'ms-clear', moyskladType: 'counterparty', moyskladParentId: null, active: false, lifecycleStatus: 'TOMBSTONED', tombstoneSource: 'MOYSKLAD', deletionMarkerStatus: 'MARKED' };
  let body = '';
  globalThis.fetch = async (_input, init) => { body = String(init?.body); return Response.json({ result: true }); };
  const tx = {
    $queryRaw: async () => [{ locked: 1 }],
    entityPair: {
      findUnique: async () => pair,
      findFirst: async () => null,
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(pair, data); return pair; },
    },
    adminAuditEntry: { create: async () => ({}) },
  };
  const database = {
    entityPair: {
      findUnique: async () => pair,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(pair, data); return { count: 1 }; },
    },
    ...mockLifecycleLocks(),
    syncSetting: { findUnique: async () => ({ clientDeletionMarkerFields: { COMPANY: 'UF_ARCHIVE_STATE' } }) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const gateway = { readBitrix: async (_entity: string, id: string) => ({ ID: id }), readMoysklad: async (_type: string, id: string) => ({ id }) };
  const service = new ClientLifecycleService(database as never, gateway as never, { read: async () => ({ mode: 'on' }) } as never);
  try {
    assert.deepEqual(await service.restore(pair.id, true, 'BITRIX24_USER:42'), { status: 'RESTORED', pairId: pair.id });
    const form = new URLSearchParams(body);
    assert.equal(form.get('id'), pair.bitrix24Id);
    assert.equal(form.get('fields[UF_ARCHIVE_STATE]'), '');
    assert.equal(pair.lifecycleStatus, 'ACTIVE');
    assert.equal(pair.deletionMarkerStatus, 'CLEARED');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = oldMode;
    if (oldBase === undefined) delete process.env.BITRIX24_REST_BASE_URL; else process.env.BITRIX24_REST_BASE_URL = oldBase;
  }
});
