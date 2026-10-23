export type BitrixMoneyRow = {
  price?: unknown;
  priceNetto?: unknown;
  priceBrutto?: unknown;
  discountTypeId?: unknown;
  discountRate?: unknown;
  discountSum?: unknown;
  taxRate?: unknown;
  taxIncluded?: unknown;
};

export type MoySkladMoney = {
  price: number;
  discount: number;
  vat: number;
  vatEnabled: boolean;
  vatIncluded: boolean | null;
};

export type BitrixMoney = { price: number; discountTypeId: 2; discountRate: number; discountSum: 0; taxRate: number | null; taxIncluded: 'Y' | 'N' };

/** MS price already includes VAT when vatIncluded=true; Bitrix price is final. */
export function moySkladMoneyToBitrix(input: { price: unknown; discount: unknown; vat: unknown; vatEnabled: unknown; vatIncluded: unknown }): BitrixMoney | null {
  const baseMicroCents = scaledMinorAmount(input.price);
  if (baseMicroCents === null ||
      typeof input.discount !== 'number' || !Number.isFinite(input.discount) || input.discount < 0 || input.discount > 100 ||
      typeof input.vatEnabled !== 'boolean') return null;
  const discountMicros = percentMicros(input.discount);
  if (discountMicros === null) return null;
  const tax = input.vatEnabled ? input.vat : 0;
  if (typeof tax !== 'number' || !Number.isFinite(tax) || tax < 0 || tax > 100) return null;
  if (input.vatEnabled && typeof input.vatIncluded !== 'boolean') return null;
  const afterDiscountCents = roundRatio(baseMicroCents * BigInt(100_000_000 - discountMicros), 100_000_000n * 1_000_000n);
  const taxMicros = percentMicros(tax);
  if (taxMicros === null) return null;
  const finalCents = input.vatEnabled && input.vatIncluded === false
    ? roundRatio(afterDiscountCents * BigInt(100_000_000 + taxMicros), 100_000_000n)
    : afterDiscountCents;
  if (finalCents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { price: Number(finalCents) / 100, discountTypeId: 2, discountRate: input.discount, discountSum: 0, taxRate: input.vatEnabled ? tax : null, taxIncluded: input.vatIncluded === true ? 'Y' : 'N' };
}

/**
 * Converts documented B24 row values into the Remap customer-order position
 * shape. Select the provider's own pre-discount amount in the same VAT mode:
 * priceBrutto when VAT is included, priceNetto otherwise. Never re-price from
 * the catalog or derive a rounded net value from an inclusive sale price.
 */
export function bitrixMoneyToMoySklad(row: BitrixMoneyRow): MoySkladMoney | null {
  const price = minorUnits(row.price);
  const priceNetto = providerMinorUnits(row.priceNetto);
  const priceBrutto = providerMinorUnits(row.priceBrutto);
  const type = row.discountTypeId;
  const rate = finite(row.discountRate);
  const sum = finite(row.discountSum);
  const sumMinor = minorUnits(row.discountSum);
  const tax = row.taxRate === null ? null : finite(row.taxRate);
  if (price === null || rate === null || sum === null || (row.taxRate !== null && tax === null) || (tax !== null && (tax < 0 || tax > 100))) return null;
  if (type !== 1 && type !== 2) return null;
  if (rate < 0 || rate > 100 || sum < 0) return null;
  const hasDiscount = type === 1 ? sum !== 0 : rate !== 0;
  const hasVat = tax !== null;
  if (hasVat && row.taxIncluded !== 'Y' && row.taxIncluded !== 'N') return null;
  const base = hasVat && row.taxIncluded === 'Y'
    ? priceBrutto ?? (!hasDiscount && row.priceBrutto === undefined ? price : null)
    : hasDiscount || hasVat ? priceNetto : price;
  if (base === null) return null;
  let discount = 0;
  if (type === 2) discount = rate;
  else if (sum !== 0) {
    const netBase = finite(row.priceNetto);
    if (sumMinor === null || !netBase || sum > netBase) return null;
    discount = roundRate(sum / netBase * 100);
    // MySklad stores a percentage, not an absolute value. Accept only an
    // equivalent percentage that reproduces the exact source discount in cents.
    if (Math.round(netBase * discount) !== sumMinor) return null;
  }
  const result = {
    price: base,
    discount,
    vat: tax ?? 0,
    vatEnabled: tax !== null,
    vatIncluded: hasVat ? row.taxIncluded === 'Y' : null,
  };
  const final = moySkladMoneyToBitrix({...result,vatIncluded:result.vatIncluded ?? false});
  // A format conversion must reproduce the source sale amount, not alter it.
  if (!final || minorUnits(final.price) !== price) return null;
  return result;
}

function minorUnits(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const raw = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const result = Math.round(value * 100);
  return Number.isSafeInteger(result) ? result : null;
}
/** Remap position.price is Float in minor units, not an integer-cent contract.
 * Preserve B24's eight-decimal pre-discount price; the final sale amount still
 * has to pass the exact-cent roundtrip above. Never infer a base from a total.
 */
function providerMinorUnits(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 100) return null;
  const scaled = Number((value * 100).toFixed(6));
  return scaledMinorAmount(scaled) === null ? null : scaled;
}
export function isMoySkladPositionPrice(value: unknown): value is number { return scaledMinorAmount(value) !== null; }
function scaledMinorAmount(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
  const parts = value.toFixed(6).split('.');
  if (!/^\d+$/.test(parts[0]!)) return null;
  return BigInt(parts[0]!) * 1_000_000n + BigInt(parts[1]!);
}
function finite(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function roundRate(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
function percentMicros(value: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  const scaled = value * 1_000_000;
  return Number.isSafeInteger(Math.round(scaled)) ? Math.round(scaled) : null;
}
function roundRatio(value: bigint, denominator: bigint): bigint { return (value + denominator / 2n) / denominator; }
