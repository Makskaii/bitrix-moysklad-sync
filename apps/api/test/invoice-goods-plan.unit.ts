import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { invoiceGoodsValue, InvoiceGoodsRow, InvoiceGoodsState, planInvoiceGoods } from '../src/invoices/invoice-goods-plan';
const mode={vatEnabled:false,vatIncluded:false};
const value={productType:'product',productId:'d813b5d2-5939-11ee-0a80-1143000e2d5c',quantity:1,price:41800,discount:0,vat:0};
const s:InvoiceGoodsRow={id:'886458',value},t:InvoiceGoodsRow={id:'922ad01a-cd39-11f1-0a80-0d2d0074384b',value};
const state:InvoiceGoodsState={version:1,...mode,rows:[{sourceId:s.id,targetId:t.id,source:value,target:value}]};
test('invoice goods bootstrap needs unique exact native identities and values',()=>{
  assert.deepEqual(planInvoiceGoods([s],[t],null,mode,mode),{state,actions:[]});
  assert.throws(()=>planInvoiceGoods([s],[{...t,value:{...value,price:999}}],null,mode,mode),/BOOTSTRAP_MISMATCH/);
  assert.throws(()=>planInvoiceGoods([s],[t,{...t,id:'other'}],null,mode,mode),/BOOTSTRAP_AMBIGUOUS/);
  assert.throws(()=>planInvoiceGoods([s,{...s,id:'other'}],[t],null,mode,mode),/NEW_ROWS_AMBIGUOUS/);
});
test('invoice goods keep native IDs, recover successful writes and never plan deletes or overwrite MS changes',()=>{
  const changed={...s,value:{...value,quantity:2}};
  assert.deepEqual(planInvoiceGoods([changed],[t],state,mode,mode).actions,[{kind:'update',source:changed,targetId:t.id}]);
  const recovered=planInvoiceGoods([changed],[{...t,value:changed.value}],state,mode,mode);
  assert.equal(recovered.actions.length,0);assert.equal(recovered.state.rows[0]!.source.quantity,2);
  assert.throws(()=>planInvoiceGoods([], [t],state,mode,mode),/SOURCE_ROW_REMOVED/);
  assert.throws(()=>planInvoiceGoods([s], [],state,mode,mode),/TARGET_ROW_REMOVED/);
  assert.throws(()=>planInvoiceGoods([s],[{...t,value:{...value,price:999}}],state,mode,mode),/TARGET_CHANGED/);
  assert.throws(()=>planInvoiceGoods([s],[t],state,{...mode,vatEnabled:true},mode),/VAT_MODE_CHANGED/);
  const add={id:'new',value:{...value,price:5000}};
  assert.deepEqual(planInvoiceGoods([s,add],[t],state,mode,mode).actions,[{kind:'add',source:add}]);
  const found=planInvoiceGoods([s,add],[t,{id:'recovered',value:add.value}],state,mode,mode);
  assert.equal(found.actions.length,0);assert.equal(found.state.rows[1]!.targetId,'recovered');
});
test('invoice goods values reject foreign native references and unsafe money',()=>{
  const base='https://api.moysklad.ru/api/remap/1.2/';
  const native={quantity:1,price:41800,discount:0,vat:0,assortment:{meta:{href:base+'entity/product/'+value.productId,type:'product'}}};
  assert.deepEqual(invoiceGoodsValue(native,base),value);
  assert.equal(invoiceGoodsValue({...native,price:41800.5},base).price,41800.5);
  assert.throws(()=>invoiceGoodsValue({...native,price:Infinity},base),/VALUE_INVALID/);
  assert.throws(()=>invoiceGoodsValue({...native,assortment:{meta:{...native.assortment.meta,href:native.assortment.meta.href.replace('api.moysklad.ru','foreign.invalid')}}},base),/VALUE_INVALID/);
});
