import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/database.service';
import { DocumentProductIdentityError, ensureDocumentProductIdentity } from '../src/products/document-product-identity';

const db = new DatabaseService();
const originalFetch = global.fetch;
const cards = new Map<string, unknown>();
const targets = new Map<string, unknown>();
let reads = 0;
process.env.SYNC_MODE = 'apply';
before(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /root_product_identity.*_test$/);
  await db.$connect();
  await db.syncSetting.create({ data: { id: 'global', serviceMode: 'on' } });
  await db.syncDirectionSetting.create({ data: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: false } });
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.invalid/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://ms.invalid/api/remap/1.2/';
  global.fetch = async (input, init) => {
    reads++;
    const url = new URL(String(input));
    if (url.hostname === 'bitrix.invalid') {
      assert.equal(url.pathname, '/rest/catalog.product.get.json');
      assert.equal(init?.method, 'POST');
      const id = new URLSearchParams(String(init?.body)).get('id')!;
      return Response.json({ result: { product: cards.get(id) } });
    }
    assert.equal(url.hostname, 'ms.invalid');
    assert.equal(init?.method, 'GET');
    assert.equal((init?.headers as Record<string, string>).Accept, 'application/json;charset=utf-8');
    const value = targets.get(url.pathname.split('/').pop()!);
    return value ? Response.json(value) : Response.json({}, { status: 404 });
  };
});
after(async () => { global.fetch = originalFetch; await db.$disconnect(); });
const resolve = (id: string) => ensureDocumentProductIdentity(db, { bitrix24ProductId: id, bitrix24CatalogId: '14', eventId: 'post-implementation-verification' });
function fixture(id: string, uuid: string = randomUUID()) {
  cards.set(id, { id, iblockId: 14, type: 1, active: 'Y', property108: { value: uuid }, xmlId: 'not-the-product-identity' });
  targets.set(uuid, { id: uuid, meta: { type: 'product' }, archived: false });
  return uuid;
}
function reason(expected: string) { return (error: unknown) => error instanceof DocumentProductIdentityError && error.reason === expected; }

test('existing catalog property108 links exactly once across concurrent document processing, without external writes', async () => {
  const uuid = fixture('81001');
  await Promise.all([resolve('81001'), resolve('81001')]);
  const pairs = await db.entityPair.findMany({ where: { entityType: 'PRODUCT', bitrix24Id: '81001' } });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].moyskladId, uuid);
  assert.equal(pairs[0].reason, 'BITRIX_PROPERTY108_EXACT_MOYSKLAD_ID');
  const before = reads;
  cards.set('81001', {});
  await resolve('81001');
  assert.equal(reads, before, 'saved pair remains authoritative');
});
test('occupied target and inactive source pair stop, without fallback or reactivation', async () => {
  const uuid = fixture('81002');
  await resolve('81002');
  fixture('81003', uuid);
  await assert.rejects(resolve('81003'), reason('PRODUCT_UUID_PAIR_CONFLICT'));
  const inactive = fixture('81004');
  await db.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: '81004', moyskladId: inactive, active: false } });
  await assert.rejects(resolve('81004'), reason('PRODUCT_UUID_PAIR_CONFLICT'));
  assert.equal(await db.entityPair.count({ where: { bitrix24Id: '81003' } }), 0);
});
test('malformed UUID, missing target, wrong catalog, wrong resource and archived target cannot bind', async () => {
  fixture('81005', 'not-a-uuid');
  await assert.rejects(resolve('81005'), reason('PRODUCT_UUID_INVALID'));
  const missing = fixture('81006'); targets.delete(missing);
  await assert.rejects(resolve('81006'), reason('PRODUCT_UUID_TARGET_NOT_FOUND'));
  fixture('81007'); (cards.get('81007') as any).iblockId = 99;
  await assert.rejects(resolve('81007'), reason('PRODUCT_UUID_SOURCE_INVALID'));
  const service = fixture('81008'); targets.set(service, { id: service, meta: { type: 'service' } });
  await assert.rejects(resolve('81008'), reason('PRODUCT_UUID_TARGET_INVALID'));
  const archived = fixture('81009'); targets.set(archived, { id: archived, meta: { type: 'product' }, archived: true });
  await assert.rejects(resolve('81009'), reason('PRODUCT_UUID_TARGET_INVALID'));
});
test('OFF blocks new identity reads and pair creation', async () => {
  fixture('81010');
  await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'off' } });
  const before = reads;
  await assert.rejects(resolve('81010'), /SERVICE_MODE_NOT_ON/);
  assert.equal(reads, before);
  assert.equal(await db.entityPair.count({ where: { bitrix24Id: '81010' } }), 0);
});
