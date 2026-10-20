#!/usr/bin/env node
// Reconstructs the production 25-migration history in an explicitly provisioned,
// empty test database, seeds synthetic continuity fixtures, then applies the full
// candidate and verifies fixture preservation plus Prisma schema parity.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedDatabase = process.env.ISSUE79_UPGRADE_TEST_DATABASE;
const databaseUrl = process.env.DATABASE_URL;
if (!/^sync_issue79_upgrade_[a-z0-9_]+_test$/.test(expectedDatabase ?? '')) {
  throw new Error('Set ISSUE79_UPGRADE_TEST_DATABASE to a new, dedicated sync_issue79_upgrade_<run>_test database name.');
}
if (!databaseUrl) throw new Error('Set DATABASE_URL to that dedicated test database; never use a production URL.');

const production25 = {
  '20260930000000_init': 'e266c7430d68ac042d95578a34ed94fc22c97744f154ab95a179b64366675045',
  '20260930010000_inbound_events': '8b737609e5c17355876f3975f9cedf1572cbcefdaf081010c8dd3d8f339fa5ee',
  '20261002090000_contact_email_sync': '9c371f1e97276dc5fde5e7aaaac1d7d6cf0287726832d803f43dfe86db5630ac',
  '20261002100000_contact_event_claim': 'eeebcc2a104580661264a200db04fafcd44b732ff367b43c00c86e89a3e1d4e8',
  '20261002110000_contact_event_kind': 'ad353062446bbba5af7d53ebc9e4a272568d8363ae97510e0c52bbc497f19410',
  '20261002120000_sync_settings': '7b8ca65863492603505d0b11c6df602422c00de4bc95d40b82ca34d0cbe6b286',
  '20261002130000_sync_direction_settings': '738f6f0e6d9b43d8d73f0c271425932aee6c624112044b37702f7edef34d0e69',
  '20261002140000_off_resume_cursor': '520fa30bf79b73ff202444f01a50374c62ef5d940851f3c4c1dfad3be956b69c',
  '20261005000000_monitoring_retention': '5ff02ccb2816bbba1e78d7109b3cc8bc382813a6ae0c31b5c5061d6319f2d421',
  '20261005100000_event_retry_backoff': 'a6f0d09081a5d2323823af35403e1415caec0098664b3381fa40b24305848f9f',
  '20261005120000_nightly_reconciliation': '68077911f40fabb6cae5f5d22145c319799618537f3be684c28c839aa2e95bc2',
  '20261005130000_entity_processing_lease': '6a382d43c0667e58a5ad7fb8678a15929fa820ecc813b9ce354195e378258da7',
  '20261007010000_field_settings_versions': 'f281582ba17c9dcab36dd9b28cc285ed48bb44433da624da1a2332a31f3e77f3',
  '20261007090000_entity_pair_resolution': '431e21d6ac23d557ed8f49a99f29ce15654e7efa970922d65fc69baad8759394',
  '20261007111500_entity_pair_baseline': 'cffdd5983c0919d54467d76353fe3afa8ef98b437c390ad02402dc99301757ca',
  '20261007113000_entity_pair_sync_state': '045214d1c49a09b73195f6385bb29820ebe15cc7d97e06831a37bb7dbf41a306',
  '20261007140000_deal_order_create_operation': '20afb09985cce477f191e7c83fb4291023029734135edb62deec803b004b116e',
  '20261007140000_historical_inventory': '7dbb2689dbf8b3f8d51afa50b5b17c0f9d3eb1fd50f3c521e772c7f6a61bdd64',
  '20261007150000_deal_order_create_attempted_at': '8ba11ee8744cc4daa148784fdd1c53452103fdd21f0b14880a2a380677894aeb',
  '20261007160000_deal_order_create_lease': '3d437071a4578575486a1377ba262a8f627cca6bfb823867115f43409f1fad19',
  '20261007170000_deal_order_position_pairs': '9c67ea114893c77e5f3a88712bd228676387f988b64c2cc36f8995d1ffc7652d',
  '20261007180000_deal_order_position_add_operations': '5d4bc4b83284697bcac377a8951cde5680fddd67a5934529e78cc2a6cc3a9b8e',
  '20261008100000_historical_deal_order_matching': '0b81c769053d2c8db0866fc39479eb139d0033a34f1898d94d53f7e69250b39c',
  '20261008110000_dependency_create_operation': '9b27b04467d843b2fb85bdcd9ad113322a5dc1cf49a867f241ca11fb02ee7649',
  '20261008120000_deal_order_customer_pair_refs': 'ca3b9e6381d727bf4b5be52a1273400147a372bce72c30e1ff3a1802eaf793cd',
};

const psql = process.env.PSQL_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe' : 'psql');
const psqlUrl = new URL(databaseUrl);
if (!['127.0.0.1', '::1', 'localhost'].includes(psqlUrl.hostname)) throw new Error('Upgrade proof is restricted to a loopback PostgreSQL host.');
psqlUrl.searchParams.delete('schema');
const query = (sql) => execFileSync(psql, ['--no-psqlrc', '--tuples-only', '--no-align', '--field-separator=\t', '--set=ON_ERROR_STOP=1', '--dbname', psqlUrl.toString(), '--command', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'issue79-upgrade-'));
try {
  const dbName = query('SELECT current_database()').trim();
  if (dbName !== expectedDatabase) throw new Error(`Connected database ${dbName} does not match guarded target ${expectedDatabase}.`);
  const relationCount = Number(query(`
    SELECT count(*)::int AS n FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
  `));
  if (relationCount !== 0) throw new Error('Refusing non-empty target database; create a brand-new test database.');

  const migrationRoot = path.join(repo, 'prisma', 'migrations');
  const expectedNames = Object.keys(production25).sort();
  const presentProductionNames = readdirSync(migrationRoot).filter((name) => production25[name]).sort();
  if (JSON.stringify(presentProductionNames) !== JSON.stringify(expectedNames)) throw new Error('Production migration folder set does not match the pinned 25-name manifest.');
  for (const name of expectedNames) {
    const sqlPath = path.join(migrationRoot, name, 'migration.sql');
    const actual = createHash('sha256').update(readFileSync(sqlPath)).digest('hex');
    if (actual !== production25[name]) throw new Error(`Applied migration checksum drift: ${name}`);
  }

  const baselineRoot = path.join(tempRoot, 'baseline');
  const baselineMigrations = path.join(baselineRoot, 'migrations');
  mkdirSync(baselineMigrations, { recursive: true });
  copyFileSync(path.join(repo, 'prisma', 'schema.prisma'), path.join(baselineRoot, 'schema.prisma'));
  copyFileSync(path.join(migrationRoot, 'migration_lock.toml'), path.join(baselineMigrations, 'migration_lock.toml'));
  for (const name of expectedNames) {
    const destination = path.join(baselineMigrations, name);
    mkdirSync(destination);
    copyFileSync(path.join(migrationRoot, name, 'migration.sql'), path.join(destination, 'migration.sql'));
  }
  const prismaCli = path.join(repo, 'node_modules', 'prisma', 'build', 'index.js');
  const runPrisma = (schemaPath) => execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: repo, stdio: 'inherit', env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  runPrisma(path.join(baselineRoot, 'schema.prisma'));
  const actualNames = query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name').split(/\r?\n/).filter(Boolean);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error('Baseline did not apply exactly the production 25 migrations.');

  query(`
    INSERT INTO "SyncSetting" ("id", "serviceMode", "offSince", "updatedAt")
    VALUES ('global', 'off', '2026-10-19T00:00:00Z', now());
    INSERT INTO "InboundEvent" ("id", "source", "deliveryKey", "eventType", "payload", "status", "attempts", "receivedAt")
    VALUES ('fixture-event-issue79', 'synthetic', 'fixture-delivery-issue79', 'TEST', '{"synthetic":true}', 'RECEIVED', 2, now());
    INSERT INTO "EntityPair" ("id", "entityType", "bitrix24Id", "moyskladId", "active", "source", "createdAt")
    VALUES ('fixture-pair-issue79', 'PRODUCT', 'synthetic-b24-id', 'synthetic-ms-id', true, 'MANUAL', now());
    INSERT INTO "HistoricalInventoryJob" ("id", "runId", "status", "phase", "bitrixStart", "moyskladOffset", "updatedAt")
    VALUES ('deal-order-history', 'synthetic-run-issue79', 'paused', 'MOYSKLAD', 120, 37, now());
    INSERT INTO "DealOrderCreateOperation" ("bitrix24DealId", "syncId", "payload", "settingsVersion", "status", "createdAt", "updatedAt")
    VALUES ('synthetic-deal-issue79', 'synthetic-sync-issue79', '{"synthetic":true}', 6, 'PENDING', now(), now());
  `);
  const manifest = path.join(repo, 'prisma', 'migrations');
  if (!existsSync(path.join(manifest, '20261016100000_deal_order_exchange', 'migration.sql'))) throw new Error('Candidate migration tree missing.');
  runPrisma(path.join(repo, 'prisma', 'schema.prisma'));

  const [setting, event, pair, cursor, operation] = query(`
    SELECT (SELECT "serviceMode" || ':' || COALESCE("offSince"::date::text,'') FROM "SyncSetting" WHERE id='global'),
           (SELECT "status" || ':' || attempts::text || ':' || "deliveryKey" FROM "InboundEvent" WHERE id='fixture-event-issue79'),
           (SELECT "bitrix24Id" || ':' || "moyskladId" || ':' || active::text FROM "EntityPair" WHERE id='fixture-pair-issue79'),
           (SELECT status || ':' || phase || ':' || "bitrixStart"::text || ':' || "moyskladOffset"::text FROM "HistoricalInventoryJob" WHERE id='deal-order-history'),
           (SELECT status || ':' || "settingsVersion"::text || ':' || "syncId" FROM "DealOrderCreateOperation" WHERE "bitrix24DealId"='synthetic-deal-issue79')
  `).split('\t');
  if (setting !== 'off:2026-10-19') throw new Error(`Sync mode fixture changed: ${setting}`);
  if (event !== 'RECEIVED:2:fixture-delivery-issue79') throw new Error(`Queue fixture changed: ${event}`);
  if (pair !== 'synthetic-b24-id:synthetic-ms-id:true') throw new Error(`Pair fixture changed: ${pair}`);
  if (cursor !== 'paused:MOYSKLAD:120:37') throw new Error(`Inventory cursor fixture changed: ${cursor}`);
  if (operation !== 'PENDING:6:synthetic-sync-issue79') throw new Error(`Operation fixture changed: ${operation}`);

  execFileSync(process.execPath, [prismaCli, 'migrate', 'diff', '--exit-code', '--from-url', databaseUrl, '--to-schema-datamodel', path.join(repo, 'prisma', 'schema.prisma')], {
    cwd: repo, stdio: 'inherit', env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  console.log(`PASS: exact production-25 upgrade preserved synthetic fixtures on ${expectedDatabase}; schema drift is zero.`);
} finally {
  const normalized = path.resolve(tempRoot);
  if (!normalized.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(normalized).startsWith('issue79-upgrade-')) {
    throw new Error('Refusing to remove unexpected temporary path.');
  }
  rmSync(normalized, { recursive: true, force: true });
}
