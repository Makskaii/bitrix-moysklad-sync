export type ClientMapEntity = 'COMPANY' | 'CONTACT';
export type ClientMapTargetType = 'counterparty' | 'contactperson';

export type ClientMapSource = { entity: ClientMapEntity; bitrix24Id: string; uuid: string | null };
export type ClientMapTarget = { id: string; type: ClientMapTargetType; parentId?: string | null; companyType?: string | null };
export type ExistingClientPair = { entity: ClientMapEntity; bitrix24Id: string; moyskladId: string; moyskladType?: ClientMapTargetType | null; moyskladParentId?: string | null };
export type ClientMapDecision =
  | { status: 'MATCHED'; entity: ClientMapEntity; bitrix24Id: string; moyskladId: string; moyskladType: ClientMapTargetType; moyskladParentId: string | null; source: 'UUID' | 'EXISTING' }
  | { status: 'UNMATCHED'; entity: ClientMapEntity; bitrix24Id: string; reason: 'UUID_MISSING' | 'UUID_REPEATED' | 'NO_CANDIDATE' | 'MULTIPLE_CANDIDATES' | 'CONFLICTING_ACTIVE_PAIR' | 'INCOMPLETE_VERIFICATION' };

/** Strict initial map. Never falls back to a human-readable or usage based key. */
export function planInitialClientMap(input: {
  sources: ClientMapSource[];
  targets: ClientMapTarget[];
  activePairs: ExistingClientPair[];
  inventoryComplete: boolean;
}): ClientMapDecision[] {
  const repeatedUuids = new Set<string>();
  for (const entity of ['COMPANY', 'CONTACT'] as const) {
    const counts = new Map<string, number>();
    for (const source of input.sources) {
      if (source.entity !== entity || !source.uuid) continue;
      counts.set(source.uuid, (counts.get(source.uuid) ?? 0) + 1);
    }
    for (const [uuid, count] of counts) if (count > 1) repeatedUuids.add(`${entity}:${uuid}`);
  }

  const byTarget = new Map<string, ClientMapTarget[]>();
  for (const target of input.targets) byTarget.set(target.id, [...(byTarget.get(target.id) ?? []), target]);
  const bySourcePair = new Map(input.activePairs.map((pair) => [`${pair.entity}:${pair.bitrix24Id}`, pair]));
  const occupiedTargets = new Map<string, ExistingClientPair>();
  for (const pair of input.activePairs) occupiedTargets.set(`${pair.entity}:${pair.moyskladId}`, pair);

  return input.sources.map((source): ClientMapDecision => {
    const key = `${source.entity}:${source.bitrix24Id}`;
    const existing = bySourcePair.get(key);
    if (existing) {
      const target = existing.moyskladType
        ? { id: existing.moyskladId, type: existing.moyskladType }
        : byTarget.get(existing.moyskladId)?.find((item) => item.type === 'counterparty' || item.type === 'contactperson');
      return {
        status: 'MATCHED', entity: source.entity, bitrix24Id: source.bitrix24Id,
        moyskladId: existing.moyskladId,
        moyskladType: target?.type ?? 'counterparty', source: 'EXISTING',
        moyskladParentId: existing.moyskladParentId ?? target?.parentId ?? null,
      };
    }
    if (!input.inventoryComplete) return unmatched(source, 'INCOMPLETE_VERIFICATION');
    if (!source.uuid) return unmatched(source, 'UUID_MISSING');
    if (repeatedUuids.has(`${source.entity}:${source.uuid}`)) return unmatched(source, 'UUID_REPEATED');

    const uuidTargets = byTarget.get(source.uuid!) ?? [];
    const applicableTargets = uuidTargets.filter((target) => target.type === 'counterparty' || (source.entity === 'CONTACT' && target.type === 'contactperson'));
    // A counterparty's native type is required to distinguish B24 companies
    // (legal entities/entrepreneurs) from standalone contacts (individuals).
    if (applicableTargets.some((target) => target.type === 'counterparty' && !target.companyType)) {
      return unmatched(source, 'INCOMPLETE_VERIFICATION');
    }
    const candidates = applicableTargets.filter((target) => source.entity === 'COMPANY'
      ? target.type === 'counterparty' && isCompanyCounterparty(target.companyType)
      : target.type === 'contactperson' || target.type === 'counterparty' && isIndividualCounterparty(target.companyType));
    if (!candidates.length) return unmatched(source, 'NO_CANDIDATE');
    if (candidates.length > 1) return unmatched(source, 'MULTIPLE_CANDIDATES');
    const candidate = candidates[0]!;
    if (occupiedTargets.has(`${source.entity}:${candidate.id}`)) return unmatched(source, 'CONFLICTING_ACTIVE_PAIR');
    return {
      status: 'MATCHED', entity: source.entity, bitrix24Id: source.bitrix24Id,
      moyskladId: candidate.id, moyskladType: candidate.type, source: 'UUID',
      moyskladParentId: candidate.parentId ?? null,
    };
  });
}

function isCompanyCounterparty(value: string | null | undefined): boolean {
  const type = value?.toLocaleLowerCase('en-US');
  return type === 'legal' || type === 'entrepreneur';
}

function isIndividualCounterparty(value: string | null | undefined): boolean {
  return value?.toLocaleLowerCase('en-US') === 'individual';
}

function unmatched(source: ClientMapSource, reason: Extract<ClientMapDecision, { status: 'UNMATCHED' }>['reason']): ClientMapDecision {
  return { status: 'UNMATCHED', entity: source.entity, bitrix24Id: source.bitrix24Id, reason };
}
