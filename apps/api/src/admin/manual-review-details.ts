import { Prisma } from '@prisma/client';

export type ManualReviewDetails = {
  entityLabel?: string;
  fieldTitle?: string;
  previousValue?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  proposedValue?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
};

export function manualReviewFields(diagnostic: unknown): Partial<ManualReviewDetails> {
  const details = manualReviewDetails(diagnostic);
  return {
    ...(details.entityLabel ? { entityLabel: details.entityLabel } : {}),
    ...(details.fieldTitle ? { fieldTitle: details.fieldTitle } : {}),
    ...(details.previousValue !== undefined ? { previousValue: details.previousValue } : {}),
    ...(details.proposedValue !== undefined ? { proposedValue: details.proposedValue } : {}),
  };
}

export function sanitizeReviewDiagnostic(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return sanitizeRecord(value as Record<string, unknown>, 0);
}

function sanitizeRecord(source: Record<string, unknown>, depth: number): Record<string, unknown> | null {
  if (depth >= 3) return null;
  return Object.fromEntries(Object.entries(source).slice(0, 30)
    .filter(([key]) => !/(token|secret|password|email|phone|address|birthday|comment|description|raw|payload|auth|credential)/i.test(key))
    .map(([key, child]) => [key.slice(0, 100), sanitizeValue(child, depth + 1)]));
}

/** Extract only explicitly named, bounded display values from a stored diagnostic object. */
export function manualReviewDetails(diagnostic: unknown): ManualReviewDetails {
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) return {};
  const source = diagnostic as Record<string, unknown>;
  const details: ManualReviewDetails = {};
  const entityLabel = firstString(source, ['entityLabel', 'recordTitle', 'displayName']);
  const fieldTitle = firstString(source, ['fieldTitle', 'fieldName', 'field']);
  if (entityLabel) details.entityLabel = entityLabel.slice(0, 500);
  if (fieldTitle) details.fieldTitle = fieldTitle.slice(0, 500);
  if ('previousValue' in source) details.previousValue = boundedJson(source.previousValue);
  else if ('oldValue' in source) details.previousValue = boundedJson(source.oldValue);
  if ('proposedValue' in source) details.proposedValue = boundedJson(source.proposedValue);
  else if ('newValue' in source) details.proposedValue = boundedJson(source.newValue);
  return details;
}

function boundedJson(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (value === null) return Prisma.JsonNull;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized.slice(0, 4_000)) as Prisma.InputJsonValue;
  } catch { return '[unavailable]'; }
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof source[key] === 'string' && source[key].trim()) return source[key] as string;
  return undefined;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 500);
  if (depth >= 3) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') return sanitizeRecord(value as Record<string, unknown>, depth);
  return String(value).slice(0, 500);
}
