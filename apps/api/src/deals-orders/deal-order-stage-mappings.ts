import type { FieldSettingsConfigDto } from '../field-settings/field-settings.dto';

export type DealStagePair = { bitrix24StageId: string; moyskladId: string };

/** Legacy creation-stage maps retain their old bilateral meaning unless an
 * explicit, directional existing-document transition map is configured. */
export function dealStageMappings(config: FieldSettingsConfigDto): {
  bitrix24ToMoysklad: DealStagePair[]; moyskladToBitrix24: DealStagePair[];
} {
  const runtime = config.dealOrderRuntime;
  return runtime?.stageTransitions ?? {
    bitrix24ToMoysklad: runtime?.stages ?? [],
    moyskladToBitrix24: runtime?.stages ?? [],
  };
}

export function configuredStagePairs(config: FieldSettingsConfigDto): DealStagePair[] {
  const mappings = dealStageMappings(config);
  const pairs = new Map<string, DealStagePair>();
  for (const pair of [...mappings.bitrix24ToMoysklad, ...mappings.moyskladToBitrix24]) {
    pairs.set(JSON.stringify([pair.bitrix24StageId, pair.moyskladId]), pair);
  }
  return [...pairs.values()];
}
