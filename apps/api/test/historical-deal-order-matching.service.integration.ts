import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HistoricalDealOrderMatchingService } from '../src/historical-deal-order-matching.service';

const uuidA = '7d0b9d5e-72dd-4d3e-9192-2608a0e55e10';
const uuidB = '2a3f1f88-1a28-4764-b30e-8b72991c1609';
const uuidC = 'a9404d1c-79a7-42cb-9635-0fe177b8ca1a';
const uuidD = '6ddcb23e-9754-421f-8827-55ac7021c51b';
const checkpoint = new Date('2026-10-08T00:00:00Z');

test('a complete local preview classifies exact matches and apply writes only unoccupied internal pairs', async () => {
  const db = createDatabase();
  const service = new HistoricalDealOrderMatchingService(db as never);

  await service.startPreview();
  let status = await waitFor(service, (value) => value.run?.status === 'complete');
  assert.equal(status.previewFresh, true);
  const counts = status.run!.counts as Record<string, number>;
  assert.equal(counts.MATCH_READY, 1);
  assert.equal(counts.DUPLICATE_BITRIX24_KEY, 2);
  assert.equal(counts.UNMATCHED_BITRIX24, 1);
  assert.equal(counts.INVALID_BITRIX24_KEY, 1);
  assert.equal(counts.UNMATCHED_MOYSKLAD, 1);
  assert.equal(counts.INVALID_MOYSKLAD_ID, 1);
  assert.equal(db.pairs.length, 0, 'preview must not write pair rows');

  const runId = status.run!.id;
  await assert.rejects(() => service.applyPreview(runId, false), /MATCH_APPLY_CONFIRMATION_REQUIRED/);
  await service.applyPreview(runId, true);
  status = await waitFor(service, (value) => value.run?.applyStatus === 'complete');
  assert.equal(status.run?.appliedCount, 1);
  assert.equal(db.pairs.length, 1);
  assert.equal(db.pairs[0].source, 'HISTORICAL_MATCH');
  assert.equal(db.pairs[0].reason, `HISTORICAL_MATCH_RUN:${runId}`);
  assert.equal(db.pairs[0].bitrix24Id, 'deal-1');
  assert.equal(db.pairs[0].moyskladId, uuidA);
});

test('apply rechecks occupancy and withholds a candidate paired elsewhere after preview', async () => {
  const db = createDatabase({ onlyOneMatch: true });
  const service = new HistoricalDealOrderMatchingService(db as never);
  await service.startPreview();
  const status = await waitFor(service, (value) => value.run?.status === 'complete');
  db.pairs.push({ id: 'manual-race', entityType: 'DEAL', bitrix24Id: 'other-deal', moyskladId: uuidA, active: true, source: 'MANUAL', reason: null, createdAt: checkpoint });

  await service.applyPreview(status.run!.id, true);
  const applied = await waitFor(service, (value) => value.run?.applyStatus === 'complete');
  assert.equal(applied.run?.appliedCount, 0);
  assert.equal(db.pairs.length, 1);
  const conflict = await service.listResults({ runId: status.run!.id, category: 'PAIR_CONFLICT' });
  assert.equal(conflict.results[0]?.applyStatus, 'withheld_conflict');
});

test('an inventory revision change makes a completed preview stale before any pair write', async () => {
  const db = createDatabase({ onlyOneMatch: true });
  const service = new HistoricalDealOrderMatchingService(db as never);
  await service.startPreview();
  const status = await waitFor(service, (value) => value.run?.status === 'complete');
  db.changeInventoryRevision();

  assert.equal((await service.readStatus()).previewFresh, false);
  await assert.rejects(() => service.applyPreview(status.run!.id, true), /MATCH_PREVIEW_STALE/);
  assert.equal(db.pairs.length, 0);
});

function createDatabase(options: { onlyOneMatch?: boolean } = {}) {
  const now = new Date(checkpoint);
  const entries = [
    entry('BITRIX24', 'deal-1', uuidA),
    ...(options.onlyOneMatch ? [] : [entry('BITRIX24', 'deal-2', uuidB), entry('BITRIX24', 'deal-3', uuidB), entry('BITRIX24', 'deal-4', uuidC), entry('BITRIX24', 'deal-5', null)]),
    entry('MOYSKLAD', uuidA, uuidA),
    ...(options.onlyOneMatch ? [] : [entry('MOYSKLAD', uuidB, uuidB), entry('MOYSKLAD', uuidD, uuidD), entry('MOYSKLAD', 'invalid-ms-id', 'invalid-ms-id')]),
  ];
  const pairs: Array<{ id: string; entityType: string; bitrix24Id: string; moyskladId: string; active: boolean; source: string; reason: string | null; createdAt: Date }> = [];
  const runs: Array<Record<string, any>> = [];
  const results: Array<Record<string, any>> = [];
  const duplicateKeys: Array<{ runId: string; keyValue: string; recordCount: number }> = [];
  let idCounter = 0;
  let inventoryRevision = 12;
  const matches = (row: Record<string, any>, where: Record<string, any> = {}): boolean => {
    for (const [key, expected] of Object.entries(where)) {
      if (key === 'OR') {
        if (!(expected as Record<string, any>[]).some((part) => matches(row, part))) return false;
      } else if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
        if ('in' in expected && !(expected.in as unknown[]).includes(row[key])) return false;
        if ('gt' in expected && !(row[key] > expected.gt)) return false;
        if ('lt' in expected && !(row[key] < expected.lt)) return false;
      } else if (row[key] !== expected) return false;
    }
    return true;
  };
  const change = (row: Record<string, any>, data: Record<string, any>) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) row[key] = (row[key] ?? 0) + value.increment;
      else row[key] = value;
    }
    row.updatedAt = new Date();
  };
  const database: Record<string, any> = {
    pairs,
    historicalInventoryJob: {
      findUnique: async () => ({ status: 'complete', phase: 'COMPLETE', bitrixProcessed: entries.filter((row) => row.source === 'BITRIX24').length, moyskladProcessed: entries.filter((row) => row.source === 'MOYSKLAD').length, bitrixTotal: entries.filter((row) => row.source === 'BITRIX24').length, moyskladTotal: entries.filter((row) => row.source === 'MOYSKLAD').length, checkpointAt: checkpoint, inventoryRevision, updatedAt: checkpoint }),
    },
    historicalInventoryEntry: {
      groupBy: async ({ by }: { by: string[] }) => {
        const groups = [...new Set(entries.map((row) => (row as unknown as Record<string, any>)[by[0]]))];
        return groups.map((source) => {
          const sourceRows = entries.filter((row) => (row as unknown as Record<string, any>)[by[0]] === source);
          return { source, _count: { _all: sourceRows.length }, _max: { updatedAt: new Date(Math.max(...sourceRows.map((row) => row.updatedAt.getTime()))) } };
        });
      },
      findMany: async ({ where, orderBy, take }: { where: Record<string, any>; orderBy?: Record<string, string>; take?: number }) => {
        const rows = entries.filter((row) => matches(row, where)).sort((a, b) => orderBy?.externalId === 'asc' ? a.externalId.localeCompare(b.externalId) : a.externalId.localeCompare(b.externalId));
        return take ? rows.slice(0, take) : rows;
      },
    },
    historicalDealOrderDuplicateKey: {
      findMany: async ({ where }: { where: Record<string, any> }) => duplicateKeys.filter((row) => matches(row, where)),
    },
    historicalDealOrderMatchingRun: {
      findFirst: async () => runs.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => runs.find((row) => row.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, any> }) => {
        const row = { id: `run-${++idCounter}`, createdAt: now, updatedAt: now, leaseOwner: null, leaseUntil: null, bitrixProcessed: 0, moyskladProcessed: 0, applyStatus: 'not_started', appliedCount: 0, counts: {}, ...data };
        runs.push(row); return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        const rows = runs.filter((row) => matches(row, where)); rows.forEach((row) => change(row, data)); return { count: rows.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => { const row = runs.find((item) => item.id === where.id)!; change(row, data); return row; },
    },
    historicalDealOrderMatchResult: {
      createMany: async ({ data }: { data: Record<string, any>[] }) => {
        for (const item of data) if (!results.some((row) => row.runId === item.runId && row.sourceSystem === item.sourceSystem && row.sourceEntityId === item.sourceEntityId)) results.push({ id: `result-${++idCounter}`, createdAt: now, ...item });
        return { count: data.length };
      },
      findMany: async ({ where, orderBy, take }: { where: Record<string, any>; orderBy?: Record<string, string>; take?: number }) => results.filter((row) => matches(row, where)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, take),
      groupBy: async ({ by, where }: { by: string[]; where: Record<string, any> }) => {
        const counts = new Map<string, number>();
        for (const row of results.filter((item) => matches(item, where))) counts.set(row[by[0]], (counts.get(row[by[0]]) ?? 0) + 1);
        return [...counts].map(([category, count]) => ({ category, _count: { _all: count } }));
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => { const row = results.find((item) => item.id === where.id)!; change(row, data); return row; },
    },
    entityPair: {
      findMany: async ({ where }: { where: Record<string, any> }) => pairs.filter((row) => matches(row, where)),
      create: async ({ data }: { data: Record<string, any> }) => { const row = { id: `pair-${++idCounter}`, createdAt: now, ...data } as typeof pairs[number]; pairs.push(row); return row; },
    },
    $executeRaw: async () => {
      const counts = new Map<string, number>();
      for (const row of entries.filter((item) => item.source === 'BITRIX24')) {
        const key = row.fields.UF_CRM_1719836973;
        if (typeof key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const runId = runs.at(-1)!.id;
      for (const [keyValue, recordCount] of counts) if (recordCount > 1) duplicateKeys.push({ runId, keyValue, recordCount });
      return duplicateKeys.length;
    },
    $transaction: async <T>(operation: (tx: unknown) => Promise<T>) => operation(database),
    $queryRaw: async () => [{ id: 'deal-order-history', locked: 1 }],
    changeInventoryRevision: () => { inventoryRevision++; },
  };
  return database;
}

function entry(source: 'BITRIX24' | 'MOYSKLAD', externalId: string, key: string | null): { id: string; source: 'BITRIX24' | 'MOYSKLAD'; externalId: string; label: string; fields: Record<string, unknown>; fieldTitles: Record<string, unknown>; observedAt: Date; updatedAt: Date } {
  const fields = source === 'BITRIX24' ? { UF_CRM_1719836973: key } : { id: externalId };
  return { id: `${source}:${externalId}`, source, externalId, label: `${source} ${externalId}`, fields, fieldTitles: { UF_CRM_1719836973: 'UUID поля', id: 'ID' }, observedAt: checkpoint, updatedAt: checkpoint };
}

async function waitFor(service: HistoricalDealOrderMatchingService, predicate: (status: Awaited<ReturnType<HistoricalDealOrderMatchingService['readStatus']>>) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await service.readStatus();
    if (predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Matching run did not reach the expected state.');
}
