import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { PrismaClient } from '@prisma/client';
import { ControlledLiveTestAdmissionService, VerifiedControlledSource } from '../src/controlled-live-test-admission.service';
import { setVerifiedControlledLiveProviderNamespace } from '../src/controlled-live-test-namespace';
import { setControlledLiveTestWriteCheck } from '../src/external-write-guard';
import { createControlledLiveTestPolicy } from '../src/controlled-live-test-policy';

const isolated = process.env.CONTROLLED_LIVE_TEST_ADMISSION_REPEAT_POSTGRES_ISOLATED === '1';

test('additive admission migration preserves legacy rows and backfills one binding per existing exact pair', { skip: !isolated }, async () => {
  const databaseUrl = process.env.CONTROLLED_LIVE_TEST_POSTGRES_URL;
  if (!databaseUrl) throw new Error('CONTROLLED_LIVE_TEST_POSTGRES_URL_REQUIRED');
  const parsed = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /(?:^|[_-])test(?:$|[_-])/i);
  const schema = `issue79_admission_upgrade_${randomUUID().replace(/-/g, '').slice(0, 12)}_test`;
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set('schema', schema);
  const admin = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const legacy = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } });
  const migration = await readFile(join(process.cwd(), 'prisma/migrations/20261021100000_controlled_test_event_admissions/migration.sql'), 'utf8');
  const legacyRows = [
    { eventId: `legacy-paired-${randomUUID()}`, runId: `LIVE-TEST-${randomUUID()}`, entity: 'client:COMPANY', sourceSystem: 'BITRIX24', sourceNativeId: `b24-${randomUUID()}`, targetSystem: 'MOYSKLAD', targetNativeId: randomUUID(), bitrix24PortalOrigin: 'https://synthetic.invalid', bitrix24UserId: '3664', moyskladAccountId: 'b0b309ee-13e3-11e9-9109-f8fc0001f188', sourceName: `тест legacy ${randomUUID()}`, sourceCreatedAt: new Date('2026-10-20T10:00:00.000Z'), admittedAt: new Date('2026-10-20T10:01:00.000Z') },
    { eventId: `legacy-reserved-${randomUUID()}`, runId: `LIVE-TEST-${randomUUID()}`, entity: 'client:COMPANY', sourceSystem: 'BITRIX24', sourceNativeId: `b24-${randomUUID()}`, targetSystem: 'MOYSKLAD', targetNativeId: null, bitrix24PortalOrigin: 'https://synthetic.invalid', bitrix24UserId: '3664', moyskladAccountId: 'b0b309ee-13e3-11e9-9109-f8fc0001f188', sourceName: `тест legacy reservation ${randomUUID()}`, sourceCreatedAt: new Date('2026-10-20T10:00:00.000Z'), admittedAt: new Date('2026-10-20T10:02:00.000Z') },
  ];
  try {
    await admin.$connect();
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await legacy.$connect();
    await legacy.$executeRawUnsafe('CREATE TABLE "InboundEvent" ("id" TEXT PRIMARY KEY)');
    await legacy.$executeRawUnsafe(`CREATE TABLE "ControlledTestAdmission" (
      "eventId" TEXT PRIMARY KEY REFERENCES "InboundEvent"("id") ON DELETE CASCADE,
      "runId" TEXT NOT NULL, "entity" TEXT NOT NULL, "sourceSystem" TEXT NOT NULL,
      "sourceNativeId" TEXT NOT NULL, "targetSystem" TEXT NOT NULL, "targetNativeId" TEXT,
      "bitrix24PortalOrigin" TEXT, "bitrix24UserId" TEXT, "moyskladAccountId" TEXT,
      "sourceName" TEXT NOT NULL, "sourceCreatedAt" TIMESTAMP(3) NOT NULL,
      "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await legacy.$executeRawUnsafe('CREATE UNIQUE INDEX "ctl_test_admission_source_uq" ON "ControlledTestAdmission"("runId", "entity", "sourceSystem", "sourceNativeId")');
    await legacy.$executeRawUnsafe('CREATE UNIQUE INDEX "ctl_test_admission_target_uq" ON "ControlledTestAdmission"("runId", "entity", "targetSystem", "targetNativeId")');
    for (const row of legacyRows) {
      await legacy.$executeRaw`INSERT INTO "InboundEvent" ("id") VALUES (${row.eventId})`;
      await legacy.$executeRaw`INSERT INTO "ControlledTestAdmission" (
        "eventId", "runId", "entity", "sourceSystem", "sourceNativeId", "targetSystem", "targetNativeId",
        "bitrix24PortalOrigin", "bitrix24UserId", "moyskladAccountId", "sourceName", "sourceCreatedAt", "admittedAt")
        VALUES (${row.eventId}, ${row.runId}, ${row.entity}, ${row.sourceSystem}, ${row.sourceNativeId}, ${row.targetSystem}, ${row.targetNativeId},
        ${row.bitrix24PortalOrigin}, ${row.bitrix24UserId}, ${row.moyskladAccountId}, ${row.sourceName}, ${row.sourceCreatedAt}, ${row.admittedAt})`;
    }
    const preservedColumns = '"eventId", "runId", "entity", "sourceSystem", "sourceNativeId", "targetSystem", "targetNativeId", "bitrix24PortalOrigin", "bitrix24UserId", "moyskladAccountId", "sourceName", "sourceCreatedAt", "admittedAt"';
    const before = await legacy.$queryRawUnsafe<any[]>(`SELECT ${preservedColumns} FROM "ControlledTestAdmission" ORDER BY "eventId"`);
    assert.equal(before.length, legacyRows.length);
    await legacy.$transaction(async (tx) => {
      for (const statement of migration.split(';').map((value) => value.trim()).filter(Boolean)) {
        await tx.$executeRawUnsafe(statement);
      }
    });
    const after = await legacy.$queryRawUnsafe<any[]>(`SELECT ${preservedColumns} FROM "ControlledTestAdmission" ORDER BY "eventId"`);
    assert.equal(after.length, before.length, 'migration must retain every legacy event admission');
    const afterBindings = await legacy.$queryRawUnsafe<any[]>('SELECT "eventId", "bindingId" FROM "ControlledTestAdmission" ORDER BY "eventId"');
    for (const [index, row] of after.entries()) {
      for (const field of Object.keys(legacyRows[0]!)) assert.deepEqual(row[field], before[index]![field], `legacy field ${field} remains unchanged`);
      const bindingId = afterBindings[index]!.bindingId as string;
      assert.equal(typeof bindingId, 'string');
      const bindings = await legacy.$queryRaw<any[]>`SELECT "runId", "entity", "bitrix24NativeId", "moyskladNativeId" FROM "ControlledTestSourceBinding" WHERE "id" = ${bindingId}`;
      assert.equal(bindings.length, 1);
      assert.equal(bindings[0]!.runId, row.runId);
      assert.equal(bindings[0]!.entity, row.entity);
      assert.equal(bindings[0]!.bitrix24NativeId, row.sourceNativeId);
      assert.equal(bindings[0]!.moyskladNativeId, row.targetNativeId);
    }
  } finally {
    await legacy.$disconnect().catch(() => undefined);
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.$disconnect();
  }
});

test('a manifested company may be admitted for repeated update events without weakening pair exclusivity', { skip: !isolated }, async () => {
  const databaseUrl = process.env.CONTROLLED_LIVE_TEST_POSTGRES_URL;
  if (!databaseUrl) throw new Error('CONTROLLED_LIVE_TEST_POSTGRES_URL_REQUIRED');
  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  const schemaName = url.searchParams.get('schema');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.match(databaseName, /(?:^|[_-])test(?:$|[_-])/i);
  assert.match(schemaName ?? '', /(?:^|[_-])test(?:$|[_-])/i);

  const now = new Date();
  const runId = `LIVE-TEST-${now.toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
  const sourceName = `тест ${runId} repeated admission company`;
  const sourceId = `b24-${randomUUID()}`;
  const targetId = `ms-${randomUUID()}`;
  const secondSourceId = `b24-${randomUUID()}`;
  const providerNamespace = {
    bitrix24PortalOrigin: 'https://issue79-admission-repeat-test.invalid',
    bitrix24UserId: '3664',
    moyskladAccountId: 'b0b309ee-13e3-11e9-9109-f8fc0001f188',
  };
  const records = [
    { entity: 'client:COMPANY', direction: 'BOTH', name: sourceName, syntheticOnly: true,
      sourceSystem: 'BITRIX24', sourceNativeId: sourceId, targetSystem: 'MOYSKLAD', targetNativeId: targetId,
      allowedActions: ['UPDATE'], createdAfterUtc: new Date(now.getTime() - 1_000).toISOString() },
  ];
  const directory = await mkdtemp(join(tmpdir(), 'issue79-admission-repeat-'));
  const manifestPath = join(directory, 'manifest.json');
  const previous = Object.fromEntries(['CONTROLLED_LIVE_TEST_MODE', 'CONTROLLED_LIVE_TEST_INSTANCE', 'CONTROLLED_LIVE_TEST_MANIFEST', 'DATABASE_URL', 'SYNC_MODE']
    .map((key) => [key, process.env[key]]));
  const eventIds = Array.from({ length: 5 }, () => `repeat-${randomUUID()}`);
  let database: DatabaseService | undefined;
  try {
    process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
    process.env.CONTROLLED_LIVE_TEST_INSTANCE = 'isolated';
    process.env.CONTROLLED_LIVE_TEST_MANIFEST = manifestPath;
    process.env.DATABASE_URL = databaseUrl;
    process.env.SYNC_MODE = 'apply';
    await writeFile(manifestPath, JSON.stringify({ runId, testDatabaseName: databaseName, testSchemaName: schemaName, providerNamespace, records }), 'utf8');
    setVerifiedControlledLiveProviderNamespace(providerNamespace);
    database = new DatabaseService();
    await database.$connect();
    setControlledLiveTestWriteCheck(createControlledLiveTestPolicy({ runId, testDatabaseName: databaseName, testSchemaName: schemaName, providerNamespace, records }, databaseUrl));
    const events = await Promise.all(eventIds.map((id, index) => database!.inboundEvent.create({ data: {
      id, source: index === 3 ? 'MOYSKLAD' : 'BITRIX24', deliveryKey: `delivery-${id}`,
      eventType: index === 3 ? 'UPDATE' : 'ONCRMCOMPANYUPDATE',
      externalEntityType: index === 3 ? 'counterparty' : 'company',
      externalEntityId: index === 3 ? targetId : index === 4 ? secondSourceId : sourceId, payload: {},
    } })));
    const admission = new ControlledLiveTestAdmissionService(database);
    const source: VerifiedControlledSource = {
      entity: 'client:COMPANY', sourceSystem: 'BITRIX24', sourceNativeId: sourceId,
      currentNativeId: sourceId, currentName: sourceName, sourceCreatedAt: now,
    };

    await admission.admit(events[0]!.id, source);
    await admission.admit(events[0]!.id, source);
    assert.equal(await database.controlledTestAdmission.count({ where: { runId, entity: 'client:COMPANY', sourceNativeId: sourceId } }), 1,
      're-admitting the same event is idempotent');

    await Promise.all([
      admission.admit(events[1]!.id, source),
      admission.admit(events[2]!.id, source),
    ]);
    assert.equal(await database.controlledTestAdmission.count({ where: { runId, entity: 'client:COMPANY', sourceNativeId: sourceId } }), 3,
      'concurrent events for the same exact source-target pair receive independent admissions');
    await admission.admit(events[0]!.id, source);
    assert.equal(await database.controlledTestAdmission.count({ where: { runId, entity: 'client:COMPANY', sourceNativeId: sourceId } }), 3,
      're-admitting the same event remains idempotent');

    const reverseSource: VerifiedControlledSource = {
      entity: 'client:COMPANY', sourceSystem: 'MOYSKLAD', sourceNativeId: targetId,
      currentNativeId: targetId, currentName: sourceName, sourceCreatedAt: new Date(now.getTime() - 500),
    };
    await admission.admit(events[3]!.id, reverseSource);
    const reverseAdmission = await database.controlledTestAdmission.findUniqueOrThrow({ where: { eventId: events[3]!.id } });
    assert.equal(reverseAdmission.sourceSystem, 'MOYSKLAD');
    assert.equal(reverseAdmission.targetSystem, 'BITRIX24');
    assert.equal(reverseAdmission.targetNativeId, sourceId);
    assert.equal(reverseAdmission.bindingId, (await database.controlledTestAdmission.findUniqueOrThrow({ where: { eventId: events[0]!.id } })).bindingId,
      'opposite provider timestamps may differ while both independently satisfy the manifest window');

    const conflictingSource: VerifiedControlledSource = {
      ...source, sourceNativeId: secondSourceId, currentNativeId: secondSourceId, currentName: `тест ${runId} unmanifested company`,
    };
    await assert.rejects(admission.admit(events[3]!.id, conflictingSource), /CONTROLLED_LIVE_TEST_SOURCE_NOT_ADMITTED/,
      'a source not explicitly pinned by the manifest cannot claim the exclusive target');
    assert.equal(await database.controlledTestAdmission.count({ where: { runId, entity: 'client:COMPANY', targetNativeId: targetId } }), 3);

    await database.controlledTestSourceBinding.update({
      where: { id: (await database.controlledTestAdmission.findUniqueOrThrow({ where: { eventId: events[0]!.id } })).bindingId },
      data: { moyskladNativeId: `ms-conflict-${randomUUID()}` },
    });
    await assert.rejects(admission.admit(events[1]!.id, source), /CONTROLLED_LIVE_TEST_ADMISSION_CONFLICT/,
      'an existing source binding cannot be silently redirected to a different target');

    const duplicateTargetRecord = { ...records[0]!, sourceNativeId: secondSourceId, name: `тест ${runId} duplicate-target` };
    assert.throws(() => createControlledLiveTestPolicy({
      runId, testDatabaseName: databaseName, testSchemaName: schemaName, providerNamespace,
      records: [...records, duplicateTargetRecord],
    }, databaseUrl), /CONTROLLED_LIVE_TEST_MANIFEST_DUPLICATE_RECORD/,
    'the manifest parser rejects distinct sources claiming one exclusive target before admission');
  } finally {
    if (database) {
      await database.inboundEvent.deleteMany({ where: { id: { in: eventIds } } });
      await database.controlledTestSourceBinding.deleteMany({ where: { runId } });
      await database.$disconnect();
    }
    setControlledLiveTestWriteCheck(null);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
