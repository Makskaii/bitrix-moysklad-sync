import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HttpClientInventoryProvider } from '../src/clients/client-inventory.provider';

function providerWith(payload: unknown) {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  return new HttpClientInventoryProvider(fetcher);
}

test('Bitrix24 inventory rejects missing and inconsistent paging metadata', async () => {
  process.env.BITRIX24_REST_BASE_URL = 'https://example.invalid/rest/';
  await assert.rejects(providerWith({ result: [{ ID: 1 }], total: 2 }).bitrixPage('COMPANY', 0, 'synthetic-token'), /INVALID_PAGINATION/);
  await assert.rejects(providerWith({ result: [{ ID: 1 }], total: 2, next: 50 }).bitrixPage('COMPANY', 0, 'synthetic-token'), /INVALID_PAGINATION/);
  await assert.rejects(providerWith({ result: [], total: 0, next: 'bad' }).bitrixPage('CONTACT', 0, 'synthetic-token'), /INVALID_PAGINATION/);
  await assert.rejects(providerWith({ result: [{ ID: 1 }], total: 0 }).bitrixPage('COMPANY', 0, 'synthetic-token'), /INVALID_PAGINATION/);
});

test('Bitrix24 inventory accepts contract sized pages and stable next offsets', async () => {
  process.env.BITRIX24_REST_BASE_URL = 'https://example.invalid/rest/';
  const first = await providerWith({ result: Array.from({ length: 50 }, (_, index) => ({ ID: index + 1 })), total: 51, next: 50 })
    .bitrixPage('COMPANY', 0, 'synthetic-token');
  assert.equal(first.rows.length, 50);
  assert.equal(first.next, 50);
  const last = await providerWith({ result: [{ ID: 51 }], total: 51 }).bitrixPage('COMPANY', 50, 'synthetic-token');
  assert.equal(last.next, null);
  assert.equal(last.total, 51);
});

test('MoySklad top-level and nested pages reject absent, mismatched, and truncated metadata', async () => {
  process.env.MOYSKLAD_API_BASE_URL = 'https://example.invalid/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-token';
  const rows = Array.from({ length: 2 }, (_, index) => ({ id: `id-${index}` }));
  await assert.rejects(providerWith({ rows: [], meta: { offset: 0, limit: 1000 } }).counterpartyPage(0), /INVALID_PAGINATION/);
  await assert.rejects(providerWith({ rows, meta: { size: 3, offset: 1, limit: 1000 } }).counterpartyPage(0), /INVALID_PAGINATION/);
  await assert.rejects(providerWith({ rows: [rows[0]], meta: { size: 2, offset: 0, limit: 1000 } }).counterpartyPage(0), /INVALID_PAGINATION/);
  await assert.rejects(providerWith({ rows: [rows[0]], meta: { size: 2, offset: 0, limit: 1000 } }).contactpersonPage('parent-id', 0), /INVALID_PAGINATION/);
  const page = await providerWith({ rows, meta: { size: 2, offset: 0, limit: 1000 } }).contactpersonPage('parent-id', 0);
  assert.equal(page.total, 2);
  assert.equal(page.rows[0]?.parentId, 'parent-id');
});
