import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, Server } from 'node:http';
import { DealOrderHeaderSyncProcessor } from '../src/deals-orders/deal-order-header-sync.processor';

const ids = {
  oldCompany: '101', b24NewCompany: '102', msWinsCompany: '103',
  oldAgent: '11111111-1111-4111-8111-111111111111', b24NewAgent: '22222222-2222-4222-8222-222222222222', msAgent: '33333333-3333-4333-8333-333333333333',
};
const priorEnv = new Map<string, string | undefined>();
let server: Server;
let base = '';
let companyId = ids.oldCompany;
let agentId = ids.oldAgent;
let writes: Array<{ method: string; path: string; fields: Record<string, unknown> }> = [];

before(async () => {
  for (const key of ['SYNC_MODE', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN']) priorEnv.set(key, process.env[key]);
  process.env.SYNC_MODE = 'apply';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-only';
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const path = new URL(request.url ?? '/', base).pathname;
    const fields: Record<string, unknown> = {};
    if (request.method === 'PUT') {
      const payload = JSON.parse(body) as { agent: { meta: { href: string } } };
      agentId = payload.agent.meta.href.split('/').at(-1)!;
      fields.agent = payload.agent;
    } else if (request.method === 'POST') {
      const form = new URLSearchParams(body);
      companyId = form.get('fields[COMPANY_ID]') ?? companyId;
      fields.COMPANY_ID = companyId;
    }
    writes.push({ method: request.method ?? 'GET', path, fields });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.method === 'POST' ? { result: true } : { success: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}/`;
  process.env.BITRIX24_REST_BASE_URL = `${base}b24/rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${base}ms/api/remap/1.2/`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [key, value] of priorEnv) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});

test('B24 company changes update the same MySklad order agent and persist confirmed readback', async () => {
  companyId = ids.b24NewCompany; agentId = ids.oldAgent; writes = [];
  const { processor, tx, state } = fixture({ b24: companyId, ms: agentId, oldB24: ids.oldCompany, oldMs: agentId, sourceMap: ids.b24NewAgent });
  const result = await (processor as any).syncCompanyClient(input(tx, { COMPANY_ID: companyId }, { agent: { id: agentId } }, state));
  assert.equal(result, 'UPDATED');
  assert.equal(agentId, ids.b24NewAgent);
  assert.deepEqual(writes.map((write) => [write.method, write.path]), [['PUT', '/ms/api/remap/1.2/entity/customerorder/order-id']]);
  assert.equal(state.saved.bitrix24Values['client:companyId'], ids.b24NewCompany);
  assert.equal(state.saved.moyskladValues['client:agentId'], ids.b24NewAgent);
});

test('MySklad agent changes update the same B24 deal company', async () => {
  companyId = ids.oldCompany; agentId = ids.msAgent; writes = [];
  const { processor, tx, state } = fixture({ b24: companyId, ms: agentId, oldB24: companyId, oldMs: ids.oldAgent, sourceMap: ids.msWinsCompany });
  const result = await (processor as any).syncCompanyClient(input(tx, { COMPANY_ID: companyId }, { agent: { id: agentId } }, state));
  assert.equal(result, 'UPDATED');
  assert.equal(companyId, ids.msWinsCompany);
  assert.deepEqual(writes.map((write) => [write.method, write.path]), [['POST', '/b24/rest/crm.deal.update.json']]);
  assert.equal(state.saved.bitrix24Values['client:companyId'], ids.msWinsCompany);
});

test('MySklad wins when both customer fields changed and never creates a replacement document', async () => {
  companyId = ids.b24NewCompany; agentId = ids.msAgent; writes = [];
  const { processor, tx, state } = fixture({ b24: companyId, ms: agentId, oldB24: ids.oldCompany, oldMs: ids.oldAgent, sourceMap: ids.msWinsCompany });
  const result = await (processor as any).syncCompanyClient(input(tx, { COMPANY_ID: companyId }, { agent: { id: agentId } }, state));
  assert.equal(result, 'UPDATED');
  assert.equal(companyId, ids.msWinsCompany);
  assert.deepEqual(writes.map((write) => write.path), ['/b24/rest/crm.deal.update.json']);
  assert.equal(writes.some((write) => /crm\.item\.add|customerorder$/.test(write.path)), false);
  assert.equal(state.saved.bitrix24Values['client:companyId'], ids.msWinsCompany);
});

function fixture(input: { b24: string | null; ms: string; oldB24: string | null; oldMs: string; sourceMap: string }) {
  const state: { saved: { bitrix24Values: Record<string, unknown>; moyskladValues: Record<string, unknown> } } = { saved: { bitrix24Values: {}, moyskladValues: {} } };
  const tx = {
    entityPair: { async findMany(args: { where: Record<string, unknown> }) { return args.where.moyskladId === input.ms ? [{ bitrix24Id: input.sourceMap }] : [{ moyskladId: input.sourceMap }]; } },
    entityPairSyncState: { async findUnique() { return null; }, async upsert(args: { create: any; update: any }) { state.saved = args.update; return state.saved; } },
  };
  const database = {
    async $transaction<T>(work: (transaction: { $queryRaw: () => Promise<Array<{ serviceMode: string }>> }) => Promise<T>) {
      return work({ async $queryRaw() { return [{ serviceMode: 'on' }]; } });
    },
  } as never;
  const reader = {
    async readBitrix24DealForBaseline() { return { ID: 'deal-id', COMPANY_ID: companyId }; },
    async readMoySkladCustomerOrderForBaseline() { return { id: 'order-id', agent: { id: agentId } }; },
  } as never;
  const mode = {
    async isDirectionEnabled() { return true; },
    async assertDealOrderExternalWriteAllowed(_direction: string, assertLease?: () => Promise<boolean>) {
      if (assertLease && !await assertLease()) throw new Error('test lease lost');
    },
    async runDealOrderExternalWrite(_direction: string, assertLease: (() => Promise<boolean>) | undefined, _pair: unknown, mutation: () => Promise<unknown>) {
      await this.assertDealOrderExternalWriteAllowed(_direction, assertLease);
      return mutation();
    },
  } as never;
  const processor = new DealOrderHeaderSyncProcessor(database, reader, mode);
  return { processor, tx, state };
}

function input(tx: unknown, b24: Record<string, unknown>, ms: Record<string, unknown>, state: unknown) {
  return {
    transaction: tx, pairId: 'pair-id', eventId: 'event-id', settingsVersion: 1,
    bitrix24DealId: 'deal-id', moyskladOrderId: 'order-id', b24, ms,
    previous: { bitrix24Values: { 'client:companyId': ids.oldCompany }, moyskladValues: { 'client:agentId': ids.oldAgent } },
    baseline: { bitrix24Values: {}, moyskladValues: {} },
  };
}
