import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { moyskladUomReferenceId as id } from '../src/deals-orders/moysklad-uom-reference';
test('MS native uom relation accepts exact href and expanded ID, rejects foreign/conflicting/malformed relations',()=>{
  const base=new URL('https://api.moysklad.ru/api/remap/1.2/');
  const uuid='11111111-2222-3333-4444-555555555555';
  const meta={type:'uom',href:new URL('entity/uom/'+uuid,base).href};
  assert.equal(id({meta},base),uuid);
  assert.equal(id({id:uuid},base),uuid);
  assert.equal(id({id:uuid,meta},base),uuid);
  for(const value of [{id:796},{meta:{...meta,type:'product'}},{meta:{...meta,href:meta.href+'?extra=1'}},{meta:{...meta,href:meta.href.replace('api.moysklad.ru','foreign.invalid')}},{id:'11111111-2222-3333-4444-555555555556',meta},null]) assert.equal(id(value,base),null);
});
