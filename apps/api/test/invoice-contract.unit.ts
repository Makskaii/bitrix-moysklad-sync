import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { invoiceCreatedAt, invoicePairLinksMatchOrder, isInvoiceEvent, resolveInvoiceOrderLink } from '../src/invoices/invoice-contract';

test('invoice order links use explicit deal/order relations and reject missing or ambiguous links', () => {
  assert.deepEqual(resolveInvoiceOrderLink({ parentId2: 42, accountNumber: '42' }, 'BITRIX24'), { status: 'linked', orderId: '42' });
  assert.deepEqual(resolveInvoiceOrderLink({ accountNumber: '42' }, 'BITRIX24'), { status: 'missing' });
  assert.deepEqual(resolveInvoiceOrderLink({ parentId: 42 }, 'BITRIX24'), { status: 'missing' });
  assert.deepEqual(resolveInvoiceOrderLink({ parentId2: { id: 42 } }, 'BITRIX24'), { status: 'ambiguous' });
  assert.deepEqual(resolveInvoiceOrderLink({ customerOrder: { id: '12345678-1234-1234-1234-123456789abc', meta: { href: 'https://x/entity/customerorder/12345678-1234-1234-1234-123456789abc' } } }, 'MOYSKLAD'), { status: 'linked', orderId: '12345678-1234-1234-1234-123456789abc' });
  assert.deepEqual(resolveInvoiceOrderLink({ customerOrder: null }, 'MOYSKLAD'), { status: 'missing' });
});

test('invoice routing accepts only Bitrix dynamic entity 31 or MySklad invoiceout CRUD events', () => {
  assert.equal(isInvoiceEvent({ source: 'BITRIX24', eventType: 'ONCRMDYNAMICITEMADD', externalEntityType: null, payload: { data: { FIELDS: { ENTITY_TYPE_ID: '31' } } } }), true);
  assert.equal(isInvoiceEvent({ source: 'BITRIX24', eventType: 'ONCRMDYNAMICITEMUPDATE', externalEntityType: null, payload: { data: { FIELDS: { ENTITY_TYPE_ID: '5' } } } }), false);
  assert.equal(isInvoiceEvent({ source: 'MOYSKLAD', eventType: 'CREATE', externalEntityType: 'invoiceout' }), true);
  assert.equal(isInvoiceEvent({ source: 'MOYSKLAD', eventType: 'UPDATE', externalEntityType: 'customerorder' }), false);
});

test('invoice creation boundary timestamps must be explicit and parseable', () => {
  assert.equal(invoiceCreatedAt({ createdTime: '2026-10-16T10:00:00Z' })?.toISOString(), '2026-10-16T10:00:00.000Z');
  assert.equal(invoiceCreatedAt({ updatedTime: '2026-10-16T10:00:00Z' }), null);
  assert.equal(invoiceCreatedAt({ created: 'not a date' }), null);
  assert.equal(invoiceCreatedAt({ created: '2026-10-21 12:49:23.123' })?.toISOString(), '2026-10-21T09:49:23.123Z');
  assert.equal(invoiceCreatedAt({ createdTime: '2026-10-21T12:49:23+03:00' })?.toISOString(), '2026-10-21T09:49:23.000Z');
  assert.equal(invoiceCreatedAt({ created: '2026-02-30 12:49:23' }), null);
});

test('paired invoices must both point to the exact already-paired deal and customer order', () => {
  const order = { bitrix24Id: '42', moyskladId: '12345678-1234-1234-1234-123456789abc' };
  assert.equal(invoicePairLinksMatchOrder({ parentId2: 42 }, { customerOrder: { id: order.moyskladId } }, order), true);
  assert.equal(invoicePairLinksMatchOrder({ parentId2: 43 }, { customerOrder: { id: order.moyskladId } }, order), false);
  assert.equal(invoicePairLinksMatchOrder({ parentId2: 42 }, { customerOrder: { id: '87654321-4321-4321-4321-cba987654321' } }, order), false);
  assert.equal(invoicePairLinksMatchOrder({ parentId2: 42 }, {}, order), false);
});
