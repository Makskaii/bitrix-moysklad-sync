export type BitrixMoneyRow = {
  price?: unknown;
  priceNetto?: unknown;
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

/** Maps an MS base unit price to Bitrix24's documented row price (after discount,
 * and including VAT only when the row says the tax is included). */
export function moySkladMoneyToBitrix(input: { price: unknown; discount: unknown; vat: unknown; vatEnabled: unknown; vatIncluded: unknown }): BitrixMoney | null {
  if (typeof input.price !== 'number' || !Number.isSafeInteger(input.price) || input.price < 0 ||
      typeof input.discount !== 'number' || !Number.isFinite(input.discount) || input.discount < 0 || input.discount > 100 ||
      typeof input.vatEnabled !== 'boolean') return null;
  const discountMicros = percentMicros(input.discount);
  if (discountMicros === null) return null;
  const tax = input.vatEnabled ? input.vat : 0;
  if (typeof tax !== 'number' || !Number.isFinite(tax) || tax < 0 || tax > 100) return null;
  if (input.vatEnabled && typeof input.vatIncluded !== 'boolean') return null;
  const baseCents = BigInt(input.price);
  const afterDiscountCents = roundRatio(baseCents * BigInt(100_000_000 - discountMicros), 100_000_000n);
  const taxMicros = percentMicros(tax);
  if (taxMicros === null) return null;
  const finalCents = input.vatEnabled && input.vatIncluded === true
    ? roundRatio(afterDiscountCents * BigInt(100_000_000 + taxMicros), 100_000_000n)
    : afterDiscountCents;
  if (finalCents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { price: Number(finalCents) / 100, discountTypeId: 2, discountRate: input.discount, discountSum: 0, taxRate: input.vatEnabled ? tax : null, taxIncluded: input.vatIncluded === true ? 'Y' : 'N' };
}

/**
 * Converts documented B24 row values into the Remap customer-order position
 * shape. This deliberately requires Bitrix's calculated pre-discount/net
 * `priceNetto` whenever a discount or VAT is present; deriving a base from the
 * final `price` would depend on undocumented rounding/order of operations.
 */
export function bitrixMoneyToMoySklad(row: BitrixMoneyRow): MoySkladMoney | null {
  const price = minorUnits(row.price);
  const priceNetto = minorUnits(row.priceNetto);
  const type = row.discountTypeId;
  const rate = finite(row.discountRate);
  const sum = finite(row.discountSum);
  const sumMinor = minorUnits(row.discountSum);
  const tax = row.taxRate === null ? null : finite(row.taxRate);
  if (price === null || rate === null || sum === null || (tax !== null && (tax === null || tax < 0 || tax > 100))) return null;
  if (type !== 1 && type !== 2) return null;
  if (rate < 0 || rate > 100 || sum < 0) return null;
  const hasDiscount = type === 1 ? sum !== 0 : rate !== 0;
  const hasVat = tax !== null;
  if (hasDiscount || hasVat) {
    if (priceNetto === null) return null;
  }
  let discount = 0;
  if (type === 2) discount = rate;
  else if (sum !== 0) {
    if (sumMinor === null || !priceNetto || sumMinor > priceNetto) return null;
    discount = roundRate(sumMinor / priceNetto * 100);
    // MySklad stores a percentage, not an absolute value. Accept only an
    // equivalent percentage that reproduces the exact source discount in cents.
    if (Math.round(priceNetto * discount / 100) !== sumMinor) return null;
  }
  if (hasVat && row.taxIncluded !== 'Y' && row.taxIncluded !== 'N') return null;
  return {
    price: hasDiscount || hasVat ? priceNetto! : price,
    discount,
    vat: tax ?? 0,
    vatEnabled: tax !== null,
    vatIncluded: hasVat ? row.taxIncluded === 'Y' : null,
  };
}

function minorUnits(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const raw = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const result = Math.round(value * 100);
  return Number.isSafeInteger(result) ? result : null;
}
function finite(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function roundRate(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
function percentMicros(value: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  const scaled = value * 1_000_000;
  return Number.isSafeInteger(Math.round(scaled)) ? Math.round(scaled) : null;
}
function roundRatio(value: bigint, denominator: bigint): bigint { return (value + denominator / 2n) / denominator; }
