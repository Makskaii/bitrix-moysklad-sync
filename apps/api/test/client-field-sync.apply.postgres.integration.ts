import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DatabaseService } from '../src/database.service';
import { ClientSyncProcessor } from '../src/clients/client-sync.processor';
import { HttpClientSyncGateway } from '../src/clients/client-sync.gateway';
import { ClientChildResourceSync } from '../src/clients/client-child-resource-sync';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { EntityPairService } from '../src/pairs/entity-pair.service';
import { AdminAccessGuard, LOCAL_ADMIN_PREVIEW_ACCESS } from '../src/admin/admin-access.guard';
import { FieldSettingsController } from '../src/admin/field-settings.controller';
import { EventIntakeService, EventsController } from '../src/events.controller';

const suffix = randomUUID();
const sourceId = '100001';
const targetId = randomUUID();
const pairId = `client-apply-pair-${suffix}`;
const contactSourceId = `client-contact-${suffix}`;
const contactTargetId = randomUUID();
const contactPairId = `client-contact-pair-${suffix}`;
const eventIds: string[] = [];
let database: DatabaseService;
let settings: FieldSettingsService;
let server: Server;
let address: string;
let adminApp: INestApplication;
let adminUrl: string;
let bitrix: Record<string, unknown>;
let moysklad: Record<string, unknown>;
let bitrixContact: Record<string, unknown>;
let moyskladContact: Record<string, unknown>;
let bitrixRequisite: Record<string, unknown>;
const writes: Array<{ method: string; path: string; body: string }> = [];
let applyTestSequence: Promise<unknown> = Promise.resolve();
let failNextCompanyReadback = false;
let failReadbackAfterNextCompanyWrite = false;

@Module({
  controllers: [FieldSettingsController, EventsController],
  providers: [
    AdminAccessGuard,
    { provide: LOCAL_ADMIN_PREVIEW_ACCESS, useValue: true },
    { provide: FieldSettingsService, useFactory: () => settings },
    { provide: EventIntakeService, useFactory: () => new EventIntakeService(database, {
      read: async () => ({ mode: 'on' }), isDirectionEnabled: async () => true,
    } as never, undefined, settings) },
  ],
})
class ClientRevisionHttpModule {}

function serializeApplyTest<T>(work: () => Promise<T>): Promise<T> {
  const result = applyTestSequence.then(work, work);
  applyTestSequence = result.then(() => undefined, () => undefined);
  return result;
}

async function saveThroughAdmin(config: unknown): Promise<Awaited<ReturnType<FieldSettingsService['save']>>> {
  const response = await fetch(`${adminUrl}/api/admin/field-settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-loopback-token' },
    body: JSON.stringify({ config }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload as Awaited<ReturnType<FieldSettingsService['save']>>;
}

async function acceptCompanyWebhook(key: string): Promise<string> {
  return acceptBitrixWebhook('ONCRMCOMPANYUPDATE', sourceId, key);
}

async function acceptBitrixWebhook(eventType: string, id: string, key: string): Promise<string> {
  const response = await fetch(`${adminUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: eventType, data: { FIELDS: { ID: id } }, auth: { application_token: 'synthetic-loopback-event-token' }, testKey: key }),
  });
  const payload = await response.json() as { eventId?: string };
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.ok(payload.eventId, 'webhook acknowledges a persisted event');
  eventIds.push(payload.eventId!);
  return payload.eventId!;
}

before(async () => {
  assert.equal(process.env.CLIENT_FIELD_SYNC_APPLY_TEST_ISOLATED, '1', 'set CLIENT_FIELD_SYNC_APPLY_TEST_ISOLATED=1 only for the disposable loopback test schema');
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  const dryDatabaseUrl = new URL(process.env.DRY_DATABASE_URL ?? '');
  assert.match(databaseUrl.hostname, /^(localhost|127\.0\.0\.1)$/i);
  assert.match(databaseUrl.searchParams.get('schema') ?? '', /client53_field_sync_apply_test/i);
  assert.notEqual(databaseUrl.searchParams.get('schema'), dryDatabaseUrl.searchParams.get('schema'));
  process.env.SYNC_MODE = 'apply';
  database = new DatabaseService();
  settings = new FieldSettingsService(database, {
    async fieldCatalogs() {
      return {
        bitrix24: [...['TITLE', 'NAME', 'UF_AGE', 'UF_COMPOSED'].map((code) => ({ code, type: 'string', cardinality: 'single' as const, shape: 'scalar' as const, writable: true })),
          { code: 'UF_CATEGORY', type: 'project', referenceKind: 'project', cardinality: 'single' as const, shape: 'scalar' as const, writable: true }],
        moysklad: [{ code: 'name', type: 'string', cardinality: 'single', shape: 'scalar', writable: true }, { code: 'age', type: 'integer', cardinality: 'single', shape: 'scalar', writable: true }, { code: 'description', type: 'string', cardinality: 'single', shape: 'scalar', writable: true },
          { code: 'category', type: 'project', referenceKind: 'project', cardinality: 'single', shape: 'scalar', writable: true }],
      };
    },
  } as never, {} as EntityPairService);
  process.env.ADMIN_PREVIEW = '1';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-loopback-event-token';
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  adminApp = await NestFactory.create(ClientRevisionHttpModule, { logger: false });
  await adminApp.listen(0, '127.0.0.1');
  const adminAddress = adminApp.getHttpServer().address() as AddressInfo;
  adminUrl = `http://127.0.0.1:${adminAddress.port}`;
  await settings.active();
  await database.entityPair.deleteMany({ where: { id: pairId } });
  await database.inboundEvent.deleteMany({ where: { deliveryKey: { startsWith: `client-apply-${suffix}-` } } });

  bitrix = { ID: sourceId, TITLE: 'Initial Company', UF_AGE: '10', UF_COMPOSED: 'old value', UF_CATEGORY: 'legacy' };
  moysklad = { id: targetId, companyType: 'legal', name: 'Initial Company', age: 42, description: 'United', category: 'target-existing', inn: '7700000000', kpp: 'authoritative-kpp', legalTitle: 'Authoritative legal name' };
  bitrixRequisite = { ID: '200', ENTITY_TYPE_ID: '4', ENTITY_ID: sourceId, RQ_INN: 'old-inn', RQ_KPP: 'old-kpp', RQ_COMPANY_FULL_NAME: 'Old company name' };
  bitrixContact = { ID: contactSourceId, NAME: 'Jane' };
  moyskladContact = { id: contactTargetId, company: { id: targetId }, name: 'Jane', age: 37 };
  server = createServer(async (request, response) => {
    assert.equal(request.socket.remoteAddress, '127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const path = request.url ?? '';
    const method = request.method ?? 'GET';
    writes.push({ method, path, body });
    response.setHeader('content-type', 'application/json');

    if (path.endsWith('/crm.company.get.json')) {
      if (failNextCompanyReadback) {
        failNextCompanyReadback = false;
        response.statusCode = 503;
        response.end(JSON.stringify({ error: 'synthetic readback failure' }));
        return;
      }
      response.end(JSON.stringify({ result: bitrix }));
      return;
    }
    if (path.endsWith('/crm.requisite.get.json')) {
      assert.equal(new URLSearchParams(body).get('id'), '200', 'the adapter reads only the explicitly bound requisite ID');
      response.end(JSON.stringify({ result: bitrixRequisite }));
      return;
    }
    if (path.endsWith('/crm.requisite.update.json')) {
      const form = new URLSearchParams(body);
      assert.equal(form.get('id'), '200', 'the adapter updates only the explicitly bound requisite ID');
      const updates: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) {
        const match = /^fields\[([^\]]+)\]$/.exec(key);
        if (match) updates[match[1]!] = value;
      }
      bitrixRequisite = { ...bitrixRequisite, ...updates };
      response.end(JSON.stringify({ result: true }));
      return;
    }
    if (path.endsWith('/crm.contact.get.json')) {
      response.end(JSON.stringify({ result: bitrixContact }));
      return;
    }
    if (path.endsWith('/crm.company.update.json')) {
      const form = new URLSearchParams(body);
      const updates: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) {
        const match = /^fields\[([^\]]+)\]$/.exec(key);
        if (match) updates[match[1]!] = value;
      }
      bitrix = { ...bitrix, ...updates };
      if (Object.keys(updates).length && failReadbackAfterNextCompanyWrite) {
        failReadbackAfterNextCompanyWrite = false;
        failNextCompanyReadback = true;
      }
      response.end(JSON.stringify({ result: true }));
      return;
    }
    if (path.endsWith('/crm.contact.update.json')) {
      const form = new URLSearchParams(body);
      const updates: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) {
        const match = /^fields\[([^\]]+)\]$/.exec(key);
        if (match) updates[match[1]!] = value;
      }
      bitrixContact = { ...bitrixContact, ...updates };
      response.end(JSON.stringify({ result: true }));
      return;
    }
    if (path.endsWith(`/entity/counterparty/${targetId}`) && method === 'GET') {
      response.end(JSON.stringify(moysklad));
      return;
    }
    if (path.endsWith(`/entity/counterparty/${targetId}`) && method === 'PUT') {
      const fields = JSON.parse(body) as Record<string, unknown>;
      moysklad = { ...moysklad, ...fields };
      response.end(JSON.stringify(moysklad));
      return;
    }
    if (path.endsWith(`/entity/counterparty/${targetId}/contactpersons/${contactTargetId}`) && method === 'GET') {
      response.end(JSON.stringify(moyskladContact));
      return;
    }
    if (path.endsWith(`/entity/counterparty/${targetId}/contactpersons/${contactTargetId}`) && method === 'PUT') {
      const fields = JSON.parse(body) as Record<string, unknown>;
      moyskladContact = { ...moyskladContact, ...fields };
      response.end(JSON.stringify(moyskladContact));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: `Unexpected fake request: ${method} ${path}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  address = `http://127.0.0.1:${port}`;
  process.env.BITRIX24_REST_BASE_URL = `${address}/rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${address}/api/remap/1.2/`;
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-loopback-token';

  const config = {
    ...((await settings.active()).config),
    rules: [{ id: 'company-title-name-apply', entity: 'companies', sourceField: 'TITLE', targetField: 'name', criticality: 'optional',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } },
    }],
    groups: [],
  };
  await saveThroughAdmin(config);
  await database.entityPair.create({ data: { id: pairId, entityType: 'COMPANY', bitrix24Id: sourceId, moyskladId: targetId, moyskladType: 'counterparty', active: true, source: 'MANUAL' } });
});

after(async () => {
  if (adminApp) await adminApp.close();
  if (database) {
    await database.entityPairSyncState.deleteMany({ where: { pairId } });
    await database.entityPairBaseline.deleteMany({ where: { pairId } });
    await database.entityPairSyncState.deleteMany({ where: { pairId: contactPairId } });
    await database.entityPairBaseline.deleteMany({ where: { pairId: contactPairId } });
    await database.entityPair.deleteMany({ where: { id: contactPairId } });
    await database.entityPair.deleteMany({ where: { id: pairId } });
    await database.inboundEvent.deleteMany({ where: { id: { in: eventIds } } });
    await database.$disconnect();
  }
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('APPLY client field writes use only fake loopback providers and persist confirmed readbacks', async () => serializeApplyTest(async () => {
  const gateway = new HttpClientSyncGateway();
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, gateway, { readCompanyInn: async () => null } as never);
  const accept = async (key: string, source: 'BITRIX24' | 'MOYSKLAD') => {
    const event = await settings.saveAcceptedEvent({
      source, deliveryKey: `client-apply-${suffix}-${key}`, eventType: source === 'BITRIX24' ? 'ONCRMCOMPANYUPDATE' : 'UPDATE',
      externalEntityId: source === 'BITRIX24' ? sourceId : targetId,
      externalEntityType: source === 'BITRIX24' ? 'company' : 'counterparty', payload: { event: key }, directionDisabled: false,
    });
    eventIds.push(event.id);
    return event.id;
  };

  assert.equal(await processor.process(await accept('baseline', 'BITRIX24')), 'BASELINE');
  bitrix = { ...bitrix, TITLE: 'Updated in B24' };
  assert.equal(await processor.process(await accept('forward', 'BITRIX24')), 'SYNCED');
  assert.equal(moysklad.name, 'Updated in B24', 'the loopback MySklad PUT was read back before state advanced');
  assert.equal((await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId } }).then((state) => (state.moyskladValues as Record<string, unknown>).name)), 'Updated in B24');

  moysklad = { ...moysklad, name: 'Updated in MySklad' };
  assert.equal(await processor.process(await accept('reverse', 'MOYSKLAD')), 'SYNCED');
  assert.equal(bitrix.TITLE, 'Updated in MySklad', 'the loopback Bitrix update was read back before state advanced');
  assert.ok(writes.some((request) => request.method === 'PUT' && request.path.includes('/entity/counterparty/')));
  assert.ok(writes.some((request) => request.method === 'POST' && request.path.endsWith('/crm.company.update.json')));
  assert.ok(writes.every((request) => new URL(request.path, address).origin === address), 'all requests remained inside the loopback fake provider');

  const active = await settings.active();
    await saveThroughAdmin({ ...active.config, rules: [{ id: 'company-title-name-critical', entity: 'companies', sourceField: 'TITLE', targetField: 'name', criticality: 'critical',
    bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } },
  }], groups: [] });
  assert.equal(await processor.process(await accept('critical-settings-rebase', 'BITRIX24')), 'UNCHANGED');
  assert.equal(bitrix.TITLE, 'Updated in MySklad', 'the settings transition restores the changed value from MySklad before ordinary field diffs resume');
  bitrix = { ...bitrix, TITLE: '' };
  const clearEventId = await accept('critical-clear', 'BITRIX24');
  assert.equal(await processor.process(clearEventId), 'REVIEW', 'a critical source-side clear is held for review instead of erasing the target');
  const review = await database.manualReviewCase.findUnique({ where: { eventId: clearEventId } });
  assert.equal(review?.reason, 'CRITICAL_FIELD_CLEAR_REVIEW');
  assert.equal(review?.fieldTitle, 'name');
  assert.equal(review?.previousValue, 'Updated in MySklad');
  assert.equal(review?.proposedValue, 'Updated in MySklad', 'the prior target value is the explicit suggested restore value');
  assert.equal(moysklad.name, 'Updated in MySklad', 'the external target was not cleared');
  assert.ok(JSON.stringify(review?.diagnostic).includes('sourceProposedValue'), 'the incoming empty value is distinguished from the restore suggestion');
}));

test('new client mappings reconcile from MySklad and old pinned work cannot roll back the revision', async () => serializeApplyTest(async () => {
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never,
    new HttpClientSyncGateway(), { readCompanyInn: async () => null } as never);
  const accept = acceptCompanyWebhook;

  bitrix = { ...bitrix, TITLE: 'Updated in MySklad' };
  const oldPinned = await accept('old-pinned-before-revision');
  const oldPinnedDuringRetry = await accept('old-pinned-during-partial-revision');
  const current = await settings.active();
  const next = await saveThroughAdmin({ ...current.config, rules: [
    ...current.config.rules,
    { id: 'company-age-conversion', entity: 'companies', sourceField: 'UF_AGE', targetField: 'age', criticality: 'optional',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'string-to-number', numberType: 'integer' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'number-to-string' } } },
    { id: 'company-category-reference', entity: 'companies', sourceField: 'UF_CATEGORY', targetField: 'category', criticality: 'optional',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'reference-map', resource: 'project', pairs: [{ source: '10', target: 'target-existing' }] } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'reference-map', resource: 'project', pairs: [{ source: 'target-existing', target: '10' }] } } },
  ], groups: [{ id: 'company-description-group', entity: 'companies', direction: 'MOYSKLAD_TO_BITRIX24',
    sourceFields: ['description'], targetField: 'UF_COMPOSED', criticality: 'optional',
    transform: { kind: 'join-non-empty', separator: ' ' } }] });
  const revisionEvent = await accept('new-settings-revision');

  failReadbackAfterNextCompanyWrite = true;
  assert.equal(await processor.process(revisionEvent), 'RETRY', 'a write without verified readback remains retryable');
  const preparedBaseline = await database.entityPairBaseline.findUniqueOrThrow({ where: { pairId } });
  assert.notEqual(preparedBaseline.settingsVersion, next.version, 'the baseline does not advance after partial external success');
  const preparedRevision = await database.entityPairSettingsRevision.findUniqueOrThrow({ where: { pairId_toSettingsVersion: { pairId, toSettingsVersion: next.version } } });
  assert.equal(preparedRevision.status, 'PREPARED');
  assert.equal(await processor.process(oldPinnedDuringRetry), 'UNCHANGED', 'a newer prepared revision fences older work after partial external success');
  assert.equal((await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId } })).settingsVersion, preparedBaseline.settingsVersion);
  const retryEvent = await accept('new-settings-revision-retry');
  assert.equal(await processor.process(retryEvent), 'UNCHANGED');
  assert.equal(bitrix.UF_AGE, '42', 'new numeric mapping was transformed from the authoritative MySklad value');
  assert.equal(bitrix.UF_CATEGORY, '10', 'new reference mapping used the explicit reverse resource pair');
  assert.equal(bitrix.UF_COMPOSED, 'United', 'new group mapping was initialized from MySklad');
  const baseline = await database.entityPairBaseline.findUniqueOrThrow({ where: { pairId } });
  const state = await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId } });
  assert.equal(baseline.settingsVersion, next.version);
  assert.equal(state.settingsVersion, next.version);
  const revision = await database.entityPairSettingsRevision.findUniqueOrThrow({ where: { pairId_toSettingsVersion: { pairId, toSettingsVersion: next.version } } });
  assert.equal(revision.status, 'COMPLETE');

  bitrix = { ...bitrix, UF_AGE: '99' };
  assert.equal(await processor.process(oldPinned), 'UNCHANGED');
  assert.equal(moysklad.age, 42, 'processing a V1-pinned event after V2 does not restore V1 or overwrite MySklad');
  assert.equal((await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId } })).settingsVersion, next.version);

  const removedMappingEvent = await accept('removed-mapping-settings');
  const beforeRemoval = await settings.active();
  const withoutCompanyOptional = await saveThroughAdmin({ ...beforeRemoval.config,
    rules: beforeRemoval.config.rules.filter((rule) => rule.entity !== 'companies' || rule.sourceField === 'TITLE'),
    groups: beforeRemoval.config.groups.filter((group) => group.entity !== 'companies'),
  });
  writes.length = 0;
  const removalEvent = await accept('removed-mappings-revision');
  assert.equal(await processor.process(removalEvent), 'UNCHANGED');
  assert.equal((await database.entityPairSettingsRevision.findUniqueOrThrow({ where: { pairId_toSettingsVersion: { pairId, toSettingsVersion: withoutCompanyOptional.version } } })).status, 'COMPLETE');
  assert.equal(moysklad.age, 42, 'removed mappings cease exchange without clearing their external values');
  assert.equal(moysklad.category, 'target-existing');
  assert.equal(writes.some((request) => request.method === 'PUT' && request.path.includes('/entity/counterparty/')), false);
  assert.equal(await processor.process(removedMappingEvent), 'UNCHANGED', 'pending work pinned to the prior version is skipped after the removal revision');
  assert.equal(moysklad.age, 42);

  await database.entityPair.create({ data: { id: contactPairId, entityType: 'CONTACT', bitrix24Id: contactSourceId, moyskladId: contactTargetId, moyskladType: 'contactperson', moyskladParentId: targetId, active: true, source: 'MANUAL' } });
  const withContactName = await saveThroughAdmin({ ...(await settings.active()).config, rules: [
    ...(await settings.active()).config.rules,
    { id: 'contact-name', entity: 'contacts-companies', sourceField: 'NAME', targetField: 'name', criticality: 'optional',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } },
  ] });
  const acceptContact = async (key: string) => acceptBitrixWebhook('ONCRMCONTACTUPDATE', contactSourceId, key);
  const contactBaseline = await acceptContact('contact-settings-baseline');
  assert.equal(await processor.process(contactBaseline), 'BASELINE');
  const oldContactEvent = await acceptContact('contact-old-pinned');
  const withContactAge = await saveThroughAdmin({ ...withContactName.config, rules: [
    ...withContactName.config.rules,
    { id: 'contact-age', entity: 'contacts-companies', sourceField: 'UF_AGE', targetField: 'age', criticality: 'optional',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'string-to-number', numberType: 'integer' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'number-to-string' } } },
  ] });
  const contactRevisionEvent = await acceptContact('contact-settings-revision');
  assert.equal(await processor.process(contactRevisionEvent), 'UNCHANGED');
  assert.equal(bitrixContact.UF_AGE, '37', 'contact field initialization also reads MySklad within its company-scoped pair');
  const contactRevision = await database.entityPairSettingsRevision.findUniqueOrThrow({ where: { pairId_toSettingsVersion: { pairId: contactPairId, toSettingsVersion: withContactAge.version } } });
  assert.equal(contactRevision.status, 'COMPLETE');
  bitrixContact = { ...bitrixContact, UF_AGE: '99' };
  assert.equal(await processor.process(oldContactEvent), 'UNCHANGED');
  assert.equal(moyskladContact.age, 37, 'an older pinned contact event cannot overwrite the current MySklad value');
}));

test('child-only settings revisions initialize changed exact requisite fields from MySklad and verify readback', async () => serializeApplyTest(async () => {
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never,
    new HttpClientSyncGateway(), { readCompanyInn: async () => null } as never, undefined,
    new ClientChildResourceSync(fetch, undefined, { allowTestProviderOrigins: true }));
  const bindingV1 = { id: 'client-revision-child', entity: 'companies' as const, bitrix24CompanyId: sourceId,
    bitrix24RequisiteId: '200', moyskladCounterpartyId: targetId,
    legalFields: [{ bitrix24Field: 'RQ_INN', moyskladField: 'inn' }] };
  const base = await settings.active();
  const v1 = await saveThroughAdmin({ ...base.config, childResourceBindings: [bindingV1] });
  const v1Event = await acceptCompanyWebhook('child-v1-config');
  assert.equal(await processor.process(v1Event), 'UNCHANGED');
  assert.equal(bitrixRequisite.RQ_INN, '7700000000', 'V1 child mapping establishes an MS-authoritative value');
  const v1Revision = await database.entityPairSettingsRevision.findUniqueOrThrow({ where: { pairId_toSettingsVersion: { pairId, toSettingsVersion: v1.version } } });
  assert.equal(v1Revision.status, 'COMPLETE');

  const oldPending = await acceptCompanyWebhook('child-old-v1-pending');
  const v2 = await saveThroughAdmin({ ...v1.config, childResourceBindings: [{ ...bindingV1,
    legalFields: [...bindingV1.legalFields, { bitrix24Field: 'RQ_KPP', moyskladField: 'kpp' }] }] });
  const v2Event = await acceptCompanyWebhook('child-v2-only-change');
  writes.length = 0;
  assert.equal(await processor.process(v2Event), 'UNCHANGED');
  assert.equal(bitrixRequisite.RQ_KPP, 'authoritative-kpp', 'new child field is initialized from MySklad, not the prior Bitrix value');
  assert.equal(bitrixRequisite.RQ_INN, '7700000000', 'unchanged child mapping retains its prior value');
  assert.ok(writes.some((request) => request.path.endsWith('/crm.requisite.update.json')));
  assert.equal(writes.filter((request) => request.path.endsWith('/crm.requisite.update.json')).length, 1);
  assert.equal(writes.every((request) => new URL(request.path, address).origin === address), true);
  const revision = await database.entityPairSettingsRevision.findUniqueOrThrow({ where: { pairId_toSettingsVersion: { pairId, toSettingsVersion: v2.version } } });
  assert.equal(revision.status, 'COMPLETE');
  const state = await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId } });
  assert.equal(state.settingsVersion, v2.version);
  assert.equal(((state.childResourceState as any).bitrix24.requisite).RQ_KPP, 'authoritative-kpp');

  bitrixRequisite = { ...bitrixRequisite, RQ_KPP: 'later-bitrix-value' };
  assert.equal(await processor.process(oldPending), 'UNCHANGED');
  assert.equal(bitrixRequisite.RQ_KPP, 'later-bitrix-value', 'older V1 work does not roll back the newer child mapping');

  const withoutChildMapping = await saveThroughAdmin({ ...v2.config, childResourceBindings: [] });
  const removeEvent = await acceptCompanyWebhook('child-binding-removed');
  writes.length = 0;
  assert.equal(await processor.process(removeEvent), 'UNCHANGED');
  assert.equal(bitrixRequisite.RQ_KPP, 'later-bitrix-value', 'removal leaves physical child data untouched');
  assert.equal(writes.some((request) => request.method === 'POST' && request.path.endsWith('/crm.requisite.update.json')), false);
  assert.equal((await database.entityPairSettingsRevision.findUniqueOrThrow({ where: { pairId_toSettingsVersion: { pairId, toSettingsVersion: withoutChildMapping.version } } })).status, 'COMPLETE');
}));
