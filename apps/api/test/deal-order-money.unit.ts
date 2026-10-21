import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bitrixMoneyToMoySklad, moySkladMoneyToBitrix } from '../src/deals-orders/deal-order-money';

test('percentage discount and included VAT use explicit Bitrix pre-discount unit amount', () => {
  assert.deepEqual(bitrixMoneyToMoySklad({ price: 108, priceNetto: 100, priceBrutto:120, discountTypeId: 2, discountRate: 10, discountSum: 10, taxRate: 20, taxIncluded: 'Y' }), {
    price: 12000, discount: 10, vat: 20, vatEnabled: true, vatIncluded: true,
  });
});

test('absolute discount converts only when its equivalent percentage reproduces the exact cent amount', () => {
  assert.deepEqual(bitrixMoneyToMoySklad({ price: 90, priceNetto: 100, discountTypeId: 1, discountRate: 0, discountSum: 10, taxRate: null, taxIncluded: 'N' }), {
    price: 10000, discount: 10, vat: 0, vatEnabled: false, vatIncluded: null,
  });
  assert.equal(bitrixMoneyToMoySklad({ price: 0, priceNetto: 100, discountTypeId: 1, discountRate: 0, discountSum: 100.01, taxRate: null, taxIncluded: 'N' }), null);
});

test('excluded VAT remains enabled and missing base, invalid tax flag, or sub-cent values are rejected', () => {
  assert.deepEqual(bitrixMoneyToMoySklad({ price: 120, priceNetto: 100, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: 20, taxIncluded: 'N' }), {
    price: 10000, discount: 0, vat: 20, vatEnabled: true, vatIncluded: false,
  });
  assert.equal(bitrixMoneyToMoySklad({ price: 120, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: 20, taxIncluded: 'N' }), null);
  assert.equal(bitrixMoneyToMoySklad({ price: 120, priceNetto: 100, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: 20, taxIncluded: 'maybe' }), null);
  assert.equal(bitrixMoneyToMoySklad({ price: 10.001, priceNetto: 10, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: null, taxIncluded: 'N' }), null);
});

test('MySklad discounts and included/excluded VAT become Bitrix row values without guessing VAT defaults', () => {
  assert.deepEqual(moySkladMoneyToBitrix({ price: 10000, discount: 10, vat: 20, vatEnabled: true, vatIncluded: true }), {
    price: 90, discountTypeId: 2, discountRate: 10, discountSum: 0, taxRate: 20, taxIncluded: 'Y',
  });
  assert.deepEqual(moySkladMoneyToBitrix({ price: 10000, discount: 10, vat: 20, vatEnabled: true, vatIncluded: false }), {
    price: 108, discountTypeId: 2, discountRate: 10, discountSum: 0, taxRate: 20, taxIncluded: 'N',
  });
  assert.deepEqual(moySkladMoneyToBitrix({ price: 10000, discount: 0, vat: 0, vatEnabled: true, vatIncluded: false }), {
    price: 100, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: 0, taxIncluded: 'N',
  });
  assert.equal(moySkladMoneyToBitrix({ price: 10000, discount: 0, vat: 20, vatEnabled: true, vatIncluded: undefined }), null);
});

test('native picker inclusive price is copied despite sub-cent net price; inconsistent sale totals fail closed',()=>{
  const row={price:171,priceBrutto:171,priceNetto:140.16393443,discountTypeId:2,discountRate:0,discountSum:0,taxRate:22,taxIncluded:'Y'};
  assert.deepEqual(bitrixMoneyToMoySklad(row),{price:17100,discount:0,vat:22,vatEnabled:true,vatIncluded:true});
  assert.equal(bitrixMoneyToMoySklad({...row,price:170}),null);
  assert.equal(bitrixMoneyToMoySklad({...row,taxRate:undefined}),null);
  assert.deepEqual(bitrixMoneyToMoySklad({...row,price:153.9,discountRate:10}),{price:17100,discount:10,vat:22,vatEnabled:true,vatIncluded:true});
});
