import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { applyFieldTransform, semanticFieldRule } from '../src/field-settings/field-transform';

test('explicit numeric conversion rejects identifier-like leading zeroes and preserves precision policy', () => {
  assert.equal(applyFieldTransform({ kind: 'string-to-number', numberType: 'integer' }, '0012').status, 'error');
  assert.deepEqual(applyFieldTransform({ kind: 'string-to-number', numberType: 'decimal', precision: 2 }, '12.30'), { status: 'mapped', value: 12.3, transform: 'string-to-number' });
  assert.equal(applyFieldTransform({ kind: 'string-to-number', numberType: 'decimal', precision: 1 }, '12.30').status, 'error');
});

test('transform distinguishes missing/null from false, zero, and empty string values', () => {
  assert.equal(applyFieldTransform({ kind: 'copy' }, undefined).status, 'skip');
  assert.deepEqual(applyFieldTransform({ kind: 'copy' }, null), { status: 'mapped', value: null, transform: 'copy' });
  assert.deepEqual(applyFieldTransform({ kind: 'copy' }, false), { status: 'mapped', value: false, transform: 'copy' });
  assert.deepEqual(applyFieldTransform({ kind: 'copy' }, 0), { status: 'mapped', value: 0, transform: 'copy' });
  assert.deepEqual(applyFieldTransform({ kind: 'copy' }, ''), { status: 'mapped', value: '', transform: 'copy' });
});

test('enum and cardinality conversions require exact explicit mappings and policies', () => {
  assert.deepEqual(applyFieldTransform({ kind: 'enum-map', pairs: [{ source: '701', target: 'A' }] }, 701), { status: 'mapped', value: 'A', transform: 'enum-map' });
  assert.equal(applyFieldTransform({ kind: 'enum-map', pairs: [{ source: '0701', target: 'A' }] }, 701).status, 'error');
  assert.equal(applyFieldTransform({ kind: 'multiple-to-single', strategy: 'only' }, ['a', 'b']).status, 'error');
  assert.deepEqual(applyFieldTransform({ kind: 'single-to-multiple' }, 'value'), { status: 'mapped', value: ['value'], transform: 'single-to-multiple' });
});

test('date conversion uses explicit time-zone semantics and rejects invalid wall-clock dates', () => {
  assert.deepEqual(applyFieldTransform({ kind: 'date-to-datetime', timeZone: 'Europe/Moscow' }, '2026-10-20'), { status: 'mapped', value: '2026-10-20T00:00:00+03:00', transform: 'date-to-datetime' });
  assert.equal(applyFieldTransform({ kind: 'date-to-datetime', timeZone: 'Europe/Moscow' }, '2026-02-30').status, 'error');
  assert.equal(applyFieldTransform({ kind: 'date-to-datetime', timeZone: 'Europe/London', time: '01:30:00' }, '2026-10-25').status, 'error', 'ambiguous daylight-saving wall times are rejected');
  assert.equal(applyFieldTransform({ kind: 'date-to-datetime', timeZone: 'Europe/London', time: '01:30:00' }, '2026-03-29').status, 'error', 'nonexistent daylight-saving wall times are rejected');
});

test('semantic rule projection excludes UI presentation but includes mapping and transform semantics', () => {
  const projection = semanticFieldRule({ id: 'ui-id', label: 'Display only', entity: 'contacts', sourceField: 'NAME', targetField: 'name', criticality: 'optional', bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } }, moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' } } });
  assert.deepEqual(Object.keys(projection), ['entity', 'sourceField', 'targetField', 'criticality', 'bitrix24ToMoysklad', 'moyskladToBitrix24']);
  assert.deepEqual(projection.bitrix24ToMoysklad, { enabled: true, transform: { kind: 'copy' } });
});
