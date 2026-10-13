import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { planInitialClientMap } from '../src/clients/client-map';
import { chooseCandidate, ClientCandidate, ClientRuntimeResolver } from '../src/clients/client-runtime-resolver';

test('primary map uses only unique UUIDs, accepts both contact target types, and preserves confirmed pairs', () => {
  const decisions = planInitialClientMap({
    inventoryComplete: true,
    sources: [
      { entity: 'COMPANY', bitrix24Id: 'c1', uuid: 'company-ms' },
      { entity: 'COMPANY', bitrix24Id: 'c2', uuid: 'duplicate' },
      { entity: 'COMPANY', bitrix24Id: 'c3', uuid: 'duplicate' },
      { entity: 'CONTACT', bitrix24Id: 'p1', uuid: 'person-ms' },
      { entity: 'CONTACT', bitrix24Id: 'p2', uuid: 'missing-ms' },
      { entity: 'CONTACT', bitrix24Id: 'p3', uuid: 'conflict-ms' },
      { entity: 'CONTACT', bitrix24Id: 'p4', uuid: null },
      { entity: 'COMPANY', bitrix24Id: 'c-old', uuid: 'changed-uuid' },
    ],
    targets: [
      { id: 'company-ms', type: 'counterparty' },
      { id: 'person-ms', type: 'contactperson' },
      { id: 'conflict-ms', type: 'counterparty' },
    ],
    activePairs: [
      { entity: 'CONTACT', bitrix24Id: 'p3', moyskladId: 'another-ms' },
      { entity: 'COMPANY', bitrix24Id: 'c-old', moyskladId: 'old-ms' },
    ],
  });

  assert.deepEqual(decisions.map((decision) => decision.status === 'UNMATCHED' ? decision.reason : `${decision.source}:${decision.moyskladId}`), [
    'UUID:company-ms', 'UUID_REPEATED', 'UUID_REPEATED', 'UUID:person-ms',
    'NO_CANDIDATE', 'EXISTING:another-ms', 'UUID_MISSING', 'EXISTING:old-ms',
  ]);
});

test('primary map leaves every new row unmatched while inventory is incomplete', () => {
  const decisions = planInitialClientMap({
    inventoryComplete: false,
    sources: [{ entity: 'COMPANY', bitrix24Id: 'c1', uuid: 'known' }],
    targets: [{ id: 'known', type: 'counterparty' }],
    activePairs: [],
  });
  assert.deepEqual(decisions, [{ status: 'UNMATCHED', entity: 'COMPANY', bitrix24Id: 'c1', reason: 'INCOMPLETE_VERIFICATION' }]);
});

function candidate(id: string, values: Partial<ClientCandidate> = {}): ClientCandidate {
  return { id, type: 'counterparty', createdAt: '2025-01-01T00:00:00.000Z', usageCount: 0, filledFields: 1, occupiedByPair: false, ...values };
}

test('candidate selection follows usage, filled fields and earliest creation date without inventing a tie-break', () => {
  assert.equal(chooseCandidate([
    candidate('more-used', { usageCount: 5, filledFields: 1 }),
    candidate('fuller', { usageCount: 4, filledFields: 9 }),
  ], 'exact_inn')?.action, 'USE_CANDIDATE');
  const winner = chooseCandidate([
    candidate('later', { createdAt: '2024-02-01T00:00:00.000Z' }),
    candidate('earlier', { createdAt: '2024-01-01T00:00:00.000Z' }),
  ], 'exact_inn');
  assert.equal(winner?.action === 'USE_CANDIDATE' ? winner.targetId : null, 'earlier');
  assert.deepEqual(chooseCandidate([
    candidate('a', { createdAt: '2024-01-01T00:00:00.000Z' }),
    candidate('b', { createdAt: '2024-01-01T00:00:00.000Z' }),
  ], 'exact_inn'), { action: 'MANUAL_REVIEW', reason: 'AMBIGUOUS_CANDIDATES', candidates: ['a', 'b'] });
});

test('partial usage metrics require manual review; occupied candidates are excluded', () => {
  assert.equal(chooseCandidate([
    candidate('occupied', { usageCount: 20, occupiedByPair: true }),
    candidate('unknown', { usageCount: null }),
    candidate('known', { usageCount: 3 }),
  ], 'exact_inn')?.action, 'MANUAL_REVIEW');
});

test('missing usage counts are only treated as systemic degradation when that condition is explicit', () => {
  assert.deepEqual(chooseCandidate([
    candidate('unknown-a', { usageCount: null }), candidate('unknown-b', { usageCount: null }),
  ], 'exact_inn'), { action: 'MANUAL_REVIEW', reason: 'INCOMPLETE_USAGE_METRICS', candidates: ['unknown-a', 'unknown-b'] });
  const degraded = chooseCandidate([
    candidate('more-filled', { usageCount: null, usageMetricUnavailable: true, filledFields: 4 }),
    candidate('less-filled', { usageCount: null, usageMetricUnavailable: true, filledFields: 2 }),
  ], 'exact_inn');
  assert.equal(degraded?.action, 'USE_CANDIDATE');
  assert.equal(degraded?.action === 'USE_CANDIDATE' && degraded.evidence.usageMetricDegraded, true);
});

test('company lookup prefers INN and never fills an empty target INN from the Bitrix24 source', async () => {
  const calls: string[] = [];
  const resolver = new ClientRuntimeResolver({
    findPair: async () => null,
    companyByInn: async () => { calls.push('inn'); return [candidate('by-inn', { inn: '123' })]; },
    companyByExactNameAndPhone: async () => { calls.push('name-phone'); return []; },
    contactByCompanyAndNamePhone: async () => [], contactByCompanyAndNameEmail: async () => [],
    contactByStandaloneNamePhone: async () => [], contactByStandaloneNameEmail: async () => [],
  });
  const result = await resolver.resolve({ id: 'b24', entity: 'COMPANY', inn: '123', name: 'Exact', phone: '555' });
  assert.equal(result.action, 'USE_CANDIDATE');
  assert.deepEqual(calls, ['inn']);
});

test('client processor support is restricted to client entity events', async () => {
  const { ClientSyncProcessor } = await import('../src/clients/client-sync.processor');
  const processor = new ClientSyncProcessor({} as never, {} as never, {} as never, undefined);
  assert.equal(processor.supports({ source: 'BITRIX24', eventType: 'ONCRMCOMPANYUPDATE', externalEntityType: 'company' }), true);
  assert.equal(processor.supports({ source: 'MOYSKLAD', eventType: 'CREATE', externalEntityType: 'contactperson' }), true);
  assert.equal(processor.supports({ source: 'MOYSKLAD', eventType: 'UPDATE', externalEntityType: 'customerorder' }), false);
  assert.equal(processor.supports({ source: 'BITRIX24', eventType: 'ONCRMCONTACTDELETE', externalEntityType: 'contact' }), false);
});

test('contact lookup normalizes FIO and phone, uses email only when phone is absent, and does not search by name alone', async () => {
  const calls: string[] = [];
  const resolver = new ClientRuntimeResolver({
    findPair: async () => null,
    companyByInn: async () => [], companyByExactNameAndPhone: async () => [],
    contactByCompanyAndNamePhone: async (_company, name, phone, email) => { calls.push(`${name}|${phone}|${email}`); return []; },
    contactByCompanyAndNameEmail: async (_company, name, email) => { calls.push(`${name}|${email}`); return []; },
    contactByStandaloneNamePhone: async (name, phone, email) => { calls.push(`${name}|${phone}|${email}`); return []; },
    contactByStandaloneNameEmail: async (name, email) => { calls.push(`${name}|${email}`); return []; },
  });
  await resolver.resolve({ id: 'p1', entity: 'CONTACT', name: '  Иванов   Иван ', phone: '+7 (999) 111-22-33', email: 'TEST@example.com' });
  assert.equal(calls[0], 'иванов иван|79991112233|test@example.com');
  calls.length = 0;
  await resolver.resolve({ id: 'p2', entity: 'CONTACT', name: 'Иванов Иван', email: 'TEST@example.com' });
  assert.equal(calls[0], 'иванов иван|test@example.com');
  calls.length = 0;
  const noKeys = await resolver.resolve({ id: 'p3', entity: 'CONTACT', name: 'Иванов Иван' });
  assert.equal(noKeys.action, 'CREATE');
  assert.equal(calls.length, 0);
});

test('contact with an unresolved primary company is not attached to a random company', async () => {
  const resolver = new ClientRuntimeResolver({
    findPair: async () => null,
    companyByInn: async () => [], companyByExactNameAndPhone: async () => [],
    contactByCompanyAndNamePhone: async () => [], contactByCompanyAndNameEmail: async () => [],
    contactByStandaloneNamePhone: async () => [], contactByStandaloneNameEmail: async () => [],
  });
  assert.deepEqual(await resolver.resolve({ id: 'p1', entity: 'CONTACT', name: 'Ivanov', phone: '123', companyId: 'c1' }), {
    action: 'MANUAL_REVIEW', reason: 'PRIMARY_COMPANY_UNRESOLVED', candidates: [],
  });
});
