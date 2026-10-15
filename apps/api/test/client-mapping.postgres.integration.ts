import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { EntityPair } from '@prisma/client';
import { DatabaseService } from '../src/database.service';
import { ClientMappingService } from '../src/clients/client-mapping.service';
import { ClientInventoryProvider } from '../src/clients/client-inventory.provider';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { ClientSyncProcessor } from '../src/clients/client-sync.processor';
import { ClientSyncGateway } from '../src/clients/client-sync.gateway';
import { HttpClientCandidateGateway } from '../src/clients/client-candidate.gateway';
import { EntityPairService } from '../src/pairs/entity-pair.service';
import { PairFirstEventProcessor } from '../src/pairs/pair-first-event.processor';
import { EventWorkerLeaseService } from '../src/event-worker-lease.service';
import { ProviderFailure } from '../src/provider-failure';
import { toMoySkladCustomerOrderClientFields } from '../src/clients/document-client-contract';
import { ClientChildResourceSync } from '../src/clients/client-child-resource-sync';
import { DryRunWriteJournal } from '../src/dry-run-write-journal';
import { setDatabaseRecoveryReady } from '../src/external-write-guard';

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
const ordinaryLeaseEventId = `ordinary-lease-event-${suffix}`;
const ordinaryLeaseSecondEventId = `ordinary-lease-second-event-${suffix}`;
const ordinarySourceLockEventId = `ordinary-source-lock-event-${suffix}`;
const ordinarySourceLockSecondEventId = `ordinary-source-lock-second-event-${suffix}`;
const ordinaryLeaseLossEventId = `ordinary-lease-loss-event-${suffix}`;
const ordinaryLeaseLossSourceId = `ordinary-lease-loss-source-${suffix}`;
const ordinaryLeaseLossTargetId = randomUUID();
const duplicateCompanyId = `duplicate-company-${suffix}`;
const canonicalCompanyId = `canonical-company-${suffix}`;
const duplicateContactId = `duplicate-contact-${suffix}`;
const dependencyCompanyTarget = randomUUID();
const badContactId = `bad-contact-${suffix}`;
const badContactTarget = randomUUID();
const badContactEventId = `bad-contact-event-${suffix}`;
const contactConflictEventId = `contact-conflict-event-${suffix}`;
const missingMsParentEventId = `missing-ms-parent-event-${suffix}`;
const combinedEventId = `combined-dependency-event-${suffix}`;
const uncertainEventId = `uncertain-dependency-event-${suffix}`;
const uncertainRetryEventId = `uncertain-retry-event-${suffix}`;
const leaseLossEventId = `lease-loss-dependency-event-${suffix}`;
const pairWorkerLeaseLossEventId = `pair-worker-lease-loss-event-${suffix}`;
const combinedCompanyId = `combined-company-${suffix}`;
const combinedCompanyTarget = randomUUID();
const concurrentOrdinaryEventId = `concurrent-ordinary-event-${suffix}`;
const concurrentDealEventId = `concurrent-deal-event-${suffix}`;
const concurrentCompanyId = `concurrent-company-${suffix}`;
const concurrentCompanyTarget = randomUUID();
const multiCompanyContactId = `multi-company-contact-${suffix}`;
const multiCompanyCompanyA = `multi-company-a-${suffix}`;
const multiCompanyCompanyB = `multi-company-b-${suffix}`;
const multiCompanyTargetA = randomUUID();
const multiCompanyTargetB = randomUUID();
const multiCompanyContactTargetA = randomUUID();
const multiCompanyContactTargetB = randomUUID();
const multiCompanyEventId = `multi-company-event-${suffix}`;
const optionalContactEventId = `optional-contact-event-${suffix}`;
const optionalContactSourceId = `optional-contact-${suffix}`;
const optionalContactTargetId = randomUUID();
const optionalDealPairId = `optional-deal-pair-${suffix}`;
const serviceCounterpartyEventId = `service-counterparty-event-${suffix}`;
const missingServiceCounterpartyEventId = `missing-service-counterparty-event-${suffix}`;
const serviceCounterpartyId = randomUUID();
const uncertainCompanyId = `uncertain-company-${suffix}`;
let database: DatabaseService;

const fakeApi: ClientInventoryProvider = {
  async bitrixPage(entity, start) {
    if (start) return { rows: [], next: null, total: 1 };
    return { rows: entity === 'COMPANY' ? [{ id: companyId, uuid: companyUuid }] : [{ id: contactId, uuid: contactUuid }], next: null, total: 1 };
  },
  async counterpartyPage(offset) {
    return offset === 0 ? { rows: [{ id: companyTarget, companyType: 'legal' }], next: null, total: 1 } : { rows: [], next: null, total: 1 };
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
  process.env.SYNC_MODE = 'apply';
  const dryTarget = new URL(process.env.DATABASE_URL);
  dryTarget.searchParams.set('schema', 'dry_client53_test');
  process.env.DRY_DATABASE_URL = dryTarget.toString();
  database = new DatabaseService();
  await database.clientInventoryJob.deleteMany({ where: { id: 'client-map' } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: runtimeCompanyId } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: runtimeContactId } });
  await database.inboundEvent.deleteMany({ where: { id: runtimeEventId } });
  await database.inboundEvent.deleteMany({ where: { id: runtimeContactEventId } });
  await database.inboundEvent.deleteMany({ where: { id: dependencyEventId } });
  await database.inboundEvent.deleteMany({ where: { id: duplicateContactEventId } });
  await database.inboundEvent.deleteMany({ where: { id: duplicateOrdinaryEventId } });
  await database.inboundEvent.deleteMany({ where: { id: ordinaryLeaseEventId } });
  await database.inboundEvent.deleteMany({ where: { id: ordinaryLeaseSecondEventId } });
  await database.inboundEvent.deleteMany({ where: { id: { in: [ordinarySourceLockEventId, ordinarySourceLockSecondEventId] } } });
  await database.inboundEvent.deleteMany({ where: { id: ordinaryLeaseLossEventId } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: ordinaryLeaseLossSourceId } });
  await database.inboundEvent.deleteMany({ where: { id: badContactEventId } });
  await database.inboundEvent.deleteMany({ where: { id: contactConflictEventId } });
  await database.inboundEvent.deleteMany({ where: { id: missingMsParentEventId } });
  await database.inboundEvent.deleteMany({ where: { id: { in: [combinedEventId, uncertainEventId, uncertainRetryEventId, concurrentOrdinaryEventId, concurrentDealEventId, leaseLossEventId, pairWorkerLeaseLossEventId] } } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: { in: [multiCompanyCompanyA, multiCompanyCompanyB, multiCompanyContactId] } } });
  await database.inboundEvent.deleteMany({ where: { id: multiCompanyEventId } });
  await database.clientDependencyRetry.deleteMany({ where: { eventId: optionalContactEventId } });
  await database.inboundEvent.deleteMany({ where: { id: optionalContactEventId } });
  await database.inboundEvent.deleteMany({ where: { id: { in: [serviceCounterpartyEventId, missingServiceCounterpartyEventId] } } });
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
  await database.inboundEvent.deleteMany({ where: { id: ordinaryLeaseEventId } });
  await database.inboundEvent.deleteMany({ where: { id: ordinaryLeaseSecondEventId } });
  await database.inboundEvent.deleteMany({ where: { id: { in: [ordinarySourceLockEventId, ordinarySourceLockSecondEventId] } } });
  await database.inboundEvent.deleteMany({ where: { id: ordinaryLeaseLossEventId } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: ordinaryLeaseLossSourceId } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: badContactId } });
  await database.inboundEvent.deleteMany({ where: { id: badContactEventId } });
  await database.inboundEvent.deleteMany({ where: { id: contactConflictEventId } });
  await database.inboundEvent.deleteMany({ where: { id: missingMsParentEventId } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: { in: [combinedCompanyId, uncertainCompanyId, concurrentCompanyId] } } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: { in: [multiCompanyCompanyA, multiCompanyCompanyB, multiCompanyContactId] } } });
  await database.inboundEvent.deleteMany({ where: { id: multiCompanyEventId } });
  await database.clientDependencyRetry.deleteMany({ where: { eventId: optionalContactEventId } });
  await database.entityPair.deleteMany({ where: { entityType: 'CONTACT', bitrix24Id: optionalContactSourceId } });
  await database.inboundEvent.deleteMany({ where: { id: optionalContactEventId } });
  await database.inboundEvent.deleteMany({ where: { id: { in: [serviceCounterpartyEventId, missingServiceCounterpartyEventId] } } });
  await database.pairReviewCase.deleteMany({ where: { sourceEntityId: uncertainCompanyId } });
  await database.inboundEvent.deleteMany({ where: { id: { in: [combinedEventId, uncertainEventId, uncertainRetryEventId, concurrentOrdinaryEventId, concurrentDealEventId, leaseLossEventId, pairWorkerLeaseLossEventId] } } });
  await database.$disconnect();
});

test('unpaired company resolves and creates through fake APIs, then persists the runtime pair in PostgreSQL', async () => {
  const previousMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'apply';
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
  const inventoriedCompany = await database.clientInventoryObject.findFirst({ where: { system: 'MOYSKLAD', entityType: 'COMPANY', externalId: companyTarget } });
  assert.equal(inventoriedCompany?.companyType, 'legal');
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
      return { ID: id, TITLE: 'Canonical LLC', PHONE: '+7 999 222-33-44', UF_CRM_1789126724375: id === duplicateCompanyId ? 'Дубль' : '' };
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

test('claimed deal event resolves and persists client dependency under worker fencing; uncertain create leaves durable hold', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.fake/rest/';
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  await settings.active();
  const calls: Array<{ url: string; method: string }> = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input); const method = init.method ?? 'GET'; calls.push({ url, method });
    if (url.includes('crm.requisite.list')) return Response.json({ result: [], total: 0 });
    if (url.includes('crm.company.list')) return Response.json({ result: [], total: 0 });
    if (url.includes('/entity/counterparty') && method === 'GET') return Response.json({ rows: [], meta: { size: 0, limit: 1000, offset: 0 } });
    if (url.includes('/entity/counterparty') && method === 'POST') return Response.json({ id: combinedCompanyTarget, name: 'Combined Company' });
    throw new Error(`Unexpected fake API request: ${method} ${url}`);
  };
  const clientGateway: ClientSyncGateway = {
    async readBitrix(entity, id) { assert.equal(entity, 'COMPANY'); assert.equal(id, combinedCompanyId); return { ID: id, TITLE: 'Combined Company' }; },
    async readMoysklad(type, id) { assert.equal(type, 'counterparty'); return { id, name: 'Combined Company' }; },
    async updateBitrix() { assert.fail('dependency resolution must not write'); },
    async updateMoysklad() { assert.fail('dependency resolution must not write'); },
  };
  const resolver = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, clientGateway, new HttpClientCandidateGateway(database, fakeFetch));
  const workerLease = new EventWorkerLeaseService(database);
  const dealPair = { id: `deal-pair-${suffix}`, entityType: 'DEAL' as const, bitrix24Id: `deal-${suffix}`, moyskladId: randomUUID(), status: 'CONFIRMED' as const, source: 'PERSISTED' as const };
  const processor = new PairFirstEventProcessor(
    database,
    { resolve: async () => ({ status: 'confirmed', pair: dealPair }) } as never,
    settings,
    { ensureForConfirmedPair: async () => ({ status: 'READY', baselineId: `baseline-${suffix}` }) } as never,
    undefined,
    workerLease,
    { read: async () => ({ mode: 'on' }) } as never,
    resolver,
    { readBitrix24DealForBaseline: async () => ({ ID: dealPair.bitrix24Id, COMPANY_ID: combinedCompanyId }) } as never,
  );
  await database.inboundEvent.create({ data: {
    id: combinedEventId, source: 'BITRIX24', deliveryKey: combinedEventId, eventType: 'ONCRMDEALADD',
    externalEntityId: dealPair.bitrix24Id, externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(combinedEventId);
  await processor.process(combinedEventId);
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: combinedEventId } })).status, 'SUCCEEDED');
  const persisted = await database.entityPair.findFirst({ where: { entityType: 'COMPANY', bitrix24Id: combinedCompanyId, active: true } });
  assert.ok(persisted);
  assert.equal(persisted.moyskladId, combinedCompanyTarget);
  await processor.process(combinedEventId);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/entity/counterparty')).length, 1);

  let postEntered!: () => void;
  let releasePost!: () => void;
  const postStarted = new Promise<void>((resolve) => { postEntered = resolve; });
  const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
  let concurrentPosts = 0;
  const concurrentFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input); const method = init.method ?? 'GET';
    if (url.includes('crm.requisite.list')) return Response.json({ result: [], total: 0 });
    if (url.includes('crm.company.list')) return Response.json({ result: [], total: 0 });
    if (url.includes('/entity/counterparty') && method === 'GET') return Response.json({ rows: [], meta: { size: 0, limit: 1000, offset: 0 } });
    if (url.includes('/entity/counterparty') && method === 'POST') {
      concurrentPosts++;
      postEntered();
      await postGate;
      return Response.json({ id: concurrentCompanyTarget, name: 'Concurrent Company' });
    }
    throw new Error(`Unexpected fake API request: ${method} ${url}`);
  };
  const concurrentGateway: ClientSyncGateway = {
    async readBitrix(entity, id) { assert.equal(entity, 'COMPANY'); assert.equal(id, concurrentCompanyId); return { ID: id, TITLE: 'Concurrent Company' }; },
    async readMoysklad(type, id) { assert.equal(type, 'counterparty'); return { id, name: 'Concurrent Company' }; },
    async updateBitrix() { assert.fail('concurrent dependency resolution must not write'); },
    async updateMoysklad() { assert.fail('concurrent dependency resolution must not write'); },
  };
  const concurrentResolver = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, concurrentGateway, new HttpClientCandidateGateway(database, concurrentFetch));
  const concurrentTargetDealPair = { ...dealPair, id: `concurrent-deal-pair-${suffix}`, bitrix24Id: `concurrent-deal-${suffix}` };
  const concurrentPairFirst = new PairFirstEventProcessor(
    database,
    { resolve: async () => ({ status: 'confirmed', pair: concurrentTargetDealPair }) } as never,
    settings,
    { ensureForConfirmedPair: async () => ({ status: 'READY', baselineId: `concurrent-baseline-${suffix}` }) } as never,
    undefined,
    workerLease,
    { read: async () => ({ mode: 'on' }) } as never,
    concurrentResolver,
    { readBitrix24DealForBaseline: async () => ({ ID: concurrentTargetDealPair.bitrix24Id, COMPANY_ID: concurrentCompanyId }) } as never,
  );
  await database.inboundEvent.create({ data: {
    id: concurrentOrdinaryEventId, source: 'BITRIX24', deliveryKey: concurrentOrdinaryEventId, eventType: 'ONCRMCOMPANYADD',
    externalEntityId: concurrentCompanyId, externalEntityType: 'company', payload: { event: 'ONCRMCOMPANYADD' }, status: 'RECEIVED',
  } });
  await database.inboundEvent.create({ data: {
    id: concurrentDealEventId, source: 'BITRIX24', deliveryKey: concurrentDealEventId, eventType: 'ONCRMDEALADD',
    externalEntityId: concurrentTargetDealPair.bitrix24Id, externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(concurrentOrdinaryEventId);
  await settings.pinEvent(concurrentDealEventId);
  const ordinaryInFlight = concurrentResolver.process(concurrentOrdinaryEventId);
  await postStarted;
  await concurrentPairFirst.process(concurrentDealEventId);
  const contended = await database.inboundEvent.findUniqueOrThrow({ where: { id: concurrentDealEventId } });
  assert.equal(contended.status, 'RETRYABLE_FAILURE');
  assert.equal(concurrentPosts, 1, 'document path must not POST while ordinary client event owns the source lease');
  releasePost();
  await ordinaryInFlight;
  await database.inboundEvent.update({ where: { id: concurrentDealEventId }, data: { status: 'RECEIVED', retryAfter: null, processingStartedAt: null } });
  await concurrentPairFirst.process(concurrentDealEventId);
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: concurrentDealEventId } })).status, 'SUCCEEDED');
  assert.equal(concurrentPosts, 1, 'the retried dependency must reuse the pair persisted by ordinary processing');

  await database.inboundEvent.create({ data: {
    id: leaseLossEventId, source: 'MOYSKLAD', deliveryKey: leaseLossEventId, eventType: 'UPDATE',
    externalEntityId: randomUUID(), externalEntityType: 'customerorder', payload: { event: 'UPDATE' }, status: 'PROCESSING', processingStartedAt: new Date(),
  } });
  await settings.pinEvent(leaseLossEventId);
  const leaseLostResolver = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, concurrentGateway, new HttpClientCandidateGateway(database, concurrentFetch));
  const leaseEvent = await database.inboundEvent.findUniqueOrThrow({ where: { id: leaseLossEventId } });
  let leaseWasRejected = false;
  try {
    await (leaseLostResolver as any).dependencyHold(leaseEvent, 'STALE_WORKER_TEST', {}, {
      assertOwned: async () => undefined,
      assertOwnedIn: async () => { throw new Error('EVENT_WORKER_LEASE_LOST'); },
    });
  } catch (error) { leaseWasRejected = error instanceof Error && error.message === 'EVENT_WORKER_LEASE_LOST'; }
  assert.equal(leaseWasRejected, true, 'dependency hold checks the worker fence inside its transaction before persistence');
  assert.equal(await database.manualReviewCase.count({ where: { eventId: leaseLossEventId } }), 0, 'a stale worker cannot create a manual review case');
  assert.equal(await database.operationalLog.count({ where: { referenceId: leaseLossEventId, category: 'CLIENT_DEPENDENCY' } }), 0, 'a stale worker cannot emit dependency logs');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: leaseLossEventId } })).status, 'PROCESSING');

  await database.inboundEvent.create({ data: {
    id: pairWorkerLeaseLossEventId, source: 'BITRIX24', deliveryKey: pairWorkerLeaseLossEventId, eventType: 'ONCRMDEALADD',
    externalEntityId: `stale-deal-${suffix}`, externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
  } });
  let pairLeaseAssertions = 0;
  const pairWorker = {
    async run<T>(_eventId: string, work: (lease: { assertOwned(): Promise<void>; assertOwnedIn(): Promise<void> }) => Promise<T>) {
      return work({ assertOwned: async () => undefined, assertOwnedIn: async () => {
        pairLeaseAssertions++;
        if (pairLeaseAssertions === 2) throw new Error('EVENT_WORKER_LEASE_LOST');
      } });
    },
  };
  const stalePairProcessor = new PairFirstEventProcessor(
    database,
    { resolve: async () => ({ status: 'unmatched', reason: 'NO_CANDIDATES' }) } as never,
    undefined,
    undefined,
    undefined,
    pairWorker as never,
    { read: async () => ({ mode: 'on' }) } as never,
  );
  let pairLeaseRejected = false;
  try { await stalePairProcessor.process(pairWorkerLeaseLossEventId); }
  catch (error) { pairLeaseRejected = error instanceof Error && error.message === 'EVENT_WORKER_LEASE_LOST'; }
  assert.equal(pairLeaseRejected, true, 'lease loss inside the retry/manual-review transaction aborts the transition');
  assert.equal(pairLeaseAssertions, 2, 'claim is fenced, then the stale terminal transition is rejected');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: pairWorkerLeaseLossEventId } })).status, 'PROCESSING');

  let uncertainPosts = 0;
  const uncertainFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input); const method = init.method ?? 'GET';
    if (url.includes('crm.requisite.list')) return Response.json({ result: [], total: 0 });
    if (url.includes('crm.company.list')) return Response.json({ result: [], total: 0 });
    if (url.includes('/entity/counterparty') && method === 'GET') return Response.json({ rows: [], meta: { size: 0, limit: 1000, offset: 0 } });
    if (url.includes('/entity/counterparty') && method === 'POST') { uncertainPosts++; throw new Error('simulated lost create response'); }
    throw new Error(`Unexpected fake API request: ${method} ${url}`);
  };
  const uncertainResolver = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, {
    ...clientGateway,
    async readBitrix(_entity: 'COMPANY' | 'CONTACT', id: string) { assert.equal(id, uncertainCompanyId); return { ID: id, TITLE: 'Uncertain Company' }; },
  } as never, new HttpClientCandidateGateway(database, uncertainFetch));
  const uncertainProcessor = new PairFirstEventProcessor(
    database,
    { resolve: async () => ({ status: 'confirmed', pair: { ...dealPair, id: `uncertain-deal-pair-${suffix}` } }) } as never,
    settings,
    { ensureForConfirmedPair: async () => ({ status: 'READY', baselineId: `uncertain-baseline-${suffix}` }) } as never,
    undefined,
    workerLease,
    { read: async () => ({ mode: 'on' }) } as never,
    uncertainResolver,
    { readBitrix24DealForBaseline: async () => ({ ID: dealPair.bitrix24Id, COMPANY_ID: uncertainCompanyId }) } as never,
  );
  for (const eventId of [uncertainEventId, uncertainRetryEventId]) {
    await database.inboundEvent.create({ data: {
      id: eventId, source: 'BITRIX24', deliveryKey: eventId, eventType: 'ONCRMDEALADD',
      externalEntityId: dealPair.bitrix24Id, externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
    } });
    await settings.pinEvent(eventId);
    await uncertainProcessor.process(eventId);
    assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } })).status, 'MANUAL_REVIEW');
  }
  assert.equal(uncertainPosts, 1, 'second distinct event must not repeat an uncertain provider create');
  const durableHold = await database.pairReviewCase.findFirst({ where: { sourceEntityId: uncertainCompanyId, reason: 'CLIENT_CREATE_IN_PROGRESS', status: 'OPEN' } });
  assert.ok(durableHold, 'uncertain response remains held durably for reconciliation');
});

test('document client dependency preserves provider Retry-After as durable dueAt', async () => {
  const eventId = `dependency-throttle-${suffix}`;
  const sourceCompanyId = `throttled-company-${suffix}`;
  const dealPair = { id: `throttled-deal-pair-${suffix}`, entityType: 'DEAL' as const, bitrix24Id: `throttled-deal-${suffix}`, moyskladId: randomUUID(), status: 'CONFIRMED' as const, source: 'PERSISTED' as const };
  const retryAt = new Date(Date.now() + 30_000);
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  await settings.active();
  const clientGateway: ClientSyncGateway = {
    async readBitrix(entity, id) {
      assert.equal(entity, 'COMPANY');
      assert.equal(id, sourceCompanyId);
      throw new ProviderFailure('BITRIX24', 429, retryAt);
    },
    async readMoysklad() { assert.fail('B24 read is rate limited first'); },
    async updateBitrix() { assert.fail('document dependency never writes client fields'); },
    async updateMoysklad() { assert.fail('document dependency never writes client fields'); },
  };
  const resolver = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, clientGateway, new HttpClientCandidateGateway(database, async () => { assert.fail('candidate search is not reached'); }));
  const workerLease = new EventWorkerLeaseService(database);
  await database.inboundEvent.create({ data: {
    id: eventId, source: 'BITRIX24', deliveryKey: eventId, eventType: 'ONCRMDEALADD',
    externalEntityId: dealPair.bitrix24Id, externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(eventId);
  const processor = new PairFirstEventProcessor(
    database,
    { resolve: async () => ({ status: 'confirmed', pair: dealPair }) } as never,
    settings,
    { ensureForConfirmedPair: async () => ({ status: 'READY', baselineId: dealPair.id }) } as never,
    undefined,
    workerLease,
    { read: async () => ({ mode: 'on' }) } as never,
    resolver,
    { readBitrix24DealForBaseline: async () => ({ ID: dealPair.bitrix24Id, COMPANY_ID: sourceCompanyId }) } as never,
  );
  try {
    await processor.process(eventId);
    const event = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(event.status, 'RETRYABLE_FAILURE');
    assert.ok(event.retryAfter);
    assert.ok(Math.abs(event.retryAfter!.getTime() - retryAt.getTime()) < 1_000);
  } finally {
    await database.inboundEvent.deleteMany({ where: { id: eventId } });
  }
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

test('document company scopes a contact pair independently of the contact native company', async () => {
  const companyPair = await database.entityPair.create({ data: {
    entityType: 'COMPANY', bitrix24Id: multiCompanyCompanyA, moyskladId: multiCompanyTargetA, moyskladType: 'counterparty', active: true, source: 'TEST',
  } });
  await database.entityPair.create({ data: {
    entityType: 'CONTACT', bitrix24Id: badContactId, moyskladId: badContactTarget,
    moyskladType: 'contactperson', moyskladParentId: companyPair.moyskladId, active: true, source: 'TEST',
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
    async readMoysklad(type, id) { assert.equal(type, 'contactperson'); assert.equal(id, badContactTarget); return { id, name: 'Ada Example', company: { meta: { href: `https://fake/entity/counterparty/${companyPair.moyskladId}` } } }; },
    async updateBitrix() { assert.fail('document dependency lookup must not write'); },
    async updateMoysklad() { assert.fail('document dependency lookup must not write'); },
  };
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, gateway, new HttpClientCandidateGateway(database, async () => { throw new Error('saved pair must not search or create'); }));
  const result = await processor.resolveForDocument({ eventId: badContactEventId, sourceSystem: 'BITRIX24', entity: 'CONTACT', sourceId: badContactId, primaryCompanySourceId: multiCompanyCompanyA });
  assert.equal(result.status, 'RESOLVED');
  if (result.status === 'RESOLVED') assert.equal(result.pair.moyskladParentId, companyPair.moyskladId);
});

test('the same Bitrix24 contact keeps separate MoySklad contactpersons for each document company', async () => {
  const companyA = await database.entityPair.findFirst({ where: { entityType: 'COMPANY', bitrix24Id: multiCompanyCompanyA, active: true } })
    ?? await database.entityPair.create({ data: {
      entityType: 'COMPANY', bitrix24Id: multiCompanyCompanyA, moyskladId: multiCompanyTargetA, moyskladType: 'counterparty', active: true, source: 'TEST',
    } });
  const companyB = await database.entityPair.findFirst({ where: { entityType: 'COMPANY', bitrix24Id: multiCompanyCompanyB, active: true } })
    ?? await database.entityPair.create({ data: {
      entityType: 'COMPANY', bitrix24Id: multiCompanyCompanyB, moyskladId: multiCompanyTargetB, moyskladType: 'counterparty', active: true, source: 'TEST',
    } });
  const contactA = await database.entityPair.create({ data: {
    entityType: 'CONTACT', bitrix24Id: multiCompanyContactId, moyskladId: multiCompanyContactTargetA, moyskladType: 'contactperson', moyskladParentId: multiCompanyTargetA, active: true, source: 'TEST',
  } });
  const contactB = await database.entityPair.create({ data: {
    entityType: 'CONTACT', bitrix24Id: multiCompanyContactId, moyskladId: multiCompanyContactTargetB, moyskladType: 'contactperson', moyskladParentId: multiCompanyTargetB, active: true, source: 'TEST',
  } });
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  await database.inboundEvent.create({ data: {
    id: multiCompanyEventId, source: 'BITRIX24', deliveryKey: multiCompanyEventId, eventType: 'ONCRMDEALADD',
    externalEntityId: `deal-${suffix}`, externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(multiCompanyEventId);
  const gateway: ClientSyncGateway = {
    async readBitrix(entity, id) {
      if (entity === 'COMPANY') return { ID: id, TITLE: 'Current Company' };
      assert.equal(id, multiCompanyContactId);
      return { ID: id, COMPANY_ID: multiCompanyCompanyA, LAST_NAME: 'Ada', NAME: 'Example' };
    },
    async readMoysklad(type, id, parentId) {
      assert.equal(type, id === multiCompanyTargetA || id === multiCompanyTargetB ? 'counterparty' : 'contactperson');
      const parent = id === multiCompanyContactTargetA ? multiCompanyTargetA : id === multiCompanyContactTargetB ? multiCompanyTargetB : null;
      if (parent) assert.equal(parentId, parent);
      return parent
        ? { id, name: 'Ada Example', company: { meta: { href: `https://fake/entity/counterparty/${parent}` } } }
        : { id, name: 'Current Company' };
    },
    async updateBitrix() { assert.fail('document dependency lookup must not write client fields'); },
    async updateMoysklad() { assert.fail('document dependency lookup must not write client fields'); },
  };
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, gateway, new HttpClientCandidateGateway(database, async () => { assert.fail('both company-specific pairs already exist'); }));
  const first = await processor.resolveForDocument({ eventId: multiCompanyEventId, sourceSystem: 'BITRIX24', entity: 'CONTACT', sourceId: multiCompanyContactId, primaryCompanySourceId: multiCompanyCompanyA });
  const second = await processor.resolveForDocument({ eventId: multiCompanyEventId, sourceSystem: 'BITRIX24', entity: 'CONTACT', sourceId: multiCompanyContactId, primaryCompanySourceId: multiCompanyCompanyB });

  assert.equal(first.status, 'RESOLVED');
  assert.equal(second.status, 'RESOLVED');
  if (first.status === 'RESOLVED' && second.status === 'RESOLVED') {
    assert.equal(first.pair.id, contactA.id);
    assert.equal(second.pair.id, contactB.id);
  }
  assert.equal(await database.entityPair.count({ where: { entityType: 'CONTACT', bitrix24Id: multiCompanyContactId, active: true } }), 2);
  assert.equal(companyA.active, true);
  assert.equal(companyB.active, true);
});

test('optional contact retry survives independently, resumes after restart, and preserves the completed deal', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.fake/rest/';
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  const companyPair = await database.entityPair.findFirst({ where: { entityType: 'COMPANY', bitrix24Id: companyId, active: true } })
    ?? await database.entityPair.create({ data: { entityType: 'COMPANY', bitrix24Id: companyId, moyskladId: companyTarget, moyskladType: 'counterparty', active: true, source: 'TEST' } });
  const dealPair = {
    id: optionalDealPairId, entityType: 'DEAL' as const, bitrix24Id: `deal-${suffix}`, moyskladId: randomUUID(),
    status: 'CONFIRMED' as const, source: 'PERSISTED' as const,
  };
  await database.inboundEvent.create({ data: {
    id: optionalContactEventId, source: 'BITRIX24', deliveryKey: optionalContactEventId, eventType: 'ONCRMDEALADD',
    externalEntityId: dealPair.bitrix24Id, externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(optionalContactEventId);

  let rejectContactRead = true;
  let createCalls = 0;
  const contactRecord = { ID: optionalContactSourceId, COMPANY_ID: companyId, LAST_NAME: 'Retry', NAME: 'Ada', PHONE: [{ VALUE: '+79991112233', VALUE_TYPE: 'WORK' }] };
  const syncGateway: ClientSyncGateway = {
    async readBitrix(entity, id) {
      if (entity === 'COMPANY') { assert.equal(id, companyId); return { ID: id, TITLE: 'Existing Company' }; }
      assert.equal(id, optionalContactSourceId);
      if (rejectContactRead) throw new ProviderFailure('BITRIX24', 400);
      return contactRecord;
    },
    async readMoysklad(type, id, parentId) {
      if (type === 'counterparty') { assert.equal(id, companyPair.moyskladId); return { id, name: 'Existing Company' }; }
      assert.equal(type, 'contactperson'); assert.equal(id, optionalContactTargetId); assert.equal(parentId, companyPair.moyskladId);
      return { id, name: 'Ada Retry', company: { meta: { href: `https://moysklad.fake/entity/counterparty/${parentId}` } } };
    },
    async updateBitrix() { assert.fail('dependency resolution does not write client fields'); },
    async updateMoysklad() { assert.fail('dependency resolution does not write client fields'); },
  };
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input); const method = init.method ?? 'GET';
    if (url.includes('/contactpersons') && method === 'POST') {
      createCalls++;
      return Response.json({ id: optionalContactTargetId, name: 'Ada Retry' });
    }
    if (url.includes('/contactpersons') && method === 'GET') return Response.json({ rows: [], meta: { size: 0, limit: 1000, offset: 0 } });
    if (url.includes('crm.requisite.list')) return Response.json({ result: [], total: 0 });
    throw new Error(`Unexpected fake API request: ${method} ${url}`);
  };
  const resolver = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, syncGateway, new HttpClientCandidateGateway(database, fakeFetch));
  const pairFirst = new PairFirstEventProcessor(
    database,
    { resolve: async () => ({ status: 'confirmed', pair: dealPair }) } as never,
    settings,
    { ensureForConfirmedPair: async () => ({ status: 'READY', baselineId: dealPair.id }) } as never,
    undefined,
    new EventWorkerLeaseService(database),
    { read: async () => ({ mode: 'on' }) } as never,
    resolver,
    { readBitrix24DealForBaseline: async () => ({ ID: dealPair.bitrix24Id, COMPANY_ID: companyId, CONTACT_ID: optionalContactSourceId }) } as never,
  );
  const firstResult = await pairFirst.process(optionalContactEventId);
  const processedEvent = await database.inboundEvent.findUniqueOrThrow({ where: { id: optionalContactEventId } });
  assert.equal(processedEvent.status, 'SUCCEEDED', JSON.stringify({ error: processedEvent.lastErrorCategory, review: await database.manualReviewCase.findUnique({ where: { eventId: optionalContactEventId } }), logs: await database.operationalLog.findMany({ where: { referenceId: optionalContactEventId }, select: { message: true } }) }));
  assert.equal(createCalls, 0, 'the failed optional read is not mistaken for a child create');
  let retry = await database.clientDependencyRetry.findUniqueOrThrow({ where: { eventId_sourceSystem_sourceEntityId_companySourceId: {
    eventId: optionalContactEventId, sourceSystem: 'BITRIX24', sourceEntityId: optionalContactSourceId, companySourceId: companyId,
  } } });
  assert.equal(retry.status, 'PENDING');
  if (firstResult?.status === 'confirmed') {
    assert.equal(firstResult.documentClient?.company?.moyskladId, companyPair.moyskladId);
    assert.equal(firstResult.documentClient?.contact, null);
  }

  await resolver.scheduleOptionalContactRetry({ eventId: optionalContactEventId, sourceSystem: 'BITRIX24', entity: 'CONTACT', sourceId: optionalContactSourceId, primaryCompanySourceId: companyId }, 'duplicate schedule');
  await resolver.scheduleOptionalContactRetry({ eventId: optionalContactEventId, sourceSystem: 'BITRIX24', entity: 'CONTACT', sourceId: optionalContactSourceId, primaryCompanySourceId: companyId }, 'duplicate schedule');
  assert.equal(await database.clientDependencyRetry.count({ where: { eventId: optionalContactEventId } }), 1, 'the compound key makes scheduling idempotent');

  rejectContactRead = false;
  const restartedResolver = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, syncGateway, new HttpClientCandidateGateway(database, fakeFetch));
  await restartedResolver.recoverPending();
  retry = await database.clientDependencyRetry.findUniqueOrThrow({ where: { id: retry.id } });
  assert.equal(retry.status, 'SUCCEEDED', JSON.stringify({ retry, locks: await database.inboundEntityLock.findMany({}), logs: await database.operationalLog.findMany({ where: { referenceId: optionalContactEventId }, select: { message: true } }) }));
  assert.equal(retry.attempts, 1);
  assert.equal(createCalls, 1, 'the resumed worker creates the company-scoped contactperson exactly once');
  const contactPair = await database.entityPair.findFirst({ where: { entityType: 'CONTACT', bitrix24Id: optionalContactSourceId, moyskladParentId: companyPair.moyskladId, active: true } });
  assert.equal(contactPair?.moyskladId, optionalContactTargetId);
  await restartedResolver.recoverPending();
  assert.equal(createCalls, 1, 'a completed retry is not replayed on the next recovery scan');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: optionalContactEventId } })).status, 'SUCCEEDED', 'child retry never reopens the completed deal event');
  assert.ok(firstResult?.status === 'confirmed' && firstResult.documentClient?.company, 'PairFirst returns the company target even while optional contact is pending');
  assert.ok(fakeFetch, 'all provider interactions are routed through the fake provider');
});

test('no-client deal requires the configured service counterparty and returns a usable customer-order agent payload', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-token';
  const configuredEventId = serviceCounterpartyEventId;
  const missingEventId = missingServiceCounterpartyEventId;
  const configuredDealId = `service-deal-${suffix}`;
  const missingDealId = `missing-service-deal-${suffix}`;
  const dealPair = (id: string) => ({ id: `pair-${id}`, entityType: 'DEAL' as const, bitrix24Id: id, moyskladId: randomUUID(), status: 'CONFIRMED' as const, source: 'PERSISTED' as const });
  const events = [
    { id: configuredEventId, dealId: configuredDealId },
    { id: missingEventId, dealId: missingDealId },
  ];
  for (const event of events) {
    await database.inboundEvent.create({ data: {
      id: event.id, source: 'BITRIX24', deliveryKey: event.id, eventType: 'ONCRMDEALADD',
      externalEntityId: event.dealId, externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
    } });
  }
  let baselineCalls = 0;
  const configuredSettings: { eventConfig: () => Promise<{ version: number; config: { serviceCounterpartyId: string | null } }> } = { eventConfig: async () => ({ version: 1, config: { serviceCounterpartyId } }) };
  const missingSettings: typeof configuredSettings = { eventConfig: async () => ({ version: 1, config: { serviceCounterpartyId: null } }) };
  const dummySyncGateway: ClientSyncGateway = {
    async readBitrix() { assert.fail('no-client resolution does not read a client'); },
    async readMoysklad() { assert.fail('no-client resolution does not read a client'); },
    async updateBitrix() { assert.fail('no-client resolution does not write'); },
    async updateMoysklad() { assert.fail('no-client resolution does not write'); },
  };
  let providerReads = 0;
  const candidateGateway = new HttpClientCandidateGateway(database, async (input) => {
    providerReads++;
    assert.equal(String(input), `https://moysklad.fake/api/remap/1.2/entity/counterparty/${serviceCounterpartyId}`);
    return Response.json({ id: serviceCounterpartyId, meta: { type: 'counterparty' } });
  });
  const clientResolver = new ClientSyncProcessor(database, configuredSettings as never, { read: async () => ({ mode: 'on' }) } as never, dummySyncGateway, candidateGateway);
  const makeProcessor = (eventId: string, dealId: string, settings: typeof configuredSettings) => new PairFirstEventProcessor(
    database,
    { resolve: async () => ({ status: 'confirmed', pair: dealPair(dealId) }) } as never,
    settings as never,
    { ensureForConfirmedPair: async () => { baselineCalls++; return { status: 'READY', baselineId: `baseline-${eventId}` }; } } as never,
    undefined,
    new EventWorkerLeaseService(database),
    { read: async () => ({ mode: 'on' }) } as never,
    clientResolver,
    { readBitrix24DealForBaseline: async () => ({ ID: dealId }) } as never,
  );
  const missingResult = await makeProcessor(missingEventId, missingDealId, missingSettings).process(missingEventId);
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: missingEventId } })).lastErrorCategory, 'SERVICE_COUNTERPARTY_NOT_CONFIGURED');
  assert.equal(baselineCalls, 0, 'missing configuration blocks only this document before baseline/client work');
  const configuredResult = await makeProcessor(configuredEventId, configuredDealId, configuredSettings).process(configuredEventId);
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: configuredEventId } })).status, 'SUCCEEDED');
  assert.equal(baselineCalls, 1);
  assert.equal(providerReads, 1, 'the exact configured service counterparty is read from the fake provider before being returned');
  assert.ok(configuredResult?.status === 'confirmed', JSON.stringify({ configuredResult, event: await database.inboundEvent.findUnique({ where: { id: configuredEventId } }) }));
  assert.equal(configuredResult.documentClient?.company, null);
  assert.equal(configuredResult.documentClient?.contact, null);
  assert.equal(configuredResult.documentClient?.serviceCounterpartyId, serviceCounterpartyId);

  // This is the consumer contract for #54: a future customerorder writer can
  // use the returned target directly without resolving IDs or doing live writes.
  const payload = toMoySkladCustomerOrderClientFields(configuredResult.documentClient!, 'https://moysklad.fake/api/remap/1.2/');
  assert.deepEqual(payload, { agent: { meta: {
    href: `https://moysklad.fake/api/remap/1.2/entity/counterparty/${serviceCounterpartyId}`,
    type: 'counterparty', mediaType: 'application/json',
  } } });
  assert.equal(toMoySkladCustomerOrderClientFields({ company: null, contact: null, serviceCounterpartyId: null }), null);
});

test('deleted or wrong-type service counterparty is reviewed and provider outage retries without fallback', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-token';
  const settings = { eventConfig: async () => ({ version: 1, config: { serviceCounterpartyId } }) };
  type ServiceCounterpartyResponseMode = 'wrong-type' | 'deleted' | 'outage';
  let responseMode: ServiceCounterpartyResponseMode = 'wrong-type';
  const candidate = new HttpClientCandidateGateway(database, async () => {
    if (responseMode === 'deleted') return Response.json({ errors: [{ error: 'Not found' }] }, { status: 404 });
    if (responseMode === 'outage') return Response.json({ errors: [{ error: 'Unavailable' }] }, { status: 503 });
    return Response.json({ id: serviceCounterpartyId, meta: { type: 'product' } });
  });
  const unusedGateway: ClientSyncGateway = {
    async readBitrix() { assert.fail('no client data should be read'); }, async readMoysklad() { assert.fail('no client data should be read'); },
    async updateBitrix() { assert.fail('no client data should be written'); }, async updateMoysklad() { assert.fail('no client data should be written'); },
  };
  const resolver = new ClientSyncProcessor(database, settings as never, { read: async () => ({ mode: 'on' }) } as never, unusedGateway, candidate);
  const modes: ServiceCounterpartyResponseMode[] = ['wrong-type', 'deleted', 'outage'];
  for (const [index, mode] of modes.entries()) {
    responseMode = mode;
    const eventId = `service-counterparty-validation-${mode}-${suffix}`;
    const dealId = `service-validation-deal-${mode}-${suffix}`;
    await database.inboundEvent.create({ data: {
      id: eventId, source: 'BITRIX24', deliveryKey: eventId, eventType: 'ONCRMDEALADD', externalEntityId: dealId,
      externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
    } });
    const dealPair = { id: `pair-${index}-${suffix}`, entityType: 'DEAL' as const, bitrix24Id: dealId, moyskladId: randomUUID(), status: 'CONFIRMED' as const, source: 'PERSISTED' as const };
    const processor = new PairFirstEventProcessor(
      database, { resolve: async () => ({ status: 'confirmed', pair: dealPair }) } as never, settings as never,
      { ensureForConfirmedPair: async () => ({ status: 'READY', baselineId: eventId }) } as never,
      undefined, new EventWorkerLeaseService(database), { read: async () => ({ mode: 'on' }) } as never, resolver,
      { readBitrix24DealForBaseline: async () => ({ ID: dealId }) } as never,
    );
    await processor.process(eventId);
    const saved = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(saved.lastErrorCategory, mode === 'outage' ? 'SERVICE_COUNTERPARTY_VALIDATION_FAILED' : 'SERVICE_COUNTERPARTY_INVALID');
    assert.equal(saved.status, mode === 'outage' ? 'RETRYABLE_FAILURE' : 'MANUAL_REVIEW');
    await database.inboundEvent.delete({ where: { id: eventId } });
  }
});

test('document dependency uses the explicit current company when contact native company differs', async () => {
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  await database.inboundEvent.create({ data: {
    id: contactConflictEventId, source: 'BITRIX24', deliveryKey: contactConflictEventId, eventType: 'ONCRMDEALADD',
    externalEntityId: `deal-${suffix}`, externalEntityType: 'deal', payload: { event: 'ONCRMDEALADD' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(contactConflictEventId);
  const gateway: ClientSyncGateway = {
    async readBitrix(entity, id) { assert.equal(entity, 'CONTACT'); assert.equal(id, badContactId); return { ID: id, COMPANY_ID: companyId }; },
    async readMoysklad() { assert.fail('unresolved explicit company must stop before MoySklad contact lookup'); },
    async updateBitrix() { assert.fail('conflicting relationship must not write'); },
    async updateMoysklad() { assert.fail('conflicting relationship must not write'); },
  };
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, gateway, new HttpClientCandidateGateway(database, async () => { throw new Error('conflicting relationship must not search'); }));
  const result = await processor.resolveForDocument({ eventId: contactConflictEventId, sourceSystem: 'BITRIX24', entity: 'CONTACT', sourceId: badContactId, primaryCompanySourceId: `other-${suffix}` });
  assert.deepEqual(result, { status: 'REVIEW', reason: 'CLIENT_CONTACT_PRIMARY_COMPANY_UNRESOLVED' });
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
    async readBitrix(entity, id) { assert.equal(entity, 'COMPANY'); assert.equal(id, duplicateCompanyId); return { ID: id, TITLE: 'Duplicate', UF_CRM_1789126724375: 'Дубль' }; },
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

test('two ordinary client workers atomically claim one event and only one reads the persisted pair', async () => {
  const pair = await database.entityPair.findFirst({ where: { entityType: 'COMPANY', bitrix24Id: companyId, active: true } });
  assert.ok(pair, 'the inventory test provides an active persisted company pair');
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  await database.inboundEvent.create({ data: {
    id: ordinaryLeaseEventId, source: 'BITRIX24', deliveryKey: ordinaryLeaseEventId, eventType: 'ONCRMCOMPANYUPDATE',
    externalEntityId: companyId, externalEntityType: 'company', payload: { event: 'ONCRMCOMPANYUPDATE' }, status: 'RECEIVED',
  } });
  await settings.pinEvent(ordinaryLeaseEventId);

  let findArrivals = 0;
  let releaseBothFinds!: () => void;
  const bothFinds = new Promise<void>((resolve) => { releaseBothFinds = resolve; });
  const inboundDelegate = new Proxy(database.inboundEvent, {
    get(delegate, property) {
      if (property === 'findUnique') return async (args: { where?: { id?: string } }) => {
        const event = await delegate.findUnique(args as never);
        if (args.where?.id === ordinaryLeaseEventId) {
          findArrivals += 1;
          if (findArrivals === 2) releaseBothFinds();
          await bothFinds;
        }
        return event;
      };
      const value = Reflect.get(delegate, property, delegate);
      return typeof value === 'function' ? value.bind(delegate) : value;
    },
  });
  const racingDatabase = new Proxy(database, {
    get(target, property) {
      if (property === 'inboundEvent') return inboundDelegate;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let providerReads = 0;
  const gateway: ClientSyncGateway = {
    async readBitrix(entity, id) { assert.equal(entity, 'COMPANY'); assert.equal(id, companyId); providerReads += 1; return { ID: id, TITLE: 'Example Company' }; },
    async readMoysklad(type, id) { assert.equal(type, 'counterparty'); assert.equal(id, pair!.moyskladId); providerReads += 1; return { id, name: 'Example Company' }; },
    async updateBitrix() { assert.fail('initial read must not update fields'); },
    async updateMoysklad() { assert.fail('initial read must not update fields'); },
  };
  const leases = new EventWorkerLeaseService(database);
  const first = new ClientSyncProcessor(racingDatabase as never, settings, { read: async () => ({ mode: 'on' }) } as never, gateway, new HttpClientCandidateGateway(database, async () => { throw new Error('saved pair must not search'); }), leases);
  const second = new ClientSyncProcessor(racingDatabase as never, settings, { read: async () => ({ mode: 'on' }) } as never, gateway, new HttpClientCandidateGateway(database, async () => { throw new Error('saved pair must not search'); }), leases);
  const results = await Promise.all([first.process(ordinaryLeaseEventId), second.process(ordinaryLeaseEventId)]);
  assert.equal(results.filter((result) => result === 'BASELINE').length, 1);
  assert.equal(results.filter((result) => result === 'IGNORED').length, 1);
  assert.equal(providerReads, 3, 'only the event claimant performs the duplicate check and pair reads');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: ordinaryLeaseEventId } })).status, 'UNCHANGED');
});

test('ordinary events for the same persisted client serialize on the shared source lease', async () => {
  const pair = await database.entityPair.findFirst({ where: { entityType: 'COMPANY', bitrix24Id: companyId, active: true } });
  assert.ok(pair);
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  for (const id of [ordinarySourceLockEventId, ordinarySourceLockSecondEventId]) {
    await database.inboundEvent.create({ data: {
      id, source: 'BITRIX24', deliveryKey: id, eventType: 'ONCRMCOMPANYUPDATE',
      externalEntityId: companyId, externalEntityType: 'company', payload: { event: 'ONCRMCOMPANYUPDATE' }, status: 'RECEIVED',
    } });
    await settings.pinEvent(id);
  }
  let announceRead!: () => void;
  let releaseRead!: () => void;
  const enteredRead = new Promise<void>((resolve) => { announceRead = resolve; });
  const blockedRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  let firstRead = true;
  let firstProviderReads = 0;
  let secondProviderReads = 0;
  const makeGateway = (countRead: () => void): ClientSyncGateway => ({
    async readBitrix(entity, id) {
      assert.equal(entity, 'COMPANY'); assert.equal(id, companyId); countRead();
      if (firstRead) { firstRead = false; announceRead(); await blockedRead; }
      return { ID: id, TITLE: 'Example Company' };
    },
    async readMoysklad(type, id) { assert.equal(type, 'counterparty'); assert.equal(id, pair!.moyskladId); countRead(); return { id, name: 'Example Company' }; },
    async updateBitrix() { assert.fail('baseline state is unchanged'); },
    async updateMoysklad() { assert.fail('baseline state is unchanged'); },
  });
  const leases = new EventWorkerLeaseService(database);
  const first = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, makeGateway(() => { firstProviderReads += 1; }), new HttpClientCandidateGateway(database, async () => { throw new Error('saved pair must not search'); }), leases);
  const second = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, makeGateway(() => { secondProviderReads += 1; }), new HttpClientCandidateGateway(database, async () => { throw new Error('saved pair must not search'); }), leases);
  const firstRun = first.process(ordinarySourceLockEventId);
  await enteredRead;
  const secondResult = await second.process(ordinarySourceLockSecondEventId);
  releaseRead();
  const firstResult = await firstRun;
  assert.equal(firstResult, 'UNCHANGED');
  assert.equal(secondResult, 'RETRY');
  assert.ok(firstProviderReads > 0);
  assert.equal(secondProviderReads, 0, 'the busy second event must not read or write the same source pair concurrently');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: ordinarySourceLockEventId } })).status, 'SUCCEEDED');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: ordinarySourceLockSecondEventId } })).status, 'RETRYABLE_FAILURE');
});

test('paired client update cannot commit sync state or terminal status after worker lease is stolen during provider write', async () => {
  const pair = await database.entityPair.create({ data: {
    entityType: 'COMPANY', bitrix24Id: ordinaryLeaseLossSourceId, moyskladId: ordinaryLeaseLossTargetId,
    moyskladType: 'counterparty', active: true, source: 'TEST',
  } });
  await database.entityPairSyncState.create({ data: {
    pairId: pair.id, settingsVersion: 1, bitrix24Values: { TITLE: 'old' }, moyskladValues: { name: 'old' },
  } });
  await database.inboundEvent.create({ data: {
    id: ordinaryLeaseLossEventId, source: 'BITRIX24', deliveryKey: ordinaryLeaseLossEventId, eventType: 'ONCRMCOMPANYUPDATE',
    externalEntityId: ordinaryLeaseLossSourceId, externalEntityType: 'company', payload: { event: 'ONCRMCOMPANYUPDATE' }, status: 'RECEIVED',
  } });
  const settings = {
    eventConfig: async () => ({ version: 1, config: { rules: [{
      entity: 'companies', sourceField: 'TITLE', targetField: 'name',
      bitrix24ToMoysklad: { enabled: true }, moyskladToBitrix24: { enabled: false },
    }], groups: [] } }),
    transformField: (_config: unknown, _entity: string, _direction: string, _sourceField: string, source: Record<string, unknown>) => ({ value: source.TITLE }),
  };
  let targetName = 'old';
  let leaseLost = false;
  let writes = 0;
  const gateway: ClientSyncGateway = {
    async readBitrix(entity, id) { assert.equal(entity, 'COMPANY'); assert.equal(id, ordinaryLeaseLossSourceId); return { ID: id, TITLE: 'new' }; },
    async readMoysklad(type, id) { assert.equal(type, 'counterparty'); assert.equal(id, ordinaryLeaseLossTargetId); return { id, name: targetName }; },
    async updateBitrix() { assert.fail('only the configured MoySklad target field should be written'); },
    async updateMoysklad(_type, _id, _parent, values) { writes += 1; assert.deepEqual(values, { name: 'new' }); targetName = 'new'; leaseLost = true; },
  };
  const workerLease = {
    assertOwned: async () => { if (leaseLost) throw new Error('EVENT_WORKER_LEASE_LOST'); },
    assertOwnedIn: async () => { if (leaseLost) throw new Error('EVENT_WORKER_LEASE_LOST'); },
  };
  const processor = new ClientSyncProcessor(database, settings as never, { read: async () => ({ mode: 'on' }) } as never, gateway, new HttpClientCandidateGateway(database, async () => { throw new Error('saved pair must not search'); }));
  const run = (processor as unknown as { processWithLease(eventId: string, lease: typeof workerLease): Promise<string> }).processWithLease.bind(processor);
  assert.equal(await run(ordinaryLeaseLossEventId, workerLease), 'RETRY');
  assert.equal(writes, 1);
  const savedEvent = await database.inboundEvent.findUniqueOrThrow({ where: { id: ordinaryLeaseLossEventId } });
  assert.equal(savedEvent.status, 'PROCESSING', 'stale worker must not record a retry or terminal transition');
  const savedState = await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId: pair.id } });
  assert.deepEqual(savedState.bitrix24Values, { TITLE: 'old' });
  assert.deepEqual(savedState.moyskladValues, { name: 'old' });
});

test('ambiguous applied client update is read back before retry and never written twice', async () => {
  const sourceId = `ambiguous-applied-source-${suffix}`;
  const targetId = `ambiguous-applied-target-${suffix}`;
  const eventId = `ambiguous-applied-event-${suffix}`;
  const pair = await database.entityPair.create({ data: { entityType: 'COMPANY', bitrix24Id: sourceId, moyskladId: targetId, moyskladType: 'counterparty', active: true, source: 'TEST' } });
  await database.entityPairSyncState.create({ data: { pairId: pair.id, settingsVersion: 1, bitrix24Values: { TITLE: 'old' }, moyskladValues: { name: 'old' } } });
  await database.inboundEvent.create({ data: { id: eventId, source: 'BITRIX24', deliveryKey: eventId, eventType: 'ONCRMCOMPANYUPDATE', externalEntityId: sourceId, externalEntityType: 'company', payload: { event: 'ONCRMCOMPANYUPDATE' }, status: 'RECEIVED' } });
  const settings = {
    eventConfig: async () => ({ version: 1, config: { rules: [{ entity: 'companies', sourceField: 'TITLE', targetField: 'name', bitrix24ToMoysklad: { enabled: true }, moyskladToBitrix24: { enabled: false } }], groups: [] } }),
    transformField: (_config: unknown, _entity: string, _direction: string, _field: string, source: Record<string, unknown>) => ({ value: source.TITLE }),
  };
  let targetName = 'old'; let writes = 0;
  const gateway: ClientSyncGateway = {
    async readBitrix() { return { ID: sourceId, TITLE: 'new' }; },
    async readMoysklad() { return { id: targetId, name: targetName }; },
    async updateBitrix() { assert.fail('only MoySklad should be written'); },
    async updateMoysklad() { writes += 1; targetName = 'new'; throw new ProviderFailure('MOYSKLAD', null); },
  };
  const processor = new ClientSyncProcessor(database, settings as never, { read: async () => ({ mode: 'on' }) } as never, gateway, new HttpClientCandidateGateway(database, async () => { throw new Error('saved pair must not search'); }));
  assert.equal(await processor.process(eventId), 'RETRY');
  const pending = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
  assert.equal(pending.status, 'RETRYABLE_FAILURE');
  assert.equal(await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId: pair.id } }).then((state) => (state.moyskladValues as { name: string }).name), 'old');
  await database.inboundEvent.update({ where: { id: eventId }, data: { status: 'RECEIVED', retryAfter: null } });
  assert.equal(await processor.process(eventId), 'UNCHANGED');
  assert.equal(writes, 1);
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } })).status, 'SUCCEEDED');
  await database.entityPair.delete({ where: { id: pair.id } });
  await database.inboundEvent.delete({ where: { id: eventId } });
});

test('saved exact-name-and-phone company pair never receives INN while the target INN is empty', async () => {
  const sourceId = `fallback-inn-source-${suffix}`;
  const targetId = randomUUID();
  const eventId = `fallback-inn-event-${suffix}`;
  const pair = await database.entityPair.create({ data: {
    entityType: 'COMPANY', bitrix24Id: sourceId, moyskladId: targetId, moyskladType: 'counterparty',
    active: true, source: 'RUNTIME', reason: 'exact_name_and_phone Evidence: usage=0, filled=1, created=unknown, criteria=name,phone',
  } });
  await database.entityPairSyncState.create({ data: { pairId: pair.id, settingsVersion: 1, bitrix24Values: { RQ_INN: 'old' }, moyskladValues: { inn: null } } });
  await database.inboundEvent.create({ data: {
    id: eventId, source: 'BITRIX24', deliveryKey: eventId, eventType: 'ONCRMCOMPANYUPDATE',
    externalEntityId: sourceId, externalEntityType: 'company', payload: { event: 'ONCRMCOMPANYUPDATE' }, status: 'RECEIVED',
  } });
  const settings = {
    eventConfig: async () => ({ version: 1, config: { rules: [{ entity: 'companies', sourceField: 'RQ_INN', targetField: 'inn', bitrix24ToMoysklad: { enabled: true }, moyskladToBitrix24: { enabled: false } }], groups: [] } }),
    transformField: (_config: unknown, _entity: string, _direction: string, _field: string, source: Record<string, unknown>) => ({ value: source.RQ_INN }),
  };
  let writes = 0;
  const gateway: ClientSyncGateway = {
    async readBitrix(_entity, id) { assert.equal(id, sourceId); return { ID: id, RQ_INN: 'new' }; },
    async readMoysklad(_type, id) { assert.equal(id, targetId); return { id, inn: null }; },
    async updateBitrix() { assert.fail('Bitrix must not be written'); },
    async updateMoysklad() { writes++; },
  };
  const resolver = new ClientSyncProcessor(database, settings as never, { read: async () => ({ mode: 'on' }) } as never, gateway,
    new HttpClientCandidateGateway(database, async () => Response.json({ result: [], total: 0 })));
  assert.equal(await resolver.process(eventId), 'UNCHANGED');
  assert.equal(writes, 0, 'explicit inn mapping cannot populate the empty target for a name+phone fallback pair');
  assert.equal((await database.entityPair.findUniqueOrThrow({ where: { id: pair.id } })).reason?.startsWith('exact_name_and_phone'), true);
  await database.entityPair.delete({ where: { id: pair.id } });
  await database.inboundEvent.delete({ where: { id: eventId } });
});

test('ordinary Bitrix contact events fan out by saved company context with independent baselines and retry', async () => {
  const contactSource = `fanout-contact-${suffix}`;
  const contextIds = [randomUUID(), randomUUID(), randomUUID()];
  const companySources = [`fanout-company-a-${suffix}`, `fanout-company-b-${suffix}`, `fanout-company-c-${suffix}`];
  const contextNames = ['a', 'b', 'c'];
  const pairs: EntityPair[] = [];
  for (let index = 0; index < contextIds.length; index++) {
    const company = await database.entityPair.create({ data: {
      entityType: 'COMPANY', bitrix24Id: companySources[index]!, moyskladId: contextIds[index]!, moyskladType: 'counterparty', active: true, source: 'TEST',
    } });
    pairs.push(await database.entityPair.create({ data: {
      entityType: 'CONTACT', bitrix24Id: contactSource, moyskladId: `contact-target-${contextNames[index]}-${suffix}`,
      moyskladType: 'contactperson', moyskladParentId: company.moyskladId, active: true, source: 'TEST',
    } }));
  }
  await database.entityPairSyncState.create({ data: { pairId: pairs[0]!.id, settingsVersion: 1, bitrix24Values: { NAME: 'old' }, moyskladValues: { name: 'old' } } });
  await database.entityPairSyncState.create({ data: { pairId: pairs[2]!.id, settingsVersion: 1, bitrix24Values: { NAME: 'old' }, moyskladValues: { name: 'old' } } });
  const eventA = `fanout-event-a-${suffix}`;
  const eventB = `fanout-event-b-${suffix}`;
  for (const id of [eventA, eventB]) await database.inboundEvent.create({ data: {
    id, source: 'BITRIX24', deliveryKey: id, eventType: 'ONCRMCONTACTUPDATE', externalEntityId: contactSource,
    externalEntityType: 'contact', payload: { event: 'ONCRMCONTACTUPDATE' }, status: 'RECEIVED',
  } });
  let sourceName = 'new';
  let failContextCOnce = true;
  const currentTargets = new Map(pairs.map((pair, index) => [pair.moyskladId, 'old']));
  const writeCounts = new Map(pairs.map((pair) => [pair.id, 0]));
  const pairByTarget = new Map(pairs.map((pair) => [pair.moyskladId, pair]));
  const settings = {
    eventConfig: async () => ({ version: 1, config: { rules: [{ entity: 'contacts-companies', sourceField: 'NAME', targetField: 'name', bitrix24ToMoysklad: { enabled: true }, moyskladToBitrix24: { enabled: false } }], groups: [] } }),
    transformField: (_config: unknown, _entity: string, _direction: string, _field: string, source: Record<string, unknown>) => ({ value: source.NAME }),
  };
  const gateway: ClientSyncGateway = {
    async readBitrix(_entity, id) { assert.equal(id, contactSource); return { ID: id, NAME: sourceName }; },
    async readMoysklad(type, id, parentId) {
      assert.equal(type, 'contactperson');
      const pair = pairByTarget.get(id)!;
      assert.equal(parentId, pair.moyskladParentId, 'each target read uses its exact persisted parent');
      if (pair.id === pairs[2]!.id && failContextCOnce) { failContextCOnce = false; throw new ProviderFailure('MOYSKLAD', 429); }
      return { id, name: currentTargets.get(id), company: { meta: { href: `https://moysklad.fake/entity/counterparty/${parentId}`, type: 'counterparty' } } };
    },
    async updateBitrix() { assert.fail('only the saved company-context target contacts should be written'); },
    async updateMoysklad(_type, id, parentId, fields) {
      const pair = pairByTarget.get(id)!;
      assert.equal(parentId, pair.moyskladParentId);
      assert.deepEqual(fields, { name: sourceName });
      currentTargets.set(id, sourceName);
      writeCounts.set(pair.id, writeCounts.get(pair.id)! + 1);
    },
  };
  const processor = new ClientSyncProcessor(database, settings as never, { read: async () => ({ mode: 'on' }) } as never, gateway,
    new HttpClientCandidateGateway(database, async () => { throw new Error('saved contextual pairs must not search'); }));
  try {
    assert.equal(await processor.process(eventA), 'RETRY');
    assert.equal(currentTargets.get(pairs[0]!.moyskladId), 'new', 'the first context syncs despite another context failing');
    assert.equal(currentTargets.get(pairs[1]!.moyskladId), 'old', 'the context without a baseline captures one and does not write');
    assert.equal(await database.entityPairSyncState.findUnique({ where: { pairId: pairs[1]!.id } }).then((state) => (state?.moyskladValues as { name: string }).name), 'old');
    sourceName = 'newer';
    await database.inboundEvent.update({ where: { id: eventB }, data: { status: 'RECEIVED' } });
    assert.equal(await processor.process(eventB), 'SYNCED');
    assert.deepEqual([...writeCounts.values()], [2, 1, 1]);
    assert.equal(await database.entityPair.count({ where: { entityType: 'CONTACT', bitrix24Id: contactSource, active: true } }), 3, 'fanout does not deactivate or replace prior company associations');
    for (const pair of pairs) assert.equal((await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId: pair.id } }).then((state) => (state.moyskladValues as { name: string }).name)), 'newer');
  } finally {
    await database.entityPair.deleteMany({ where: { bitrix24Id: { in: [contactSource, ...companySources] } } });
    await database.inboundEvent.deleteMany({ where: { id: { in: [eventA, eventB] } } });
  }
});

test('ordinary company processor pins requisite and bank child IDs, baselines then journals mapped child writes in dry mode', async () => {
  const oldMode = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'dry';
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.fake/rest/';
  const sourceId = String(Date.now() + 3);
  const targetId = randomUUID();
  const requisiteId = String(Date.now() + 1);
  const bankDetailId = String(Date.now() + 2);
  const accountId = randomUUID();
  const pair = await database.entityPair.create({ data: { entityType: 'COMPANY', bitrix24Id: sourceId, moyskladId: targetId, moyskladType: 'counterparty', active: true, source: 'TEST' } });
  const eventIds = [`child-company-baseline-${suffix}`, `child-company-update-${suffix}`];
  for (const id of eventIds) await database.inboundEvent.create({ data: {
    id, source: 'BITRIX24', deliveryKey: id, eventType: 'ONCRMCOMPANYUPDATE', externalEntityId: sourceId,
    externalEntityType: 'company', payload: { event: 'ONCRMCOMPANYUPDATE' }, status: 'RECEIVED',
  } });
  let requisiteInn = '7700000000';
  let bankBic = '044000000';
  const binding = {
    id: 'processor-child-binding', entity: 'companies' as const, bitrix24CompanyId: sourceId, bitrix24RequisiteId: requisiteId,
    moyskladCounterpartyId: targetId, legalFields: [{ bitrix24Field: 'RQ_INN', moyskladField: 'inn' }],
    bankDetail: { bitrix24Id: bankDetailId, moyskladAccountId: accountId, fields: [{ bitrix24Field: 'RQ_BIK', moyskladField: 'bic' }] },
  };
  const settings = {
    eventConfig: async () => ({ version: 7, config: { rules: [], groups: [], childResourceBindings: [binding] } }),
    transformField: () => null,
  };
  const providerCalls: Array<{ provider: string; method: string; url: string }> = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input); const method = init.method ?? 'GET';
    providerCalls.push({ provider: url.includes('bitrix.fake') ? 'BITRIX24' : 'MOYSKLAD', method, url });
    if (url.includes('crm.requisite.list')) return Response.json({ result: [{ RQ_INN: requisiteInn }], total: 1 });
    if (url.includes('crm.requisite.get.json')) return Response.json({ result: { ID: requisiteId, ENTITY_TYPE_ID: 4, ENTITY_ID: sourceId, RQ_INN: requisiteInn } });
    if (url.includes('crm.requisite.bankdetail.get.json')) return Response.json({ result: { ID: bankDetailId, ENTITY_ID: requisiteId, RQ_BIK: bankBic } });
    if (url.includes(`/entity/counterparty/${targetId}/accounts/${accountId}`)) return Response.json({ id: accountId, bic: null });
    if (url.includes(`/entity/counterparty/${targetId}`)) return Response.json({ id: targetId, companyType: 'legal', inn: null });
    throw new Error(`Unexpected fake provider request: ${method} ${url}`);
  };
  const gateway: ClientSyncGateway = {
    async readBitrix(entity, id) { assert.equal(entity, 'COMPANY'); assert.equal(id, sourceId); return { ID: id, TITLE: 'Child test company' }; },
    async readMoysklad(type, id) { assert.equal(type, 'counterparty'); assert.equal(id, targetId); return { id, name: 'Child test company', inn: null }; },
    async updateBitrix() { assert.fail('dry child sync never calls scalar writes'); },
    async updateMoysklad() { assert.fail('dry child sync never calls scalar writes'); },
  };
  const resolver = new ClientSyncProcessor(database, settings as never, { read: async () => ({ mode: 'on' }) } as never, gateway,
    new HttpClientCandidateGateway(database, fakeFetch), undefined, new ClientChildResourceSync(fakeFetch, new DryRunWriteJournal(database)));
  try {
    assert.equal(await resolver.process(eventIds[0]!), 'BASELINE');
    let state = await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId: pair.id } });
    assert.deepEqual(state.childResourceState, {
      bitrix24: { requisite: { RQ_INN: requisiteInn }, bankDetail: { RQ_BIK: bankBic } },
      moysklad: { counterparty: { inn: null }, account: { bic: null } },
    });
    requisiteInn = '7700000001'; bankBic = '044000001';
    assert.equal(await resolver.process(eventIds[1]!), 'SYNCED');
    state = await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId: pair.id } });
    assert.equal((state.childResourceState as { bitrix24: { requisite: { RQ_INN: string } } }).bitrix24.requisite.RQ_INN, requisiteInn);
    const proposals = await database.dryRunWriteProposal.findMany({ where: { eventId: eventIds[1] }, orderBy: { entityType: 'asc' } });
    assert.equal(proposals.length, 2);
    assert.deepEqual(proposals.map((proposal) => proposal.fields).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [{ bic: bankBic }, { inn: requisiteInn }]);
    assert.ok(providerCalls.every((call) => !/\.update\.json/i.test(call.url) && (call.provider === 'BITRIX24' || call.method === 'GET')), 'the fake provider sees reads only; child updates are journaled in dry mode');
    assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: eventIds[1]! } })).status, 'SUCCEEDED');
  } finally {
    if (oldMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = oldMode;
    await database.dryRunWriteProposal.deleteMany({ where: { eventId: { in: eventIds } } });
    await database.entityPair.delete({ where: { id: pair.id } });
    await database.inboundEvent.deleteMany({ where: { id: { in: eventIds } } });
  }
});

test('processor keeps child snapshot and event retryable when APPLY writes are blocked during database recovery', async () => {
  const oldMode = process.env.SYNC_MODE;
  const oldB24Base = process.env.BITRIX24_REST_BASE_URL;
  const oldMsBase = process.env.MOYSKLAD_API_BASE_URL;
  const oldToken = process.env.MOYSKLAD_API_TOKEN;
  process.env.SYNC_MODE = 'apply';
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.fake/rest/';
  const sourceId = String(Date.now() + 11);
  const targetId = randomUUID();
  const requisiteId = String(Date.now() + 12);
  const bankDetailId = String(Date.now() + 13);
  const accountId = randomUUID();
  const eventId = `child-recovery-${suffix}`;
  const pair = await database.entityPair.create({ data: { entityType: 'COMPANY', bitrix24Id: sourceId, moyskladId: targetId, moyskladType: 'counterparty', active: true, source: 'TEST' } });
  const originalSnapshot = {
    bitrix24: { requisite: { RQ_INN: 'old-inn' }, bankDetail: { RQ_BIK: 'old-bic' } },
    moysklad: { counterparty: { inn: 'old-inn' }, account: { bic: 'old-bic' } },
  };
  await database.entityPairSyncState.create({ data: { pairId: pair.id, settingsVersion: 7, bitrix24Values: {}, moyskladValues: {}, childResourceState: originalSnapshot } });
  await database.inboundEvent.create({ data: { id: eventId, source: 'BITRIX24', deliveryKey: eventId, eventType: 'ONCRMCOMPANYUPDATE', externalEntityId: sourceId, externalEntityType: 'company', payload: { event: eventId }, status: 'RECEIVED' } });
  const binding = { id: 'recovery-child-binding', entity: 'companies' as const, bitrix24CompanyId: sourceId, bitrix24RequisiteId: requisiteId,
    moyskladCounterpartyId: targetId, legalFields: [{ bitrix24Field: 'RQ_INN', moyskladField: 'inn' }],
    bankDetail: { bitrix24Id: bankDetailId, moyskladAccountId: accountId, fields: [{ bitrix24Field: 'RQ_BIK', moyskladField: 'bic' }] } };
  const settings = { eventConfig: async () => ({ version: 7, config: { rules: [], groups: [], childResourceBindings: [binding] } }), transformField: () => null };
  const calls: Array<{ method: string; path: string }> = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input); const method = init.method ?? 'GET'; const path = new URL(url).pathname;
    calls.push({ method, path });
    if (path.endsWith('crm.requisite.get.json')) return Response.json({ result: { ID: requisiteId, ENTITY_TYPE_ID: 4, ENTITY_ID: sourceId, RQ_INN: 'new-inn' } });
    if (path.endsWith('crm.requisite.bankdetail.get.json')) return Response.json({ result: { ID: bankDetailId, ENTITY_ID: requisiteId, RQ_BIK: 'new-bic' } });
    if (path === `/api/remap/1.2/entity/counterparty/${targetId}`) return Response.json({ id: targetId, companyType: 'legal', inn: 'old-inn' });
    if (path.endsWith(`/accounts/${accountId}`)) return Response.json({ id: accountId, bic: 'old-bic' });
    throw new Error(`Unexpected fake request ${method} ${url}`);
  };
  const gateway: ClientSyncGateway = {
    async readBitrix() { return { ID: sourceId, TITLE: 'Recovery guard company' }; },
    async readMoysklad() { return { id: targetId, name: 'Recovery guard company' }; },
    async updateBitrix() { assert.fail('child writes are blocked before scalar writes'); },
    async updateMoysklad() { assert.fail('child writes are blocked before scalar writes'); },
  };
  const processor = new ClientSyncProcessor(database, settings as never, { read: async () => ({ mode: 'on' }) } as never, gateway,
    new HttpClientCandidateGateway(database, fakeFetch), undefined, new ClientChildResourceSync(fakeFetch, new DryRunWriteJournal(database)));
  setDatabaseRecoveryReady(false);
  try {
    assert.equal(await processor.process(eventId), 'RETRY');
    const savedEvent = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(savedEvent.status, 'RETRYABLE_FAILURE');
    const savedState = await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId: pair.id } });
    assert.deepEqual(savedState.childResourceState, originalSnapshot, 'blocked child write cannot advance the persisted snapshot');
    assert.equal(calls.some((call) => call.method === 'PUT' || call.path.endsWith('crm.requisite.update.json') || call.path.endsWith('crm.requisite.bankdetail.update.json')), false);
  } finally {
    setDatabaseRecoveryReady(true);
    if (oldMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = oldMode;
    if (oldB24Base === undefined) delete process.env.BITRIX24_REST_BASE_URL; else process.env.BITRIX24_REST_BASE_URL = oldB24Base;
    if (oldMsBase === undefined) delete process.env.MOYSKLAD_API_BASE_URL; else process.env.MOYSKLAD_API_BASE_URL = oldMsBase;
    if (oldToken === undefined) delete process.env.MOYSKLAD_API_TOKEN; else process.env.MOYSKLAD_API_TOKEN = oldToken;
    await database.entityPair.delete({ where: { id: pair.id } });
    await database.inboundEvent.delete({ where: { id: eventId } });
  }
});

test('client update readback mismatch stays retryable and preserves the previous sync baseline', async () => {
  const sourceId = `unapplied-source-${suffix}`;
  const targetId = `unapplied-target-${suffix}`;
  const eventId = `unapplied-event-${suffix}`;
  const pair = await database.entityPair.create({ data: { entityType: 'COMPANY', bitrix24Id: sourceId, moyskladId: targetId, moyskladType: 'counterparty', active: true, source: 'TEST' } });
  await database.entityPairSyncState.create({ data: { pairId: pair.id, settingsVersion: 1, bitrix24Values: { TITLE: 'old' }, moyskladValues: { name: 'old' } } });
  await database.inboundEvent.create({ data: { id: eventId, source: 'BITRIX24', deliveryKey: eventId, eventType: 'ONCRMCOMPANYUPDATE', externalEntityId: sourceId, externalEntityType: 'company', payload: { event: 'ONCRMCOMPANYUPDATE' }, status: 'RECEIVED' } });
  const settings = {
    eventConfig: async () => ({ version: 1, config: { rules: [{ entity: 'companies', sourceField: 'TITLE', targetField: 'name', bitrix24ToMoysklad: { enabled: true }, moyskladToBitrix24: { enabled: false } }], groups: [] } }),
    transformField: (_config: unknown, _entity: string, _direction: string, _field: string, source: Record<string, unknown>) => ({ value: source.TITLE }),
  };
  let writes = 0;
  const gateway: ClientSyncGateway = {
    async readBitrix() { return { ID: sourceId, TITLE: 'new' }; },
    async readMoysklad() { return { id: targetId, name: 'old' }; },
    async updateBitrix() { assert.fail('only MoySklad should be written'); },
    async updateMoysklad() { writes += 1; },
  };
  const processor = new ClientSyncProcessor(database, settings as never, { read: async () => ({ mode: 'on' }) } as never, gateway, new HttpClientCandidateGateway(database, async () => { throw new Error('saved pair must not search'); }));
  assert.equal(await processor.process(eventId), 'RETRY');
  assert.equal(writes, 1);
  const savedEvent = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
  assert.equal(savedEvent.status, 'RETRYABLE_FAILURE');
  const savedState = await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId: pair.id } });
  assert.deepEqual(savedState.bitrix24Values, { TITLE: 'old' });
  assert.deepEqual(savedState.moyskladValues, { name: 'old' });
  await database.entityPair.delete({ where: { id: pair.id } });
  await database.inboundEvent.delete({ where: { id: eventId } });
});
