import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HttpClientCandidateGateway } from '../src/clients/client-candidate.gateway';
import { chooseCandidate, ClientRuntimeResolver } from '../src/clients/client-runtime-resolver';

const fakeDb = {
  entityPair: {
    findFirst: async () => null,
    findMany: async () => [],
  },
} as never;

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function candidate(id: string, filledFields = 1): Record<string, unknown> {
  return { id, inn: '7700000000', name: 'Example LLC', phone: '+7 (999) 000-11-22', created: filledFields > 1 ? '2024-01-02T00:00:00.000Z' : '2024-01-01T00:00:00.000Z', ...(filledFields > 2 ? { email: 'info@example.test', address: { city: 'Moscow' } } : {}), companyType: 'legal' };
}

test('production candidate gateway returns partial usage evidence so resolver holds ambiguous rankings', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://candidate.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-candidate-token';
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/entity/counterparty')) return response({ rows: ids.map((id, i) => candidate(id, i + 2)), meta: { size: 2, limit: 1000, offset: 0 } });
    if (url.pathname.endsWith('/entity/customerorder')) {
      const filter = url.searchParams.get('filter') ?? '';
      return filter.includes(ids[0]!) ? response({ rows: [], meta: { size: 6 } }) : response({ error: 'temporary failure' }, 503);
    }
    throw new Error(`Unexpected fake API request ${url.pathname}`);
  };
  const gateway = new HttpClientCandidateGateway(fakeDb, fetcher);
  const candidates = await gateway.companyByInn('7700000000');
  assert.deepEqual(candidates.map((row) => [row.usageCount, row.usageMetricUnavailable]), [[6, false], [null, false]]);
  const result = await new ClientRuntimeResolver(gateway).resolve({ id: 'b24', entity: 'COMPANY', name: 'Example LLC', inn: '7700000000' });
  assert.deepEqual(result, { action: 'MANUAL_REVIEW', reason: 'INCOMPLETE_USAGE_METRICS', candidates: ids });
});

test('systemwide metric endpoint unavailability is explicit and permits deterministic equal-usage ranking', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://candidate.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-candidate-token';
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/entity/counterparty')) return response({ rows: [candidate('first', 1), candidate('second', 3)], meta: { size: 2, limit: 1000, offset: 0 } });
    if (url.pathname.endsWith('/entity/customerorder')) return response({ error: 'metric unavailable' }, 404);
    throw new Error(`Unexpected fake API request ${url.pathname}`);
  };
  const gateway = new HttpClientCandidateGateway(fakeDb, fetcher);
  const candidates = await gateway.companyByInn('7700000000');
  assert.ok(candidates.every((row) => row.usageCount === null && row.usageMetricUnavailable === true));
  const winner = chooseCandidate(candidates, 'exact_inn');
  assert.equal(winner?.action, 'USE_CANDIDATE');
  assert.equal(winner?.action === 'USE_CANDIDATE' && winner.evidence.usageMetricDegraded, true);
  assert.equal(winner?.action === 'USE_CANDIDATE' && winner.targetId, 'second');
});

test('runtime create sends only required identity plus explicitly configured fields to the target API', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://candidate.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-candidate-token';
  let posted: Record<string, unknown> | null = null;
  const fetcher: typeof fetch = async (_input, init) => {
    posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response({ id: '33333333-3333-4333-8333-333333333333' });
  };
  const gateway = new HttpClientCandidateGateway(fakeDb, fetcher);
  const created = await gateway.createTarget({
    entity: 'COMPANY', targetSystem: 'MOYSKLAD', targetType: 'counterparty', parentId: null,
    source: { TITLE: 'A New Company', INN: '7700000000' }, configuredFields: { notes: 'configured' },
  });
  assert.equal(created, '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(posted, { name: 'A New Company', notes: 'configured' });
});

test('temporary usage failures retry before evidence is classified as incomplete', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://candidate.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-candidate-token';
  let attempts = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/entity/counterparty')) return response({ rows: [candidate('retry-candidate')], meta: { size: 1, limit: 1000, offset: 0 } });
    if (url.pathname.endsWith('/entity/customerorder')) {
      attempts++;
      return attempts < 3 ? response({ error: 'temporary' }, 503) : response({ rows: [], meta: { size: 9 } });
    }
    throw new Error(`Unexpected fake API request ${url.pathname}`);
  };
  const [resolved] = await new HttpClientCandidateGateway(fakeDb, fetcher).companyByInn('7700000000');
  assert.equal(attempts, 3);
  assert.equal(resolved?.usageCount, 9);
  assert.equal(resolved?.usageMetricUnavailable, false);
});

test('standalone contact search excludes legal counterparties and company title fallback is character-exact', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://candidate.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-candidate-token';
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/entity/counterparty')) return response({ rows: [
      { id: 'legal', name: 'Ada Example', phone: '+7 999 111-22-33', companyType: 'legal', created: '2024-01-01' },
      { id: 'person', name: 'Ada Example', phone: '+7 999 111-22-33', companyType: 'individual', created: '2024-01-01' },
      { id: 'title-variant', name: 'Example  LLC', phone: '+7 999 111-22-33', inn: null, created: '2024-01-01' },
    ], meta: { size: 3, limit: 1000, offset: 0 } });
    if (url.pathname.endsWith('/entity/customerorder')) return response({ rows: [], meta: { size: 0 } });
    throw new Error(`Unexpected fake API request ${url.pathname}`);
  };
  const gateway = new HttpClientCandidateGateway(fakeDb, fetcher);
  const contactRows = await gateway.contactByStandaloneNamePhone('ada example', '79991112233');
  assert.deepEqual(contactRows.map((row) => row.id), ['person']);
  const companyRows = await gateway.companyByExactNameAndPhone('Example LLC', '+7 999 111-22-33');
  assert.deepEqual(companyRows, []);
});

test('company searches exclude MoySklad individual counterparties', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://candidate.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-candidate-token';
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/entity/counterparty')) return response({ rows: [
      { id: 'legal', inn: '7700000000', name: 'Example LLC', phone: '+7 999 000-11-22', companyType: 'legal', created: '2024-01-01' },
      { id: 'person', inn: '7700000000', name: 'Example LLC', phone: '+7 999 000-11-22', companyType: 'individual', created: '2024-01-01' },
    ], meta: { size: 2, limit: 1000, offset: 0 } });
    if (url.pathname.endsWith('/entity/customerorder')) return response({ rows: [], meta: { size: 0 } });
    throw new Error(`Unexpected fake API request ${url.pathname}`);
  };
  const rows = await new HttpClientCandidateGateway(fakeDb, fetcher).companyByInn('7700000000');
  assert.deepEqual(rows.map((row) => row.id), ['legal']);
});
