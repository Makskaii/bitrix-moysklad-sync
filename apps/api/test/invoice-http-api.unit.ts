import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { InvoiceHttpApi } from '../src/invoices/invoice-http-api';

const invoiceId = '12345678-1234-1234-1234-123456789abc';
const orderId = '87654321-4321-4321-4321-cba987654321';

test('invoice HTTP adapter creates invoiceout linked to the exact customer order and source identity', async () => {
  const oldFetch = globalThis.fetch;
  const oldMode = process.env.SYNC_MODE;
  const oldBase = process.env.MOYSKLAD_API_BASE_URL;
  const oldToken = process.env.MOYSKLAD_API_TOKEN;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  process.env.SYNC_MODE = 'apply';
  process.env.MOYSKLAD_API_BASE_URL = 'https://ms-fixture.invalid/api/remap/1.2';
  process.env.MOYSKLAD_API_TOKEN = 'fixture-only-token';
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Response.json({ id: invoiceId });
  };
  try {
    assert.equal(await new InvoiceHttpApi().createMoysklad('b24-91', orderId, { name: 'Invoice A', payedSum: 90, 'attributes.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'mapped' }), invoiceId);
    assert.equal(requests[0]?.url, 'https://ms-fixture.invalid/api/remap/1.2/entity/invoiceout');
    assert.equal(new Headers(requests[0].init.headers).get('accept'),'application/json;charset=utf-8');
    assert.equal(new Headers(requests[0].init.headers).get('accept-encoding'),'gzip');
    const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, any>;
    assert.equal(body.externalCode, 'b24-91');
    assert.equal(body.customerOrder.meta.href, `https://ms-fixture.invalid/api/remap/1.2/entity/customerorder/${orderId}`);
    assert.deepEqual(body.name, 'Invoice A');
    assert.equal('payedSum' in body, false);
    assert.deepEqual(body.attributes, [{ meta: {
      href: 'https://ms-fixture.invalid/api/remap/1.2/entity/invoiceout/metadata/attributes/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      type: 'attributemetadata', mediaType: 'application/json',
    }, value: 'mapped' }]);
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv('SYNC_MODE', oldMode);
    restoreEnv('MOYSKLAD_API_BASE_URL', oldBase);
    restoreEnv('MOYSKLAD_API_TOKEN', oldToken);
  }
});

test('invoice HTTP adapter creates only smart invoice type 31 linked to its deal', async () => {
  const oldFetch = globalThis.fetch;
  const oldMode = process.env.SYNC_MODE;
  const oldBase = process.env.BITRIX24_REST_BASE_URL;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_REST_BASE_URL = 'https://b24-fixture.invalid/rest/';
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Response.json({ result: { item: { id: '92' } } });
  };
  try {
    assert.equal(await new InvoiceHttpApi().createBitrix24(invoiceId, '91', { title: 'Invoice B' }), '92');
    assert.equal(requests[0]?.url, 'https://b24-fixture.invalid/rest/crm.item.add.json');
    const form = new URLSearchParams(String(requests[0]?.init.body));
    assert.equal(form.get('entityTypeId'), '31');
    assert.equal(form.get('fields[parentId2]'), '91');
    assert.equal(form.get('fields[originId]'), invoiceId);
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv('SYNC_MODE', oldMode);
    restoreEnv('BITRIX24_REST_BASE_URL', oldBase);
  }
});

test('invoice updates omit payments and reflected payment/shipment totals', async () => {
  const oldFetch = globalThis.fetch;
  const oldMode = process.env.SYNC_MODE;
  const oldBase = process.env.MOYSKLAD_API_BASE_URL;
  const oldToken = process.env.MOYSKLAD_API_TOKEN;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  process.env.SYNC_MODE = 'apply';
  process.env.MOYSKLAD_API_BASE_URL = 'https://ms-fixture.invalid/api/remap/1.2';
  process.env.MOYSKLAD_API_TOKEN = 'fixture-only-token';
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Response.json({ id: invoiceId });
  };
  try {
    await new InvoiceHttpApi().updateMoysklad(invoiceId, { name: 'Invoice C', payedSum: 10, shippedSum: 8, payments: [], shipment: {} });
    const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
    assert.deepEqual(body, { name: 'Invoice C' });
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv('SYNC_MODE', oldMode);
    restoreEnv('MOYSKLAD_API_BASE_URL', oldBase);
    restoreEnv('MOYSKLAD_API_TOKEN', oldToken);
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
