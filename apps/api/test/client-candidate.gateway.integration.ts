import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HttpClientCandidateGateway } from '../src/clients/client-candidate.gateway';
import { HttpClientInventoryProvider } from '../src/clients/client-inventory.provider';
import { chooseCandidate, ClientRuntimeResolver } from '../src/clients/client-runtime-resolver';
import { ProviderFailure } from '../src/provider-failure';

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

test('production candidate gateway propagates transient usage failures for durable automatic retry', async () => {
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
  await assert.rejects(new ClientRuntimeResolver(gateway).resolve({ id: 'b24', entity: 'COMPANY', name: 'Example LLC', inn: '7700000000' }),
    (error: unknown) => error instanceof ProviderFailure && error.status === 503 && error.retryable);
});

test('usage HTTP429 preserves Retry-After and does not retry immediately or invent zero usage', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://candidate.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-candidate-token';
  let usageReads = 0;
  const before = Date.now();
  const gateway = new HttpClientCandidateGateway(fakeDb, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/entity/counterparty')) return response({ rows: [candidate('one')], meta: { size: 1 } });
    usageReads++;
    return new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
  });
  await assert.rejects(gateway.companyByInn('7700000000'), (error: unknown) => error instanceof ProviderFailure
    && error.status === 429 && error.retryable && !!error.retryAfterAt && error.retryAfterAt.getTime() >= before + 30_000);
  assert.equal(usageReads, 1);
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

test('client create failure retains safe provider status and operation without response details', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://candidate.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-candidate-token';
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ error: 'do-not-expose-this-response' }), { status: 422 });
  const gateway = new HttpClientCandidateGateway(fakeDb, fetcher);
  await assert.rejects(gateway.createTarget({
    entity: 'COMPANY', targetSystem: 'MOYSKLAD', targetType: 'counterparty', parentId: null,
    source: { TITLE: 'A New Company' }, configuredFields: { actualAddress: null },
  }), (error: unknown) => error instanceof ProviderFailure
    && error.provider === 'MOYSKLAD'
    && error.status === 422
    && error.operation === 'CLIENT_COUNTERPARTY_CREATE'
    && !error.message.includes('do-not-expose-this-response'));
});

test('subsequent durable attempt can obtain usage after temporary failures without a manual hold', async () => {
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
  const gateway = new HttpClientCandidateGateway(fakeDb, fetcher);
  await assert.rejects(gateway.companyByInn('7700000000'), ProviderFailure);
  await assert.rejects(gateway.companyByInn('7700000000'), ProviderFailure);
  const [resolved] = await gateway.companyByInn('7700000000');
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

test('initial inventory requests native company type and safe display labels', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://inventory.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-inventory-token';
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input)); requests.push(url);
    return response({ rows: [{ id: 'counterparty-id', companyType: 'individual', unexpected: 'ignored' }], meta: { size: 1, limit: 1000, offset: 0 } });
  };
  const provider = new HttpClientInventoryProvider(fetcher);
  const counterparty = await provider.counterpartyPage(0);
  const contactpersons = await provider.contactpersonPage('parent-id', 0);
  assert.equal(requests[0]?.searchParams.get('fields'), 'id,name,companyType');
  assert.equal(requests[1]?.searchParams.get('fields'), 'id,name');
  assert.deepEqual(counterparty.rows, [{ id: 'counterparty-id', parentId: null, companyType: 'individual', displayLabel: null }]);
  assert.deepEqual(contactpersons.rows, [{ id: 'counterparty-id', parentId: 'parent-id', displayLabel: null }]);
});

test('Bitrix24 company searches request and retain the duplicate marker', async () => {
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix-candidate.fake/rest/';
  const calls: Array<{ method: string; body: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const form = new URLSearchParams(String(init?.body));
    const method = url.pathname.split('/').at(-1) ?? '';
    calls.push({ method, body: String(init?.body) });
    if (method === 'crm.requisite.list') return response({ result: [{ ENTITY_ID: 'marked', RQ_INN: '7700000000' }, { ENTITY_ID: 'unmarked', RQ_INN: '7700000000' }] });
    if (method === 'crm.company.list') return response({ result: [
      { ID: 'marked', TITLE: 'Example LLC', PHONE: '+7 999 000-11-22', UF_CRM_1789126724375: 'Дубль' },
      { ID: 'unmarked', TITLE: 'Example LLC', PHONE: '+7 999 000-11-22', UF_CRM_1789126724375: '' },
    ] });
    if (method === 'crm.deal.list') return response({ result: [], total: 0 });
    throw new Error(`Unexpected fake API request ${method}`);
  };
  const gateway = new HttpClientCandidateGateway(fakeDb, fetcher);
  const byInn = await gateway.companyByInn('7700000000', 'BITRIX24');
  const exact = await gateway.companyByExactNameAndPhone('Example LLC', '+7 999 000-11-22', 'BITRIX24');
  assert.deepEqual(byInn.map((row) => [row.id, row.duplicateMarked]), [['marked', true], ['unmarked', false]]);
  assert.deepEqual(exact.map((row) => [row.id, row.duplicateMarked]), [['marked', true], ['unmarked', false]]);
  const companyRequests = calls.filter((call) => call.method === 'crm.company.list').map((call) => call.body);
  assert.ok(companyRequests.every((body) => body.includes('UF_CRM_1789126724375')));
});

test('Bitrix24 company search fails closed when the requested duplicate marker is absent', async () => {
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix-candidate.fake/rest/';
  const fetcher: typeof fetch = async (input) => {
    const method = new URL(String(input)).pathname.split('/').at(-1);
    if (method === 'crm.company.list') return response({ result: [{ ID: 'unknown-marker', TITLE: 'Example LLC', PHONE: '+7 999 000-11-22' }] });
    throw new Error(`Unexpected fake API request ${method}`);
  };
  await assert.rejects(
    new HttpClientCandidateGateway(fakeDb, fetcher).companyByExactNameAndPhone('Example LLC', '+7 999 000-11-22', 'BITRIX24'),
    /CLIENT_COMPANY_DUPLICATE_MARKER_UNVERIFIED/,
  );
});

test('linked email lookup uses parent-scoped search and still requires exact normalized email', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://candidate.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-candidate-token';
  const parent='33333333-3333-4333-8333-333333333333';
  const fetcher: typeof fetch = async input => {
    const url=new URL(String(input));
    assert.equal(url.pathname,`/api/remap/1.2/entity/counterparty/${parent}/contactpersons`);
    assert.equal(url.searchParams.get('search'),'owned@example.invalid');
    assert.equal(url.searchParams.has('filter'),false,'MS rejects nested filter=email with 412/1034');
    assert.equal(url.searchParams.get('limit'),'1000');
    return response({rows:[
      {id:'exact',name:'Different Name',email:' OWNED@EXAMPLE.INVALID ',created:'2026-01-01'},
      {id:'substring-only',email:'not-owned@example.invalid'},
      {id:'archived',email:'owned@example.invalid',archived:true},
    ],meta:{size:3}});
  };
  const rows=await new HttpClientCandidateGateway(fakeDb,fetcher).contactByEmail('owned@example.invalid',parent);
  assert.deepEqual(rows.map(row=>({id:row.id,parent:row.parentId,type:row.type})),[{id:'exact',parent,type:'contactperson'}]);
});

test('standalone email lookup retains counterparty filter and excludes legal companies', async () => {
  const fetcher: typeof fetch = async input => {
    const url=new URL(String(input));
    if(url.pathname.endsWith('/entity/customerorder'))return response({rows:[],meta:{size:0}});
    assert.ok(url.pathname.endsWith('/entity/counterparty'));
    assert.equal(url.searchParams.get('filter'),'email=owned@example.invalid');
    return response({rows:[{id:'person',companyType:'individual',email:'owned@example.invalid'},{id:'legal',companyType:'legal',email:'owned@example.invalid'}],meta:{size:2}});
  };
  assert.deepEqual((await new HttpClientCandidateGateway(fakeDb,fetcher).contactByEmail('owned@example.invalid')).map(row=>row.id),['person']);
});

test('nested email search never accepts an incomplete candidate page or an ambiguous exact email', async () => {
  const parent='33333333-3333-4333-8333-333333333333';
  const incomplete=new HttpClientCandidateGateway(fakeDb,async()=>response({rows:[{id:'first',email:'owned@example.invalid'}],meta:{size:2}}));
  await assert.rejects(incomplete.contactByEmail('owned@example.invalid',parent),/CLIENT_CANDIDATE_SEARCH_INCOMPLETE/);
  const gateway=new HttpClientCandidateGateway(fakeDb,async()=>response({rows:[{id:'first',email:'owned@example.invalid'},{id:'second',email:'owned@example.invalid'}],meta:{size:2}}));
  const result=await new ClientRuntimeResolver(gateway).resolve({id:'owned-b24',entity:'CONTACT',email:'owned@example.invalid',companyId:'owned-company'},parent);
  assert.equal(result.action,'MANUAL_REVIEW');
  assert.equal(result.reason,'AMBIGUOUS_CANDIDATES');
});

test('only nested contactperson CREATE accepts a strict single native acknowledgement array', async () => {
  const uuid='55555555-5555-4555-8555-555555555555';
  const input={entity:'CONTACT' as const,targetSystem:'MOYSKLAD' as const,targetType:'contactperson' as const,parentId:'33333333-3333-4333-8333-333333333333',source:{NAME:'Owned'},configuredFields:{email:'owned@example.invalid'}};
  assert.equal(await new HttpClientCandidateGateway(fakeDb,async()=>response([{id:uuid}])).createTarget(input),uuid);
  for(const payload of [[],[{id:uuid},{id:uuid}],[{}],[{id:'not-native-uuid'}],[{id:uuid,errors:[]}]]) {
    await assert.rejects(new HttpClientCandidateGateway(fakeDb,async()=>response(payload)).createTarget(input),/CLIENT_CREATE_RESPONSE_INVALID/);
  }
  await assert.rejects(new HttpClientCandidateGateway(fakeDb,async()=>response([{id:uuid}])).createTarget({...input,targetType:'counterparty',parentId:null}),/CLIENT_CREATE_RESPONSE_INVALID/);
});
