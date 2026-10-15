import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ClientChildResourceBindingDto } from '../src/field-settings/field-settings.dto';
import { ClientChildResourceSync, syncPinnedClientChildResources, validateChildResourceBindings } from '../src/clients/client-child-resource-sync';

const companyId = '100';
const requisiteId = '200';
const bankDetailId = '300';
const counterpartyId = randomUUID();
const accountId = randomUUID();
let server: Server;
let baseUrl: string;
let requisite: Record<string, unknown>;
let bankDetail: Record<string, unknown>;
let counterparty: Record<string, unknown>;
let account: Record<string, unknown>;
let calls: Array<{ method: string; path: string; body: string }> = [];
let accountPutReturnsUncertainOnce = false;

const binding: ClientChildResourceBindingDto = {
  id: 'manual-child-pair-1', entity: 'companies', bitrix24CompanyId: companyId, bitrix24RequisiteId: requisiteId,
  moyskladCounterpartyId: counterpartyId,
  legalFields: [
    { bitrix24Field: 'RQ_INN', moyskladField: 'inn' },
    { bitrix24Field: 'RQ_KPP', moyskladField: 'kpp' },
    { bitrix24Field: 'RQ_COMPANY_FULL_NAME', moyskladField: 'legalTitle' },
    { bitrix24Field: 'RQ_OGRN', moyskladField: 'ogrn' },
    { bitrix24Field: 'RQ_OKPO', moyskladField: 'okpo' },
  ],
  bankDetail: { bitrix24Id: bankDetailId, moyskladAccountId: accountId, fields: [
    { bitrix24Field: 'RQ_ACC_NUM', moyskladField: 'accountNumber' },
    { bitrix24Field: 'RQ_BANK_NAME', moyskladField: 'bankName' },
    { bitrix24Field: 'RQ_BIC', moyskladField: 'bic' },
    { bitrix24Field: 'RQ_BANK_ADDR', moyskladField: 'bankLocation' },
    { bitrix24Field: 'RQ_COR_ACC_NUM', moyskladField: 'correspondentAccount' },
  ] },
};

before(async () => {
  requisite = { ID: requisiteId, ENTITY_TYPE_ID: '4', ENTITY_ID: companyId, RQ_INN: '111', RQ_KPP: 'old-kpp', RQ_COMPANY_FULL_NAME: 'Old legal name', RQ_OGRN: 'old-ogrn', RQ_OKPO: 'old-okpo' };
  bankDetail = { ID: bankDetailId, ENTITY_ID: requisiteId, RQ_ACC_NUM: 'old-account', RQ_BANK_NAME: 'Old Bank', RQ_BIC: 'old-bic', RQ_BANK_ADDR: 'Old bank address', RQ_COR_ACC_NUM: 'old-correspondent' };
  counterparty = { id: counterpartyId, inn: '222', kpp: 'old-kpp', legalTitle: 'Old legal name', ogrn: 'old-ogrn', okpo: 'old-okpo' };
  account = { id: accountId, accountNumber: 'old-account', bankName: 'Old Bank', bic: 'old-bic', bankLocation: 'Old bank address', correspondentAccount: 'old-correspondent' };
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const path = request.url ?? '';
    const method = request.method ?? 'GET';
    calls.push({ method, path, body });
    response.setHeader('content-type', 'application/json');
    if (path.endsWith('/crm.requisite.get.json')) return response.end(JSON.stringify({ result: requisite }));
    if (path.endsWith('/crm.requisite.update.json')) {
      const fields = decodeBitrixFields(body); requisite = { ...requisite, ...fields };
      return response.end(JSON.stringify({ result: true }));
    }
    if (path.endsWith('/crm.requisite.bankdetail.get.json')) return response.end(JSON.stringify({ result: bankDetail }));
    if (path.endsWith('/crm.requisite.bankdetail.update.json')) {
      const fields = decodeBitrixFields(body); bankDetail = { ...bankDetail, ...fields };
      return response.end(JSON.stringify({ result: true }));
    }
    if (path === `/api/remap/1.2/entity/counterparty/${counterpartyId}` && method === 'GET') return response.end(JSON.stringify(counterparty));
    if (path === `/api/remap/1.2/entity/counterparty/${counterpartyId}` && method === 'PUT') {
      counterparty = { ...counterparty, ...JSON.parse(body) as Record<string, unknown> };
      return response.end(JSON.stringify(counterparty));
    }
    if (path === `/api/remap/1.2/entity/counterparty/${counterpartyId}/accounts/${accountId}` && method === 'GET') return response.end(JSON.stringify(account));
    if (path === `/api/remap/1.2/entity/counterparty/${counterpartyId}/accounts/${accountId}` && method === 'PUT') {
      account = { ...account, ...JSON.parse(body) as Record<string, unknown> };
      if (accountPutReturnsUncertainOnce) { accountPutReturnsUncertainOnce = false; response.statusCode = 500; return response.end(JSON.stringify({ error: 'synthetic uncertain response' })); }
      return response.end(JSON.stringify(account));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: `Unexpected fake request ${method} ${path}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.BITRIX24_REST_BASE_URL = `${baseUrl}/rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${baseUrl}/api/remap/1.2/`;
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-loopback-token';
});

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('explicit child IDs validate only documented writable requisite, bank-detail and account fields', () => {
  assert.equal(validateChildResourceBindings([binding]), null);
  assert.match(validateChildResourceBindings([{ ...binding, legalFields: [{ bitrix24Field: 'ID', moyskladField: 'id' }] }]) ?? '', /Unsupported or read-only requisite mapping/);
  assert.match(validateChildResourceBindings([{ ...binding, bankDetail: { ...binding.bankDetail!, fields: [{ bitrix24Field: 'RQ_COUNTRY_CODE_GUESS', moyskladField: 'country' }] } }]) ?? '', /Unsupported or read-only bank mapping/);
  assert.match(validateChildResourceBindings([{ ...binding, bitrix24RequisiteId: '' }]) ?? '', /explicit company, requisite, and counterparty IDs/);
});

test('missing or ambiguous explicit binding holds without any provider calls', async () => {
  process.env.SYNC_MODE = 'apply';
  calls = [];
  const adapter = new ClientChildResourceSync();
  const missing = await adapter.syncForPair({ eventId: 'missing', direction: 'BITRIX24_TO_MOYSKLAD', bindings: [], bitrix24CompanyId: companyId, moyskladCounterpartyId: counterpartyId });
  const ambiguous = await adapter.syncForPair({ eventId: 'ambiguous', direction: 'BITRIX24_TO_MOYSKLAD', bindings: [binding, { ...binding, id: 'second' }], bitrix24CompanyId: companyId, moyskladCounterpartyId: counterpartyId });
  assert.deepEqual(missing, { status: 'MANUAL_REVIEW', reason: 'CHILD_RESOURCE_BINDING_MISSING' });
  assert.deepEqual(ambiguous, { status: 'MANUAL_REVIEW', reason: 'CHILD_RESOURCE_BINDING_AMBIGUOUS' });
  assert.equal(calls.length, 0);
});

test('event-pinned settings version supplies the child binding to the extension point', async () => {
  process.env.SYNC_MODE = 'apply';
  calls = [];
  const adapter = new ClientChildResourceSync();
  let eventConfigCalls = 0;
  const pinned = await syncPinnedClientChildResources({
    adapter,
    settings: { async eventConfig(eventId) { eventConfigCalls++; assert.equal(eventId, 'pinned-child-event'); return { version: 19, config: { childResourceBindings: [binding] } }; } },
    eventId: 'pinned-child-event', direction: 'BITRIX24_TO_MOYSKLAD', bitrix24CompanyId: companyId, moyskladCounterpartyId: counterpartyId,
  });
  assert.equal(eventConfigCalls, 1);
  assert.equal(pinned.settingsVersion, 19);
  assert.equal(pinned.result.status, 'BASELINE');
  assert.equal(calls.some((call) => call.method === 'PUT'), false, 'pinned first observation remains read-only');
});

test('dry mode journals exact legal/bank proposals and performs no external writes', async () => {
  process.env.SYNC_MODE = 'dry';
  calls = [];
  const proposals: Array<Record<string, unknown>> = [];
  const adapter = new ClientChildResourceSync(fetch, { async propose(input) { proposals.push(input); return true; } });
  const baseline = await adapter.syncForPair({ eventId: 'dry-baseline', direction: 'BITRIX24_TO_MOYSKLAD', bindings: [binding], bitrix24CompanyId: companyId, moyskladCounterpartyId: counterpartyId });
  assert.equal(baseline.status, 'BASELINE', 'first observation does not journal or write legal/bank records');
  requisite = { ...requisite, RQ_INN: 'dry-inn-change' };
  bankDetail = { ...bankDetail, RQ_ACC_NUM: 'dry-account-proposal', RQ_BANK_ADDR: 'new bank address' };
  const result = await adapter.syncForPair({ eventId: 'dry-event', direction: 'BITRIX24_TO_MOYSKLAD', bindings: [binding], bitrix24CompanyId: companyId, moyskladCounterpartyId: counterpartyId, prior: baseline.state });
  assert.equal(result.status, 'JOURNALED');
  assert.equal(proposals.length, 2);
  assert.deepEqual(proposals.map((row) => row.entityType).sort(), ['MOYSKLAD_ACCOUNT', 'MOYSKLAD_COUNTERPARTY']);
  assert.deepEqual(proposals.find((row) => row.entityType === 'MOYSKLAD_COUNTERPARTY')?.fields, { inn: 'dry-inn-change' });
  assert.deepEqual(proposals.find((row) => row.entityType === 'MOYSKLAD_ACCOUNT')?.fields, { accountNumber: 'dry-account-proposal', bankLocation: 'new bank address' });
  assert.equal(calls.some((call) => call.method === 'PUT'), false);
});

test('APPLY maps requisite/bank-detail through their official update methods and MySklad account child endpoint with verified readback', async () => {
  process.env.SYNC_MODE = 'apply';
  calls = [];
  const adapter = new ClientChildResourceSync();
  const baseline = await adapter.syncForPair({ eventId: 'apply-baseline', direction: 'BITRIX24_TO_MOYSKLAD', bindings: [binding], bitrix24CompanyId: companyId, moyskladCounterpartyId: counterpartyId });
  assert.equal(baseline.status, 'BASELINE');
  requisite = { ...requisite, RQ_INN: '7712345678', RQ_KPP: '770101001', RQ_COMPANY_FULL_NAME: 'Acme Legal LLC', RQ_OGRN: 'new-ogrn', RQ_OKPO: 'new-okpo' };
  bankDetail = { ...bankDetail, RQ_ACC_NUM: '40702810900000000001', RQ_BANK_NAME: 'Test Bank', RQ_BIC: '044525001', RQ_BANK_ADDR: 'New bank address', RQ_COR_ACC_NUM: '30101810400000000225' };
  accountPutReturnsUncertainOnce = true;
  const result = await adapter.syncForPair({ eventId: 'apply-event', direction: 'BITRIX24_TO_MOYSKLAD', bindings: [binding], bitrix24CompanyId: companyId, moyskladCounterpartyId: counterpartyId, prior: baseline.state });
  assert.equal(result.status, 'SYNCED');
  assert.equal(counterparty.inn, '7712345678');
  assert.equal(counterparty.kpp, '770101001');
  assert.equal(counterparty.legalTitle, 'Acme Legal LLC');
  assert.equal(counterparty.ogrn, 'new-ogrn');
  assert.equal(counterparty.okpo, 'new-okpo');
  assert.equal(account.accountNumber, '40702810900000000001');
  assert.equal(account.bic, '044525001');
  assert.equal(account.bankLocation, 'New bank address');
  assert.ok(calls.some((call) => call.path.endsWith('/crm.requisite.get.json')));
  assert.ok(calls.some((call) => call.path.endsWith('/crm.requisite.get.json')));
  assert.ok(calls.some((call) => call.path.endsWith('/crm.requisite.bankdetail.get.json')));
  assert.equal(calls.some((call) => call.path.endsWith('/crm.requisite.update.json') || call.path.endsWith('/crm.requisite.bankdetail.update.json')), false, 'forward direction writes only to MySklad');
  assert.ok(calls.some((call) => call.method === 'PUT' && call.path.endsWith(`/accounts/${accountId}`)));
  assert.equal(calls.filter((call) => call.method === 'PUT' && call.path.endsWith(`/accounts/${accountId}`)).length, 1, 'uncertain write response is verified by readback and never blindly repeated');
  assert.ok(calls.every((call) => new URL(call.path, baseUrl).origin === baseUrl));
  const writeCount = calls.filter((call) => call.method === 'PUT').length;
  const echo = await adapter.syncForPair({ eventId: 'apply-echo', direction: 'BITRIX24_TO_MOYSKLAD', bindings: [binding], bitrix24CompanyId: companyId, moyskladCounterpartyId: counterpartyId, prior: result.state });
  assert.equal(echo.status, 'UNCHANGED');
  assert.equal(calls.filter((call) => call.method === 'PUT').length, writeCount, 'echo uses reconciled snapshot and does not repeat writes');
});

test('reverse sync retains explicit child IDs and updates correct B24 requisite/bank detail', async () => {
  process.env.SYNC_MODE = 'apply';
  calls = [];
  const adapter = new ClientChildResourceSync();
  const baseline = await adapter.syncForPair({ eventId: 'reverse-baseline', direction: 'MOYSKLAD_TO_BITRIX24', bindings: [binding], bitrix24CompanyId: companyId, moyskladCounterpartyId: counterpartyId });
  assert.equal(baseline.status, 'BASELINE');
  counterparty = { ...counterparty, inn: '9988776655', kpp: '770201002', legalTitle: 'Reverse Legal LLC' };
  account = { ...account, accountNumber: '40802810000000000002', bankName: 'Reverse Bank', bic: '044525999', bankLocation: 'Reverse bank address', correspondentAccount: '30101810900000000999' };
  const result = await adapter.syncForPair({ eventId: 'reverse-event', direction: 'MOYSKLAD_TO_BITRIX24', bindings: [binding], bitrix24CompanyId: companyId, moyskladCounterpartyId: counterpartyId, prior: baseline.state });
  assert.equal(result.status, 'SYNCED');
  assert.equal(requisite.RQ_INN, '9988776655');
  assert.equal(bankDetail.RQ_ACC_NUM, '40802810000000000002');
  assert.equal(bankDetail.RQ_BIC, '044525999');
  assert.ok(calls.some((call) => call.path.endsWith('/crm.requisite.update.json') && new URLSearchParams(call.body).get('id') === requisiteId));
  assert.ok(calls.some((call) => call.path.endsWith('/crm.requisite.bankdetail.update.json') && new URLSearchParams(call.body).get('id') === bankDetailId));
});

test('fallback with empty MySklad INN retains the legal INN exception', async () => {
  process.env.SYNC_MODE = 'apply';
  calls = [];
  counterparty = { ...counterparty, inn: '' };
  const adapter = new ClientChildResourceSync();
  const baseline = await adapter.syncForPair({ eventId: 'fallback-baseline', direction: 'BITRIX24_TO_MOYSKLAD', bindings: [binding], bitrix24CompanyId: companyId, moyskladCounterpartyId: counterpartyId });
  assert.equal(baseline.status, 'BASELINE');
  requisite = { ...requisite, RQ_INN: 'source-inn-after-fallback' };
  const result = await adapter.syncForPair({ eventId: 'fallback-event', direction: 'BITRIX24_TO_MOYSKLAD', bindings: [binding], bitrix24CompanyId: companyId, moyskladCounterpartyId: counterpartyId, fallbackMatch: 'exact_name_and_phone', prior: baseline.state });
  assert.equal(result.status, 'UNCHANGED');
  assert.equal(counterparty.inn, '', 'fallback does not copy B24 INN into an empty MySklad INN');
  assert.ok(calls.every((call) => !call.path.endsWith('/crm.requisite.update.json')));
});

function decodeBitrixFields(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const match = /^fields\[([^\]]+)\]$/.exec(key);
    if (match) result[match[1]] = value;
  }
  return result;
}
