import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { ControlledLiveTestAdmissionService } from '../src/controlled-live-test-admission.service';
import { enterControlledLiveEventScope } from '../src/controlled-live-test-policy';
import { setControlledLiveTestWriteCheck } from '../src/external-write-guard';

const isolated = process.env.CONTROLLED_LIVE_TEST_POSTGRES_ISOLATED === '1';
test('controlled live source admission and target binding survive service restart in isolated PostgreSQL', { skip: !isolated }, async () => {
  const databaseUrl = process.env.CONTROLLED_LIVE_TEST_POSTGRES_URL;
  if (!databaseUrl) throw new Error('CONTROLLED_LIVE_TEST_POSTGRES_URL_REQUIRED');
  const target = new URL(databaseUrl);
  const testDatabaseName = decodeURIComponent(target.pathname.slice(1));
  const testSchemaName = target.searchParams.get('schema');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !/(?:^|[_-])test(?:$|[_-])/i.test(testDatabaseName) ||
      !testSchemaName || !/(?:^|[_-])test(?:$|[_-])/i.test(testSchemaName)) {
    throw new Error('CONTROLLED_LIVE_TEST_POSTGRES_TARGET_NOT_ISOLATED');
  }
  const now = new Date();
  const runId = `LIVE-TEST-${now.toISOString().replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z')}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const name = `тест ${runId} company`;
  const directory = await mkdtemp(join(tmpdir(), 'issue60-admission-pg-'));
  const manifestPath = join(directory, 'manifest.json');
  const previous = {
    mode: process.env.CONTROLLED_LIVE_TEST_MODE, instance: process.env.CONTROLLED_LIVE_TEST_INSTANCE,
    manifest: process.env.CONTROLLED_LIVE_TEST_MANIFEST, database: process.env.DATABASE_URL, sync: process.env.SYNC_MODE,
  };
  const oldDbUrl = process.env.DATABASE_URL;
  process.env.SYNC_MODE = 'apply';
  process.env.DATABASE_URL = databaseUrl;
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
  process.env.CONTROLLED_LIVE_TEST_INSTANCE = 'isolated';
  process.env.CONTROLLED_LIVE_TEST_MANIFEST = manifestPath;
  await writeFile(manifestPath, JSON.stringify({ runId, testDatabaseName, testSchemaName, records: [{
    entity: 'client:COMPANY', direction: 'BOTH', name, syntheticOnly: true,
    sourceSystem: 'BITRIX24', sourceNativeId: null, targetSystem: 'MOYSKLAD', targetNativeId: null,
    createdAfterUtc: new Date(now.getTime() - 5_000).toISOString(),
  }] }), 'utf8');
  const database = new DatabaseService();
  const eventIds = [`issue60-${randomUUID()}`, `issue60-${randomUUID()}`];
  try {
    const sourceEvent = await database.inboundEvent.create({ data: {
      id: eventIds[0], source: 'BITRIX24', deliveryKey: randomUUID(), eventType: 'ONCOMPANYADD',
      externalEntityId: 'b24-controlled-source', externalEntityType: 'COMPANY', payload: {},
    } });
    const sourceAdmission = new ControlledLiveTestAdmissionService(database);
    await sourceAdmission.runForEvent(sourceEvent.id, async () => {
      await sourceAdmission.admit(sourceEvent.id, { entity: 'client:COMPANY', sourceSystem: 'BITRIX24', sourceNativeId: 'b24-controlled-source', currentNativeId: 'b24-controlled-source', currentName: name, sourceCreatedAt: now });
      enterControlledLiveEventScope(await sourceAdmission.scopeForEvent(sourceEvent.id));
      await sourceAdmission.bindCreatedTarget(sourceEvent.id, 'ms-controlled-target', 'ms-controlled-target', name, now);
    });
    const persisted = await database.controlledTestAdmission.findUnique({ where: { eventId: sourceEvent.id } });
    assert.equal(persisted?.targetNativeId, 'ms-controlled-target');
    const echoEvent = await database.inboundEvent.create({ data: {
      id: eventIds[1], source: 'MOYSKLAD', deliveryKey: randomUUID(), eventType: 'counterparty',
      externalEntityId: 'ms-controlled-target', externalEntityType: 'counterparty', payload: {},
    } });
    const restarted = new ControlledLiveTestAdmissionService(database);
    await restarted.admit(echoEvent.id, { entity: 'client:COMPANY', sourceSystem: 'MOYSKLAD', sourceNativeId: 'ms-controlled-target', currentNativeId: 'ms-controlled-target', currentName: name, sourceCreatedAt: now });
    const echoAdmission = await database.controlledTestAdmission.findUnique({ where: { eventId: echoEvent.id } });
    assert.equal(echoAdmission?.sourceNativeId, 'ms-controlled-target');
    assert.equal(echoAdmission?.targetNativeId, 'b24-controlled-source');
  } finally {
    await database.inboundEvent.deleteMany({ where: { id: { in: eventIds } } });
    await database.$disconnect();
    setControlledLiveTestWriteCheck(null);
    for (const [key, value] of [['CONTROLLED_LIVE_TEST_MODE', previous.mode], ['CONTROLLED_LIVE_TEST_INSTANCE', previous.instance], ['CONTROLLED_LIVE_TEST_MANIFEST', previous.manifest], ['DATABASE_URL', oldDbUrl], ['SYNC_MODE', previous.sync]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
