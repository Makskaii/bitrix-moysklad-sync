import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { planInvoiceField } from '../src/invoices/invoice-field-plan';

const rule = {
  id: 'amount-label',
  bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
  moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } },
};

test('invoice field plan echoes unchanged fields and writes one-sided edits', () => {
  assert.deepEqual(planInvoiceField({ rule, bitrix24: 'old', moysklad: 'old', baselineBitrix24: 'old', baselineMoysklad: 'old', directions: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } }), { action: 'ECHO' });
  assert.deepEqual(planInvoiceField({ rule, bitrix24: 'new', moysklad: 'old', baselineBitrix24: 'old', baselineMoysklad: 'old', directions: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } }), { action: 'WRITE', direction: 'BITRIX24_TO_MOYSKLAD', value: 'new' });
  assert.deepEqual(planInvoiceField({ rule, bitrix24: 'old', moysklad: 'new', baselineBitrix24: 'old', baselineMoysklad: 'old', directions: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } }), { action: 'WRITE', direction: 'MOYSKLAD_TO_BITRIX24', value: 'new' });
});

test('MySklad wins concurrent invoice field edits and disabled mappings hold changed values', () => {
  assert.deepEqual(planInvoiceField({ rule, bitrix24: 'b24', moysklad: 'ms', baselineBitrix24: 'old', baselineMoysklad: 'old', directions: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } }), { action: 'WRITE', direction: 'MOYSKLAD_TO_BITRIX24', value: 'ms' });
  assert.deepEqual(planInvoiceField({ rule, bitrix24: 'new', moysklad: 'old', baselineBitrix24: 'old', baselineMoysklad: 'old', directions: { bitrix24ToMoysklad: false, moyskladToBitrix24: true } }), { action: 'HOLD', reason: 'DIRECTION_DISABLED' });
});

test('invoice field plan holds unconfigured transforms and leaves typed conversion to the shared transform contract', () => {
  assert.deepEqual(planInvoiceField({ rule: { ...rule, bitrix24ToMoysklad: { enabled: true, transform: { kind: 'tbd' } } }, bitrix24: 'new', moysklad: 'old', baselineBitrix24: 'old', baselineMoysklad: 'old', directions: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } }), { action: 'HOLD', reason: 'TRANSFORM_NOT_SUPPORTED' });
  assert.deepEqual(planInvoiceField({ rule, bitrix24: { id: 4 }, moysklad: null, baselineBitrix24: null, baselineMoysklad: null, directions: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } }), { action: 'WRITE', direction: 'BITRIX24_TO_MOYSKLAD', value: { id: 4 } });
});
