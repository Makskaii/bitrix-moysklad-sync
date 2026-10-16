export const PLANNED_DELIVERY_DATE_SOURCE = 'UF_CRM_1730384262074';
export const PLANNED_DELIVERY_DATE_TARGET = 'attributes.74960544-9c3d-11ef-0a80-17ac0027f1c3';

export type CalendarDayResult = { supported: true; value: string | null } | { supported: false };

export function isPlannedDeliveryDateMapping(sourceField: string, targetField: string): boolean {
  return sourceField === PLANNED_DELIVERY_DATE_SOURCE && targetField.toLowerCase() === PLANNED_DELIVERY_DATE_TARGET.toLowerCase();
}

export function touchesPlannedDeliveryDateEndpoint(sourceField: string, targetField: string): boolean {
  return sourceField === PLANNED_DELIVERY_DATE_SOURCE || targetField.toLowerCase() === PLANNED_DELIVERY_DATE_TARGET.toLowerCase();
}

/** Normalize B24 date and MSK time-attribute values to the owner's calendar-day-only contract. */
export function normalizePlannedDeliveryDate(value: unknown, side: 'BITRIX24' | 'MOYSKLAD'): CalendarDayResult {
  if (value === null || value === undefined || value === '') return { supported: true, value: null };
  if (typeof value !== 'string') return { supported: false };
  const match = side === 'BITRIX24'
    ? value.match(/^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/)
    : value.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?$/);
  if (!match || !isValidDay(match[1])) return { supported: false };
  if (side === 'MOYSKLAD' && (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59)) return { supported: false };
  return { supported: true, value: match[1] };
}

export function toMoySkladPlannedDeliveryDate(calendarDay: string | null): string | null {
  return calendarDay === null ? null : `${calendarDay} 00:00:00`;
}

function isValidDay(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}
