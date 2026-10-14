import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { assertConfiguredDatabaseTargets } from '../src/database-target';

function withEnvironment(values: Record<string, string | undefined>, action: () => void) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { action(); } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('dry database startup fails closed when either database URL is missing', () => {
  withEnvironment({ SYNC_MODE: 'dry', DATABASE_URL: undefined, DRY_DATABASE_URL: 'postgresql://user:pass@localhost:5432/test?schema=dry' }, () => {
    assert.throws(() => new DatabaseService(), /DATABASE_URL is required/);
  });
  withEnvironment({ SYNC_MODE: 'dry', DATABASE_URL: 'postgresql://user:pass@localhost:5432/test?schema=apply', DRY_DATABASE_URL: undefined }, () => {
    assert.throws(() => new DatabaseService(), /DRY_DATABASE_URL is required/);
  });
});

test('dry database startup rejects equivalent apply database/schema URLs', () => {
  withEnvironment({
    SYNC_MODE: 'dry',
    DATABASE_URL: 'postgresql://apply-user:secret@LOCALHOST/test?sslmode=require',
    DRY_DATABASE_URL: 'postgres://dry-user:other@localhost:5432/%74est?schema=public&sslmode=require',
  }, () => assert.throws(() => new DatabaseService(), /different PostgreSQL databases? or schemas?/));
  withEnvironment({
    SYNC_MODE: 'apply',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/test?schema=public',
    DRY_DATABASE_URL: 'postgresql://other:secret@LOCALHOST/test?sslmode=require',
  }, () => assert.throws(() => new DatabaseService(), /different PostgreSQL databases or schemas/));
  withEnvironment({
    SYNC_MODE: 'dry',
    DATABASE_URL: 'postgresql://apply-user:secret@localhost:5432/test?schema=apply',
    DRY_DATABASE_URL: 'postgres://dry-user:other@127.0.0.1/test?schema=apply',
  }, () => assert.throws(() => new DatabaseService(), /different PostgreSQL databases or schemas/));
});

test('Docker validates target separation before invoking migrations', () => {
  withEnvironment({
    SYNC_MODE: 'dry',
    DATABASE_URL: 'postgresql://apply@localhost/test?schema=apply',
    DRY_DATABASE_URL: 'postgresql://dry@127.0.0.1:5432/%74est?schema=apply',
  }, () => assert.throws(assertConfiguredDatabaseTargets, /different PostgreSQL databases or schemas/));
  withEnvironment({ SYNC_MODE: undefined, DATABASE_URL: 'postgresql://apply@localhost/test', DRY_DATABASE_URL: undefined }, () => {
    assert.throws(assertConfiguredDatabaseTargets, /SYNC_MODE must be dry or apply/);
  });
  withEnvironment({ SYNC_MODE: 'apply', DATABASE_URL: 'postgresql://apply@localhost/test?schema=apply', DRY_DATABASE_URL: 'postgres://dry@127.0.0.1:5432/test?schema=dry' }, () => {
    assert.doesNotThrow(assertConfiguredDatabaseTargets);
  });
  const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');
  assert.ok(dockerfile.indexOf('assertConfiguredDatabaseTargets') < dockerfile.indexOf('prisma migrate deploy'));
  assert.ok(dockerfile.includes(' && { case '), 'mode selection must run only after preflight succeeds');
  assert.ok(dockerfile.includes('} && DATABASE_URL='), 'migration must run only after both preflight and mode selection succeed');
});

test('dry database can select a distinct schema on the same disposable PostgreSQL database', async () => {
  await withDatabase({
    SYNC_MODE: 'dry',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/test?schema=apply',
    DRY_DATABASE_URL: 'postgresql://user:pass@localhost:5432/test?schema=dry_test',
  });
});

async function withDatabase(values: Record<string, string>, run: () => Promise<void> = async () => {}) {
  await new Promise<void>((resolve, reject) => {
    withEnvironment(values, () => {
      try {
        const database = new DatabaseService();
        void database.$disconnect().then(resolve, reject);
      } catch (error) { reject(error); }
    });
  });
  await run();
}
