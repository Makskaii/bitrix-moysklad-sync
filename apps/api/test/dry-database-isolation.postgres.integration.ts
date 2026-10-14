import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseService } from '../src/database.service';

test('apply and dry PostgreSQL schemas keep runtime state separate and use UTF-8', {
  skip: process.env.ISSUE57_DRY_ISOLATION_POSTGRES !== '1',
}, async () => {
  const applyUrl = process.env.DATABASE_URL;
  const dryUrl = process.env.DRY_DATABASE_URL;
  assert.ok(applyUrl && dryUrl, 'Set both DATABASE_URL and DRY_DATABASE_URL to isolated test schemas');
  const apply = new URL(applyUrl);
  const dry = new URL(dryUrl);
  assert.match(apply.hostname, /^(localhost|127\.0\.0\.1)$/i, 'Refusing a non-local apply database host');
  assert.match(dry.hostname, /^(localhost|127\.0\.0\.1)$/i, 'Refusing a non-local dry database host');
  assert.match(apply.pathname, /(test|issue57)/i, 'Apply database name must identify a disposable test database');
  assert.match(dry.pathname, /(test|issue57)/i, 'Dry database name must identify a disposable test database');
  assert.notEqual(apply.searchParams.get('schema') ?? 'public', dry.searchParams.get('schema') ?? 'public');

  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
  const applyDb = new DatabaseService();
  process.env.SYNC_MODE = 'dry';
  const dryDb = new DatabaseService();
  const table = `Issue57DryIsolation_${randomUUID().replaceAll('-', '')}`;
  const kinds = ['event', 'pair', 'setting', 'checkpoint', 'log', 'proposal'];
  try {
    const encodings = await Promise.all([
      applyDb.$queryRaw<Array<{ schema: string; encoding: string }>>`SELECT current_schema() AS schema, current_setting('server_encoding') AS encoding`,
      dryDb.$queryRaw<Array<{ schema: string; encoding: string }>>`SELECT current_schema() AS schema, current_setting('server_encoding') AS encoding`,
    ]);
    assert.equal(encodings[0][0]?.encoding, 'UTF8');
    assert.equal(encodings[1][0]?.encoding, 'UTF8');
    assert.notEqual(encodings[0][0]?.schema, encodings[1][0]?.schema);
    await Promise.all([
      applyDb.$executeRawUnsafe(`CREATE TABLE "${table}" ("kind" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`),
      dryDb.$executeRawUnsafe(`CREATE TABLE "${table}" ("kind" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`),
    ]);
    for (const kind of kinds) {
      await dryDb.$executeRawUnsafe(`INSERT INTO "${table}" ("kind", "value") VALUES ($1, $2)`, kind, `dry-${kind}`);
    }
    const applyRows = await applyDb.$queryRawUnsafe<Array<{ kind: string; value: string }>>(`SELECT "kind", "value" FROM "${table}" ORDER BY "kind"`);
    const dryRows = await dryDb.$queryRawUnsafe<Array<{ kind: string; value: string }>>(`SELECT "kind", "value" FROM "${table}" ORDER BY "kind"`);
    assert.deepEqual(applyRows, []);
    assert.deepEqual(dryRows.map((row) => row.value), kinds.map((kind) => `dry-${kind}`).sort());
  } finally {
    await Promise.all([applyDb.$disconnect(), dryDb.$disconnect()]);
    if (previousMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = previousMode;
  }
});
