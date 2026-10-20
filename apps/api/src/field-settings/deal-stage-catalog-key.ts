import { NamedReferencePair } from './field-settings.dto';

/**
 * Resolve a runtime deal STAGE_ID to the single source key emitted by the
 * live named-reference catalog. Bitrix's main-pipeline runtime ID is raw
 * (for example PREPARATION), while its catalog key is category-qualified
 * (0:PREPARATION). Custom pipeline IDs carry their category explicitly as
 * C<n>:<status>, which the catalog builder qualifies as <n>:C<n>:<status>.
 */
export function confirmedDealStageReference(
  runtimeStageId: string,
  moyskladId: string,
  namedPairs: NamedReferencePair[],
): boolean {
  const candidateKeys = new Set([runtimeStageId]);
  if (!runtimeStageId.includes(':')) {
    candidateKeys.add(`0:${runtimeStageId}`);
  } else {
    const customCategory = /^C([1-9]\d*):([^:]+)$/.exec(runtimeStageId);
    if (customCategory) candidateKeys.add(`${customCategory[1]}:${runtimeStageId}`);
  }

  const candidates = namedPairs.filter((pair) => pair.kind === 'dealStages' && candidateKeys.has(pair.bitrix24Id));
  return candidates.length === 1 && candidates[0]!.status === 'confirmed' && candidates[0]!.moyskladId === moyskladId;
}
