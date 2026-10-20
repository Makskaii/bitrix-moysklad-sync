import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { chooseProductCatalogCandidate, comparableCatalogPrice } from '../src/products/product-catalog-match-policy';

test('catalog matching requires exact title, product kind, configured price type, currency and tax semantics', () => {
  const base = {
    id: 'b-1', kind: 'product' as const, name: 'Widget', priceTypeKey: '11:retail', price: 125,
    currency: 'RUB', taxSemantics: 'vat20-included', createdAt: '2025-01-01T00:00:00Z', usage: null,
  };
  assert.equal(comparableCatalogPrice(base, { ...base, name: 'Widget ' }), false);
  assert.equal(comparableCatalogPrice(base, { ...base, kind: 'service' }), false);
  assert.equal(comparableCatalogPrice(base, { ...base, id: 'b-2', price: 125.01 }), false);
  assert.equal(comparableCatalogPrice(base, { ...base, currency: '' }), false);
  assert.equal(comparableCatalogPrice(base, { ...base, id: 'b-2', taxSemantics: 'vat20-excluded' }), false);
  assert.equal(comparableCatalogPrice(base, { ...base, id: 'b-2', priceTypeKey: '11:wholesale' }), false);
  assert.equal(comparableCatalogPrice({ ...base, price: 0 }, { ...base, id: 'b-2', price: 0 }), true);
});

test('catalog match selects highest comparable usage and records its evidence source', () => {
  const selected = chooseProductCatalogCandidate([
    { id: 'b-1', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: '2025-01-01', usage: { count: 3, source: 'document-index', coverage: 'complete' } },
    { id: 'b-2', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: '2025-01-02', usage: { count: 8, source: 'document-index', coverage: 'complete' } },
  ]);
  assert.deepEqual(selected, { status: 'selected', candidateId: 'b-2', usageSource: 'document-index', usageCoverage: 'complete', tieBreak: 'usage' });
});

test('equal or unavailable usage falls back to earliest creation then stable ID, without treating unknown as zero', () => {
  const tie = chooseProductCatalogCandidate([
    { id: 'b-2', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: '2025-01-02', usage: { count: 1, source: 'document-index', coverage: 'complete' } },
    { id: 'b-1', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: '2025-01-01', usage: { count: 1, source: 'document-index', coverage: 'complete' } },
  ]);
  assert.deepEqual(tie, { status: 'selected', candidateId: 'b-1', usageSource: 'document-index', usageCoverage: 'complete', tieBreak: 'creation' });
  const unknown = chooseProductCatalogCandidate([
    { id: 'b-2', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: '2025-01-01', usage: null },
    { id: 'b-1', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: '2025-01-01', usage: null },
  ]);
  assert.deepEqual(unknown, { status: 'selected', candidateId: 'b-1', usageSource: 'unavailable', usageCoverage: 'unavailable', tieBreak: 'creation-and-id' });
});

test('catalog matching never chooses among invalid candidates or candidates with conflicting dates and IDs', () => {
  assert.deepEqual(chooseProductCatalogCandidate([]), { status: 'none' });
  assert.deepEqual(chooseProductCatalogCandidate([
    { id: '', name: 'Widget', kind: 'product', priceTypeKey: '11:retail', price: 10, currency: 'RUB', taxSemantics: 'vat20-included', createdAt: null, usage: null },
  ]), { status: 'none' });
});
