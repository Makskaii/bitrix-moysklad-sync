import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/database.service';
import { DryRunWriteJournal } from '../src/dry-run-write-journal';
import { ClientSyncProcessor } from '../src/clients/client-sync.processor';
import { HttpClientSyncGateway } from '../src/clients/client-sync.gateway';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { EntityPairService } from '../src/pairs/entity-pair.service';
import { ProviderFailure } from '../src/provider-failure';
import { ClientChildResourceSync } from '../src/clients/client-child-resource-sync';

const suffix = randomUUID();
const sourceId = `client-field-${suffix}`;
const targetId = randomUUID();
const companySourceId = '481';
const companyTargetId = randomUUID();
const parentId = companyTargetId;
const companyAccountId = randomUUID();
const pairId = `client-field-pair-${suffix}`;
const companyPairId = `client-field-company-pair-${suffix}`;
let baseEventId = '';
let forwardEventId = '';
let echoEventId = '';
let reverseEventId = '';
let companyBaselineEventId = '';
let companyForwardEventId = '';
let companyReverseEventId = '';
let invalidCriticalTransformEventId = '';
let missingTargetPairId = '';
let missingTargetEventId = '';
let database: DatabaseService;
let settings: FieldSettingsService;
let processor: ClientSyncProcessor;
let b24: Record<string, unknown>;
let moysklad: Record<string, unknown>;
let companyB24: Record<string, unknown>;
let companyMs: Record<string, unknown>;

function event(id: string, source: 'BITRIX24' | 'MOYSKLAD', entityId: string, entityType: string) {
  const payload = source === 'MOYSKLAD' && entityType === 'contactperson'
    ? { events: [{ meta: { href: `https://moysklad.fake/api/remap/1.2/entity/counterparty/${parentId}/contactpersons/${entityId}` } }] }
    : { event: id };
  return settings.saveAcceptedEvent({
    source, deliveryKey: id, eventType: source === 'BITRIX24' ? (entityType === 'company' ? 'ONCRMCOMPANYUPDATE' : 'ONCRMCONTACTUPDATE') : 'UPDATE',
    externalEntityId: entityId, externalEntityType: entityType, payload, directionDisabled: false,
  });
}

before(async () => {
  assert.equal(process.env.CLIENT_FIELD_SYNC_TEST_ISOLATED, '1', 'set CLIENT_FIELD_SYNC_TEST_ISOLATED=1 only for the disposable local PostgreSQL schemas');
  const parentUrl = new URL(process.env.DATABASE_URL ?? '');
  const dryUrl = new URL(process.env.DRY_DATABASE_URL ?? '');
  assert.match(parentUrl.hostname, /^(localhost|127\.0\.0\.1)$/i);
  assert.match(dryUrl.hostname, /^(localhost|127\.0\.0\.1)$/i);
  assert.match(parentUrl.searchParams.get('schema') ?? '', /client53_test/i);
  assert.match(dryUrl.searchParams.get('schema') ?? '', /dry_client53_field_sync_test/i);
  assert.notEqual(parentUrl.searchParams.get('schema'), dryUrl.searchParams.get('schema'));
  process.env.SYNC_MODE = 'dry';
  database = new DatabaseService();
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { serviceMode: 'on' }, update: { serviceMode: 'on' } });
  settings = new FieldSettingsService(database, {
    async fieldCatalogs() {
      return {
        bitrix24: ['ID', 'TITLE', 'NAME', 'SECOND_NAME', 'LAST_NAME', 'PHONE', 'EMAIL', 'UF_READONLY', 'UF_NUM_CRITICAL', 'UF_NUM_OPTIONAL'].map((code) => ({ code, type: ['PHONE', 'EMAIL'].includes(code) ? 'crm_multifield' : 'string', cardinality: ['PHONE', 'EMAIL'].includes(code) ? 'multiple' : 'single', shape: ['PHONE', 'EMAIL'].includes(code) ? 'object' : 'scalar', writable: code !== 'ID' && code !== 'UF_READONLY' })),
        moysklad: ['id', 'meta', 'name', 'phone', 'email', 'calculated', 'unmapped', 'amount', 'amountOptional'].map((code) => ({ code, type: code.startsWith('amount') ? 'number' : code === 'meta' ? 'object' : 'string', cardinality: 'single', shape: code === 'meta' ? 'object' : 'scalar', writable: !['id', 'meta', 'calculated'].includes(code) })),
      };
    },
  } as never, {} as EntityPairService);
  await settings.active();
  await database.entityPair.deleteMany({ where: { id: pairId } });
  await database.entityPair.deleteMany({ where: { id: companyPairId } });
  await database.inboundEvent.deleteMany({ where: { id: { in: [baseEventId, forwardEventId, echoEventId, reverseEventId, companyBaselineEventId, companyForwardEventId, companyReverseEventId] } } });
  await database.dryRunWriteProposal.deleteMany({ where: { entityId: { in: [sourceId, targetId] } } });

  const active = await settings.active();
  const config = {
    ...active.config,
    groups: [
      { id: 'field53-phone-join', entity: 'contacts-companies', direction: 'BITRIX24_TO_MOYSKLAD', sourceFields: ['PHONE'], targetField: 'phone', criticality: 'optional', transform: { kind: 'join-non-empty', separator: ' | ' } },
      { id: 'field53-email-join', entity: 'contacts-companies', direction: 'BITRIX24_TO_MOYSKLAD', sourceFields: ['EMAIL'], targetField: 'email', criticality: 'optional', transform: { kind: 'join-non-empty', separator: '; ' } },
      { id: 'field53-fio', entity: 'contacts-companies', direction: 'BITRIX24_TO_MOYSKLAD', sourceFields: ['LAST_NAME', 'NAME', 'SECOND_NAME'], targetField: 'name', criticality: 'optional', transform: { kind: 'join-non-empty', separator: ' ' } },
      { id: 'field53-phone-split', entity: 'contacts-companies', direction: 'MOYSKLAD_TO_BITRIX24', sourceFields: ['phone'], targetField: 'PHONE', criticality: 'optional', transform: { kind: 'split-non-empty', separator: ' | ', valueType: 'MOBILE' } },
      { id: 'field53-email-split', entity: 'contacts-companies', direction: 'MOYSKLAD_TO_BITRIX24', sourceFields: ['email'], targetField: 'EMAIL', criticality: 'optional', transform: { kind: 'split-non-empty', separator: '; ', valueType: 'WORK' } },
      { id: 'field53-company-phone-join', entity: 'companies', direction: 'BITRIX24_TO_MOYSKLAD', sourceFields: ['PHONE'], targetField: 'phone', criticality: 'optional', transform: { kind: 'join-non-empty', separator: ' | ' } },
      { id: 'field53-company-email-join', entity: 'companies', direction: 'BITRIX24_TO_MOYSKLAD', sourceFields: ['EMAIL'], targetField: 'email', criticality: 'optional', transform: { kind: 'join-non-empty', separator: '; ' } },
      { id: 'field53-company-phone-split', entity: 'companies', direction: 'MOYSKLAD_TO_BITRIX24', sourceFields: ['phone'], targetField: 'PHONE', criticality: 'optional', transform: { kind: 'split-non-empty', separator: ' | ', valueType: 'WORK' } },
      { id: 'field53-company-email-split', entity: 'companies', direction: 'MOYSKLAD_TO_BITRIX24', sourceFields: ['email'], targetField: 'EMAIL', criticality: 'optional', transform: { kind: 'split-non-empty', separator: '; ', valueType: 'WORK' } },
    ],
    rules: [{ id: 'field53-company-name', entity: 'companies', sourceField: 'TITLE', targetField: 'name', criticality: 'optional',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } },
    },
    { id: 'field53-critical-number', entity: 'companies', sourceField: 'UF_NUM_CRITICAL', targetField: 'amount', criticality: 'critical', bitrix24ToMoysklad: { enabled: true, transform: { kind: 'string-to-number', numberType: 'decimal' } }, moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' } } },
    { id: 'field53-optional-number', entity: 'companies', sourceField: 'UF_NUM_OPTIONAL', targetField: 'amountOptional', criticality: 'optional', bitrix24ToMoysklad: { enabled: true, transform: { kind: 'string-to-number', numberType: 'decimal' } }, moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' } } }],
    childResourceBindings: [{
        id: 'field53-company-legal-bank', entity: 'companies', bitrix24CompanyId: companySourceId, bitrix24RequisiteId: '482',
      moyskladCounterpartyId: companyTargetId,
      legalFields: [{ bitrix24Field: 'RQ_INN', moyskladField: 'inn' }, { bitrix24Field: 'RQ_KPP', moyskladField: 'kpp' }],
      bankDetail: { bitrix24Id: '483', moyskladAccountId: companyAccountId, fields: [
        { bitrix24Field: 'RQ_ACC_NUM', moyskladField: 'accountNumber' }, { bitrix24Field: 'RQ_BIK', moyskladField: 'bic' },
      ] },
    }],
  };
  await assert.rejects(() => settings.save({ ...config, groups: [...config.groups, {
    id: 'field53-readonly-rejected', entity: 'contacts-companies', direction: 'BITRIX24_TO_MOYSKLAD',
    sourceFields: ['PHONE'], targetField: 'calculated', criticality: 'optional', transform: { kind: 'join-non-empty', separator: '|' },
  }] }, 'synthetic-test-token'), /not available as a writable moysklad field/);
  await assert.rejects(() => settings.save({ ...config, groups: [...config.groups, {
    id: 'field53-unknown-rejected', entity: 'contacts-companies', direction: 'BITRIX24_TO_MOYSKLAD',
    sourceFields: ['PHONE'], targetField: 'not-in-catalog', criticality: 'optional', transform: { kind: 'join-non-empty', separator: '|' },
  }] }, 'synthetic-test-token'), /not available as a writable moysklad field/);
  await assert.rejects(() => settings.save({ ...config, groups: [...config.groups, {
    id: 'field53-split-wrong-way', entity: 'contacts-companies', direction: 'BITRIX24_TO_MOYSKLAD',
    sourceFields: ['phone'], targetField: 'PHONE', criticality: 'optional', transform: { kind: 'split-non-empty', separator: '|', valueType: 'MOBILE' },
  }] }, 'synthetic-test-token'), /split-non-empty must target Bitrix24/);
  await assert.rejects(() => settings.save({ ...config, groups: [...config.groups, {
    id: 'field53-invalid-value-type', entity: 'contacts-companies', direction: 'MOYSKLAD_TO_BITRIX24',
    sourceFields: ['phone'], targetField: 'PHONE', criticality: 'optional', transform: { kind: 'split-non-empty', separator: '|', valueType: 'NOT_A_TYPE' },
  }] }, 'synthetic-test-token'), /VALUE_TYPE NOT_A_TYPE is not documented/);
  await assert.rejects(() => settings.save({ ...config, childResourceBindings: [{ ...config.childResourceBindings[0], legalFields: [{ bitrix24Field: 'ID', moyskladField: 'id' }] }] }, 'synthetic-test-token'), /Unsupported or read-only requisite mapping/);
  const version = await settings.save(config, 'synthetic-test-token');
  await database.entityPair.create({ data: { id: pairId, entityType: 'CONTACT', bitrix24Id: sourceId, moyskladId: targetId, moyskladType: 'contactperson', moyskladParentId: parentId, active: true, source: 'MANUAL' } });
  await database.entityPair.create({ data: { id: companyPairId, entityType: 'COMPANY', bitrix24Id: companySourceId, moyskladId: companyTargetId, moyskladType: 'counterparty', active: true, source: 'MANUAL' } });

  b24 = { ID: sourceId, NAME: 'Ada', LAST_NAME: 'Lovelace', SECOND_NAME: '', PHONE: [{ VALUE: '+7 111', VALUE_TYPE: 'WORK' }, { VALUE: '+7 222', VALUE_TYPE: 'MOBILE' }], EMAIL: [{ VALUE: 'ada@example.test', VALUE_TYPE: 'WORK' }], UF_READONLY: 'must-not-write', UF_NUM_CRITICAL: '41', UF_NUM_OPTIONAL: '20' };
  moysklad = { id: targetId, name: 'Old Name', phone: '+7 000', email: 'old@example.test', calculated: 'server-owned', unmapped: 'leave', amount: 41, amountOptional: 7 };
  companyB24 = { ID: companySourceId, TITLE: 'Old Co', PHONE: [{ VALUE: '+7 100' }], EMAIL: [], UF_NUM_CRITICAL: '41', UF_NUM_OPTIONAL: '20' };
  companyMs = { id: companyTargetId, companyType: 'legal', name: 'Old Co', phone: '+7 000', email: 'old@example.test', inn: '2222222222', amount: 41, amountOptional: 7 };
  const journal = new DryRunWriteJournal(database);
  const gateway = new HttpClientSyncGateway(async (input, init = {}) => {
    const url = String(input);
    assert.ok(url.includes('.fake/'), `provider reads must stay in fake boundary: ${url}`);
    assert.ok(url.includes('.get') || (init.method ?? 'GET').toUpperCase() === 'GET', 'dry processing may only call read endpoints');
    if (url.includes('crm.contact.get')) return Response.json({ result: b24 });
    if (url.includes('crm.company.get')) return Response.json({ result: companyB24 });
    if (url.includes('/contactpersons/')) return Response.json(moysklad);
    if (url.includes(`/counterparty/${companyTargetId}`)) return Response.json(companyMs);
    throw new Error(`Unexpected fake provider read ${url}`);
  }, journal);
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.fake/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-token';
  const childAdapter = new ClientChildResourceSync(async (input, init = {}) => {
    const url = String(input);
    if (url.includes('crm.requisite.get.json')) return Response.json({ result: { ID: '482', ENTITY_TYPE_ID: 4, ENTITY_ID: companySourceId, RQ_INN: '1234567890', RQ_KPP: '123456789' } });
    if (url.includes('crm.requisite.bankdetail.get.json')) return Response.json({ result: { ID: '483', ENTITY_ID: '482', RQ_ACC_NUM: '40700000000000000000', RQ_BIK: '044000001' } });
    if (url.includes(`/counterparty/${companyTargetId}/accounts/${companyAccountId}`)) return Response.json({ id: companyAccountId, accountNumber: '40700000000000000000', bic: '044000001' });
    if (url.includes(`/counterparty/${companyTargetId}`)) return Response.json({ id: companyTargetId, companyType: 'legal', meta: { type: 'counterparty' }, inn: '1234567890', kpp: '123456789' });
    throw new Error(`Unexpected fake child-resource read ${url} ${init.method ?? 'GET'}`);
  }, journal, { allowTestProviderOrigins: true });
  processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, gateway, { readCompanyInn: async () => '1111111111' } as never, undefined, childAdapter);
  const accepted = await event(`client-field-baseline-${suffix}`, 'BITRIX24', sourceId, 'contact');
  baseEventId = accepted.id;
  assert.equal((await settings.eventConfig(baseEventId)).version, version.version);
});

after(async () => {
  if (!database) return;
  await database.entityPairSyncState.deleteMany({ where: { pairId } });
  await database.entityPairBaseline.deleteMany({ where: { pairId } });
  await database.entityPair.deleteMany({ where: { id: pairId } });
  await database.entityPairSyncState.deleteMany({ where: { pairId: companyPairId } });
  await database.entityPairBaseline.deleteMany({ where: { pairId: companyPairId } });
  await database.entityPair.deleteMany({ where: { id: companyPairId } });
  await database.entityPair.deleteMany({ where: { id: missingTargetPairId } });
  await database.inboundEvent.deleteMany({ where: { id: { in: [baseEventId, forwardEventId, echoEventId, reverseEventId, companyBaselineEventId, companyForwardEventId, companyReverseEventId, missingTargetEventId, invalidCriticalTransformEventId] } } });
  await database.dryRunWriteProposal.deleteMany({ where: { entityId: { in: [sourceId, targetId] } } });
  await database.dryRunWriteProposal.deleteMany({ where: { entityId: { in: [companySourceId, companyTargetId] } } });
  await database.$disconnect();
});

test('pinned settings, baseline, bidirectional typed field transforms, journal readback, and echo reconciliation', async () => {
  const baselineResult = await processor.process(baseEventId);
  assert.equal(baselineResult, 'BASELINE', JSON.stringify(await database.operationalLog.findMany({ where: { referenceId: baseEventId }, select: { message: true } })));
  const basePin = await settings.eventConfig(baseEventId);
  assert.equal(basePin.version, (await settings.active()).version);
  assert.deepEqual(basePin.config.childResourceBindings, (await settings.active()).config.childResourceBindings, 'explicit child identities and field bindings are stored with and pinned to settings version');
  const forward = await event(`client-field-forward-${suffix}`, 'BITRIX24', sourceId, 'contact');
  forwardEventId = forward.id;
  b24 = { ...b24, NAME: 'Augusta', SECOND_NAME: 'Ada', PHONE: [{ VALUE: '+7 333' }, { VALUE: '+7 444' }], EMAIL: [], UF_NUM_CRITICAL: '42', UF_NUM_OPTIONAL: 'not a number' };
  const forwardResult = await processor.process(forwardEventId);
  assert.equal(forwardResult, 'SYNCED', JSON.stringify({ logs: await database.operationalLog.findMany({ where: { referenceId: forwardEventId }, select: { message: true } }), pinned: await settings.eventConfig(forwardEventId), state: await database.entityPairSyncState.findUnique({ where: { pairId } }) }));
  const forwardPin = await settings.eventConfig(forwardEventId);
  assert.equal(forwardPin.version, basePin.version);
  const forwardJournal = await database.dryRunWriteProposal.findMany({ where: { provider: 'MOYSKLAD', entityId: targetId }, orderBy: { createdAt: 'asc' } });
  const proposal = forwardJournal.at(-1)?.fields as Record<string, unknown>;
  assert.equal(proposal.phone, '+7 333 | +7 444');
  assert.equal(proposal.email, '', 'configured empty multifield clears the destination');
  assert.equal(proposal.name, 'Lovelace Augusta Ada');
  assert.equal('calculated' in proposal, false);
  assert.equal('unmapped' in proposal, false);
  moysklad = { ...moysklad, ...proposal };

  const echo = await event(`client-field-echo-${suffix}`, 'BITRIX24', sourceId, 'contact');
  echoEventId = echo.id;
  assert.equal(await processor.process(echoEventId), 'UNCHANGED', 'an echo after journal readback is reconciled, not re-written');
  const proposalCount = await database.dryRunWriteProposal.count({ where: { provider: 'MOYSKLAD', entityId: targetId } });
  assert.equal(proposalCount, 1);

  // Model a later real provider-side edit: remove the prior virtual MS write
  // overlay so the fake GET reflects the new source state, not stale journal data.
  await database.dryRunWriteProposal.deleteMany({ where: { provider: 'MOYSKLAD', entityId: targetId } });
  const reverse = await event(`client-field-reverse-${suffix}`, 'MOYSKLAD', targetId, 'contactperson');
  reverseEventId = reverse.id;
  moysklad = { ...moysklad, phone: '+7 555 |  | +7 666', email: 'work@example.test; personal@example.test' };
  const reverseResult = await processor.process(reverseEventId);
  assert.equal(reverseResult, 'SYNCED', JSON.stringify({ logs: await database.operationalLog.findMany({ where: { referenceId: reverseEventId }, select: { message: true } }), state: await database.entityPairSyncState.findUnique({ where: { pairId } }), pinned: await settings.eventConfig(reverseEventId) }));
  const b24Proposals = await database.dryRunWriteProposal.findMany({ where: { provider: 'BITRIX24', entityId: sourceId } });
  const bitrixProposal = b24Proposals.at(-1)?.fields as Record<string, unknown>;
  assert.deepEqual(bitrixProposal.PHONE, [{ VALUE: '+7 555', VALUE_TYPE: 'MOBILE' }, { VALUE: '+7 666', VALUE_TYPE: 'MOBILE' }]);
  assert.deepEqual(bitrixProposal.EMAIL, [{ VALUE: 'work@example.test', VALUE_TYPE: 'WORK' }, { VALUE: 'personal@example.test', VALUE_TYPE: 'WORK' }]);

  const companyBaseline = await event(`client-field-company-baseline-${suffix}`, 'BITRIX24', companySourceId, 'company');
  companyBaselineEventId = companyBaseline.id;
  const companyBaselineResult = await processor.process(companyBaselineEventId);
  assert.equal(companyBaselineResult, 'BASELINE', JSON.stringify(await database.operationalLog.findMany({ where: { referenceId: companyBaselineEventId }, select: { message: true } })));
  const mismatchLogs = await database.operationalLog.findMany({ where: { referenceId: companyBaselineEventId, message: { contains: 'INN mismatch' } }, select: { message: true } });
  assert.equal(mismatchLogs.length, 1, 'a saved-pair INN discrepancy is logged');
  assert.equal((await database.entityPair.findUniqueOrThrow({ where: { id: companyPairId } })).moyskladId, companyTargetId, 'the saved pair remains authoritative');

  const companyForward = await event(`client-field-company-forward-${suffix}`, 'BITRIX24', companySourceId, 'company');
  companyForwardEventId = companyForward.id;
  companyB24 = { ...companyB24, TITLE: 'New Co', PHONE: [{ VALUE: '+7 200' }, { VALUE: '+7 201' }], EMAIL: [{ VALUE: 'new@company.test' }], UF_NUM_CRITICAL: '42', UF_NUM_OPTIONAL: 'not a number' };
  assert.equal(await processor.process(companyForwardEventId), 'SYNCED');
  const companyProposal = (await database.dryRunWriteProposal.findFirstOrThrow({ where: { provider: 'MOYSKLAD', entityId: companyTargetId } })).fields as Record<string, unknown>;
  assert.equal(companyProposal.name, 'New Co');
  assert.equal(companyProposal.amount, 42, 'critical numeric field is converted using the shared transform');
  assert.equal('amountOptional' in companyProposal, false, 'invalid optional conversion does not write null or an empty value');
  assert.equal(companyMs.amountOptional, 7, 'invalid optional conversion preserves the current target');
  assert.equal(companyProposal.phone, '+7 200 | +7 201');
  assert.equal(companyProposal.email, 'new@company.test');
  assert.equal('inn' in companyProposal, false, 'mismatching INN is not inferred as a configured field');
  companyMs = { ...companyMs, ...companyProposal };

  await database.dryRunWriteProposal.deleteMany({ where: { provider: 'MOYSKLAD', entityId: companyTargetId } });
  companyMs = { ...companyMs, name: 'Reverse Co', phone: '+7 300 | +7 301', email: 'first@company.test; second@company.test' };
  const companyReverse = await event(`client-field-company-reverse-${suffix}`, 'MOYSKLAD', companyTargetId, 'counterparty');
  companyReverseEventId = companyReverse.id;
  assert.equal(await processor.process(companyReverseEventId), 'SYNCED');
  const companyB24Proposal = (await database.dryRunWriteProposal.findFirstOrThrow({ where: { provider: 'BITRIX24', entityId: companySourceId } })).fields as Record<string, unknown>;
  assert.equal(companyB24Proposal.TITLE, 'Reverse Co');
  assert.deepEqual(companyB24Proposal.PHONE, [{ VALUE: '+7 300', VALUE_TYPE: 'WORK' }, { VALUE: '+7 301', VALUE_TYPE: 'WORK' }]);
  assert.deepEqual(companyB24Proposal.EMAIL, [{ VALUE: 'first@company.test', VALUE_TYPE: 'WORK' }, { VALUE: 'second@company.test', VALUE_TYPE: 'WORK' }]);
  assert.equal((await database.entityPair.findUniqueOrThrow({ where: { id: companyPairId } })).moyskladId, companyTargetId);

  companyB24 = { ...companyB24, UF_NUM_CRITICAL: 'not a number' };
  const invalidCriticalTransform = await event(`client-field-invalid-critical-${suffix}`, 'BITRIX24', companySourceId, 'company');
  invalidCriticalTransformEventId = invalidCriticalTransform.id;
  const proposalsBeforeInvalidCritical = await database.dryRunWriteProposal.count({ where: { provider: 'MOYSKLAD', entityId: companyTargetId } });
  const invalidCriticalResult = await processor.process(invalidCriticalTransformEventId);
  assert.equal(invalidCriticalResult, 'REVIEW', JSON.stringify({ result: invalidCriticalResult, event: await database.inboundEvent.findUnique({ where: { id: invalidCriticalTransformEventId } }) }));
  assert.equal(await database.dryRunWriteProposal.count({ where: { provider: 'MOYSKLAD', entityId: companyTargetId } }), proposalsBeforeInvalidCritical);
});

test('missing saved target remains paired and fails safe without candidate search or replacement creation', async () => {
  const source = `missing-target-source-${suffix}`;
  const target = randomUUID();
  missingTargetPairId = `missing-target-pair-${suffix}`;
  const pair = await database.entityPair.create({ data: {
    id: missingTargetPairId, entityType: 'COMPANY', bitrix24Id: source, moyskladId: target,
    moyskladType: 'counterparty', active: true, source: 'MANUAL',
  } });
  const accepted = await event(`missing-target-event-${suffix}`, 'BITRIX24', source, 'company');
  missingTargetEventId = accepted.id;
  const missingTargetProcessor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, {
    async readBitrix() { return { ID: source, TITLE: 'Company' }; },
    async readMoysklad() { throw new ProviderFailure('MOYSKLAD', 404); },
    async updateBitrix() { assert.fail('a missing paired target must not write to B24'); },
    async updateMoysklad() { assert.fail('a missing paired target must not be recreated or written'); },
  }, {
    async readCompanyInn() { return null; },
    async unmarkedBitrixCompanyEquivalents() { assert.fail('saved pair must not trigger fallback candidate resolution'); },
    async createTarget() { assert.fail('saved pair must not create a replacement'); },
  } as never);
  assert.equal(await missingTargetProcessor.process(accepted.id), 'RETRY');
  assert.equal((await database.entityPair.findUniqueOrThrow({ where: { id: pair.id } })).moyskladId, target);
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: accepted.id } })).status, 'MANUAL_REVIEW');
  assert.equal(await database.entityPairSyncState.count({ where: { pairId: pair.id } }), 0, 'failed target read must not establish a partial baseline');
});
