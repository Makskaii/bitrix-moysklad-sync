export type ProductCatalogCandidate = {
  id: string;
  name: string | null;
  kind: 'product' | 'service';
  priceTypeKey: string | null;
  price: number | null;
  currency: string | null;
  taxSemantics: string | null;
  createdAt: string | Date | null;
};

export type ProductCatalogSelection =
  | { status: 'none' }
  | { status: 'selected'; candidateId: string; selectionReason: 'EARLIEST_CREATION_DATE' | 'CREATION_DATE_TIED_NATIVE_ID' | 'CREATION_DATE_UNAVAILABLE_NATIVE_ID' };

/** Exact identity/price comparison. The caller supplies values from the same configured price-type pair. */
export function comparableCatalogPrice(left: ProductCatalogCandidate, right: ProductCatalogCandidate): boolean {
  if (!left.id || !right.id || left.kind !== right.kind || left.name === null || left.name !== right.name) return false;
  if (!left.priceTypeKey || left.priceTypeKey !== right.priceTypeKey) return false;
  if (left.price === null || right.price === null || !Number.isFinite(left.price) || !Number.isFinite(right.price) || left.price !== right.price) return false;
  if (!isCurrency(left.currency) || !isCurrency(right.currency) || left.currency !== right.currency) return false;
  if (!left.taxSemantics || left.taxSemantics !== right.taxSemantics) return false;
  return true;
}

/**
 * The incoming item must already have passed exact configured price comparability.
 * Existing pairs are resolved by the caller before this policy is invoked.
 * Among exact unpaired candidates, the earliest reliable creation date wins;
 * ties or unavailable dates use native ID for deterministic selection.
 */
export function chooseProductCatalogCandidate(candidates: ProductCatalogCandidate[]): ProductCatalogSelection {
  const eligible = candidates.filter((candidate) => candidate.id.length > 0 && candidate.name !== null);
  if (!eligible.length) return { status: 'none' };

  const withCreation = eligible.map((candidate) => ({ candidate, time: validDate(candidate.createdAt) }));
  const validTimes = withCreation.flatMap(({ time }) => time === null ? [] : [time]);
  const creationUnavailable = validTimes.length !== withCreation.length;
  let selectionReason: Extract<ProductCatalogSelection, { status: 'selected' }>['selectionReason'];
  let ranked = eligible;
  if (validTimes.length && !creationUnavailable) {
    const earliest = Math.min(...validTimes);
    ranked = withCreation.filter(({ time }) => time === earliest).map(({ candidate }) => candidate);
    selectionReason = ranked.length > 1 ? 'CREATION_DATE_TIED_NATIVE_ID' : 'EARLIEST_CREATION_DATE';
  } else {
    selectionReason = 'CREATION_DATE_UNAVAILABLE_NATIVE_ID';
  }
  const byId = [...ranked].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const winner = byId[0]!;
  return { status: 'selected', candidateId: winner.id, selectionReason };
}

function validDate(value: string | Date | null): number | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

function isCurrency(value: string | null): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}
