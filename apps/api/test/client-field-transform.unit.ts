import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';

const settings = new FieldSettingsService({} as never, {} as never, {} as never);

test('field groups join every non-empty Bitrix multifield VALUE in configured order', () => {
  const config = { groups: [{
    entity: 'contact', direction: 'BITRIX24_TO_MOYSKLAD', sourceFields: ['PHONE'], targetField: 'phone',
    transform: { kind: 'join-non-empty', separator: ' | ' },
  }] };
  assert.deepEqual(settings.transformField(config, 'contact', 'BITRIX24_TO_MOYSKLAD', 'phone', {
    PHONE: [{ VALUE: '+7 111', VALUE_TYPE: 'WORK' }, { VALUE: ' ' }, '+7 222', { VALUE: '+7 333', VALUE_TYPE: 'MOBILE' }],
  }), { value: '+7 111 | +7 222 | +7 333', error: null, reason: null, status: 'mapped', transform: 'join-non-empty' });
});

test('field groups split only toward Bitrix and carry an explicitly configured VALUE_TYPE', () => {
  const config = { groups: [{
    entity: 'company', direction: 'MOYSKLAD_TO_BITRIX24', sourceFields: ['phone'], targetField: 'PHONE',
    transform: { kind: 'split-non-empty', separator: ' | ', valueType: 'WORK' },
  }] };
  assert.deepEqual(settings.transformField(config, 'company', 'MOYSKLAD_TO_BITRIX24', 'PHONE', { phone: '+7 111 |  | +7 222' }), {
    value: [{ VALUE: '+7 111', VALUE_TYPE: 'WORK' }, { VALUE: '+7 222', VALUE_TYPE: 'WORK' }], error: null, reason: null, status: 'mapped', transform: 'split-non-empty',
  });
  assert.deepEqual(settings.transformField(config, 'company', 'BITRIX24_TO_MOYSKLAD', 'PHONE', { phone: '+7 111' }), null);
});

test('direct copy semantics retain zero and empty values rather than treating them as absent', () => {
  const config = { rules: [{ entity: 'company', sourceField: 'UF_ZERO', targetField: 'zero',
    bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
  }] };
  assert.deepEqual(settings.transformField(config, 'company', 'BITRIX24_TO_MOYSKLAD', 'zero', { UF_ZERO: 0 }), {
    value: 0, error: null, reason: null, status: 'mapped', transform: 'copy',
  });
  const emptyRule = { ...config, rules: [{ ...config.rules[0], sourceField: 'UF_EMPTY' }] };
  assert.deepEqual(settings.transformField(emptyRule, 'company', 'BITRIX24_TO_MOYSKLAD', 'zero', { UF_EMPTY: '' }), {
    value: '', error: null, reason: null, status: 'mapped', transform: 'copy',
  });
});
