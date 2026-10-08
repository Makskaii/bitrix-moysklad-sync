import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyDealBatch, classifyUnmatchedOrderBatch, isUuid } from '../src/historical-deal-order-matching';

const uuidA = '7d0b9d5e-72dd-4d3e-9192-2608a0e55e10';
const uuidB = '2a3f1f88-1a28-4764-b30e-8b72991c1609';

function deal(externalId: string, key: unknown, label = externalId) {
  return { externalId, label, fields: { UF_CRM_1719836973: key }, fieldTitles: { UF_CRM_1719836973: 'UUID заказа' } };
}

function order(externalId: string, label = externalId) {
  return { externalId, label, fields: { id: externalId }, fieldTitles: { id: 'ID' } };
}

test('UUID format accepts either hex case, while pair lookup uses the exact stored key', () => {
  assert.equal(isUuid(uuidA.toUpperCase()), true);
  const result = classifyDealBatch({
    deals: [deal('deal-1', uuidA.toUpperCase())],
    ordersById: new Map([[uuidA, order(uuidA)]]),
    dealKeyCounts: new Map([[uuidA.toUpperCase(), 1]]),
    activePairs: [],
  });
  assert.equal(result[0].category, 'UNMATCHED_BITRIX24');
  assert.equal(result[0].linkedEntityId, null);
});

test('missing and malformed deal keys are visible and never become candidates', () => {
  const result = classifyDealBatch({
    deals: [deal('deal-empty', null), deal('deal-bad', `${uuidA} `)],
    ordersById: new Map([[uuidA, order(uuidA)]]),
    dealKeyCounts: new Map(),
    activePairs: [],
  });
  assert.deepEqual(result.map((row) => row.category), ['INVALID_BITRIX24_KEY', 'INVALID_BITRIX24_KEY']);
});

test('duplicate Bitrix keys are withheld even when they point to one customer order', () => {
  const result = classifyDealBatch({
    deals: [deal('deal-1', uuidA), deal('deal-2', uuidA)],
    ordersById: new Map([[uuidA, order(uuidA)]]),
    dealKeyCounts: new Map([[uuidA, 2]]),
    activePairs: [],
  });
  assert.deepEqual(result.map((row) => row.category), ['DUPLICATE_BITRIX24_KEY', 'DUPLICATE_BITRIX24_KEY']);
});

test('unique exact IDs are ready, an identical active pair is idempotent, and an occupied side conflicts', () => {
  const result = classifyDealBatch({
    deals: [deal('deal-new', uuidA), deal('deal-same', uuidB), deal('deal-conflict', uuidA)],
    ordersById: new Map([[uuidA, order(uuidA)], [uuidB, order(uuidB)]]),
    dealKeyCounts: new Map([[uuidA, 1], [uuidB, 1]]),
    activePairs: [
      { id: 'pair-same', bitrix24Id: 'deal-same', moyskladId: uuidB },
      { id: 'pair-other', bitrix24Id: 'deal-other', moyskladId: uuidA },
    ],
  });
  assert.deepEqual(result.map((row) => row.category), ['PAIR_CONFLICT', 'ALREADY_PAIRED', 'PAIR_CONFLICT']);
  assert.equal(result[1].linkedEntityId, uuidB);
});

test('customer orders with no deal reference are separated into unmatched and invalid IDs', () => {
  const result = classifyUnmatchedOrderBatch({
    orders: [order(uuidA), order('not-a-uuid')],
    referencedOrderIds: new Set(),
    idTitle: 'ID',
  });
  assert.deepEqual(result.map((row) => row.category), ['UNMATCHED_MOYSKLAD', 'INVALID_MOYSKLAD_ID']);
});
