export const DEAL_MATCH_KEY = 'UF_CRM_1719836973';
export const CUSTOMERORDER_ID = 'id';

export type MatchCategory =
  | 'MATCH_READY'
  | 'UNMATCHED_BITRIX24'
  | 'UNMATCHED_MOYSKLAD'
  | 'INVALID_BITRIX24_KEY'
  | 'INVALID_MOYSKLAD_ID'
  | 'DUPLICATE_BITRIX24_KEY'
  | 'ALREADY_PAIRED'
  | 'PAIR_CONFLICT';

export type HistoricalMatchEntry = {
  externalId: string;
  label: string | null;
  fields: Record<string, unknown>;
  fieldTitles: Record<string, unknown>;
};

export type ActiveDealOrderPair = {
  bitrix24Id: string;
  moyskladId: string;
  id: string;
};

export type HistoricalMatchResultInput = {
  sourceSystem: 'BITRIX24' | 'MOYSKLAD';
  sourceEntityId: string;
  linkedEntityId: string | null;
  category: MatchCategory;
  keyValue: string | null;
  sourceLabel: string | null;
  linkedLabel: string | null;
  keyFieldCode: string;
  keyFieldTitle: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UUID casing is accepted by format validation; matching itself remains exact and case-sensitive. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function classifyDealBatch(input: {
  deals: HistoricalMatchEntry[];
  ordersById: Map<string, HistoricalMatchEntry>;
  dealKeyCounts: Map<string, number>;
  activePairs: ActiveDealOrderPair[];
}): HistoricalMatchResultInput[] {
  const byBitrixId = new Map(input.activePairs.map((pair) => [pair.bitrix24Id, pair]));
  const byMoyskladId = new Map(input.activePairs.map((pair) => [pair.moyskladId, pair]));

  return input.deals.map((deal) => {
    const rawKey = deal.fields[DEAL_MATCH_KEY];
    const keyValue = typeof rawKey === 'string' ? rawKey : null;
    const title = titleValue(deal.fieldTitles[DEAL_MATCH_KEY]);
    if (!isUuid(rawKey)) {
      return result('BITRIX24', deal.externalId, null, 'INVALID_BITRIX24_KEY', keyValue, deal.label, null, DEAL_MATCH_KEY, title);
    }
    if ((input.dealKeyCounts.get(rawKey) ?? 0) > 1) {
      const order = input.ordersById.get(rawKey);
      return result('BITRIX24', deal.externalId, order?.externalId ?? null, 'DUPLICATE_BITRIX24_KEY', rawKey, deal.label, order?.label ?? null, DEAL_MATCH_KEY, title);
    }

    const order = input.ordersById.get(rawKey);
    if (!order) return result('BITRIX24', deal.externalId, null, 'UNMATCHED_BITRIX24', rawKey, deal.label, null, DEAL_MATCH_KEY, title);

    const currentByDeal = byBitrixId.get(deal.externalId);
    const currentByOrder = byMoyskladId.get(order.externalId);
    if (currentByDeal?.moyskladId === order.externalId && currentByOrder?.bitrix24Id === deal.externalId) {
      return result('BITRIX24', deal.externalId, order.externalId, 'ALREADY_PAIRED', rawKey, deal.label, order.label, DEAL_MATCH_KEY, title);
    }
    if (currentByDeal || currentByOrder) {
      return result('BITRIX24', deal.externalId, order.externalId, 'PAIR_CONFLICT', rawKey, deal.label, order.label, DEAL_MATCH_KEY, title);
    }
    return result('BITRIX24', deal.externalId, order.externalId, 'MATCH_READY', rawKey, deal.label, order.label, DEAL_MATCH_KEY, title);
  });
}

export function classifyUnmatchedOrderBatch(input: {
  orders: HistoricalMatchEntry[];
  referencedOrderIds: Set<string>;
  idTitle: string | null;
}): HistoricalMatchResultInput[] {
  return input.orders.filter((order) => !input.referencedOrderIds.has(order.externalId)).map((order) => {
    const category = isUuid(order.externalId) ? 'UNMATCHED_MOYSKLAD' : 'INVALID_MOYSKLAD_ID';
    return result('MOYSKLAD', order.externalId, null, category, order.externalId, order.label, null, CUSTOMERORDER_ID, input.idTitle);
  });
}

export function titleValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function result(
  sourceSystem: 'BITRIX24' | 'MOYSKLAD',
  sourceEntityId: string,
  linkedEntityId: string | null,
  category: MatchCategory,
  keyValue: string | null,
  sourceLabel: string | null,
  linkedLabel: string | null,
  keyFieldCode: string,
  keyFieldTitle: string | null,
): HistoricalMatchResultInput {
  return { sourceSystem, sourceEntityId, linkedEntityId, category, keyValue, sourceLabel, linkedLabel, keyFieldCode, keyFieldTitle };
}
