import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyPositionAddRecovery, positionIdFromCreateResponse } from '../src/deals-orders/deal-order-position-runtime.service';
import { resolveDealOrderConflict } from '../src/deals-orders/deal-order-field-runtime.service';
import { resolveDictionaryValue } from '../src/deals-orders/deal-order-field-runtime.service';
import { normalizePlannedDeliveryDate, toMoySkladPlannedDeliveryDate } from '../src/deals-orders/planned-delivery-date';

test('single-position CREATE ACK accepts only one error-free object with a native UUID', () => {
  const id = '34e82d37-cd77-11f1-0a80-1e380090e6cc';
  assert.equal(positionIdFromCreateResponse({ id }), id);
  assert.equal(positionIdFromCreateResponse([{ id }]), id);
  for (const value of [null, undefined, '', 1, [], [{ id }, { id }], [[{ id }]], {}, { id: 1 }, { id: 'not-a-uuid' }, { id, errors: [] }, [{ id, errors: [{ code: 123 }] }], { id, error: null }]) {
    assert.equal(positionIdFromCreateResponse(value), null, JSON.stringify(value));
  }
});

test('position recovery never adopts an unlinked position by matching values alone', () => {
  assert.equal(classifyPositionAddRecovery(true, 1), 'DEAL_ORDER_POSITION_ADD_IDENTITY_UNPROVEN');
  assert.equal(classifyPositionAddRecovery(true, 2), 'DEAL_ORDER_POSITION_ADD_IDENTITY_UNPROVEN');
  assert.equal(classifyPositionAddRecovery(true, 0), 'DEAL_ORDER_POSITION_ADD_OUTCOME_UNKNOWN');
  assert.equal(classifyPositionAddRecovery(false, 1), 'DEAL_ORDER_POSITION_ADD_IDENTITY_UNPROVEN');
  assert.equal(classifyPositionAddRecovery(false, 0), null);
});

test('MySklad wins simultaneous deal/order scalar conflicts independent of timestamps', () => {
  assert.equal(resolveDealOrderConflict('2026-10-08T12:00:02+03:00', '2026-10-08 12:00:01.999'), 'MOYSKLAD');
  assert.equal(resolveDealOrderConflict('not-a-timestamp', null), 'MOYSKLAD');
});

test('configured optional dictionary values resolve only through the exact pinned pair in either direction', () => {
  const dictionary = {
    key: 'service', bitrix24Field: 'UF_CRM_1766085949', bitrix24ListId: '42',
    moyskladAttributeId: '0ad997c8-8e75-11e3-1ec9-002590a28eca',
    moyskladDirectoryId: 'f0177126-8e74-11e3-b761-002590a28eca',
    pairs: [{ bitrix24Id: 87402, moyskladId: '0739768a-9611-11eb-0a80-02fe0030d850' }],
  };
  assert.deepEqual(resolveDictionaryValue(dictionary, 'BITRIX24', 87402), { status: 'MAPPED', bitrix24Id: 87402, moyskladId: '0739768a-9611-11eb-0a80-02fe0030d850' });
  assert.deepEqual(resolveDictionaryValue(dictionary, 'MOYSKLAD', '0739768a-9611-11eb-0a80-02fe0030d850'), { status: 'MAPPED', bitrix24Id: 87402, moyskladId: '0739768a-9611-11eb-0a80-02fe0030d850' });
  assert.deepEqual(resolveDictionaryValue(dictionary, 'BITRIX24', null), { status: 'EMPTY' });
  assert.deepEqual(resolveDictionaryValue(dictionary, 'BITRIX24', 99999), { status: 'UNMAPPED' });
  assert.deepEqual(resolveDictionaryValue(dictionary, 'MOYSKLAD', '0739768a-9611-11eb-0a80-02fe0030d851'), { status: 'UNMAPPED' });
});

test('planned delivery date preserves only the calendar day in the documented MySklad MSK time-attribute format', () => {
  assert.deepEqual(normalizePlannedDeliveryDate('2026-10-09T00:00:00+03:00', 'BITRIX24'), { supported: true, value: '2026-10-09' });
  assert.deepEqual(normalizePlannedDeliveryDate('2026-10-09 17:45:00', 'MOYSKLAD'), { supported: true, value: '2026-10-09' });
  assert.equal(toMoySkladPlannedDeliveryDate('2026-10-09'), '2026-10-09 00:00:00');
  assert.deepEqual(normalizePlannedDeliveryDate('', 'BITRIX24'), { supported: true, value: null });
  assert.deepEqual(normalizePlannedDeliveryDate('2026-02-30', 'BITRIX24'), { supported: false });
  assert.deepEqual(normalizePlannedDeliveryDate('2026-10-09T17:45:00Z', 'MOYSKLAD'), { supported: false });
});
