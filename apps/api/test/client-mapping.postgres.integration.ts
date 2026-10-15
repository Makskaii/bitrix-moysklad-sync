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
import { PairFirstEventProcessor } from '../src/pairs/pair-first-event.processor';
import { EventWorkerLeaseService } from '../src/event-worker-lease.service';
import { ProviderFailure } from '../src/provider-failure';

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
const uncertainCompanyId = `uncertain-company-${suffix}`;
const pagingSourceId = `paging-source-${suffix}`;
const pagingTargetId = `paging-target-${suffix}`;
const pagingManualSourceId = `paging-manual-source-${suffix}`;
const pagingSecondTargetId = `second-${suffix}`;
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
});

after(async () => {
  if (!database) return;
  await database.entityPair.deleteMany({ where: { bitrix24Id: { in: [companyId, contactId] } } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: { in: [pagingSourceId, pagingManualSourceId] } } });
  await database.clientInventoryObject.deleteMany({ where: { externalId: { in: [pagingSourceId, pagingTargetId, pagingSecondTargetId] } } });
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
  await database.pairReviewCase.deleteMany({ where: { sourceEntityId: uncertainCompanyId } });
  await database.inboundEvent.deleteMany({ where: { id: { in: [combinedEventId, uncertainEventId, uncertainRetryEventId, concurrentOrdinaryEventId, concurrentDealEventId, leaseLossEventId, pairWorkerLeaseLossEventId] } } });
  await database.$disconnect();
});

test('contactperson inventory resumes from the persisted nested offset after interruption', async () => {
  await database.clientInventoryJob.deleteMany({ where: { id: 'client-map' } });
  const people = [
    { id: `resume-person-1-${suffix}` }, { id: `resume-person-2-${suffix}` }, { id: `resume-person-3-${suffix}` },
  ];
  const parents = [{ id: `resume-parent-1-${suffix}`, companyType: 'legal' }, { id: `resume-parent-2-${suffix}`, companyType: 'legal' }];
  let failOnce = true;
  const calls: Array<{ parentId: string; offset: number }> = [];
  const provider: ClientInventoryProvider = {
    async bitrixPage() { return { rows: [], next: null, total: 0 }; },
    async counterpartyPage(offset) {
      const rows = parents.slice(offset);
      return { rows, next: offset + rows.length < parents.length ? offset + rows.length : null, total: parents.length };
    },
    async contactpersonPage(parentId, offset) {
      calls.push({ parentId, offset });
      if (parentId === parents[0]!.id && offset === 0) return { rows: [people[0]!], next: 1, total: 2 };
      if (parentId === parents[0]!.id && offset === 1 && failOnce) { failOnce = false; throw new Error('simulated interruption'); }
      if (parentId === parents[0]!.id && offset === 1) return { rows: [people[1]!], next: null, total: 2 };
      if (parentId === parents[1]!.id && offset === 0) return { rows: [people[2]!], next: null, total: 1 };
      return { rows: [], next: null, total: 0 };
    },
  };
  const service = new ClientMappingService(database, provider);
  await service.start('synthetic-disposable-b24-token');
  let status: any;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await service.readStatus();
    if (status.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(status.status, 'failed', JSON.stringify(status));
  const checkpoint = await database.clientInventoryJob.findUnique({ where: { id: 'client-map' } });
  assert.equal(checkpoint?.moyskladContactpersonParentOffset, 0);
  assert.equal(checkpoint?.moyskladContactpersonOffset, 1);
  assert.equal(checkpoint?.moyskladContactpersonProcessed, 0);

  await service.start('synthetic-disposable-b24-token');
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await service.readStatus();
    if (status.status === 'complete' || status.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(calls.filter((call) => call.parentId === parents[0]!.id && call.offset === 0).length, 1, 'resume must continue at saved nested offset instead of repeating the parent inventory');
  assert.ok(calls.some((call) => call.parentId === parents[1]!.id && call.offset === 0), 'resume advances to the next parent after the interrupted parent completes');
  const saved = await database.clientInventoryObject.findMany({ where: { system: 'MOYSKLAD', nativeType: 'contactperson', externalId: { in: people.map((person) => person.id) } } });
  assert.equal(saved.length, 3);
  await database.clientInventoryObject.deleteMany({ where: { externalId: { in: [...people.map((person) => person.id), ...parents.map((parent) => parent.id)] } } });
  await database.clientInventoryJob.deleteMany({ where: { id: 'client-map' } });
});

test('incomplete top-level inventory fails before reconciliation and resumes from its checkpoint', async () => {
  await database.clientInventoryJob.deleteMany({ where: { id: 'client-map' } });
  await database.clientInventoryObject.deleteMany({ where: { externalId: { in: [pagingSourceId, pagingTargetId, pagingSecondTargetId] } } });
  const sourceId = pagingSourceId;
  const targetId = pagingTargetId;
  const manualSourceId = pagingManualSourceId;
  const uuid = targetId;
  const preserved = await database.entityPair.create({ data: {
    entityType: 'COMPANY', bitrix24Id: manualSourceId, moyskladId: randomUUID(), moyskladType: 'counterparty',
    active: true, source: 'MANUAL', reason: 'ADMIN_CORRECTION',
  } });
  let malformed = true;
  const provider: ClientInventoryProvider = {
    async bitrixPage(entity) { return entity === 'COMPANY'
      ? { rows: [{ id: sourceId, uuid }], next: null, total: 1 }
      : { rows: [], next: null, total: 0 }; },
    async counterpartyPage(offset) {
      if (offset === 1 && !malformed) return { rows: [{ id: pagingSecondTargetId, companyType: 'legal' }], next: null, total: 2 };
      if (offset > 0) return { rows: [], next: null, total: 2 };
      if (malformed) return { rows: [{ id: targetId, companyType: 'legal' }], next: null, total: 2 };
      return { rows: [{ id: targetId, companyType: 'legal' }, { id: pagingSecondTargetId, companyType: 'legal' }], next: null, total: 2 };
    },
    async contactpersonPage(_parentId, offset) { return { rows: [], next: null, total: offset }; },
  };
  const service = new ClientMappingService(database, provider);
  await service.start('synthetic-disposable-b24-token');
  let status: any;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await service.readStatus();
    if (status.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(status.status, 'failed', JSON.stringify(status));
  assert.equal(status.error, 'CLIENT_INVENTORY_PAGE_INVALID');
  assert.equal(status.phase, 'MOYSKLAD_COUNTERPARTIES');
  assert.equal(await database.entityPair.count({ where: { bitrix24Id: sourceId, active: true } }), 0, 'unconfirmed inventory must not create pairs');
  assert.equal((await database.entityPair.findUniqueOrThrow({ where: { id: preserved.id } })).active, true, 'manual pairs remain untouched');

  malformed = false;
  await service.start('synthetic-disposable-b24-token');
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await service.readStatus();
    if (status.status === 'complete' || status.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(status.status, 'complete', JSON.stringify(status));
  assert.equal(await database.entityPair.count({ where: { bitrix24Id: sourceId, moyskladId: targetId, active: true } }), 1, 'resume creates the unique pair exactly once');
  await database.entityPair.deleteMany({ where: { id: preserved.id } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: sourceId } });
  await database.clientInventoryObject.deleteMany({ where: { externalId: { in: [sourceId, targetId, pagingSecondTargetId] } } });
  await database.clientInventoryJob.deleteMany({ where: { id: 'client-map' } });
});

test('unmatched inventory pages all records from both systems and honors filters', async () => {
  const sourceRows = Array.from({ length: 205 }, (_, index) => ({
    system: 'BITRIX24', entityType: 'COMPANY', nativeType: 'company', externalId: `page-source-${suffix}-${String(index).padStart(3, '0')}`, status: 'UNMATCHED', reason: 'UUID_MISSING',
  }));
  const targetRows = Array.from({ length: 4 }, (_, index) => ({
    system: 'MOYSKLAD', entityType: 'CONTACT', nativeType: 'contactperson', externalId: `page-target-${suffix}-${index}`, parentId: `parent-${suffix}`, status: 'UNMATCHED', reason: 'NO_SOURCE_UUID_MATCH',
  }));
  await database.clientInventoryObject.createMany({ data: [...sourceRows, ...targetRows] });
  const service = new ClientMappingService(database, fakeApi);
  const collected: Array<{ system: string; entityType: string; externalId: string }> = [];
  let page = await service.listUnmatched();
  assert.equal(page.entries.length, 100);
  while (true) {
    collected.push(...page.entries.map((entry) => ({ system: entry.system, entityType: entry.entityType, externalId: entry.externalId })));
    if (!page.nextCursor) break;
    page = await service.listUnmatched(undefined, undefined, page.nextCursor);
  }
  assert.equal(collected.length, sourceRows.length + targetRows.length);
  assert.equal(new Set(collected.map((row) => `${row.system}:${row.entityType}:${row.externalId}`)).size, collected.length);
  assert.equal(collected.filter((row) => row.system === 'BITRIX24').length, 205);
  assert.equal(collected.filter((row) => row.system === 'MOYSKLAD').length, 4);
  const filtered = await service.listUnmatched('MOYSKLAD', 'CONTACT');
  assert.equal(filtered.entries.length, 4);
  assert.ok(filtered.entries.every((row) => row.parentId === `parent-${suffix}`));
  await database.clientInventoryObject.deleteMany({ where: { externalId: { contains: suffix } } });
});

test('manual COMPANY and CONTACT assignments update both inventory sides immediately and clear replaced targets safely', async () => {
  const pairService = new EntityPairService(database);
  const mapping = new ClientMappingService(database, fakeApi);
  const companySource = `manual-company-source-${suffix}`;
  const companyTarget = `manual-company-target-${suffix}`;
  const contactSource = `manual-contact-source-${suffix}`;
  const contactTarget = `manual-contact-target-${suffix}`;
  const replacementSource = `replace-company-source-${suffix}`;
  const replacementTarget = `replace-company-target-${suffix}`;
  const replacementNextTarget = `replace-company-next-target-${suffix}`;
  const sharedContactSource = `shared-contact-source-${suffix}`;
  const staleSource = `stale-company-source-${suffix}`;
  const staleTarget = `stale-company-target-${suffix}`;
  const staleNextTarget = `stale-company-next-target-${suffix}`;
  const rows = [
    { system: 'BITRIX24', entityType: 'COMPANY', nativeType: 'company', externalId: companySource, status: 'UNMATCHED', reason: 'UUID_MISSING' },
    { system: 'MOYSKLAD', entityType: 'COMPANY', nativeType: 'counterparty', externalId: companyTarget, companyType: 'legal', status: 'UNMATCHED', reason: 'NO_SOURCE_UUID_MATCH' },
    { system: 'BITRIX24', entityType: 'CONTACT', nativeType: 'contact', externalId: contactSource, status: 'UNMATCHED', reason: 'UUID_MISSING' },
    { system: 'MOYSKLAD', entityType: 'CONTACT', nativeType: 'contactperson', externalId: contactTarget, parentId: `parent-${suffix}`, status: 'UNMATCHED', reason: 'NO_SOURCE_UUID_MATCH' },
    { system: 'BITRIX24', entityType: 'COMPANY', nativeType: 'company', externalId: replacementSource, status: 'UNMATCHED', reason: 'UUID_MISSING' },
    { system: 'MOYSKLAD', entityType: 'COMPANY', nativeType: 'counterparty', externalId: replacementTarget, companyType: 'legal', status: 'MATCHED' },
    { system: 'MOYSKLAD', entityType: 'COMPANY', nativeType: 'counterparty', externalId: replacementNextTarget, companyType: 'legal', status: 'UNMATCHED', reason: 'NO_SOURCE_UUID_MATCH' },
    { system: 'BITRIX24', entityType: 'CONTACT', nativeType: 'contact', externalId: sharedContactSource, status: 'MATCHED' },
    { system: 'MOYSKLAD', entityType: 'CONTACT', nativeType: 'counterparty', externalId: replacementTarget, companyType: 'individual', status: 'MATCHED' },
    { system: 'BITRIX24', entityType: 'COMPANY', nativeType: 'company', externalId: staleSource, status: 'MATCHED' },
    { system: 'MOYSKLAD', entityType: 'COMPANY', nativeType: 'counterparty', externalId: staleTarget, companyType: 'legal', status: 'MATCHED' },
    { system: 'MOYSKLAD', entityType: 'COMPANY', nativeType: 'counterparty', externalId: staleNextTarget, companyType: 'legal', status: 'UNMATCHED', reason: 'NO_SOURCE_UUID_MATCH' },
  ];
  await database.clientInventoryObject.createMany({ data: rows });
  const oldPair = await database.entityPair.create({ data: {
    entityType: 'COMPANY', bitrix24Id: replacementSource, moyskladId: replacementTarget,
    moyskladType: 'counterparty', source: 'MANUAL', reason: 'existing fixture',
  } });
  const stillValidPair = await database.entityPair.create({ data: {
    entityType: 'CONTACT', bitrix24Id: sharedContactSource, moyskladId: replacementTarget,
    moyskladType: 'counterparty', source: 'MANUAL', reason: 'shared target fixture',
  } });
  const stalePair = await database.entityPair.create({ data: {
    entityType: 'COMPANY', bitrix24Id: staleSource, moyskladId: staleTarget,
    moyskladType: 'counterparty', source: 'MANUAL', reason: 'stale target fixture',
  } });
  const companyPair = await pairService.assign({ entityType: 'COMPANY', bitrix24Id: companySource, moyskladId: companyTarget, moyskladType: 'counterparty' });
  const contactPair = await pairService.assign({ entityType: 'CONTACT', bitrix24Id: contactSource, moyskladId: contactTarget, moyskladType: 'contactperson', moyskladParentId: `parent-${suffix}` });
  assert.ok(companyPair.id && contactPair.id);
  const companyRows = await database.clientInventoryObject.findMany({ where: { externalId: { in: [companySource, companyTarget] } } });
  const contactRows = await database.clientInventoryObject.findMany({ where: { externalId: { in: [contactSource, contactTarget] } } });
  assert.ok(companyRows.every((row) => row.status === 'MATCHED'));
  assert.ok(contactRows.every((row) => row.status === 'MATCHED'));
  assert.deepEqual((await mapping.listUnmatched(undefined, 'COMPANY')).entries.map((row) => row.externalId).filter((id) => [companySource, companyTarget].includes(id)), []);
  assert.deepEqual((await mapping.listUnmatched(undefined, 'CONTACT')).entries.map((row) => row.externalId).filter((id) => [contactSource, contactTarget].includes(id)), []);

  await pairService.assign({ entityType: 'COMPANY', bitrix24Id: replacementSource, moyskladId: replacementNextTarget, moyskladType: 'counterparty', replaceExisting: true });
  const [oldTargetRow, newTargetRow, retainedPair] = await Promise.all([
    database.clientInventoryObject.findFirst({ where: { system: 'MOYSKLAD', entityType: 'COMPANY', externalId: replacementTarget } }),
    database.clientInventoryObject.findFirst({ where: { system: 'MOYSKLAD', entityType: 'COMPANY', externalId: replacementNextTarget } }),
    database.entityPair.findUnique({ where: { id: stillValidPair.id } }),
  ]);
  assert.equal(oldTargetRow?.status, 'UNMATCHED');
  assert.equal(oldTargetRow?.reason, 'ADMIN_REASSIGNED');
  const otherEntityTargetRow = await database.clientInventoryObject.findFirst({ where: { system: 'MOYSKLAD', entityType: 'CONTACT', externalId: replacementTarget } });
  assert.equal(otherEntityTargetRow?.status, 'MATCHED', 'replacement must not clobber a distinct inventory row still used by a valid active pair');
  assert.equal(newTargetRow?.status, 'MATCHED');
  assert.equal(retainedPair?.active, true);
  assert.equal((await database.entityPair.findUnique({ where: { id: oldPair.id } }))?.active, false);

  await pairService.assign({ entityType: 'COMPANY', bitrix24Id: staleSource, moyskladId: staleNextTarget, moyskladType: 'counterparty', replaceExisting: true });
  const [staleTargetRow, staleSourceRow] = await Promise.all([
    database.clientInventoryObject.findFirst({ where: { system: 'MOYSKLAD', entityType: 'COMPANY', externalId: staleTarget } }),
    database.clientInventoryObject.findFirst({ where: { system: 'BITRIX24', entityType: 'COMPANY', externalId: staleSource } }),
  ]);
  assert.equal(staleTargetRow?.status, 'UNMATCHED');
  assert.equal(staleTargetRow?.reason, 'ADMIN_REASSIGNED');
  assert.equal(staleSourceRow?.status, 'MATCHED');
  assert.equal((await database.entityPair.findUnique({ where: { id: stalePair.id } }))?.active, false);

  await database.entityPair.deleteMany({ where: { id: { in: [companyPair.id, contactPair.id, oldPair.id, stillValidPair.id, stalePair.id] } } });
  await database.entityPair.deleteMany({ where: { bitrix24Id: { in: [replacementSource, staleSource] } } });
  await database.clientInventoryObject.deleteMany({ where: { externalId: { in: rows.map((row) => row.externalId) } } });
});

test('manual assignment rolls back both inventory status changes if the target update fails', async () => {
  const bitrix24Id = `rollback-company-source-${suffix}`;
  const moyskladId = `rollback-company-target-${suffix}`;
  await database.clientInventoryObject.createMany({ data: [
    { system: 'BITRIX24', entityType: 'COMPANY', nativeType: 'company', externalId: bitrix24Id, status: 'UNMATCHED', reason: 'UUID_MISSING' },
    { system: 'MOYSKLAD', entityType: 'COMPANY', nativeType: 'counterparty', externalId: moyskladId, companyType: 'legal', status: 'UNMATCHED', reason: 'NO_SOURCE_UUID_MATCH' },
  ] });
  const originalTransaction = database.$transaction.bind(database);
  let updateCalls = 0;
  (database as any).$transaction = (callback: (transaction: any) => Promise<unknown>, options?: unknown) => originalTransaction(async (transaction: any) => await callback(new Proxy(transaction, {
    get(target, property, receiver) {
      if (property !== 'clientInventoryObject') return Reflect.get(target, property, receiver);
      return new Proxy(target.clientInventoryObject, {
        get(delegate, method, delegateReceiver) {
          if (method !== 'updateMany') return Reflect.get(delegate, method, delegateReceiver);
          return async (...args: unknown[]) => {
            updateCalls++;
            if (updateCalls === 2) throw new Error('INJECTED_TARGET_STATUS_FAILURE');
            return delegate.updateMany(...args);
          };
        },
      });
    },
  })), options as never);
  try {
    await assert.rejects(() => new EntityPairService(database).assign({
      entityType: 'COMPANY', bitrix24Id, moyskladId, moyskladType: 'counterparty',
    }), /INJECTED_TARGET_STATUS_FAILURE/);
  } finally {
    (database as any).$transaction = originalTransaction;
  }
  const [sourceRow, targetRow, pairCount] = await Promise.all([
    database.clientInventoryObject.findFirst({ where: { system: 'BITRIX24', entityType: 'COMPANY', externalId: bitrix24Id } }),
    database.clientInventoryObject.findFirst({ where: { system: 'MOYSKLAD', entityType: 'COMPANY', externalId: moyskladId } }),
    database.entityPair.count({ where: { entityType: 'COMPANY', bitrix24Id, moyskladId, active: true } }),
  ]);
  assert.equal(sourceRow?.status, 'UNMATCHED');
  assert.equal(targetRow?.status, 'UNMATCHED');
  assert.equal(pairCount, 0);
  await database.clientInventoryObject.deleteMany({ where: { externalId: { in: [bitrix24Id, moyskladId] } } });
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

  const correctedTarget = `manual-company-${suffix}`;
  const corrected = await new EntityPairService(database).assign({ entityType: 'COMPANY', bitrix24Id: companyId, moyskladId: correctedTarget, moyskladType: 'counterparty', replaceExisting: true });
  await database.clientInventoryJob.update({ where: { id: 'client-map' }, data: {
    status: 'idle', phase: 'BITRIX24_COMPANIES', bitrix24CompanyStart: 0, bitrix24ContactStart: 0,
    moyskladCounterpartyOffset: 0, moyskladContactpersonParentOffset: 0, moyskladContactpersonOffset: 0,
    bitrix24CompanyProcessed: 0, bitrix24ContactProcessed: 0, moyskladCounterpartyProcessed: 0, moyskladContactpersonProcessed: 0,
    leaseOwner: null, leaseUntil: null,
  } });
  await service.start('synthetic-disposable-b24-token');
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await service.readStatus();
    if (status.status === 'complete' || status.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(status.status, 'complete', JSON.stringify(status));
  const preservedCorrection = await database.entityPair.findFirst({ where: { entityType: 'COMPANY', bitrix24Id: companyId, active: true } });
  assert.equal(preservedCorrection?.id, corrected.id);
  assert.equal(preservedCorrection?.moyskladId, correctedTarget);
  assert.equal(preservedCorrection?.source, 'MANUAL', 'a later UUID inventory pass must preserve the administrator correction');
  const staleUuidTarget = await database.clientInventoryObject.findFirst({ where: { system: 'MOYSKLAD', entityType: 'COMPANY', externalId: companyTarget } });
  assert.equal(staleUuidTarget?.status, 'UNMATCHED');
  assert.equal(staleUuidTarget?.reason, 'SOURCE_ALREADY_PAIRED');
  const originalCompanyPair = pairs.find((pair) => pair.entityType === 'COMPANY');
  assert.ok(originalCompanyPair);
  await database.entityPair.update({ where: { id: corrected.id }, data: { active: false } });
  await database.entityPair.update({ where: { id: originalCompanyPair.id }, data: { active: true } });
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
