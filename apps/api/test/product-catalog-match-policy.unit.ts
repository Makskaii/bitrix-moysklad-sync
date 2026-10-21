import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { chooseProductCatalogCandidate, comparableCatalogPrice } from '../src/products/product-catalog-match-policy';

test('catalog matching requires exact title, product kind, configured price type, currency and tax semantics', () => {
  const base = {
    id: 'b-1', kind: 'product' as const, name: 'Widget', priceTypeKey: '11:retail', price: 125,
    currency: 'RUB', taxSemantics: 'vat20-included', createdAt: '2025-01-01T00:00:00Z',
  };
  assert.equal(comparableCatalogPrice(base, { ...base, name: 'Widget ' }), false);
  assert.equal(comparableCatalogPrice(base, { ...base, kind: 'service' }), false);
  assert.equal(comparableCatalogPrice(base, { ...base, id: 'b-2', price: 125.01 }), false);
  assert.equal(comparableCatalogPrice(base, { ...base, currency: '' }), false);
  assert.equal(comparableCatalogPrice(base, { ...base, id: 'b-2', taxSemantics: 'vat20-excluded' }), false);
  assert.equal(comparableCatalogPrice(base, { ...base, id: 'b-2', priceTypeKey: '11:wholesale' }), false);
  assert.equal(comparableCatalogPrice({ ...base, price: 0 }, { ...base, id: 'b-2', price: 0 }), true);
});

test('catalog match selects earliest-created exact candidate regardless of legacy usage fields', () => {
  const selected = chooseProductCatalogCandidate([
    { id: 'b-2', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: '2025-01-02' },
    { id: 'b-1', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: '2025-01-01' },
  ]);
  assert.deepEqual(selected, { status: 'selected', candidateId: 'b-1', selectionReason: 'EARLIEST_CREATION_DATE' });
});

test('equal or unavailable creation dates use stable native ID and record the reason', () => {
  const tie = chooseProductCatalogCandidate([
    { id: 'b-2', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: '2025-01-01' },
    { id: 'b-1', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: '2025-01-01' },
  ]);
  assert.deepEqual(tie, { status: 'selected', candidateId: 'b-1', selectionReason: 'CREATION_DATE_TIED_NATIVE_ID' });
  const unknown = chooseProductCatalogCandidate([
    { id: 'b-2', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: null },
    { id: 'b-1', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: null },
  ]);
  assert.deepEqual(unknown, { status: 'selected', candidateId: 'b-1', selectionReason: 'CREATION_DATE_UNAVAILABLE_NATIVE_ID' });
  const partial = chooseProductCatalogCandidate([
    { id: 'z-date-known', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: '2020-01-01' },
    { id: 'a-date-unknown', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: null },
  ]);
  assert.deepEqual(partial, { status: 'selected', candidateId: 'a-date-unknown', selectionReason: 'CREATION_DATE_UNAVAILABLE_NATIVE_ID' },
    'one missing date makes the whole candidate set incomparable by creation time');
});

test('catalog matching never chooses among invalid candidates or candidates with conflicting dates and IDs', () => {
  assert.deepEqual(chooseProductCatalogCandidate([]), { status: 'none' });
  assert.deepEqual(chooseProductCatalogCandidate([
    { id: '', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: null },
  ]), { status: 'none' });
});
