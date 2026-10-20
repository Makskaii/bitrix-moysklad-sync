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
import { assertApplyExternalWrite, installControlledLiveFetchGuard, setControlledLiveTestWriteCheck } from '../src/external-write-guard';
import { setVerifiedControlledLiveProviderNamespace } from '../src/controlled-live-test-namespace';
import { ClientLifecycleService } from '../src/clients/client-lifecycle.service';
import { HttpClientSyncGateway } from '../src/clients/client-sync.gateway';
import { SyncModeService } from '../src/sync-mode.service';

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
  const entries = [
    { entity: 'client:COMPANY', sourceId: 'b24-controlled-source', targetId: 'ms-controlled-target', name: `тест ${runId} company`, sourceType: 'COMPANY' },
    { entity: 'deal-order', sourceId: 'b24-controlled-deal', targetId: 'ms-controlled-deal', name: `тест ${runId} deal`, sourceType: 'deal' },
    { entity: 'invoice', sourceId: 'b24-controlled-invoice', targetId: 'ms-controlled-invoice', name: `тест ${runId} invoice`, sourceType: 'invoice' },
    { entity: 'catalog-product', sourceId: 'b24-controlled-product', targetId: 'ms-controlled-product', name: `тест ${runId} product`, sourceType: 'catalogproduct' },
  ] as const;
  const name = entries[0]!.name;
  const providerNamespace = { bitrix24PortalOrigin: 'https://issue60-b24-test.invalid', bitrix24UserId: '42', moyskladAccountId: 'b0b309ee-13e3-11e9-9109-f8fc0001f188' };
  const directory = await mkdtemp(join(tmpdir(), 'issue60-admission-pg-'));
  const manifestPath = join(directory, 'manifest.json');
  const previous = {
    mode: process.env.CONTROLLED_LIVE_TEST_MODE, instance: process.env.CONTROLLED_LIVE_TEST_INSTANCE,
    manifest: process.env.CONTROLLED_LIVE_TEST_MANIFEST, database: process.env.DATABASE_URL, sync: process.env.SYNC_MODE,
    b24Base: process.env.BITRIX24_REST_BASE_URL, msBase: process.env.MOYSKLAD_API_BASE_URL, msToken: process.env.MOYSKLAD_API_TOKEN,
  };
  const originalFetch = globalThis.fetch;
  const oldDbUrl = process.env.DATABASE_URL;
  let lifecyclePairId: string | null = null;
  let unadmittedLifecyclePairId: string | null = null;
  let controlledProviderRequests = 0;
  process.env.SYNC_MODE = 'apply';
  process.env.DATABASE_URL = databaseUrl;
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
  process.env.CONTROLLED_LIVE_TEST_INSTANCE = 'isolated';
  process.env.CONTROLLED_LIVE_TEST_MANIFEST = manifestPath;
  process.env.BITRIX24_REST_BASE_URL = 'https://issue60-b24-test.invalid/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://issue60-ms-test.invalid/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'fake-only-token';
  await writeFile(manifestPath, JSON.stringify({ runId, testDatabaseName, testSchemaName, providerNamespace, records: entries.map((entry, index) => ({
    entity: entry.entity, direction: index === 0 ? 'BOTH' : 'BITRIX24_TO_MOYSKLAD', name: entry.name, syntheticOnly: true,
    sourceSystem: 'BITRIX24', sourceNativeId: index === 0 ? null : entry.sourceId, targetSystem: 'MOYSKLAD', targetNativeId: index === 0 ? null : entry.targetId,
    createdAfterUtc: new Date(now.getTime() - 5_000).toISOString(),
  })) }), 'utf8');
  const database = new DatabaseService();
  const eventIds = [...entries.map(() => `issue60-${randomUUID()}`), `issue60-${randomUUID()}`];
  try {
    setVerifiedControlledLiveProviderNamespace(providerNamespace);
    const sourceEvent = await database.inboundEvent.create({ data: {
      id: eventIds[0], source: 'BITRIX24', deliveryKey: randomUUID(), eventType: 'ONCOMPANYADD',
      externalEntityId: entries[0]!.sourceId, externalEntityType: entries[0]!.sourceType, payload: {},
    } });
    const sourceAdmission = new ControlledLiveTestAdmissionService(database);
    await sourceAdmission.runForEvent(sourceEvent.id, async () => {
      await sourceAdmission.admit(sourceEvent.id, { entity: 'client:COMPANY', sourceSystem: 'BITRIX24', sourceNativeId: entries[0]!.sourceId, currentNativeId: entries[0]!.sourceId, currentName: name, sourceCreatedAt: now });
      enterControlledLiveEventScope(await sourceAdmission.scopeForEvent(sourceEvent.id));
      await sourceAdmission.bindCreatedTarget(sourceEvent.id, 'ms-controlled-target', 'ms-controlled-target', name, now);
    });
    const persisted = await database.controlledTestAdmission.findUnique({ where: { eventId: sourceEvent.id } });
    assert.equal(persisted?.targetNativeId, 'ms-controlled-target');
    assert.deepEqual({
      bitrix24PortalOrigin: persisted?.bitrix24PortalOrigin,
      bitrix24UserId: persisted?.bitrix24UserId,
      moyskladAccountId: persisted?.moyskladAccountId,
    }, providerNamespace, 'durable admission pins the verified provider namespace');
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      controlledProviderRequests += 1;
      if (url.pathname.endsWith(`/entity/counterparty/ms-controlled-target`)) return Response.json({ id: 'ms-controlled-target' });
      if (url.pathname.endsWith('/crm.company.get.json')) {
        const form = new URLSearchParams(await request.clone().text());
        return Response.json({ result: { ID: form.get('id') } });
      }
      if (url.pathname.endsWith('/crm.company.update.json')) {
        const form = new URLSearchParams(await request.clone().text());
        assert.equal(form.get('id'), 'b24-controlled-source');
        assert.equal(form.get('fields[UF_SYNC_DELETION_STATE]'), '');
        return Response.json({ result: true });
      }
      throw new Error(`Unexpected controlled lifecycle fake request: ${url.pathname}`);
    }) as typeof fetch;
    installControlledLiveFetchGuard(providerNamespace);
    await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', clientDeletionMarkerFields: { COMPANY: 'UF_SYNC_DELETION_STATE' } }, update: { clientDeletionMarkerFields: { COMPANY: 'UF_SYNC_DELETION_STATE' } } });
    const pairId = `issue60-restore-${randomUUID()}`;
    lifecyclePairId = pairId;
    await database.entityPair.create({ data: { id: pairId, entityType: 'COMPANY', bitrix24Id: 'b24-controlled-source', moyskladId: 'ms-controlled-target',
      moyskladType: 'counterparty', active: false, lifecycleStatus: 'TOMBSTONED', tombstoneSource: 'MOYSKLAD', tombstonedAt: now,
      deletionMarkerStatus: 'MARKED', deletionTimelineStatus: 'POSTED' } });
    const lifecycle = new ClientLifecycleService(database, new HttpClientSyncGateway(), new SyncModeService(database), sourceAdmission);
    assert.deepEqual(await lifecycle.restore(pairId, true, 'BITRIX24_USER:42'), { status: 'RESTORED', pairId });
    const restoredPair = await database.entityPair.findUniqueOrThrow({ where: { id: pairId } });
    assert.equal(restoredPair.lifecycleStatus, 'ACTIVE');
    assert.equal(restoredPair.active, true);
    await database.entityPair.delete({ where: { id: pairId } });
    const unadmittedPairId = `issue60-restore-unadmitted-${randomUUID()}`;
    unadmittedLifecyclePairId = unadmittedPairId;
    await database.entityPair.create({ data: { id: unadmittedPairId, entityType: 'COMPANY', bitrix24Id: 'shared-b24-record', moyskladId: 'shared-ms-record',
      moyskladType: 'counterparty', active: false, lifecycleStatus: 'TOMBSTONED', tombstoneSource: 'MOYSKLAD', tombstonedAt: now,
      deletionMarkerStatus: 'MARKED', deletionTimelineStatus: 'POSTED' } });
    const requestsBeforeUnadmittedRestore = controlledProviderRequests;
    await assert.rejects(lifecycle.restore(unadmittedPairId, true, 'BITRIX24_USER:42'), /CONTROLLED_LIVE_TEST_LIFECYCLE_PAIR_NOT_ADMITTED/);
    assert.equal(controlledProviderRequests, requestsBeforeUnadmittedRestore, 'unmanifested restore makes no provider identity reads or writes');
    await database.entityPair.delete({ where: { id: unadmittedPairId } });
    for (const [index, entry] of entries.slice(1).entries()) {
      const eventId = eventIds[index + 1]!;
      const event = await database.inboundEvent.create({ data: { id: eventId, source: 'BITRIX24', deliveryKey: randomUUID(),
        eventType: 'CONTROLLED_TEST', externalEntityId: entry.sourceId, externalEntityType: entry.sourceType, payload: {} } });
      await sourceAdmission.withCurrentSourceRead(event.id, 'BITRIX24', entry.sourceId, entry.entity, async () => {
        await sourceAdmission.admit(event.id, { entity: entry.entity, sourceSystem: 'BITRIX24', sourceNativeId: entry.sourceId,
          currentNativeId: entry.sourceId, currentName: entry.name, sourceCreatedAt: now });
      });
      await sourceAdmission.runForEvent(event.id, async () => {
        assertApplyExternalWrite('MOYSKLAD', 'CONTROLLED_TEST_UPDATE', entry.targetId, entry.entity);
        assert.throws(() => assertApplyExternalWrite('MOYSKLAD', 'CONTROLLED_TEST_UPDATE', 'shared-real-id', entry.entity), /TARGET_NOT_IN_MANIFEST/);
      });
      assert.equal((await database.controlledTestAdmission.findUnique({ where: { eventId } }))?.entity, entry.entity);
    }
    const echoEvent = await database.inboundEvent.create({ data: {
      id: eventIds[eventIds.length - 1]!, source: 'MOYSKLAD', deliveryKey: randomUUID(), eventType: 'counterparty',
      externalEntityId: 'ms-controlled-target', externalEntityType: 'counterparty', payload: {},
    } });
    const restarted = new ControlledLiveTestAdmissionService(database);
    await restarted.admit(echoEvent.id, { entity: 'client:COMPANY', sourceSystem: 'MOYSKLAD', sourceNativeId: 'ms-controlled-target', currentNativeId: 'ms-controlled-target', currentName: name, sourceCreatedAt: now });
    const echoAdmission = await database.controlledTestAdmission.findUnique({ where: { eventId: echoEvent.id } });
    assert.equal(echoAdmission?.sourceNativeId, 'ms-controlled-target');
    assert.equal(echoAdmission?.targetNativeId, 'b24-controlled-source');
    await database.controlledTestAdmission.update({ where: { eventId: sourceEvent.id }, data: { bitrix24PortalOrigin: 'https://other-portal.invalid' } });
    await assert.rejects(restarted.scopeForEvent(sourceEvent.id), /CONTROLLED_LIVE_TEST_ADMISSION_PROVIDER_NAMESPACE_MISMATCH/,
      'a durable admission cannot be replayed under a different provider namespace');
  } finally {
    await database.inboundEvent.deleteMany({ where: { id: { in: eventIds } } });
    if (lifecyclePairId) await database.entityPair.deleteMany({ where: { id: lifecyclePairId } });
    if (unadmittedLifecyclePairId) await database.entityPair.deleteMany({ where: { id: unadmittedLifecyclePairId } });
    await database.syncSetting.updateMany({ where: { id: 'global' }, data: { clientDeletionMarkerFields: {} } });
    await database.$disconnect();
    globalThis.fetch = originalFetch;
    setControlledLiveTestWriteCheck(null);
    for (const [key, value] of [['CONTROLLED_LIVE_TEST_MODE', previous.mode], ['CONTROLLED_LIVE_TEST_INSTANCE', previous.instance], ['CONTROLLED_LIVE_TEST_MANIFEST', previous.manifest], ['DATABASE_URL', oldDbUrl], ['SYNC_MODE', previous.sync], ['BITRIX24_REST_BASE_URL', previous.b24Base], ['MOYSKLAD_API_BASE_URL', previous.msBase], ['MOYSKLAD_API_TOKEN', previous.msToken]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
