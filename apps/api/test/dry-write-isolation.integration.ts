import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ClientRecord, HttpClientSyncGateway } from '../src/clients/client-sync.gateway';
import { HttpClientCandidateGateway } from '../src/clients/client-candidate.gateway';
import { DryRunWriteJournal } from '../src/dry-run-write-journal';
import { ProductCardHttpApi } from '../src/products/product-card-api';
import { ContactSyncProcessor } from '../src/contact-sync.service';
import { DealOrderHeaderSyncProcessor } from '../src/deals-orders/deal-order-header-sync.processor';

test('dry provider adapters record virtual writes and never call fake external HTTP', async () => {
  const previous = process.env.SYNC_MODE;
  process.env.SYNC_MODE = 'dry';
  let httpCalls = 0;
  const httpMethods: string[] = [];
  const oldFetch = globalThis.fetch;
  const previousB24 = process.env.BITRIX24_REST_BASE_URL;
  const previousMs = process.env.MOYSKLAD_API_BASE_URL;
  const previousToken = process.env.MOYSKLAD_API_TOKEN;
  process.env.BITRIX24_REST_BASE_URL = 'https://example.invalid/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://example.invalid/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-token';
  globalThis.fetch = async (_input, init) => {
    httpCalls += 1;
    httpMethods.push(init?.method ?? 'GET');
    return new Response(JSON.stringify({ id: '123e4567-e89b-12d3-a456-426614174000', updated: '2026-10-14T00:00:00Z', email: 'new@example.invalid' }), { status: 200 });
  };
  const proposals = new Map<string, { provider: string; entityType: string; entityId: string; fields: Record<string, unknown> }>();
  const journal = new DryRunWriteJournal({
    dryRunWriteProposal: {
      upsert: async ({ where, create }: { where: { id: string }; create: { provider: string; entityType: string; entityId: string; fields: Record<string, unknown> } }) => {
        proposals.set(where.id, create);
      },
      findMany: async ({ where }: { where: { provider: string; entityType: string; entityId: string } }) => [...proposals.values()]
        .filter((row) => row.provider === where.provider && row.entityType === where.entityType && row.entityId === where.entityId)
        .map((row) => ({ fields: row.fields })),
    },
  } as never);
  const fakeFetch: typeof fetch = async () => { httpCalls += 1; throw new Error('fake external HTTP should not be called'); };
  try {
    const clients = new HttpClientSyncGateway(fakeFetch, journal);
    await clients.updateBitrix('COMPANY', '42', { TITLE: 'Новая компания' }, 'event-1');
    assert.deepEqual(await journal.readback('BITRIX24', 'company', '42'), { TITLE: 'Новая компания' });

    const product = new ProductCardHttpApi(journal);
    await product.updateMoysklad('123e4567-e89b-12d3-a456-426614174000', { description: 'Тест' });
    await product.updateBitrix24('42', { name: 'Тестовый товар' });
    await product.updateBitrix24Price('51', 12.5, 'RUB');
    assert.deepEqual(await journal.readback('MOYSKLAD', 'product', '123e4567-e89b-12d3-a456-426614174000'), { description: 'Тест' });

    const candidates = new HttpClientCandidateGateway({} as never, fakeFetch, journal);
    const syntheticId = await candidates.createTarget({
      entity: 'COMPANY', targetSystem: 'MOYSKLAD', targetType: 'counterparty', parentId: null,
      source: { TITLE: 'Тестовая компания' }, configuredFields: {}, eventId: 'event-2',
    });
    assert.ok(syntheticId);
    assert.deepEqual(await journal.readback('MOYSKLAD', 'counterparty', syntheticId), { id: syntheticId, name: 'Тестовая компания' });

    const contact = new ContactSyncProcessor({} as never, {} as never, undefined, undefined, journal);
    const contactWriter = contact as unknown as {
      writeBitrixEmail: (...args: unknown[]) => Promise<void>;
      writeMoyskladEmail: (...args: unknown[]) => Promise<Record<string, unknown>>;
    };
    await contactWriter.writeBitrixEmail('event-3', '42', { id: 'email-1', valueType: 'WORK' }, 'dry@example.invalid');
    await contactWriter.writeMoyskladEmail('event-4', '123e4567-e89b-12d3-a456-426614174000', 'dry@example.invalid');
    assert.deepEqual(await journal.readback('BITRIX24', 'contact', '42'), { EMAIL: [{ ID: 'email-1', VALUE: 'dry@example.invalid', VALUE_TYPE: 'WORK' }] });

    const header = new DealOrderHeaderSyncProcessor({} as never, {} as never, {} as never, journal);
    const headerWriter = header as unknown as {
      writeMoySklad: (...args: unknown[]) => Promise<void>;
      writeBitrix24: (...args: unknown[]) => Promise<void>;
    };
    await assert.rejects(() => headerWriter.writeMoySklad(new URL('http://127.0.0.1/'), '123e4567-e89b-12d3-a456-426614174000', 'header'), /REQUIRES_APPLY_MODE/);
    await assert.rejects(() => headerWriter.writeBitrix24(new URL('http://127.0.0.1/'), '42', 'header'), /REQUIRES_APPLY_MODE/);
    assert.equal(httpMethods.some((method) => !['GET', 'HEAD'].includes(method.toUpperCase())), false);
    assert.equal(proposals.size, 7);
  } finally {
    globalThis.fetch = oldFetch;
    if (previousB24 === undefined) delete process.env.BITRIX24_REST_BASE_URL; else process.env.BITRIX24_REST_BASE_URL = previousB24;
    if (previousMs === undefined) delete process.env.MOYSKLAD_API_BASE_URL; else process.env.MOYSKLAD_API_BASE_URL = previousMs;
    if (previousToken === undefined) delete process.env.MOYSKLAD_API_TOKEN; else process.env.MOYSKLAD_API_TOKEN = previousToken;
    if (previous === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = previous;
  }
});

test('dry client gateway overlays the proposed fields on the provider readback', async () => {
  const previous = process.env.SYNC_MODE;
  const previousBase = process.env.BITRIX24_REST_BASE_URL;
  process.env.SYNC_MODE = 'dry';
  process.env.BITRIX24_REST_BASE_URL = 'https://example.invalid/rest/';
  const gateway = new HttpClientSyncGateway(async () => new Response(JSON.stringify({ result: { ID: '42', TITLE: 'Старая компания' } }), { status: 200 }), {
    propose: async () => true,
    readback: async () => ({ TITLE: 'Новая компания' }),
    createdRecord: async () => null,
  } as never);
  try {
    const row: ClientRecord = await gateway.readBitrix('COMPANY', '42');
    assert.equal(row.TITLE, 'Новая компания');
  } finally {
    if (previous === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = previous;
    if (previousBase === undefined) delete process.env.BITRIX24_REST_BASE_URL; else process.env.BITRIX24_REST_BASE_URL = previousBase;
  }
});
