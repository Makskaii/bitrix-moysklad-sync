export type InvoiceGoodsValue = { productType: string; productId: string; quantity: number; price: number; discount: number; vat: number };
export type InvoiceGoodsRow = { id: string; value: InvoiceGoodsValue };
export type InvoiceGoodsBinding = { sourceId: string; targetId: string; source: InvoiceGoodsValue; target: InvoiceGoodsValue };
export type InvoiceGoodsState = { version: 1; vatEnabled: boolean; vatIncluded: boolean; rows: InvoiceGoodsBinding[] };
export type InvoiceGoodsAction = { kind: 'update'; source: InvoiceGoodsRow; targetId: string } | { kind: 'add'; source: InvoiceGoodsRow };
export class InvoiceGoodsReview extends Error {}

/** No deletes, guessed row identities, or overwrites of independently changed MS rows. */
export function planInvoiceGoods(source: InvoiceGoodsRow[], target: InvoiceGoodsRow[], state: InvoiceGoodsState | null,
  mode: { vatEnabled: boolean; vatIncluded: boolean }, targetMode: { vatEnabled: boolean; vatIncluded: boolean }): { state: InvoiceGoodsState; actions: InvoiceGoodsAction[] } {
  if (new Set(source.map((r) => r.id)).size !== source.length || new Set(target.map((r) => r.id)).size !== target.length) throw new InvoiceGoodsReview('INVOICE_GOODS_ROW_ID_AMBIGUOUS');
  if (mode.vatEnabled !== targetMode.vatEnabled || mode.vatIncluded !== targetMode.vatIncluded) throw new InvoiceGoodsReview('INVOICE_GOODS_VAT_MODE_CHANGED');
  const known: InvoiceGoodsState = state ? structuredClone(state) : { version: 1, ...mode, rows: [] };
  if (known.version !== 1 || !Array.isArray(known.rows) || known.vatEnabled !== mode.vatEnabled || known.vatIncluded !== mode.vatIncluded) throw new InvoiceGoodsReview('INVOICE_GOODS_STATE_INVALID');
  if (new Set(known.rows.map((r) => r.sourceId)).size !== known.rows.length || new Set(known.rows.map((r) => r.targetId)).size !== known.rows.length) throw new InvoiceGoodsReview('INVOICE_GOODS_STATE_INVALID');
  const actions: InvoiceGoodsAction[] = [];
  for (const binding of known.rows) {
    const s = source.find((r) => r.id === binding.sourceId), t = target.find((r) => r.id === binding.targetId);
    if (!s) throw new InvoiceGoodsReview('INVOICE_GOODS_SOURCE_ROW_REMOVED');
    if (!t) throw new InvoiceGoodsReview('INVOICE_GOODS_TARGET_ROW_REMOVED');
    if (sameGoods(s.value, t.value)) { binding.source = s.value; binding.target = t.value; continue; }
    if (!sameGoods(t.value, binding.target)) throw new InvoiceGoodsReview('INVOICE_GOODS_TARGET_CHANGED');
    if (!sameGoods(s.value, binding.source)) actions.push({ kind: 'update', source: s, targetId: t.id });
    else throw new InvoiceGoodsReview('INVOICE_GOODS_TARGET_CHANGED');
  }
  const unbound = source.filter((r) => !known.rows.some((b) => b.sourceId === r.id));
  if (unbound.some((r, i) => unbound.some((other, j) => i !== j && sameGoods(r.value, other.value)))) throw new InvoiceGoodsReview('INVOICE_GOODS_NEW_ROWS_AMBIGUOUS');
  for (const s of unbound) {
    const matches = target.filter((r) => !known.rows.some((b) => b.targetId === r.id) && sameGoods(s.value, r.value));
    if (matches.length > 1) throw new InvoiceGoodsReview('INVOICE_GOODS_BOOTSTRAP_AMBIGUOUS');
    if (matches.length === 1) { known.rows.push({sourceId:s.id,targetId:matches[0]!.id,source:s.value,target:matches[0]!.value}); continue; }
    if (!state) throw new InvoiceGoodsReview('INVOICE_GOODS_BOOTSTRAP_MISMATCH');
    actions.push({kind:'add',source:s});
  }
  if (target.some((r) => !known.rows.some((b) => b.targetId === r.id))) throw new InvoiceGoodsReview('INVOICE_GOODS_TARGET_ROW_UNEXPECTED');
  return {state:known,actions};
}

export function sameGoods(a: InvoiceGoodsValue, b: InvoiceGoodsValue): boolean {
  return a.productType === b.productType && a.productId === b.productId && a.quantity === b.quantity && a.price === b.price && a.discount === b.discount && a.vat === b.vat;
}

export function invoiceGoodsValue(value: Record<string, unknown>, base: string): InvoiceGoodsValue {
  const assortment = record(value.assortment), meta = record(assortment.meta);
  const href = typeof meta.href === 'string' ? meta.href : '';
  const id = href.split('/').at(-1) ?? '';
  if (!['product','service'].includes(String(meta.type)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || href !== new URL(`entity/${meta.type}/${id}`, base.replace(/\/?$/,'/')).href ||
      typeof value.quantity !== 'number' || !Number.isFinite(value.quantity) || value.quantity <= 0 ||
      typeof value.price !== 'number' || !Number.isSafeInteger(value.price) || value.price < 0 ||
      typeof value.discount !== 'number' || !Number.isFinite(value.discount) || value.discount < 0 || value.discount > 100 ||
      typeof value.vat !== 'number' || !Number.isFinite(value.vat) || value.vat < 0 || value.vat > 100) throw new InvoiceGoodsReview('INVOICE_GOODS_VALUE_INVALID');
  return {productType:String(meta.type),productId:id,quantity:value.quantity,price:value.price,discount:value.discount,vat:value.vat};
}
function record(value: unknown): Record<string,unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {}; }
