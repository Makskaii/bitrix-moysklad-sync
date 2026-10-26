import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bitrixDocumentTotal, moyskladDocumentTotal } from '../src/deals-orders/document-total-snapshot';

test('native unexpanded currency uses the exact configured UUID mapping and minor-unit sums become major-unit decimals', () => {
  const old = process.env.MOYSKLAD_API_BASE_URL;
  process.env.MOYSKLAD_API_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2/';
  const id = '02afc9d5-d515-11e2-4ba4-7054d21a8d1e';
  const currency = { meta: { href: process.env.MOYSKLAD_API_BASE_URL+'entity/currency/'+id, type:'currency' } };
  const config = { dealOrderRuntime: { currencies:[{bitrix24Code:'RUB',moyskladId:id}] } } as any;
  try {
    assert.deepEqual(moyskladDocumentTotal({sum:34200,rate:{currency}},config), {amount:'342',currencyCode:'RUB',amountUnit:'major-v1'});
    assert.deepEqual(bitrixDocumentTotal({OPPORTUNITY:'342.00',CURRENCY_ID:'RUB'}), {amount:'342.00',currencyCode:'RUB',amountUnit:'major-v1'});
    for (const [minor,major] of [[0,'0'],[1,'0.01'],[110,'1.1'],[12345,'123.45']] as const) assert.equal(moyskladDocumentTotal({sum:minor,rate:{currency}},config).amount,major);
    assert.equal(moyskladDocumentTotal({sum:34200,rate:{currency:{...currency,isoCode:'643'}}},config).currencyCode,'RUB');
    assert.equal(moyskladDocumentTotal({sum:34200,rate:{currency:{...currency,code:'USD'}}},config).currencyCode,null);
    assert.equal(moyskladDocumentTotal({sum:34200,rate:{currency:{...currency,id:'ffffffff-ffff-ffff-ffff-ffffffffffff'}}},config).currencyCode,null);
    assert.equal(moyskladDocumentTotal({sum:34200,rate:{currency:{meta:{...currency.meta,href:currency.meta.href.replace('api.moysklad.ru','foreign.invalid')}}}},config).currencyCode,null);
    assert.equal(moyskladDocumentTotal({sum:34200,rate:{currency}}, {dealOrderRuntime:{currencies:[...config.dealOrderRuntime.currencies,...config.dealOrderRuntime.currencies]}} as any).currencyCode,null);
    assert.equal(moyskladDocumentTotal({sum:34200,rate:{currency}},{} as any).currencyCode,null);
    for (const invalid of [-1,1.1,Number.MAX_SAFE_INTEGER+1,'34200',null]) assert.equal(moyskladDocumentTotal({sum:invalid,rate:{currency}},config).amount,null);
  } finally { if(old===undefined) delete process.env.MOYSKLAD_API_BASE_URL; else process.env.MOYSKLAD_API_BASE_URL=old; }
});
