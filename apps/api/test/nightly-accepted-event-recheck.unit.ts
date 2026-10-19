import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { acceptedRecheckEntities } from '../src/sync-recovery.service';

test('accepted-event nightly scope routes supported non-delete events by entity', () => {
  assert.deepEqual(acceptedRecheckEntities('BITRIX24', 'ONCRMCONTACTUPDATE', 'contact'), [
    { entity: 'CONTACT', scope: 'contacts-companies' },
  ]);
  assert.deepEqual(acceptedRecheckEntities('MOYSKLAD', 'UPDATE', 'customerorder'), [
    { entity: 'DEAL', scope: 'deals-orders' },
  ]);
  assert.deepEqual(acceptedRecheckEntities('MOYSKLAD', 'UPDATE', 'invoiceout'), [
    { entity: 'INVOICE', scope: 'invoices' },
  ]);
  assert.deepEqual(acceptedRecheckEntities('MOYSKLAD', 'UPDATE', 'product'), [
    { entity: 'PRODUCT', scope: 'products-variations' },
  ]);
});

test('accepted-event nightly scope routes deletes to their lifecycle entity', () => {
  assert.deepEqual(acceptedRecheckEntities('BITRIX24', 'ONCRMDEALDELETE', 'deal'), [
    { entity: 'DEAL', scope: 'deals-orders' },
  ]);
  assert.deepEqual(acceptedRecheckEntities('MOYSKLAD', 'DELETE', 'customerorder'), [
    { entity: 'DEAL', scope: 'deals-orders' },
  ]);
  assert.deepEqual(acceptedRecheckEntities('MOYSKLAD', 'DELETE', 'counterparty'), [
    { entity: 'COMPANY', scope: 'contacts-companies' }, { entity: 'CONTACT', scope: 'contacts-companies' },
  ]);
});

test('accepted-event nightly scope excludes unsupported product events', () => {
  assert.deepEqual(acceptedRecheckEntities('BITRIX24', 'CATALOG.PRICE.ON.UPDATE', 'catalogprice'), []);
  assert.deepEqual(acceptedRecheckEntities('MOYSKLAD', 'CREATE', 'service'), []);
});
