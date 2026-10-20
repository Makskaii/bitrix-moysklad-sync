/**
 * MySklad JSON API emits its legacy date-time fields as Moscow wall time without
 * an offset. Parse that provider-specific shape explicitly so the app host's
 * timezone cannot move a newly created record into the future.
 */
export function parseClientMoyskladTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;

  const local = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)$/.exec(value);
  if (local && !isValidLocalDateTime(local[1], local[2])) return null;
  const timestamp = local ? `${local[1]}T${local[2]}+03:00` : value;
  if (!local && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;

  const result = new Date(timestamp);
  return Number.isNaN(result.getTime()) ? null : result;
}

function isValidLocalDateTime(date: string, time: string): boolean {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, secondAndMillis] = time.split(':');
  const [second, millis = '0'] = secondAndMillis.split('.');
  const y = year;
  const m = month;
  const d = day;
  const h = Number(hour);
  const min = Number(minute);
  const s = Number(second);
  const ms = Number(millis.padEnd(3, '0'));
  const calendarDate = new Date(Date.UTC(y, m - 1, d));
  return Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d) &&
    calendarDate.getUTCFullYear() === y && calendarDate.getUTCMonth() === m - 1 && calendarDate.getUTCDate() === d &&
    h >= 0 && h <= 23 && min >= 0 && min <= 59 && s >= 0 && s <= 59 && ms >= 0 && ms <= 999;
}
