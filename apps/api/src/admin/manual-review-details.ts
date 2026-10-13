import { Prisma } from '@prisma/client';

export type ManualReviewDetails = {
  entityLabel?: string;
  fieldTitle?: string;
  previousValue?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  proposedValue?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
};

export function manualReviewDetails(diagnostic: unknown): ManualReviewDetails {
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) return {};
  const source = diagnostic as Record<string, unknown>;
  const details: ManualReviewDetails = {};
  const entityLabel = firstString(source, ['entityLabel', 'recordTitle', 'displayName']);
  const fieldTitle = firstString(source, ['fieldTitle', 'fieldName', 'field']);
  if (entityLabel) details.entityLabel = entityLabel.slice(0, 500);
  if (fieldTitle) details.fieldTitle = fieldTitle.slice(0, 500);
  if ('previousValue' in source) details.previousValue = toJsonValue(source.previousValue);
  else if ('oldValue' in source) details.previousValue = toJsonValue(source.oldValue);
  if ('proposedValue' in source) details.proposedValue = toJsonValue(source.proposedValue);
  else if ('newValue' in source) details.proposedValue = toJsonValue(source.newValue);
  return details;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (value === null) return Prisma.JsonNull;
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized) as Prisma.InputJsonValue;
  } catch { return undefined; }
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof source[key] === 'string' && source[key].trim()) return source[key] as string;
  return undefined;
}
