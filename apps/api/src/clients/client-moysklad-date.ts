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
  if (!local && !isValidOffsetDateTime(value)) return null;

  const result = new Date(timestamp);
  return Number.isNaN(result.getTime()) ? null : result;
}

function isValidLocalDateTime(date: string, time: string): boolean {
  return isValidDateAndTime(date, time);
}

function isValidOffsetDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
  if (!match || !isValidDateAndTime(match[1], match[2])) return false;
  if (match[5] === undefined) return true;
  const offsetHour = Number(match[5]);
  const offsetMinute = Number(match[6]);
  return offsetHour <= 23 && offsetMinute <= 59;
}

function isValidDateAndTime(date: string, time: string): boolean {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, secondAndFraction] = time.split(':');
  const [second, fraction = '0'] = secondAndFraction.split('.');
  const y = year;
  const m = month;
  const d = day;
  const h = Number(hour);
  const min = Number(minute);
  const s = Number(second);
  const milliseconds = Number(fraction.slice(0, 3).padEnd(3, '0'));
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(y, m - 1, d);
  calendarDate.setUTCHours(0, 0, 0, 0);
  return Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d) &&
    calendarDate.getUTCFullYear() === y && calendarDate.getUTCMonth() === m - 1 && calendarDate.getUTCDate() === d &&
    h >= 0 && h <= 23 && min >= 0 && min <= 59 && s >= 0 && s <= 59 && milliseconds >= 0 && milliseconds <= 999;
}
