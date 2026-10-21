import { VersionedFieldSettingsDto } from '../field-settings/field-settings.dto';

export const DOCUMENT_TOTAL_UNIT = 'major-v1' as const;
export type DocumentTotalSnapshot = { amount: unknown; currencyCode: unknown; amountUnit: typeof DOCUMENT_TOTAL_UNIT };

/** Remap sum is in minor units; snapshots and B24 OPPORTUNITY are in major units. */
export function moyskladDocumentTotal(order: Record<string, unknown>, config: VersionedFieldSettingsDto['config']): DocumentTotalSnapshot {
  const sum = order.sum;
  const minor = typeof sum === 'number' && Number.isSafeInteger(sum) && sum >= 0 ? BigInt(sum) : null;
  const fraction = minor === null ? '' : String(minor % 100n).padStart(2, '0').replace(/0+$/, '');
  return { amount: minor === null ? null : `${minor / 100n}${fraction ? '.' + fraction : ''}`,
    currencyCode: moyskladCurrencyCode(order, config), amountUnit: DOCUMENT_TOTAL_UNIT };
}

export function bitrixDocumentTotal(deal: Record<string, unknown>): DocumentTotalSnapshot {
  return { amount: deal.OPPORTUNITY, currencyCode: deal.CURRENCY_ID, amountUnit: DOCUMENT_TOTAL_UNIT };
}

function moyskladCurrencyCode(order: Record<string, unknown>, config: VersionedFieldSettingsDto['config']): string | null {
  const rate = record(order.rate);
  const relation = record(rate.currency ?? order.currency);
  const other = rate.currency && order.currency ? record(order.currency) : null;
  const id = currencyId(relation);
  if (relation.meta !== undefined && id === null || other && currencyId(other) !== id) return null;
  const expanded = typeof relation.isoCode === 'string' && /^[A-Z]{3}$/.test(relation.isoCode) ? relation.isoCode
    : typeof relation.code === 'string' && /^[A-Z]{3}$/.test(relation.code) ? relation.code : null;
  if (!id) return expanded;
  const matches = (config.dealOrderRuntime?.currencies ?? []).filter((mapping) => mapping.moyskladId === id);
  if (matches.length !== 1 || !/^[A-Z]{3}$/.test(matches[0]!.bitrix24Code)) return null;
  const code = matches[0]!.bitrix24Code;
  return expanded && expanded !== code ? null : code;
}

function currencyId(value: Record<string, unknown>): string | null {
  const uuid = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (value.meta === undefined) return uuid(value.id) ? value.id : null;
  const meta = record(value.meta);
  if (meta.type !== 'currency' || typeof meta.href !== 'string') return null;
  try {
    const base = new URL(process.env.MOYSKLAD_API_BASE_URL!.replace(/\/?$/, '/'));
    const prefix = new URL('entity/currency/', base).href;
    if (!meta.href.startsWith(prefix)) return null;
    const id = meta.href.slice(prefix.length);
    return uuid(id) && (value.id === undefined || value.id === id) ? id : null;
  } catch { return null; }
}

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
