import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/database.service';
import { ProductCatalogCreateService } from '../src/products/product-catalog-create.service';
import { ensureDocumentProductIdentity } from '../src/products/document-product-identity';

process.env.SYNC_MODE = 'apply';
const db = new DatabaseService();
const cards = new Map<string, any>();
const oldFetch = global.fetch;
let writes = 0;
let changeOnRecheck: (() => void) | null = null;
let uuidReads = 0;
const service = new ProductCatalogCreateService(db, {
  runDealOrderExternalWrite: async (_direction: unknown, check: () => Promise<void>, _pair: unknown, mutate: () => Promise<any>) => { await check(); return mutate(); },
} as any);

before(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/root_product_identity_duplicate_20261022_test');
  assert.match(url.searchParams.get('schema') ?? '', /^uuid_reuse(?:_[a-z0-9]+)?$/);
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.invalid/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://ms.invalid/api/remap/1.2/';
  await db.$connect();
  await db.syncSetting.create({ data: { id: 'global', serviceMode: 'on' } });
  global.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = url.pathname.split('/').pop()!;
    if (/\.(add|update|delete)$/.test(method)) { writes++; throw Error('UNEXPECTED_PROVIDER_WRITE'); }
    if (method === 'catalog.product.get.json') {
      const id = new URLSearchParams(String(init?.body)).get('id')!;
      return Response.json({ result: { product: cards.get(id) } });
    }
    if (url.hostname === 'ms.invalid') {
      const id = url.pathname.split('/').pop()!;
      return Response.json({ id, meta: { type: 'product' }, archived: false });
    }
    const payload = JSON.parse(String(init?.body));
    if (method === 'catalog.product.getFieldsByFilter') return Response.json({ result: { product: {
      name: { type: 'string', isReadOnly: false },
      property108: { type: 'productproperty', propertyType: 'S', isMultiple: false, isReadOnly: false },
    } } });
    if (method === 'catalog.product.list') {
      if (payload.filter.property108) {
        uuidReads++;
        if (uuidReads === 2 && changeOnRecheck) changeOnRecheck();
      }
      const products = [...cards.values()].filter(c => String(c.iblockId) === String(payload.filter.iblockId) &&
        (payload.filter.property108 ? c.property108.value === payload.filter.property108 : c.xmlId === payload.filter.xmlId));
      return Response.json({ result: { products }, total: products.length });
    }
    throw Error('UNEXPECTED_PROVIDER_READ_' + method);
  };
});
after(async () => { global.fetch = oldFetch; await db.$disconnect(); });

function fixture(id: string) {
  const uuid = randomUUID();
  cards.set(id, { id: Number(id), iblockId: 14, type: 1, active: 'Y', xmlId: 'legacy-' + id, property108: { value: uuid }, name: 'Existing working card' });
  uuidReads = 0; changeOnRecheck = null;
  return {
    productId: uuid, product: { id: uuid, meta: { type: 'product' }, name: 'New source name must not overwrite' }, eventId: randomUUID(),
    eventConfig: { version: 1, config: { productCatalogRuntime: { bitrix24CatalogId: '14', moyskladFields: ['name'] }, rules: [] } },
    prices: [{ catalogGroupId: 2, value: 999, currency: 'RUB' }],
  } as any;
}

test('reuse a unique legacy UUID without any provider writes; repeat is idempotent', async () => {
  const input = fixture('91001');
  const original = structuredClone(cards.get('91001'));
  assert.equal(await service.createOrRecover(input), '91001');
  assert.equal(await service.createOrRecover(input), '91001');
  assert.equal(await db.entityPair.count({ where: { moyskladId: input.productId } }), 1);
  assert.deepEqual(cards.get('91001'), original);
  assert.equal(writes, 0);
  const op = await db.dealOrderReverseProductOperation.findUniqueOrThrow({ where: { moyskladProductId: input.productId } });
  assert.equal(op.status, 'SUCCEEDED');
  assert.equal((op.payload as any).reusedIdentity.id, '91001');
  assert.deepEqual(await service.inspectCreateEcho({ targetId: '91001', kind: 'product', card: original, receivedAt: new Date() }, async () => { throw Error('NO_RECOVERY_LOOKUP_FOR_LEGACY'); }), { status: 'NONE' });
  await assert.rejects(() => service.inspectCreateEcho({ targetId: '99901', kind: 'product', card: { ...original, id: 99901, xmlId: `MOYSKLAD_PRODUCT_${input.productId}` }, receivedAt: new Date() }, async () => []), /PRODUCT_IMPORT_ECHO_IDENTITY_MISMATCH/);
});

test('two UUID matches stop without pairing, price writes or creating another card', async () => {
  const input = fixture('91002');
  cards.set('91003', { ...cards.get('91002'), id: 91003 });
  await assert.rejects(() => service.createOrRecover(input), /PRODUCT_UUID_AMBIGUOUS/);
  assert.equal(await db.entityPair.count({ where: { moyskladId: input.productId } }), 0);
  assert.equal(writes, 0);
  cards.delete('91003');
  assert.equal(await service.createOrRecover(input), '91002', 'read-only conflict can recover after explicit catalog repair; no ADD was sent');
  assert.equal(writes, 0);
});

test('inactive source binding cannot be treated as absence', async () => {
  const input = fixture('91004');
  await db.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: '99904', moyskladId: input.productId, moyskladType: 'product', active: false } });
  await assert.rejects(() => service.createOrRecover(input), /PRODUCT_CREATE_PAIR_CONFLICT/);
  assert.equal(await db.entityPair.count({ where: { bitrix24Id: '91004' } }), 0);
  assert.equal(writes, 0);
});

test('occupied target prevents adoption and cannot create an alternative', async () => {
  const input = fixture('91005');
  await db.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: '91005', moyskladId: randomUUID(), moyskladType: 'product' } });
  await assert.rejects(() => service.createOrRecover(input), /PRODUCT_CREATE_PAIR_CONFLICT/);
  assert.equal(await db.entityPair.count({ where: { moyskladId: input.productId } }), 0);
  assert.equal(writes, 0);
});

test('persisted reuse reservation survives failed recheck and retry, without ADD', async () => {
  const input = fixture('91006');
  changeOnRecheck = () => { cards.get('91006').active = 'N'; };
  await assert.rejects(() => service.createOrRecover(input), /PRODUCT_UUID_EXISTING_CARD_INVALID/);
  assert.equal(await db.entityPair.count({ where: { moyskladId: input.productId } }), 0);
  cards.get('91006').active = 'Y'; changeOnRecheck = null;
  assert.equal(await service.createOrRecover(input), '91006');
  assert.equal(writes, 0);
});

test('competing reverse requests converge to one pair; busy contender retries safely', async () => {
  const input = fixture('91007');
  const results = await Promise.allSettled([service.createOrRecover(input), service.createOrRecover(input)]);
  for (const result of results) if (result.status === 'rejected') assert.match(result.reason.message, /PRODUCT_CREATE_OPERATION_BUSY|PRODUCT_CREATE_OPERATION_NOT_PENDING|PRODUCT_CREATE_PAIR_CONFLICT/);
  assert.equal(await service.createOrRecover(input), '91007');
  assert.equal(await db.entityPair.count({ where: { moyskladId: input.productId } }), 1);
  assert.equal(writes, 0);
});

test('a pending reverse reservation blocks a competing forward document link', async () => {
  const input = fixture('91008');
  await db.dealOrderReverseProductOperation.create({ data: { moyskladProductId: input.productId, syncId: randomUUID(), eventId: input.eventId, settingsVersion: 1, bitrix24CatalogId: '14', payload: {} } });
  await assert.rejects(() => ensureDocumentProductIdentity(db, { bitrix24ProductId: '91008', bitrix24CatalogId: '14', eventId: input.eventId }), /PRODUCT_UUID_PAIR_CONFLICT/);
  assert.equal(await db.entityPair.count({ where: { moyskladId: input.productId } }), 0);
  assert.equal(writes, 0);
});

test('OFF prevents UUID adoption and leaves pair count unchanged', async () => {
  const input = fixture('91009');
  await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'off' } });
  try {
    await assert.rejects(() => service.createOrRecover(input), /SERVICE_MODE_NOT_ON/);
    assert.equal(await db.entityPair.count({ where: { moyskladId: input.productId } }), 0);
    assert.equal(writes, 0);
  } finally {
    await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  }
});

test('uncertain prior ADD cannot be replaced by adopting another legacy identity', async () => {
  const input = fixture('91010');
  const xmlId = `MOYSKLAD_PRODUCT_${input.productId}`;
  await db.dealOrderReverseProductOperation.create({ data: {
    moyskladProductId: input.productId, syncId: randomUUID(), eventId: input.eventId,
    settingsVersion: 1, bitrix24CatalogId: '14', attemptedAt: new Date(),
    payload: { fields: { iblockId: 14, name: input.product.name, property108: { value: input.productId }, xmlId }, xmlId, kind: 'product', uuidLookupVersion: 1, providerCreateAttempted: true },
  } });
  await assert.rejects(() => service.createOrRecover(input), /PRODUCT_UUID_REUSE_AFTER_ATTEMPT/);
  assert.equal(await db.entityPair.count({ where: { moyskladId: input.productId } }), 0);
  assert.equal(writes, 0);
});
