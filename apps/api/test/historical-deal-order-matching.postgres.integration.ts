import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DatabaseService } from '../src/database.service';
import { HistoricalDealOrderMatchingService } from '../src/historical-deal-order-matching.service';

const uuidA = '7d0b9d5e-72dd-4d3e-9192-2608a0e55e10';
const uuidB = '2a3f1f88-1a28-4764-b30e-8b72991c1609';
const uuidC = 'a9404d1c-79a7-42cb-9635-0fe177b8ca1a';
const checkpoint = new Date('2026-10-08T00:00:00Z');
const dealIds = [`matching-test-${uuidA}`, `matching-test-${uuidB}`, `matching-test-${uuidC}`];
const pairIds: string[] = [];
let database: DatabaseService;
let service: HistoricalDealOrderMatchingService;
let priorMode: string | undefined;
let priorDryUrl: string | undefined;
let createdInventoryJob = false;
let fixtureInitialized = false;

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to an isolated ephemeral PostgreSQL database');
  assert.equal(process.env.HISTORICAL_MATCHING_TEST_ISOLATED, '1', 'set HISTORICAL_MATCHING_TEST_ISOLATED=1 only for the isolated database');
  const url = new URL(process.env.DATABASE_URL);
  assert.match(url.hostname, /^(localhost|127\.0\.0\.1|postgres)$/i, 'refusing to run against a non-local database host');
  assert.match(url.pathname, /(issue.?50.*matching|matching.*issue.?50)/i, 'database name must identify the issue-50 matching test');
  const repositoryRoot = resolve(__dirname, '../../../../');
  const migration = spawnSync(process.execPath, [
    resolve(repositoryRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', resolve(repositoryRoot, 'prisma/schema.prisma'),
  ], { cwd: repositoryRoot, env: process.env, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(migration.status, 0, 'Prisma migrations must deploy successfully to the guarded isolated #50 database');
  priorMode = process.env.SYNC_MODE;
  priorDryUrl = process.env.DRY_DATABASE_URL;
  process.env.SYNC_MODE = 'dry';
  process.env.DRY_DATABASE_URL = process.env.DATABASE_URL;
  database = new DatabaseService();
  await database.$connect();
  const applied = await database.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = '20261008100000_historical_deal_order_matching' AND finished_at IS NOT NULL`;
  assert.equal(applied.length, 1, 'matching migration must be applied to the isolated test database');
  assert.equal(await database.historicalInventoryEntry.count(), 0, 'isolated test inventory must start empty');
  assert.equal(await database.historicalDealOrderMatchingRun.count(), 0, 'isolated test runs must start empty');
  assert.equal(await database.entityPair.count(), 0, 'isolated test pairs must start empty');
  assert.equal(await database.historicalInventoryJob.findUnique({ where: { id: 'deal-order-history' } }), null, 'isolated test must not contain the historical inventory job');
  createdInventoryJob = true;
  fixtureInitialized = true;
  await database.historicalInventoryJob.upsert({
    where: { id: 'deal-order-history' },
    create: { id: 'deal-order-history', status: 'complete', phase: 'COMPLETE', bitrixProcessed: 3, bitrixTotal: 3, moyskladProcessed: 3, moyskladTotal: 3, checkpointAt: checkpoint, inventoryRevision: 3 },
    update: { status: 'complete', phase: 'COMPLETE', bitrixProcessed: 3, bitrixTotal: 3, moyskladProcessed: 3, moyskladTotal: 3, checkpointAt: checkpoint, inventoryRevision: 3 },
  });
  for (const [index, uuid] of [uuidA, uuidB, uuidC].entries()) {
    await database.historicalInventoryEntry.create({ data: {
      source: 'BITRIX24', externalId: dealIds[index], label: `Synthetic deal ${index + 1}`,
      fields: { UF_CRM_1719836973: uuid }, fieldTitles: { UF_CRM_1719836973: 'UUID order link' },
    } });
    await database.historicalInventoryEntry.create({ data: {
      source: 'MOYSKLAD', externalId: uuid, label: `Synthetic customer order ${index + 1}`,
      fields: { id: uuid }, fieldTitles: { id: 'ID' },
    } });
  }
  service = new HistoricalDealOrderMatchingService(database);
});

after(async () => {
  if (database && fixtureInitialized) {
    await database.historicalDealOrderMatchingRun.deleteMany();
    await database.entityPair.deleteMany({ where: { id: { in: pairIds } } });
    await database.historicalInventoryEntry.deleteMany({ where: { externalId: { in: [...dealIds, uuidA, uuidB, uuidC] } } });
    if (createdInventoryJob) await database.historicalInventoryJob.deleteMany({ where: { id: 'deal-order-history' } });
    await database.$disconnect();
  }
  if (priorMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = priorMode;
  if (priorDryUrl === undefined) delete process.env.DRY_DATABASE_URL; else process.env.DRY_DATABASE_URL = priorDryUrl;
});

test('PostgreSQL fences concurrent apply, preserves pair uniqueness, and resumes a committed checkpoint idempotently', async () => {
  await service.startPreview();
  let status = await waitFor((value) => value.run?.status === 'complete');
  assert.equal((status.run!.counts as Record<string, number>).MATCH_READY, 3);

  const runId = status.run!.id;
  await Promise.all([service.applyPreview(runId, true), service.applyPreview(runId, true)]);
  status = await waitFor((value) => value.run?.applyStatus === 'complete');
  assert.equal(status.run?.appliedCount, 3);
  const saved = await database.entityPair.findMany({ where: { entityType: 'DEAL', active: true } });
  assert.equal(saved.length, 3);
  pairIds.push(...saved.map((pair) => pair.id));
  assert.ok(saved.every((pair) => pair.source === 'HISTORICAL_MATCH' && pair.reason === `HISTORICAL_MATCH_RUN:${runId}`));
  await service.applyPreview(runId, true);
  assert.equal(await database.entityPair.count({ where: { entityType: 'DEAL', active: true } }), 3);

  const result = await database.historicalDealOrderMatchResult.findFirst({ where: { runId, category: 'APPLIED' }, orderBy: { id: 'asc' } });
  assert.ok(result);
  const firstAppliedPair = await database.entityPair.create({ data: {
    entityType: 'DEAL', bitrix24Id: result!.sourceEntityId, moyskladId: result!.linkedEntityId!,
    active: true, source: 'HISTORICAL_MATCH', reason: `HISTORICAL_MATCH_RUN:${runId}`,
  } });
  pairIds.push(firstAppliedPair.id);
  await database.entityPair.deleteMany({ where: { id: { in: saved.map((pair) => pair.id) } } });
  await database.historicalDealOrderMatchingRun.update({ where: { id: runId }, data: { applyStatus: 'failed', applyCursor: result.id, appliedCount: 1 } });
  await database.historicalDealOrderMatchResult.update({ where: { id: result!.id }, data: { category: 'APPLIED', applyStatus: 'applied', pairId: firstAppliedPair.id } });
  await service.applyPreview(runId, true);
  status = await waitFor((value) => value.run?.applyStatus === 'complete');
  assert.equal(status.run?.appliedCount, 3);
  assert.equal(await database.entityPair.count({ where: { entityType: 'DEAL', active: true } }), 3);
  await database.entityPair.deleteMany({ where: { id: firstAppliedPair.id } });
});

test('PostgreSQL rejects stale previews and rechecks conflicting active pairs without reassignment', async () => {
  await service.startPreview();
  let status = await waitFor((value) => value.run?.status === 'complete');
  const runId = status.run!.id;
  await database.historicalInventoryJob.update({ where: { id: 'deal-order-history' }, data: { inventoryRevision: { increment: 1 } } });
  status = await service.readStatus();
  assert.equal(status.previewFresh, false);
  await assert.rejects(() => service.applyPreview(runId, true), /MATCH_PREVIEW_STALE/);

  await database.historicalInventoryJob.update({ where: { id: 'deal-order-history' }, data: { inventoryRevision: 3 } });
  await service.startPreview();
  status = await waitFor((value) => value.run?.status === 'complete' && value.run.id !== runId);
  const conflictRunId = status.run!.id;
  const blocker = await database.entityPair.create({ data: {
    entityType: 'DEAL', bitrix24Id: 'different-deal', moyskladId: uuidA, source: 'MANUAL', reason: 'synthetic conflict',
  } });
  pairIds.push(blocker.id);
  await service.applyPreview(conflictRunId, true);
  const conflictStatus = await waitFor((value) => value.run?.applyStatus === 'complete');
  assert.equal(conflictStatus.run?.appliedCount, 2);
  assert.equal(await database.entityPair.count({ where: { entityType: 'DEAL', active: true, moyskladId: uuidA } }), 1);
  assert.equal(await database.entityPair.count({ where: { entityType: 'DEAL', active: true, bitrix24Id: 'different-deal' } }), 1);
  const historicalPairs = await database.entityPair.findMany({ where: { source: 'HISTORICAL_MATCH', reason: { startsWith: `HISTORICAL_MATCH_RUN:${conflictRunId}` } }, select: { id: true } });
  pairIds.push(...historicalPairs.map((pair) => pair.id));
});

async function waitFor(predicate: (status: Awaited<ReturnType<HistoricalDealOrderMatchingService['readStatus']>>) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await service.readStatus();
    if (predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Matching run did not reach the expected state.');
}
