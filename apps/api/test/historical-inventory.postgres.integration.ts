import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DatabaseService } from '../src/database.service';
import { HISTORICAL_INVENTORY_FETCHER, HistoricalInventoryService } from '../src/historical-inventory.service';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const prefix = `issue45-${suffix}-`;
const originalEnv = new Map<string, string | undefined>();
let apps: INestApplication[] = [];
let database: DatabaseService;

before(async () => {
  assert.equal(process.env.HISTORICAL_INVENTORY_TEST_ISOLATED, '1', 'set HISTORICAL_INVENTORY_TEST_ISOLATED=1 only for a disposable isolated database');
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to a disposable isolated PostgreSQL database');
  const databaseUrl = new URL(process.env.DATABASE_URL);
  assert.match(databaseUrl.hostname, /^(localhost|127\.0\.0\.1|postgres)$/i, 'refusing to run against a non-local database host');
  assert.match(databaseUrl.pathname, /(issue.?45.*inventory|inventory.*issue.?45)/i, 'database name must be dedicated to the #45 inventory integration test');
  for (const key of ['SYNC_MODE', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN']) originalEnv.set(key, process.env[key]);
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.test/rest/1/hook/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.test/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-ms-token';
  const repositoryRoot = resolve(__dirname, '../../../../');
  const migration = spawnSync(process.execPath, [
    resolve(repositoryRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy',
    '--schema', resolve(repositoryRoot, 'prisma/schema.prisma'),
  ], { cwd: repositoryRoot, env: process.env, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(migration.status, 0, 'Prisma migrations must deploy successfully to the guarded isolated #45 database');
  const app = await boot(async () => json({}));
  database = app.get(DatabaseService);
  const applied = await database.$queryRawUnsafe<Array<{ migration_name: string }>>(`
    SELECT migration_name FROM "_prisma_migrations"
    WHERE migration_name = '20261007140000_historical_inventory' AND finished_at IS NOT NULL
  `);
  assert.equal(applied.length, 1, 'the #45 migration must be deployed before this integration test');
  const existing = await database.historicalInventoryJob.findUnique({ where: { id: 'deal-order-history' } });
  assert.equal(existing, null, 'isolated test database must not contain the historical inventory singleton before the test');
});

after(async () => {
  if (database) {
    await database.historicalInventoryEntry.deleteMany({ where: { externalId: { startsWith: prefix } } });
    await database.historicalInventoryJob.deleteMany({ where: { id: 'deal-order-history' } });
  }
  for (const app of apps.reverse()) {
    (app.getHttpServer() as import('node:http').Server).closeAllConnections();
    await app.close();
  }
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('PostgreSQL persists page checkpoints across service restart and enforces one active inventory lease', async () => {
  const runtimeCountsBefore = await countRuntimeRows(database);
  let releaseFirstPage!: () => void;
  let firstPageRequested!: () => void;
  const firstPageGate = new Promise<void>((resolve) => { releaseFirstPage = resolve; });
  const firstPageStarted = new Promise<void>((resolve) => { firstPageRequested = resolve; });
  const fetchFirstRun: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/crm.deal.fields.json')) return json({ result: {} });
    if (url.pathname.endsWith('/crm.deal.list.json')) {
      firstPageRequested();
      await firstPageGate;
      const form = new URLSearchParams(String(init?.body ?? ''));
      const start = Number(form.get('start') ?? 0);
      assert.equal(start, 0);
      return json({ total: 51, next: 50, result: Array.from({ length: 50 }, (_, index) => ({ ID: `${prefix}${index + 1}`, TITLE: `Deal ${index + 1}` })) });
    }
    if (url.pathname.endsWith('/entity/customerorder/metadata')) return json({});
    if (url.pathname.endsWith('/entity/customerorder')) return json({ meta: { size: 0 }, rows: [] });
    throw new Error(`Unexpected upstream path ${url.pathname}`);
  };

  const firstApp = await boot(fetchFirstRun);
  const firstService = firstApp.get(HistoricalInventoryService);
  await firstService.start({ accessToken: 'synthetic-b24-session', requestIntervalMs: 500 });
  await firstPageStarted;
  await firstService.pause();
  releaseFirstPage();
  const paused = await waitForStatus(firstService, 'paused');
  assert.equal(paused.phase, 'BITRIX24');
  assert.equal(paused.bitrixStart, 50);
  assert.equal(await database.historicalInventoryEntry.count({ where: { externalId: { startsWith: prefix } } }), 50);
  (firstApp.getHttpServer() as import('node:http').Server).closeAllConnections();
  await firstApp.close();
  apps = apps.filter((current) => current !== firstApp);

  const resumedStarts: number[] = [];
  const resumedApp = await boot(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/crm.deal.fields.json')) return json({ result: {} });
    if (url.pathname.endsWith('/crm.deal.list.json')) {
      const start = Number(new URLSearchParams(String(init?.body ?? '')).get('start') ?? 0);
      resumedStarts.push(start);
      assert.equal(start, 50, 'restart must resume at the persisted next-page cursor');
      return json({ total: 51, result: [{ ID: `${prefix}50`, TITLE: 'Repeated boundary ID' }, { ID: `${prefix}51`, TITLE: 'Deal 51' }] });
    }
    if (url.pathname.endsWith('/entity/customerorder/metadata')) return json({});
    if (url.pathname.endsWith('/entity/customerorder')) return json({ meta: { size: 0 }, rows: [] });
    throw new Error(`Unexpected upstream path ${url.pathname}`);
  });
  const resumedService = resumedApp.get(HistoricalInventoryService);
  const resumed = await resumedService.start({ accessToken: 'synthetic-new-session', requestIntervalMs: 500 });
  assert.notEqual(resumed.runId, paused.runId, 'resuming creates a new UI-visible run generation');
  const complete = await waitForStatus(resumedService, 'complete');
  assert.deepEqual(resumedStarts, [50]);
  assert.equal(complete.bitrixProcessed, 52);
  assert.equal(await database.historicalInventoryEntry.count({ where: { externalId: { startsWith: prefix } } }), 51, 'replayed boundary ID is idempotent');
  assert.deepEqual(await countRuntimeRows(database), runtimeCountsBefore, 'inventory must not modify pairs or synchronization baselines');

  await database.historicalInventoryEntry.deleteMany({ where: { externalId: { startsWith: prefix } } });
  await database.historicalInventoryJob.deleteMany({ where: { id: 'deal-order-history' } });
  const gateA = makeGate();
  const gateB = makeGate();
  const counters = [{ bitrix: 0, moysklad: 0 }, { bitrix: 0, moysklad: 0 }];
  const appsForRace = await Promise.all([
    boot(async (input) => gatedMetadata(input, counters[0], gateA.promise)),
    boot(async (input) => gatedMetadata(input, counters[1], gateB.promise)),
  ]);
  const [serviceA, serviceB] = appsForRace.map((app) => app.get(HistoricalInventoryService));
  await Promise.all([
    serviceA.start({ accessToken: 'synthetic-session-a', requestIntervalMs: 500 }),
    serviceB.start({ accessToken: 'synthetic-session-b', requestIntervalMs: 500 }),
  ]);
  await waitForCondition(() => counters.reduce((sum, value) => sum + value.bitrix, 0) >= 1, async () => {
    const state = await serviceA.readStatus();
    return `metadata calls=${JSON.stringify(counters)}, job=${state.status}, error=${state.error}`;
  });
  assert.equal(counters.reduce((sum, value) => sum + value.bitrix, 0), 1, 'only one worker should issue a metadata read');
  await serviceB.pause();
  gateA.resolve(); gateB.resolve();
  const [afterA, afterB] = await Promise.all([waitForStatus(serviceA, 'paused'), waitForStatus(serviceB, 'paused')]);
  assert.equal(afterA.runId, afterB.runId);
  assert.deepEqual(counters.map((value) => value.bitrix + value.moysklad).sort(), [0, 1], 'exactly one process owns the active lease');
  assert.equal(await database.historicalInventoryEntry.count(), 0, 'concurrent claim test must not write inventory rows');
});

async function boot(fetcher: typeof fetch) {
  @Module({ providers: [DatabaseService, HistoricalInventoryService, { provide: HISTORICAL_INVENTORY_FETCHER, useValue: fetcher }] })
  class HistoricalInventoryPostgresTestModule {}
  const app = await NestFactory.create(HistoricalInventoryPostgresTestModule, { logger: false });
  await app.init();
  apps.push(app);
  database = app.get(DatabaseService);
  return app;
}

async function waitForStatus(service: HistoricalInventoryService, expected: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const status = await service.readStatus();
    if (status.status === expected) return status;
    if (status.status === 'failed') throw new Error(`Inventory worker failed: ${status.error}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Inventory did not reach ${expected}`);
}

async function countRuntimeRows(db: DatabaseService) {
  const result = await db.$queryRawUnsafe<Array<{ pairs: bigint; baselines: bigint; states: bigint }>>(`
    SELECT (SELECT COUNT(*) FROM "EntityPair") AS pairs,
      (SELECT COUNT(*) FROM "EntityPairBaseline") AS baselines,
      (SELECT COUNT(*) FROM "EntityPairSyncState") AS states
  `);
  return result[0];
}

async function waitForCondition(predicate: () => boolean, diagnose: () => Promise<string>) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Condition was not reached before timeout. ${await diagnose()}`);
}

function makeGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function gatedMetadata(input: string | URL | Request, counts: { bitrix: number; moysklad: number }, gate: Promise<void>) {
  const pathname = new URL(String(input)).pathname;
  if (pathname.endsWith('/crm.deal.fields.json')) { counts.bitrix++; await gate; return json({ result: {} }); }
  else if (pathname.endsWith('/entity/customerorder/metadata')) return json({});
  else throw new Error(`Unexpected upstream path ${pathname}`);
}

function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }
