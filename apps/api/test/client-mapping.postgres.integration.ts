import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/database.service';
import { ClientMappingService } from '../src/clients/client-mapping.service';
import { ClientInventoryProvider } from '../src/clients/client-inventory.provider';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { ClientSyncProcessor } from '../src/clients/client-sync.processor';
import { ClientSyncGateway } from '../src/clients/client-sync.gateway';
import { HttpClientCandidateGateway } from '../src/clients/client-candidate.gateway';
import { EntityPairService } from '../src/pairs/entity-pair.service';

const suffix = randomUUID();
const companyId = `client53-${suffix}`;
const contactId = `client53-contact-${suffix}`;
const companyUuid = randomUUID();
const contactUuid = randomUUID();
const companyTarget = companyUuid;
const contactTarget = contactUuid;
const runtimeCompanyId = `runtime-company-${suffix}`;
const runtimeCompanyTarget = randomUUID();
const runtimeEventId = `runtime-event-${suffix}`;
const runtimeContactId = `runtime-contact-${suffix}`;
const runtimeContactTarget = randomUUID();
const runtimeContactEventId = `runtime-contact-event-${suffix}`;
const dependencyEventId = `dependency-event-${suffix}`;
const duplicateContactEventId = `duplicate-contact-event-${suffix}`;
const duplicateOrdinaryEventId = `duplicate-ordinary-event-${suffix}`;
const duplicateCompanyId = `duplicate-company-${suffix}`;
const canonicalCompanyId = `canonical-company-${suffix}`;
const duplicateContactId = `duplicate-contact-${suffix}`;
const dependencyCompanyTarget = randomUUID();
const badContactId = `bad-contact-${suffix}`;
const badContactTarget = randomUUID();
const badContactEventId = `bad-contact-event-${suffix}`;
const contactConflictEventId = `contact-conflict-event-${suffix}`;
const missingMsParentEventId = `missing-ms-parent-event-${suffix}`;
let database: DatabaseService;

const fakeApi: ClientInventoryProvider = {
  async bitrixPage(entity, start) {
    if (start) return { rows: [], next: null, total: 1 };
    return { rows: entity === 'COMPANY' ? [{ id: companyId, uuid: companyUuid }] : [{ id: contactId, uuid: contactUuid }], next: null, total: 1 };
  },
  async counterpartyPage(offset) {
    return offset === 0 ? { rows: [{ id: companyTarget }], next: null, total: 1 } : { rows: [], next: null, total: 1 };
  },
  async contactpersonPage(parentId, offset) {
    return offset === 0 ? { rows: [{ id: contactTarget, parentId }], next: null, total: 1 } : { rows: [], next: null, total: 1 };
  },
};

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to a disposable local PostgreSQL database');
  assert.equal(process.env.CLIENT_MAPPING_TEST_ISOLATED, '1', 'set CLIENT_MAPPING_TEST_ISOLATED=1 only for the isolated test database');
  const parsed = new URL(process.env.DATABASE_URL);
  assert.match(parsed.hostname, /^(localhost|127\.0\.0\.1)$/i);
  assert.match(parsed.pathname, /client53_test/i);
  process.env.SYNC_MODE = 'dry';
  process.env.DRY_DATABASE_URL = process.env.DATABASE_URL;
  database = new DatabaseService();
  await database.clientInventoryJob.deleteMany({ where: { id: 'client-map' } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: runtimeCompanyId } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: runtimeContactId } });
  await database.inboundEvent.deleteMany({ where: { id: runtimeEventId } });
  await database.inboundEvent.deleteMany({ where: { id: runtimeContactEventId } });
  await database.inboundEvent.deleteMany({ where: { id: dependencyEventId } });
  await database.inboundEvent.deleteMany({ where: { id: duplicateContactEventId } });
  await database.inboundEvent.deleteMany({ where: { id: duplicateOrdinaryEventId } });
  await database.inboundEvent.deleteMany({ where: { id: badContactEventId } });
  await database.inboundEvent.deleteMany({ where: { id: contactConflictEventId } });
  await database.inboundEvent.deleteMany({ where: { id: missingMsParentEventId } });
});

after(async () => {
  if (!database) return;
  await database.entityPair.deleteMany({ where: { bitrix24Id: { in: [companyId, contactId] } } });
  await database.clientInventoryObject.deleteMany({ where: { externalId: { in: [companyId, contactId, companyTarget, contactTarget] } } });
  await database.clientInventoryJob.deleteMany({ where: { id: 'client-map' } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: runtimeCompanyId } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: runtimeContactId } });
  await database.inboundEvent.deleteMany({ where: { id: runtimeEventId } });
  await database.inboundEvent.deleteMany({ where: { id: runtimeContactEventId } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: { in: [duplicateCompanyId, canonicalCompanyId, duplicateContactId] } } });
  await database.inboundEvent.deleteMany({ where: { id: dependencyEventId } });
  await database.inboundEvent.deleteMany({ where: { id: duplicateContactEventId } });
  await database.inboundEvent.deleteMany({ where: { id: duplicateOrdinaryEventId } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: badContactId } });
  await database.inboundEvent.deleteMany({ where: { id: badContactEventId } });
  await database.inboundEvent.deleteMany({ where: { id: contactConflictEventId } });
  await database.inboundEvent.deleteMany({ where: { id: missingMsParentEventId } });
  await database.$disconnect();
});

test('unpaired company resolves and creates through fake APIs, then persists the runtime pair in PostgreSQL', async () => {
  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'dry';
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.fake/rest/';
  const apiCalls: Array<{ url: string; method: string; body: string }> = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : '';
    apiCalls.push({ url, method, body });
    if (url.includes('crm.requisite.list')) return Response.json({ result: [], total: 0 });
    if (url.includes('/entity/counterparty') && method === 'POST') return Response.json({ id: runtimeCompanyTarget, name: 'Runtime Company' });
    if (url.includes('/entity/counterparty') && method === 'GET') return Response.json({ rows: [], meta: { size: 0, limit: 1000, offset: 0 } });
    throw new Error(`Unexpected fake API request: ${method} ${url}`);
  };
  const syncWrites: string[] = [];
  const syncGateway: ClientSyncGateway = {
    async readBitrix(entity, id) { assert.equal(entity, 'COMPANY'); assert.equal(id, runtimeCompanyId); return { ID: id, TITLE: 'Runtime Company' }; },
    async readMoysklad(type, id) { assert.equal(type, 'counterparty'); return { id, name: 'Runtime Company' }; },
    async updateBitrix() { syncWrites.push('BITRIX24'); },
    async updateMoysklad() { syncWrites.push('MOYSKLAD'); },
  };
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  await settings.active();
  await database.inboundEvent.create({ data: {
    id: runtimeEventId, source: 'BITRIX24', deliveryKey: runtimeEventId, eventType: 'ONCRMCOMPANYADD',
    externalEntityId: runtimeCompanyId, externalEntityType: 'company', payload: { event: 'ONCRMCOMPANYADD' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(runtimeEventId);
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, syncGateway, new HttpClientCandidateGateway(database, fakeFetch));
  const processingResult = await processor.process(runtimeEventId);
  const diagnosticLogs = await database.operationalLog.findMany({ where: { referenceId: runtimeEventId }, select: { message: true } });
  assert.equal(processingResult, 'BASELINE', JSON.stringify(diagnosticLogs));
  const pair = await database.entityPair.findFirst({ where: { entityType: 'COMPANY', bitrix24Id: runtimeCompanyId, active: true } });
  assert.ok(pair);
  assert.equal(pair.moyskladId, runtimeCompanyTarget);
  assert.equal(pair.source, 'RUNTIME');
  assert.equal(pair.moyskladType, 'counterparty');
  assert.equal(await database.entityPairSyncState.count({ where: { pairId: pair.id } }), 1);
  assert.deepEqual(syncWrites, [], 'initial baseline must not write existing fields');
  assert.ok(apiCalls.some((call) => call.method === 'POST' && call.url.endsWith('/entity/counterparty')));
  assert.ok(apiCalls.every((call) => call.url.includes('.fake/')), 'all HTTP requests stay inside the fake API boundary');
  if (previousMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = previousMode;
});

test('resumable inventory maps exact company/contact UUIDs to native IDs, including nested contactpersons', async () => {
  const service = new ClientMappingService(database, fakeApi);
  await service.start('synthetic-disposable-b24-token');
  let status: any;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await service.readStatus();
    if (status.status === 'complete' || status.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(status.status, 'complete', JSON.stringify(status));
  const pairs = await database.entityPair.findMany({ where: { bitrix24Id: { in: [companyId, contactId] }, active: true }, orderBy: { entityType: 'asc' } });
  assert.deepEqual(pairs.map((pair) => [pair.entityType, pair.moyskladId, pair.moyskladType, pair.moyskladParentId]), [
    ['COMPANY', companyTarget, 'counterparty', null], ['CONTACT', contactTarget, 'contactperson', companyTarget],
  ], JSON.stringify({ status, objects: await database.clientInventoryObject.findMany({ where: { externalId: { in: [companyId, contactId, companyTarget, contactTarget] } } }) }));
  const unmatched = await service.listUnmatched();
  assert.equal(unmatched.entries.some((row) => row.externalId === companyId || row.externalId === contactId), false);
});

test('unpaired contact resolves its primary company and creates a nested MoySklad contactperson through fake APIs', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.fake/rest/';
  const apiCalls: Array<{ url: string; method: string }> = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input); const method = init.method ?? 'GET'; apiCalls.push({ url, method });
    if (url.includes('/contactpersons') && method === 'POST') return Response.json({ id: runtimeContactTarget, name: 'Ada Example' });
    if (url.includes('/contactpersons')) return Response.json({ rows: [], meta: { size: 0, limit: 1000, offset: 0 } });
    if (url.includes('/customerorder')) return Response.json({ rows: [], meta: { size: 0 } });
    throw new Error(`Unexpected fake API request: ${method} ${url}`);
  };
  const syncGateway: ClientSyncGateway = {
    async readBitrix(entity, id) {
      if (entity === 'COMPANY') { assert.equal(id, companyId); return { ID: id, TITLE: 'Example Company' }; }
      assert.equal(id, runtimeContactId); return { ID: id, NAME: 'Ada', LAST_NAME: 'Example', PHONE: [{ VALUE: '+7 999 111-22-33' }], COMPANY_ID: companyId };
    },
    async readMoysklad(type, id, parentId) {
      if (type === 'counterparty') { assert.equal(id, companyTarget); return { id, name: 'Example Company' }; }
      assert.equal(parentId, companyTarget); return { id, name: 'Ada Example', phone: '+7 999 111-22-33' };
    },
    async updateBitrix() { assert.fail('initial baseline must not write'); },
    async updateMoysklad() { assert.fail('initial baseline must not write'); },
  };
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  await database.inboundEvent.create({ data: {
    id: runtimeContactEventId, source: 'BITRIX24', deliveryKey: runtimeContactEventId, eventType: 'ONCRMCONTACTADD',
    externalEntityId: runtimeContactId, externalEntityType: 'contact', payload: { event: 'ONCRMCONTACTADD' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(runtimeContactEventId);
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, syncGateway, new HttpClientCandidateGateway(database, fakeFetch));
  assert.equal(await processor.process(runtimeContactEventId), 'BASELINE');
  const pair = await database.entityPair.findFirst({ where: { entityType: 'CONTACT', bitrix24Id: runtimeContactId, active: true } });
  assert.ok(pair);
  assert.equal(pair.moyskladId, runtimeContactTarget);
  assert.equal(pair.moyskladType, 'contactperson');
  assert.equal(pair.moyskladParentId, companyTarget);
  assert.ok(apiCalls.some((call) => call.method === 'POST' && call.url.includes(`/counterparty/${companyTarget}/contactpersons`)));
  assert.ok(apiCalls.every((call) => call.url.includes('.fake/')));
});

test('document dependency canonicalizes a duplicate company to an unmarked equivalent and persists pair under owning event settings', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.fake/rest/';
  const apiCalls: Array<{ url: string; method: string }> = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input); const method = init.method ?? 'GET'; apiCalls.push({ url, method });
    if (url.includes('crm.requisite.list')) return Response.json({ result: [], total: 0 });
    if (url.includes('crm.company.list')) return Response.json({ result: [{ ID: canonicalCompanyId, TITLE: 'Canonical LLC', PHONE: '+7 999 222-33-44', DATE_CREATE: '2020-01-01T00:00:00Z', UF_CRM_1789126724375: '0' }], total: 1 });
    if (url.includes('crm.deal.list')) return Response.json({ result: [], total: 3 });
    if (url.includes('/entity/counterparty') && method === 'POST') return Response.json({ id: dependencyCompanyTarget, name: 'Canonical LLC' });
    if (url.includes('/entity/counterparty') && method === 'GET') return Response.json({ rows: [], meta: { size: 0, limit: 1000, offset: 0 } });
    throw new Error(`Unexpected fake API request: ${method} ${url}`);
  };
  const syncGateway: ClientSyncGateway = {
    async readBitrix(entity, id) {
      assert.equal(entity, 'COMPANY');
      assert.ok([duplicateCompanyId, canonicalCompanyId].includes(id));
      return { ID: id, TITLE: 'Canonical LLC', PHONE: '+7 999 222-33-44', UF_CRM_1789126724375: id === duplicateCompanyId ? '1' : '0' };
    },
    async readMoysklad(type, id) { assert.equal(type, 'counterparty'); return { id, name: 'Canonical LLC' }; },
    async updateBitrix() { assert.fail('dependency mapping must not write fields'); },
    async updateMoysklad() { assert.fail('dependency mapping must not write fields'); },
  };
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  await database.inboundEvent.create({ data: {
    id: dependencyEventId, source: 'BITRIX24', deliveryKey: dependencyEventId, eventType: 'ONCRMDEALADD',
    externalEntityId: `deal-${suffix}`, externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(dependencyEventId);
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, syncGateway, new HttpClientCandidateGateway(database, fakeFetch));
  const resolved = await processor.resolveForDocument({ eventId: dependencyEventId, sourceSystem: 'BITRIX24', entity: 'COMPANY', sourceId: duplicateCompanyId });
  if (resolved.status !== 'RESOLVED') throw new Error(JSON.stringify({ resolved, review: await database.manualReviewCase.findUnique({ where: { eventId: dependencyEventId } }) }));
  if (resolved.status !== 'RESOLVED') return;
  assert.equal(resolved.selectedSourceId, canonicalCompanyId);
  assert.equal(resolved.reason, 'DUPLICATE_COMPANY_CANONICALIZED');
  assert.equal(resolved.pair.bitrix24Id, canonicalCompanyId);
  assert.equal(resolved.pair.moyskladId, dependencyCompanyTarget);
  const repeated = await processor.resolveForDocument({ eventId: dependencyEventId, sourceSystem: 'BITRIX24', entity: 'COMPANY', sourceId: duplicateCompanyId });
  assert.equal(repeated.status, 'RESOLVED');
  if (repeated.status === 'RESOLVED') assert.equal(repeated.pair.id, resolved.pair.id, 'repeated dependency resolution reuses the persisted pair');
  assert.equal(apiCalls.filter((call) => call.method === 'POST' && call.url.endsWith('/entity/counterparty')).length, 1);
  assert.ok(apiCalls.every((call) => call.url.includes('.fake/')));
});

test('document dependency omits a duplicate contact only after validating the saved company pair', async () => {
  const existingCompanyPair = await database.entityPair.findFirst({ where: { entityType: 'COMPANY', bitrix24Id: companyId, active: true } });
  assert.ok(existingCompanyPair, 'the preceding inventory test creates the company pair');
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  await database.inboundEvent.create({ data: {
    id: duplicateContactEventId, source: 'BITRIX24', deliveryKey: duplicateContactEventId, eventType: 'ONCRMDEALADD',
    externalEntityId: `deal-${suffix}`, externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(duplicateContactEventId);
  const syncGateway: ClientSyncGateway = {
    async readBitrix(entity, id) {
      if (entity === 'COMPANY') { assert.equal(id, companyId); return { ID: id, TITLE: 'Existing Company' }; }
      assert.equal(id, duplicateContactId); return { ID: id, COMPANY_ID: companyId, UF_CRM_1789126649744: '1' };
    },
    async readMoysklad(type, id) { assert.equal(type, 'counterparty'); assert.equal(id, existingCompanyPair.moyskladId); return { id, name: 'Existing Company' }; },
    async updateBitrix() { assert.fail('duplicate contact is omitted'); },
    async updateMoysklad() { assert.fail('duplicate contact is omitted'); },
  };
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, syncGateway, new HttpClientCandidateGateway(database, async () => { throw new Error('duplicate contact path must not search or create'); }));
  const resolved = await processor.resolveForDocument({ eventId: duplicateContactEventId, sourceSystem: 'BITRIX24', entity: 'CONTACT', sourceId: duplicateContactId });
  assert.equal(resolved.status, 'OMITTED');
  if (resolved.status === 'OMITTED') assert.equal(resolved.companyPair.id, existingCompanyPair.id);
  assert.equal(await database.entityPair.count({ where: { entityType: 'CONTACT', bitrix24Id: duplicateContactId } }), 0);
});

test('persisted contact dependency rejects a contactperson pair attached to a different company', async () => {
  const companyPair = await database.entityPair.findFirst({ where: { entityType: 'COMPANY', bitrix24Id: companyId, active: true } });
  assert.ok(companyPair);
  await database.entityPair.create({ data: {
    entityType: 'CONTACT', bitrix24Id: badContactId, moyskladId: badContactTarget,
    moyskladType: 'contactperson', moyskladParentId: randomUUID(), active: true, source: 'TEST',
  } });
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  await database.inboundEvent.create({ data: {
    id: badContactEventId, source: 'BITRIX24', deliveryKey: badContactEventId, eventType: 'ONCRMDEALADD',
    externalEntityId: `deal-${suffix}`, externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(badContactEventId);
  const gateway: ClientSyncGateway = {
    async readBitrix(entity, id) {
      if (entity === 'COMPANY') { assert.equal(id, companyId); return { ID: id, TITLE: 'Existing Company' }; }
      assert.equal(id, badContactId); return { ID: id, COMPANY_ID: companyId, LAST_NAME: 'Ada', NAME: 'Example' };
    },
    async readMoysklad(type, id) { assert.equal(type, 'contactperson'); assert.equal(id, badContactTarget); return { id, name: 'Ada Example' }; },
    async updateBitrix() { assert.fail('mismatched persisted dependency must not write'); },
    async updateMoysklad() { assert.fail('mismatched persisted dependency must not write'); },
  };
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, gateway, new HttpClientCandidateGateway(database, async () => { throw new Error('saved pair must not search or create'); }));
  const result = await processor.resolveForDocument({ eventId: badContactEventId, sourceSystem: 'BITRIX24', entity: 'CONTACT', sourceId: badContactId });
  assert.deepEqual(result, { status: 'REVIEW', reason: 'CLIENT_CONTACTPERSON_PARENT_MISMATCH' });
  assert.equal((await database.manualReviewCase.findUnique({ where: { eventId: badContactEventId } }))?.reason, 'CLIENT_CONTACTPERSON_PARENT_MISMATCH');
  assert.ok(companyPair);
});

test('document dependency rejects explicit company conflicting with a Bitrix contact native company', async () => {
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  await database.inboundEvent.create({ data: {
    id: contactConflictEventId, source: 'BITRIX24', deliveryKey: contactConflictEventId, eventType: 'ONCRMDEALADD',
    externalEntityId: `deal-${suffix}`, externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(contactConflictEventId);
  const gateway: ClientSyncGateway = {
    async readBitrix(entity, id) { assert.equal(entity, 'CONTACT'); assert.equal(id, badContactId); return { ID: id, COMPANY_ID: companyId }; },
    async readMoysklad() { assert.fail('conflicting relationship must not access MoySklad'); },
    async updateBitrix() { assert.fail('conflicting relationship must not write'); },
    async updateMoysklad() { assert.fail('conflicting relationship must not write'); },
  };
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, gateway, new HttpClientCandidateGateway(database, async () => { throw new Error('conflicting relationship must not search'); }));
  const result = await processor.resolveForDocument({ eventId: contactConflictEventId, sourceSystem: 'BITRIX24', entity: 'CONTACT', sourceId: badContactId, primaryCompanySourceId: `other-${suffix}` });
  assert.deepEqual(result, { status: 'REVIEW', reason: 'CLIENT_CONTACT_PRIMARY_COMPANY_CONFLICT' });
});

test('MoySklad contact dependency without a parent is held before reading the wrong endpoint', async () => {
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  await database.inboundEvent.create({ data: {
    id: missingMsParentEventId, source: 'MOYSKLAD', deliveryKey: missingMsParentEventId, eventType: 'UPDATE',
    externalEntityId: randomUUID(), externalEntityType: 'contactperson', payload: { event: 'UPDATE' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(missingMsParentEventId);
  const gateway: ClientSyncGateway = {
    async readBitrix() { assert.fail('missing parent must be held before read'); },
    async readMoysklad() { assert.fail('missing parent must be held before reading a counterparty endpoint'); },
    async updateBitrix() { assert.fail('missing parent must not write'); },
    async updateMoysklad() { assert.fail('missing parent must not write'); },
  };
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, gateway, new HttpClientCandidateGateway(database, async () => { throw new Error('missing parent must not search'); }));
  const result = await processor.resolveForDocument({ eventId: missingMsParentEventId, sourceSystem: 'MOYSKLAD', entity: 'CONTACT', sourceId: randomUUID() });
  assert.deepEqual(result, { status: 'REVIEW', reason: 'CLIENT_CONTACT_SOURCE_PARENT_MISSING' });
});

test('ordinary client sync excludes a duplicate-marked company without searching or writing', async () => {
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  await database.inboundEvent.create({ data: {
    id: duplicateOrdinaryEventId, source: 'BITRIX24', deliveryKey: duplicateOrdinaryEventId, eventType: 'ONCRMCOMPANYUPDATE',
    externalEntityId: duplicateCompanyId, externalEntityType: 'company', payload: { event: 'ONCRMCOMPANYUPDATE' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(duplicateOrdinaryEventId);
  const syncGateway: ClientSyncGateway = {
    async readBitrix(entity, id) { assert.equal(entity, 'COMPANY'); assert.equal(id, duplicateCompanyId); return { ID: id, TITLE: 'Duplicate', UF_CRM_1789126724375: '1' }; },
    async readMoysklad() { assert.fail('duplicate-marked company must not access the target'); },
    async updateBitrix() { assert.fail('duplicate-marked company must not sync'); },
    async updateMoysklad() { assert.fail('duplicate-marked company must not sync'); },
  };
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, syncGateway, new HttpClientCandidateGateway(database, async () => { throw new Error('duplicate-marked company must not search'); }));
  assert.equal(await processor.process(duplicateOrdinaryEventId), 'UNCHANGED');
  const savedEvent = await database.inboundEvent.findUnique({ where: { id: duplicateOrdinaryEventId } });
  assert.equal(savedEvent?.status, 'SUCCEEDED');
  assert.equal(savedEvent?.lastErrorCategory, 'DUPLICATE_COMPANY_EXCLUDED_FROM_ORDINARY_SYNC');
});
