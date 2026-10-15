import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, Server } from 'node:http';
import { ProductCardHttpApi } from '../src/products/product-card-api';
import { isRetryableFailure, ProviderFailure } from '../src/provider-failure';

let server: Server;
let base = '';
const saved = new Map<string, string | undefined>();
const requests: Array<{ method: string; path: string; body: string }> = [];
let malformedNextProductWriteResponse = false;
let failNextProductWriteRetryAfter: string | null = null;
const productId = '12345678-1234-1234-1234-123456789abc';

before(async () => {
  for (const key of ['BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN']) saved.set(key, process.env[key]);
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: request.method ?? '', path: request.url ?? '', body });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/rest/catalog.product.get.json') return response.end(JSON.stringify({ result: { product: { id: 101, type: 1, name: 'Starter', detailText: 'HTML detail', measure: 3, dateModify: '2026-10-07T10:00:00Z' } } }));
      if (request.url === '/rest/catalog.price.get.json') return response.end(JSON.stringify({ result: { price: { id: 51, productId: 101, catalogGroupId: 2, currency: 'RUB', price: 12.5 } } }));
      if (request.url === '/rest/catalog.price.list.json') return response.end(JSON.stringify({ result: { prices: [{ id: 51, productId: 101, catalogGroupId: 2, price: 12.5, currency: 'RUB' }] } }));
      if (request.url === '/api/remap/1.2/entity/product/' + productId && request.method === 'GET') return response.end(JSON.stringify({
        id: productId, meta: { type: 'product' }, name: 'Starter', description: 'Plain detail', updated: '2026-10-07 10:00:00.000',
        uom: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/uom/abcdefab-cdef-abcd-efab-cdefabcdefab' } },
        salePrices: [{ value: 12.5,
          currency: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/currency/abcdefab-cdef-abcd-efab-cdefabcdefad' } },
          priceType: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/context/companysettings/pricetype/abcdefab-cdef-abcd-efab-cdefabcdefac' } } }],
      }));
      if (request.url === '/api/remap/1.2/entity/currency/abcdefab-cdef-abcd-efab-cdefabcdefad' && request.method === 'GET') return response.end(JSON.stringify({ id: 'abcdefab-cdef-abcd-efab-cdefabcdefad', isoCode: 'RUB' }));
      if (request.url === '/api/remap/1.2/entity/product/' + productId && request.method === 'PUT' && malformedNextProductWriteResponse) {
        malformedNextProductWriteResponse = false;
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end('{');
      }
      if (request.url === '/api/remap/1.2/entity/product/' + productId && request.method === 'PUT' && failNextProductWriteRetryAfter) {
        const retryAfter = failNextProductWriteRetryAfter;
        failNextProductWriteRetryAfter = null;
        response.writeHead(429, { 'retry-after': retryAfter, 'content-type': 'text/plain' });
        return response.end('temporarily rate limited');
      }
      if (request.url === '/rest/catalog.product.update.json' || request.url === '/rest/catalog.price.update.json' || request.url === '/api/remap/1.2/entity/product/' + productId) return response.end(JSON.stringify({ result: true }));
      response.statusCode = 404;
      return response.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  process.env.BITRIX24_REST_BASE_URL = `${base}/rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${base}/api/remap/1.2/`;
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-token';
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('product API adapter reads only addressed cards and issues partial field and exact-price writes', async () => {
  const api = new ProductCardHttpApi();
  assert.equal(await api.readBitrix24PriceProductId('51'), '101');
  const b24 = await api.readBitrix24('101');
  assert.deepEqual(b24, {
    name: 'Starter', detailText: 'HTML detail', unitId: '3', prices: [{ priceId: '51', typeId: '2', value: 12.5, currency: 'RUB' }], updatedAt: '2026-10-07T10:00:00Z',
  });
  const ms = await api.readMoysklad(productId);
  assert.equal(ms.unitId, 'abcdefab-cdef-abcd-efab-cdefabcdefab');
  assert.equal(ms.prices[0].typeId, 'abcdefab-cdef-abcd-efab-cdefabcdefac');
  assert.equal(ms.prices[0].currency, 'RUB');
  assert.equal((ms.prices[0].currencyRef?.meta as { type: string }).type, 'currency');

  await api.updateBitrix24('101', { name: 'Renamed' });
  await api.updateBitrix24Price('51', 13.25, 'RUB');
  await api.updateMoysklad(productId, { description: 'Plain text' });
  assert.deepEqual(requests.filter((request) => request.method === 'PUT').map((request) => JSON.parse(request.body)), [{ description: 'Plain text' }]);
  const b24FieldBody = new URLSearchParams(requests.find((request) => request.path === '/rest/catalog.product.update.json')!.body);
  assert.equal(b24FieldBody.get('fields[name]'), 'Renamed');
  assert.equal(b24FieldBody.has('fields[previewText]'), false);
  assert.equal(requests.some((request) => request.path.includes('entity/search') || request.method === 'POST' && request.path.includes('/entity/product')), false);
});

test('truncated successful product response is a retryable uncertain outcome', async () => {
  const api = new ProductCardHttpApi();
  malformedNextProductWriteResponse = true;
  await assert.rejects(
    api.updateMoysklad(productId, { description: 'applied before truncation' }),
    (error: unknown) => error instanceof ProviderFailure && isRetryableFailure(error),
  );
});

test('malformed 429 product response preserves Retry-After classification', async () => {
  const api = new ProductCardHttpApi();
  const retryAfter = new Date(Date.now() + 30_000).toUTCString();
  failNextProductWriteRetryAfter = retryAfter;
  await assert.rejects(api.updateMoysklad(productId, { description: 'rate limited' }), (error: unknown) => {
    assert.ok(error instanceof ProviderFailure);
    assert.equal(error.status, 429);
    assert.ok(error.retryAfterAt);
    assert.ok(Math.abs(error.retryAfterAt.getTime() - Date.parse(retryAfter)) < 1_000);
    return isRetryableFailure(error);
  });
});
