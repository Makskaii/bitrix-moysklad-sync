export type FieldTransform =
  | { kind: 'copy' | 'tbd' | 'price-type-uuid' }
  | { kind: 'string-to-number'; numberType: 'integer' | 'decimal'; precision?: number; min?: number; max?: number; leadingZeros?: 'reject' | 'allow' }
  | { kind: 'number-to-string'; precision?: number }
  | { kind: 'date-to-datetime'; timeZone: string; time?: string }
  | { kind: 'datetime-to-date'; timeZone: string }
  | { kind: 'boolean-map'; trueValue: boolean | 'Y' | 'N' | '1' | '0'; falseValue: boolean | 'Y' | 'N' | '1' | '0' }
  | { kind: 'enum-map'; pairs: Array<{ source: string; target: string }> }
  | { kind: 'reference-map'; resource: string; pairs: Array<{ source: string; target: string }> }
  | { kind: 'multiple-to-single'; strategy: 'only' | 'first' | 'join'; separator?: string }
  | { kind: 'single-to-multiple' };

export type FieldTransformResult =
  | { status: 'mapped'; value: unknown; transform: string }
  | { status: 'skip'; reason: string; transform: string }
  | { status: 'error'; reason: string; transform: string };

/** Applies a saved, explicit transform without guessing at source value semantics. */
export function applyFieldTransform(transform: FieldTransform, value: unknown): FieldTransformResult {
  const kind = transform.kind;
  if (value === undefined) return { status: 'skip', reason: 'source value is missing', transform: kind };
  if (value === null && kind === 'copy') return { status: 'mapped', value: null, transform: kind };
  if (value === null) return { status: 'skip', reason: 'source value is null', transform: kind };
  if (kind === 'tbd') return { status: 'error', reason: 'transform is not configured', transform: kind };
  if (kind === 'copy') return { status: 'mapped', value, transform: kind };
  if (kind === 'price-type-uuid') {
    if (value === '' || value === false) return { status: 'skip', reason: 'company price type is not selected', transform: kind };
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return invalid(kind, 'price type must be a verified UUID');
    return { status: 'mapped', value: value.toLowerCase(), transform: kind };
  }

  if (kind === 'string-to-number') {
    if (typeof value !== 'string' || !/^[+-]?(?:\d+)(?:\.\d+)?$/.test(value)) return invalid(kind, 'value is not a strict decimal string');
    if (transform.leadingZeros !== 'allow' && /^[+-]?0\d/.test(value)) return invalid(kind, 'leading zeroes would be lost');
    const number = Number(value);
    if (!Number.isFinite(number)) return invalid(kind, 'number is outside the supported range');
    if (transform.numberType === 'integer' && !Number.isSafeInteger(number)) return invalid(kind, 'value is not a safe integer');
    if (transform.numberType === 'decimal' && transform.precision !== undefined && decimalPlaces(value) > transform.precision) return invalid(kind, `value exceeds the configured precision of ${transform.precision}`);
    if (transform.min !== undefined && number < transform.min || transform.max !== undefined && number > transform.max) return invalid(kind, 'number is outside the configured range');
    return { status: 'mapped', value: number, transform: kind };
  }
  if (kind === 'number-to-string') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(kind, 'value is not a finite number');
    if (transform.precision !== undefined && decimalPlaces(String(value)) > transform.precision) return invalid(kind, `value exceeds the configured precision of ${transform.precision}`);
    return { status: 'mapped', value: String(value), transform: kind };
  }
  if (kind === 'date-to-datetime') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isValidDate(value)) return invalid(kind, 'value is not a valid YYYY-MM-DD date');
    const time = transform.time ?? '00:00:00';
    if (!/^\d{2}:\d{2}:\d{2}$/.test(time) || !isValidTime(time)) return invalid(kind, 'configured time must use valid HH:mm:ss');
    const instant = localDateTimeToIso(value, time, transform.timeZone);
    return instant ? { status: 'mapped', value: instant, transform: kind } : invalid(kind, 'time zone is invalid or the local time is ambiguous');
  }
  if (kind === 'datetime-to-date') {
    if (typeof value !== 'string') return invalid(kind, 'value is not a datetime string');
    const instant = parseDateTime(value, transform.timeZone);
    return instant ? { status: 'mapped', value: dateInTimeZone(instant, transform.timeZone), transform: kind } : invalid(kind, 'datetime must be ISO-8601 or a valid local MySklad datetime');
  }
  if (kind === 'boolean-map') {
    if (transform.trueValue === transform.falseValue) return invalid(kind, 'trueValue and falseValue must differ');
    if (value === true || value === 'Y' || value === '1') return { status: 'mapped', value: transform.trueValue, transform: kind };
    if (value === false || value === 'N' || value === '0') return { status: 'mapped', value: transform.falseValue, transform: kind };
    return invalid(kind, 'value is not a supported boolean representation');
  }
  if (kind === 'enum-map' || kind === 'reference-map') {
    if (kind === 'reference-map' && !transform.resource.trim()) return invalid(kind, 'reference resource is required');
    const key = exactScalarKey(value);
    if (key === null) return invalid(kind, 'value must be a scalar option/reference ID');
    const entries = transform.pairs.filter((pair) => pair.source === key);
    if (entries.length !== 1) return invalid(kind, entries.length === 0 ? 'source value has no exact configured mapping' : 'source value has an ambiguous configured mapping');
    return { status: 'mapped', value: entries[0]!.target, transform: kind };
  }
  if (kind === 'multiple-to-single') {
    if (!Array.isArray(value)) return invalid(kind, 'source value is not multiple');
    if (value.length === 0) return { status: 'skip', reason: 'source collection is empty', transform: kind };
    if (transform.strategy === 'only') return value.length === 1 ? { status: 'mapped', value: value[0], transform: kind } : invalid(kind, 'source collection does not contain exactly one value');
    if (transform.strategy === 'first') return { status: 'mapped', value: value[0], transform: kind };
    if (transform.strategy === 'join' && typeof transform.separator === 'string' && value.every((item) => typeof item === 'string')) {
      return { status: 'mapped', value: value.join(transform.separator), transform: kind };
    }
    return invalid(kind, 'join requires string values and an explicit separator');
  }
  if (kind === 'single-to-multiple') {
    if (Array.isArray(value) || typeof value === 'object') return invalid(kind, 'source value is not scalar');
    return { status: 'mapped', value: [value], transform: kind };
  }
  return invalid(kind, 'transform is unsupported');
}

/** Canonical settings input for semantic comparisons; display text and UI order are deliberately absent. */
export function semanticFieldRule(rule: Record<string, unknown>) {
  const direction = (value: unknown) => {
    if (!isRecord(value) || !isRecord(value.transform)) return null;
    return { enabled: value.enabled === true, transform: stableValue(value.transform) };
  };
  return {
    entity: rule.entity,
    sourceField: rule.sourceField,
    targetField: rule.targetField,
    criticality: rule.criticality,
    bitrix24ToMoysklad: direction(rule.bitrix24ToMoysklad),
    moyskladToBitrix24: direction(rule.moyskladToBitrix24),
  };
}

export function semanticFieldGroup(group: Record<string, unknown>) {
  return {
    entity: group.entity,
    direction: group.direction,
    targetField: group.targetField,
    sourceFields: Array.isArray(group.sourceFields) ? [...group.sourceFields] : [],
    criticality: group.criticality,
    transform: isRecord(group.transform) ? stableValue(group.transform) : null,
  };
}

function invalid(transform: string, reason: string): FieldTransformResult { return { status: 'error', reason, transform }; }
function decimalPlaces(value: string) { return value.includes('.') ? value.length - value.indexOf('.') - 1 : 0; }
function exactScalarKey(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}
function isValidDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function isValidTime(value: string) { const [hours, minutes, seconds] = value.split(':').map(Number); return hours! < 24 && minutes! < 60 && seconds! < 60; }
function localDateTimeToIso(date: string, time: string, timeZone: string): string | null {
  const desired = `${date}T${time}`;
  const wallClock = Date.parse(`${desired}Z`);
  if (!Number.isFinite(wallClock)) return null;
  const offsets = new Set<number>();
  for (let delta = -36; delta <= 36; delta += 6) {
    const offset = timezoneOffset(wallClock + delta * 60 * 60 * 1000, timeZone);
    if (offset !== null) offsets.add(offset);
  }
  const candidates = [...offsets].map((offset) => wallClock - offset * 60_000).filter((candidate) => formatDateTime(candidate, timeZone) === desired);
  if (candidates.length !== 1) return null;
  const instant = candidates[0]!;
  const offset = timezoneOffset(instant, timeZone);
  if (offset === null) return null;
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return `${desired}${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}
function parseDateTime(value: string, timeZone: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const local = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?$/);
  if (!local || !isValidDate(local[1]!) || !isValidTime(local[2]!)) return null;
  const iso = localDateTimeToIso(local[1]!, local[2]!, timeZone);
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}
function formatDateTime(instant: number, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
    const part = (name: string) => parts.find((candidate) => candidate.type === name)?.value;
    const values = ['year', 'month', 'day', 'hour', 'minute', 'second'].map(part);
    return values.some((value) => !value) ? null : `${values[0]}-${values[1]}-${values[2]}T${values[3]}:${values[4]}:${values[5]}`;
  } catch { return null; }
}
function timezoneOffset(instant: number, timeZone: string): number | null {
  const formatted = formatDateTime(instant, timeZone);
  if (!formatted) return null;
  return (Date.parse(`${formatted}Z`) - instant) / 60_000;
}
function dateInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (name: string) => parts.find((candidate) => candidate.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
