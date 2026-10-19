import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ProductCatalogCreateService } from '../src/products/product-catalog-create.service';

test('new MySklad product creates one Bitrix24 card, durable hardpair, and repeat recovers without a duplicate', async () => {
  const oldFetch = globalThis.fetch;
  const oldBase = process.env.BITRIX24_REST_BASE_URL;
  process.env.BITRIX24_REST_BASE_URL = 'https://fake.example/rest/';
  const cards = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const operations = new Map<string, Record<string, any>>();
  const pairs: Array<Record<string, unknown>> = [];
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
    return Response.json({ error: 'unexpected method' }, { status: 404 });
  };
  try {
    const service = new ProductCatalogCreateService(db, mode);
    const input: any = {
      productId: '12345678-1234-1234-1234-123456789abc', eventId: 'event-new-product',
      eventConfig: { version: 4, config: { productCatalogRuntime: { bitrix24CatalogId: '12', moyskladFields: ['name', 'code', 'description'] }, dealOrderRuntime: null } },
      product: { id: '12345678-1234-1234-1234-123456789abc', meta: { type: 'product' }, name: 'Rotor', code: 'R-1', description: 'Rotor body' },
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

    const serviceInput: any = {
      productId: '22345678-1234-1234-1234-123456789abc', moyskladType: 'service', eventId: 'event-new-service',
      eventConfig: input.eventConfig,
      product: { id: '22345678-1234-1234-1234-123456789abc', meta: { type: 'service' }, name: 'Installation', code: 'S-1', description: 'Install rotor' },
      prices: [],
    };
    assert.equal(await service.createOrRecover(serviceInput), '822');
    assert.equal(await service.createOrRecover(serviceInput), '822');
    assert.deepEqual(pairs[1], { active: true, entityType: 'PRODUCT', bitrix24Id: '822', moyskladId: serviceInput.productId, moyskladType: 'service', source: 'AUTO' });
    assert.equal(calls.filter((name) => name === 'catalog.product.service.add').length, 1);
    assert.equal(operations.get(serviceInput.productId)?.status, 'SUCCEEDED');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldBase === undefined) delete process.env.BITRIX24_REST_BASE_URL;
    else process.env.BITRIX24_REST_BASE_URL = oldBase;
  }
});
