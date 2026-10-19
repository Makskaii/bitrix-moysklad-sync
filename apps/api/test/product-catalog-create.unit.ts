import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ProductCatalogCreateService } from '../src/products/product-catalog-create.service';

test('new MySklad product creates one Bitrix24 card, durable hardpair, and repeat recovers without a duplicate', async () => {
  const oldFetch = globalThis.fetch;
  const oldBase = process.env.BITRIX24_REST_BASE_URL;
  process.env.BITRIX24_REST_BASE_URL = 'https://fake.example/rest/';
  const cards = new Map<string, Record<string, unknown>>();
  const prices: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const operations = new Map<string, Record<string, any>>();
  const pairs: Array<Record<string, unknown>> = [];
  let failAfterServicePriceWrite = true;
  const operationModel = {
    findUnique: async ({ where }: { where: { moyskladProductId: string } }) => operations.get(where.moyskladProductId) ?? null,
    findUniqueOrThrow: async ({ where }: { where: { moyskladProductId: string } }) => operations.get(where.moyskladProductId),
    create: async ({ data }: { data: Record<string, any> }) => {
      const value = { ...data, status: 'PENDING', bitrix24ProductId: null, leaseToken: null, leaseUntil: null };
      operations.set(data.moyskladProductId, value);
      return value;
    },
    updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      const operation = operations.get(where.moyskladProductId);
      if (!operation || (where.status && where.status !== operation.status) || (where.leaseToken && where.leaseToken !== operation.leaseToken)) return { count: 0 };
      if (where.OR && operation.leaseUntil && operation.leaseUntil > new Date()) return { count: 0 };
      Object.assign(operation, data);
      return { count: 1 };
    },
  };
  const db: any = {
    dealOrderReverseProductOperation: operationModel,
    entityPair: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => pairs.filter((pair) => pair.entityType === where.entityType && pair.active && (pair.bitrix24Id === where.bitrix24Id || pair.moyskladId === where.moyskladId)),
      create: async ({ data }: { data: Record<string, unknown> }) => pairs.push(data),
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn({
      $queryRaw: async () => [{ locked: 1 }],
      entityPair: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => pairs.filter((pair) => pair.entityType === where.entityType && pair.active && (pair.bitrix24Id === where.bitrix24Id || pair.moyskladId === where.moyskladId)),
        create: async ({ data }: { data: Record<string, unknown> }) => pairs.push({ active: true, ...data }),
      },
      dealOrderReverseProductOperation: {
        updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => operationModel.updateMany({ where, data }),
        findUnique: async ({ where }: { where: { moyskladProductId: string } }) => operations.get(where.moyskladProductId) ?? null,
      },
    }),
  };
  const mode: any = { runDealOrderExternalWrite: async (_direction: string, assertLease: () => Promise<void>, _pair: unknown, mutation: () => Promise<unknown>) => { await assertLease(); return mutation(); } };
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf('/') + 1);
    calls.push(method);
    const request = JSON.parse(String(init?.body)) as { fields?: Record<string, unknown> };
    if (method === 'catalog.product.getFieldsByFilter') return Response.json({ result: { product: { name: { type: 'string', isReadOnly: false }, code: { type: 'string', isReadOnly: false }, detailText: { type: 'string', isReadOnly: false }, weight: { type: 'double', isReadOnly: false }, iblockId: { type: 'integer', isReadOnly: false } } } });
    if (method === 'catalog.product.service.getFieldsByFilter') return Response.json({ result: { service: { name: { type: 'string', isReadOnly: false }, code: { type: 'string', isReadOnly: false }, detailText: { type: 'string', isReadOnly: false }, iblockId: { type: 'integer', isReadOnly: false } } } });
    if (method === 'catalog.product.list') return Response.json({ result: { products: [...cards.values()].filter((card) => card.xmlId === (request as any).filter?.xmlId), total: cards.size }, total: cards.size });
    if (method === 'catalog.product.add') {
      const id = '821';
      const card = { id: Number(id), type: 1, ...request.fields };
      cards.set(id, card);
      return Response.json({ result: { element: card } });
    }
    if (method === 'catalog.product.service.list') {
      const services = [...cards.values()].filter((card) => card.xmlId === (request as any).filter?.xmlId && card.type === 7);
      return Response.json({ result: { services, total: services.length }, total: services.length });
    }
    if (method === 'catalog.product.service.add') {
      const id = '822';
      const card = { id: Number(id), type: 7, ...request.fields };
      cards.set(id, card);
      return Response.json({ result: { service: card } });
    }
    if (method === 'catalog.price.list') {
      const filter = (request as any).filter ?? {};
      const rows = prices.filter((price) => String(price.productId) === String(filter.productId) && String(price.catalogGroupId) === String(filter.catalogGroupId));
      return Response.json({ result: { prices: rows, total: rows.length }, total: rows.length });
    }
    if (method === 'catalog.price.add') {
      const price = { id: prices.length + 1, ...(request as any).fields };
      prices.push(price);
      if (price.productId === 822 && failAfterServicePriceWrite) {
        failAfterServicePriceWrite = false;
        return Response.json({ error: 'temporary timeout after applying write' }, { status: 503 });
      }
      return Response.json({ result: { price } });
    }
    return Response.json({ error: 'unexpected method' }, { status: 404 });
  };
  try {
    const service = new ProductCatalogCreateService(db, mode);
    const input: any = {
      productId: '12345678-1234-1234-1234-123456789abc', eventId: 'event-new-product',
      eventConfig: { version: 4, config: { productCatalogRuntime: { bitrix24CatalogId: '12', moyskladFields: ['name', 'code', 'description'] }, rules: [{ id: 'weight', entity: 'catalog', sourceField: 'weight', targetField: 'weight', bitrix24ToMoysklad: { enabled: false, transform: { kind: 'tbd' } }, moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }], dealOrderRuntime: null } },
      product: { id: '12345678-1234-1234-1234-123456789abc', meta: { type: 'product' }, name: 'Rotor', code: 'R-1', description: 'Rotor body', weight: 0 },
      prices: [],
    };
    assert.equal(await service.createOrRecover(input), '821');
    assert.equal(await service.createOrRecover(input), '821');
    assert.equal(cards.size, 1);
    assert.deepEqual(pairs[0], { active: true, entityType: 'PRODUCT', bitrix24Id: '821', moyskladId: input.productId, moyskladType: 'product', source: 'AUTO' });
    assert.equal(calls.filter((name) => name === 'catalog.product.add').length, 1);
    assert.equal(operations.get(input.productId)?.status, 'SUCCEEDED');
    assert.equal((cards.get('821') as any).name, 'Rotor');
    assert.equal((cards.get('821') as any).code, 'R-1');
    assert.equal((cards.get('821') as any).detailText, 'Rotor body');
    assert.equal((cards.get('821') as any).weight, 0, 'explicitly mapped numeric zero is included in durable create and readback');

    const serviceInput: any = {
      productId: '22345678-1234-1234-1234-123456789abc', moyskladType: 'service', eventId: 'event-new-service',
      eventConfig: input.eventConfig,
      product: { id: '22345678-1234-1234-1234-123456789abc', meta: { type: 'service' }, name: 'Installation', code: 'S-1', description: 'Install rotor' },
      prices: [{ catalogGroupId: 2, value: 42, currency: 'RUB' }],
    };
    await assert.rejects(
      () => service.createOrRecover({ ...serviceInput, prices: [{ catalogGroupId: 2, value: 42, currency: 'rub' }] }),
      (error: unknown) => error instanceof Error && error.message === 'PRODUCT_CREATE_PRICE_MAPPING_INVALID',
    );
    assert.equal(calls.filter((name) => name === 'catalog.product.service.add').length, 0, 'invalid service currency is rejected before any provider write');
    await assert.rejects(() => service.createOrRecover(serviceInput), /BITRIX24_PRODUCT_API_503/);
    assert.equal(await service.createOrRecover(serviceInput), '822');
    assert.equal(await service.createOrRecover(serviceInput), '822');
    assert.deepEqual(pairs[1], { active: true, entityType: 'PRODUCT', bitrix24Id: '822', moyskladId: serviceInput.productId, moyskladType: 'service', source: 'AUTO' });
    assert.equal(calls.filter((name) => name === 'catalog.product.service.add').length, 1);
    assert.equal(calls.filter((name) => name === 'catalog.price.add').length, 1, 'retry reads the applied service price and does not duplicate it');
    assert.deepEqual(prices, [{ id: 1, productId: 822, catalogGroupId: 2, price: 42, currency: 'RUB' }]);
    assert.equal(operations.get(serviceInput.productId)?.status, 'SUCCEEDED');

    const unsupportedServiceWeight = {
      ...serviceInput,
      productId: '32345678-1234-1234-1234-123456789abc',
      eventId: 'event-unsupported-service-weight',
      product: { ...serviceInput.product, id: '32345678-1234-1234-1234-123456789abc', weight: 1.5 },
    };
    await assert.rejects(
      () => service.createOrRecover(unsupportedServiceWeight),
      (error: unknown) => error instanceof Error && error.message === 'PRODUCT_CREATE_FIELD_NOT_CONFIRMED_WRITABLE',
      'product-only fields are not written to service cards even when a stored generic rule selects them',
    );
    assert.equal(calls.filter((name) => name === 'catalog.product.service.add').length, 1);
    assert.equal(operations.has(unsupportedServiceWeight.productId), false, 'schema rejection precedes durable create journal and provider write');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldBase === undefined) delete process.env.BITRIX24_REST_BASE_URL;
    else process.env.BITRIX24_REST_BASE_URL = oldBase;
  }
});
