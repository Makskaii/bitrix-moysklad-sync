export type InvoiceFieldRule = {
  bitrix24ToMoysklad: { enabled: boolean; transform: { kind: string } };
  moyskladToBitrix24: { enabled: boolean; transform: { kind: string } };
};
export type InvoiceFieldDirection = 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24';
export type InvoiceFieldPlan =
  | { action: 'ECHO' }
  | { action: 'WRITE'; direction: InvoiceFieldDirection; value: unknown }
  | { action: 'HOLD'; reason: 'TRANSFORM_NOT_SUPPORTED' | 'FIELD_VALUE_NOT_SCALAR' | 'DIRECTION_DISABLED' };

export function planInvoiceField(input: {
  rule: InvoiceFieldRule;
  bitrix24: unknown;
  moysklad: unknown;
  baselineBitrix24: unknown;
  baselineMoysklad: unknown;
  directions: { bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean };
}): InvoiceFieldPlan {
  const b24Changed = !sameJson(input.bitrix24, input.baselineBitrix24);
  const msChanged = !sameJson(input.moysklad, input.baselineMoysklad);
  if (!b24Changed && !msChanged) return { action: 'ECHO' };
  const direction: InvoiceFieldDirection = msChanged ? 'MOYSKLAD_TO_BITRIX24' : 'BITRIX24_TO_MOYSKLAD';
  const configuredDirection = direction === 'BITRIX24_TO_MOYSKLAD' ? input.rule.bitrix24ToMoysklad : input.rule.moyskladToBitrix24;
  const enabled = direction === 'BITRIX24_TO_MOYSKLAD' ? input.directions.bitrix24ToMoysklad : input.directions.moyskladToBitrix24;
  if (!enabled || !configuredDirection.enabled) return { action: 'HOLD', reason: 'DIRECTION_DISABLED' };
  if (configuredDirection.transform.kind === 'tbd') return { action: 'HOLD', reason: 'TRANSFORM_NOT_SUPPORTED' };
  return { action: 'WRITE', direction, value: direction === 'MOYSKLAD_TO_BITRIX24' ? input.moysklad : input.bitrix24 };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
