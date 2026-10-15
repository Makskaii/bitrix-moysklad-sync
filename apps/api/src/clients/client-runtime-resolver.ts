export type ClientEntity = 'COMPANY' | 'CONTACT';
export type ClientTargetType = 'counterparty' | 'contactperson';
export type ClientSystem = 'BITRIX24' | 'MOYSKLAD';

export type ClientCandidate = {
  id: string;
  type: ClientTargetType | 'company' | 'contact';
  parentId?: string | null;
  inn?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  createdAt: string;
  usageCount: number | null;
  /** True only when the service has established that the usage endpoint is unavailable systemwide. */
  usageMetricUnavailable?: boolean;
  filledFields: number;
  occupiedByPair: boolean;
  duplicateMarked?: boolean | null;
};

export type ClientSource = {
  id: string;
  entity: ClientEntity;
  sourceSystem?: ClientSystem;
  inn?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  companyId?: string | null;
};

export type ClientResolution =
  | { action: 'USE_PAIR'; targetId: string; targetType: ClientTargetType | 'company' | 'contact'; targetSystem: ClientSystem; reason: 'PERSISTED_PAIR' }
  | { action: 'USE_CANDIDATE'; targetId: string; targetType: ClientTargetType | 'company' | 'contact'; targetSystem: ClientSystem; reason: string; evidence: CandidateEvidence }
  | { action: 'CREATE'; targetType: ClientTargetType | 'company' | 'contact'; targetSystem: ClientSystem; reason: 'NO_CANDIDATE' | 'NO_CONTACT_KEYS' }
  | { action: 'MANUAL_REVIEW'; reason: 'INCOMPLETE_USAGE_METRICS' | 'AMBIGUOUS_CANDIDATES' | 'PRIMARY_COMPANY_UNRESOLVED' | 'MISSING_REQUIRED_NAME'; candidates: string[] };

export type CandidateEvidence = {
  usageCount: number | null;
  filledFields: number;
  createdAt: string;
  usageMetricDegraded: boolean;
  criteria: string[];
};

export interface ClientCandidateGateway {
  findPair(entity: ClientEntity, sourceId: string, sourceSystem?: ClientSystem): Promise<{ targetId: string; targetType: ClientTargetType | 'company' | 'contact' } | null>;
  companyByInn(inn: string, targetSystem?: ClientSystem): Promise<ClientCandidate[]>;
  companyByExactNameAndPhone(name: string, phone: string, targetSystem?: ClientSystem): Promise<ClientCandidate[]>;
  contactByCompanyAndNamePhone(companyId: string, normalizedName: string, normalizedPhone: string, email?: string, targetSystem?: ClientSystem): Promise<ClientCandidate[]>;
  contactByCompanyAndNameEmail(companyId: string, normalizedName: string, normalizedEmail: string, targetSystem?: ClientSystem): Promise<ClientCandidate[]>;
  contactByStandaloneNamePhone(normalizedName: string, normalizedPhone: string, email?: string, targetSystem?: ClientSystem): Promise<ClientCandidate[]>;
  contactByStandaloneNameEmail(normalizedName: string, normalizedEmail: string, targetSystem?: ClientSystem): Promise<ClientCandidate[]>;
}

/** Runtime lookup for a new document dependency. This deliberately does not participate in the UUID inventory map. */
export class ClientRuntimeResolver {
  constructor(private readonly gateway: ClientCandidateGateway) {}

  async resolve(source: ClientSource, primaryCompanyTargetId?: string | null): Promise<ClientResolution> {
    const sourceSystem = source.sourceSystem ?? 'BITRIX24';
    const targetSystem = sourceSystem === 'BITRIX24' ? 'MOYSKLAD' : 'BITRIX24';
    const existing = await this.gateway.findPair(source.entity, source.id, sourceSystem);
    if (existing) return { action: 'USE_PAIR', targetId: existing.targetId, targetType: existing.targetType, targetSystem, reason: 'PERSISTED_PAIR' };

    if (source.entity === 'COMPANY') return this.resolveCompany(source, targetSystem);
    return this.resolveContact(source, primaryCompanyTargetId, targetSystem);
  }

  private async resolveCompany(source: ClientSource, targetSystem: ClientSystem): Promise<ClientResolution> {
    const inn = nonEmpty(source.inn);
    if (!nonEmpty(source.name)) return { action: 'MANUAL_REVIEW', reason: 'MISSING_REQUIRED_NAME', candidates: [] };
    const exactInn = inn ? await this.gateway.companyByInn(inn, targetSystem) : [];
    // A search result with no INN is not an exact-INN match and must not be
    // selected (nor populated with the source's INN as a side effect).
    const innMatches = exactInn.filter((candidate) => !candidate.occupiedByPair && candidate.inn === inn);
    const permittedByInn = targetSystem === 'BITRIX24' ? preferUnmarkedCompany(innMatches) : innMatches;
    const innChoice = chooseCandidate(permittedByInn, 'exact_inn', targetSystem);
    if (innChoice) return innChoice;
    if (inn && permittedByInn.length) return permittedByInn.length > 1
      ? { action: 'MANUAL_REVIEW', reason: 'AMBIGUOUS_CANDIDATES', candidates: permittedByInn.map((candidate) => candidate.id) }
      : permittedByInn[0] ? candidateResolution(permittedByInn[0], 'exact_inn', false, targetSystem) : { action: 'CREATE', targetType: targetSystem === 'MOYSKLAD' ? 'counterparty' : 'company', targetSystem, reason: 'NO_CANDIDATE' };

    const name = nonEmpty(source.name);
    const phone = nonEmpty(source.phone);
    const fallback = name && phone ? await this.gateway.companyByExactNameAndPhone(name, phone, targetSystem) : [];
    const fallbackMatches = fallback.filter((candidate) => !candidate.occupiedByPair && (!nonEmpty(candidate.inn) || !inn || candidate.inn === inn));
    const permitted = targetSystem === 'BITRIX24' ? preferUnmarkedCompany(fallbackMatches) : fallbackMatches;
    const choice = chooseCandidate(permitted, 'exact_name_and_phone', targetSystem);
    if (choice) return choice;
    if (permitted.length > 1) return { action: 'MANUAL_REVIEW', reason: 'AMBIGUOUS_CANDIDATES', candidates: permitted.map((candidate) => candidate.id) };
    if (permitted.length === 1) return candidateResolution(permitted[0], 'exact_name_and_phone', false, targetSystem);
    return { action: 'CREATE', targetType: targetSystem === 'MOYSKLAD' ? 'counterparty' : 'company', targetSystem, reason: 'NO_CANDIDATE' };
  }

  private async resolveContact(source: ClientSource, primaryCompanyTargetId: string | null | undefined, targetSystem: ClientSystem): Promise<ClientResolution> {
    const name = normalizePersonName(source.name);
    const phone = normalizePhone(source.phone);
    const email = normalizeEmail(source.email);
    if (source.companyId && !primaryCompanyTargetId) {
      return { action: 'MANUAL_REVIEW', reason: 'PRIMARY_COMPANY_UNRESOLVED', candidates: [] };
    }
    if (!name) return { action: 'MANUAL_REVIEW', reason: 'MISSING_REQUIRED_NAME', candidates: [] };
    if (!name || (!phone && !email)) return { action: 'CREATE', targetType: targetSystem === 'MOYSKLAD' ? primaryCompanyTargetId ? 'contactperson' : 'counterparty' : 'contact', targetSystem, reason: 'NO_CONTACT_KEYS' };

    const candidates = primaryCompanyTargetId
      ? phone
        ? await this.gateway.contactByCompanyAndNamePhone(primaryCompanyTargetId, name, phone, email ?? undefined, targetSystem)
        : await this.gateway.contactByCompanyAndNameEmail(primaryCompanyTargetId, name, email!, targetSystem)
      : phone
        ? await this.gateway.contactByStandaloneNamePhone(name, phone, email ?? undefined, targetSystem)
        : await this.gateway.contactByStandaloneNameEmail(name, email!, targetSystem);
    const permitted = candidates.filter((candidate) => !candidate.occupiedByPair);
    const choice = chooseCandidate(permitted, phone ? 'normalized_name_and_phone' : 'normalized_name_and_email', targetSystem);
    if (choice) return choice;
    if (permitted.length > 1) return { action: 'MANUAL_REVIEW', reason: 'AMBIGUOUS_CANDIDATES', candidates: permitted.map((candidate) => candidate.id) };
    if (permitted.length === 1) return candidateResolution(permitted[0], phone ? 'normalized_name_and_phone' : 'normalized_name_and_email', false, targetSystem);
    return { action: 'CREATE', targetType: targetSystem === 'MOYSKLAD' ? primaryCompanyTargetId ? 'contactperson' : 'counterparty' : 'contact', targetSystem, reason: 'NO_CANDIDATE' };
  }
}

/** A duplicate-marked company is a fallback only when no eligible unmarked
 * company matches the same approved search keys. */
function preferUnmarkedCompany(candidates: ClientCandidate[]): ClientCandidate[] {
  const unmarked = candidates.filter((candidate) => candidate.duplicateMarked === false);
  return unmarked.length ? unmarked : candidates.filter((candidate) => candidate.duplicateMarked === true);
}

/** Returns a choice only when the approved metrics make one candidate unique. */
export function chooseCandidate(candidates: ClientCandidate[], matchedBy: string, targetSystem: ClientSystem = 'MOYSKLAD'): ClientResolution | null {
  const available = candidates.filter((candidate) => !candidate.occupiedByPair);
  if (!available.length) return null;
  const hasSomeUsage = available.some((candidate) => candidate.usageCount !== null);
  const hasMissingUsage = available.some((candidate) => candidate.usageCount === null);
  const systemwideUsageUnavailable = hasMissingUsage && available.every((candidate) => candidate.usageCount === null && candidate.usageMetricUnavailable === true);
  if (hasSomeUsage && hasMissingUsage || hasMissingUsage && !systemwideUsageUnavailable && available.length > 1) {
    return { action: 'MANUAL_REVIEW', reason: 'INCOMPLETE_USAGE_METRICS', candidates: available.map((candidate) => candidate.id) };
  }

  const ranked = [...available].sort((a, b) =>
    ((hasSomeUsage ? b.usageCount! - a.usageCount! : 0)) ||
    (b.filledFields - a.filledFields) ||
    (dateNumber(a.createdAt) - dateNumber(b.createdAt)),
  );
  const first = ranked[0];
  const second = ranked[1];
  if (!first) return null;
  if (second && sameRank(first, second, hasSomeUsage)) {
    return { action: 'MANUAL_REVIEW', reason: 'AMBIGUOUS_CANDIDATES', candidates: ranked.filter((candidate) => sameRank(first, candidate, hasSomeUsage)).map((candidate) => candidate.id) };
  }
  return candidateResolution(first, matchedBy, systemwideUsageUnavailable, targetSystem);
}

function candidateResolution(candidate: ClientCandidate, matchedBy: string, usageMetricDegraded: boolean, targetSystem: ClientSystem): ClientResolution {
  const criteria = [matchedBy];
  if (!usageMetricDegraded) criteria.push('usage_count');
  criteria.push('filled_fields', 'earliest_created_at');
  return {
    action: 'USE_CANDIDATE', targetId: candidate.id, targetType: candidate.type, targetSystem,
    reason: `Matched by ${matchedBy}; ranked by usage, filled fields, then earliest creation date${usageMetricDegraded ? ' (usage metric unavailable for all candidates)' : ''}.`,
    evidence: {
      usageCount: candidate.usageCount, filledFields: candidate.filledFields,
      createdAt: candidate.createdAt, usageMetricDegraded, criteria,
    },
  };
}

function sameRank(a: ClientCandidate, b: ClientCandidate, useUsage: boolean): boolean {
  return (!useUsage || a.usageCount === b.usageCount) && a.filledFields === b.filledFields && dateNumber(a.createdAt) === dateNumber(b.createdAt);
}

function normalizePersonName(value: string | null | undefined): string | null {
  const normalized = nonEmpty(value)?.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru-RU');
  return normalized || null;
}

function normalizePhone(value: string | null | undefined): string | null {
  const source = nonEmpty(value);
  if (!source) return null;
  let digits = source.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  return digits.length >= 10 ? digits : null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  return nonEmpty(value)?.toLocaleLowerCase('en-US') ?? null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function dateNumber(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
