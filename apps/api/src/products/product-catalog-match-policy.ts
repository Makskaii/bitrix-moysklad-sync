export type CatalogUsage = {
  count: number;
  source: string;
  coverage: string;
} | null;

export type ProductCatalogCandidate = {
  id: string;
  name: string | null;
  kind: 'product' | 'service';
  priceTypeKey: string | null;
  price: number | null;
  currency: string | null;
  taxSemantics: string | null;
  createdAt: string | Date | null;
  usage: CatalogUsage;
};

export type ProductCatalogSelection =
  | { status: 'none' }
  | { status: 'selected'; candidateId: string; usageSource: string; usageCoverage: string; tieBreak: 'usage' | 'creation' | 'creation-and-id' };

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
 * Usage is ranked only when every candidate has a value from the same source and
 * coverage declaration; otherwise creation time is the only defensible fallback.
 */
export function chooseProductCatalogCandidate(candidates: ProductCatalogCandidate[]): ProductCatalogSelection {
  const eligible = candidates.filter((candidate) => candidate.id.length > 0 && candidate.name !== null);
  if (!eligible.length) return { status: 'none' };

  const firstUsage = eligible[0]?.usage;
  const comparableUsage = !!firstUsage && Number.isSafeInteger(firstUsage.count) && firstUsage.count >= 0 &&
    eligible.every((candidate) => candidate.usage && Number.isSafeInteger(candidate.usage.count) && candidate.usage.count >= 0 &&
      candidate.usage.source === firstUsage.source && candidate.usage.coverage === firstUsage.coverage);

  let ranked = eligible;
  let tieBreak: ProductCatalogSelection extends infer _ ? 'usage' | 'creation' | 'creation-and-id' : never = 'creation';
  if (comparableUsage) {
    const highest = Math.max(...eligible.map((candidate) => candidate.usage!.count));
    ranked = eligible.filter((candidate) => candidate.usage!.count === highest);
    if (ranked.length === 1) {
      const winner = ranked[0]!;
      return { status: 'selected', candidateId: winner.id, usageSource: firstUsage!.source, usageCoverage: firstUsage!.coverage, tieBreak: 'usage' };
    }
  }

  const withCreation = ranked.map((candidate) => ({ candidate, time: validDate(candidate.createdAt) }));
  const validTimes = withCreation.flatMap(({ time }) => time === null ? [] : [time]);
  const creationUnavailable = validTimes.length !== withCreation.length;
  if (validTimes.length && !creationUnavailable) {
    const earliest = Math.min(...validTimes);
    ranked = withCreation.filter(({ time }) => time === earliest).map(({ candidate }) => candidate);
  }
  const byId = [...ranked].sort((left, right) => left.id.localeCompare(right.id));
  const winner = byId[0]!;
  const creationTied = byId.length > 1 || creationUnavailable;
  tieBreak = creationTied ? 'creation-and-id' : 'creation';
  const source = comparableUsage ? firstUsage!.source : 'unavailable';
  const coverage = comparableUsage ? firstUsage!.coverage : 'unavailable';
  return { status: 'selected', candidateId: winner.id, usageSource: source, usageCoverage: coverage, tieBreak };
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
