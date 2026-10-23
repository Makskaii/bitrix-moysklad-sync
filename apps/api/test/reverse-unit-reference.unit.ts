import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateUnits } from '../src/field-settings/field-settings.service';
import { matchesReverseUnit } from '../src/field-settings/unit-reference';

const canonical = '19f1edc0-fc42-4001-94cb-c9ec9c62ec10';
const reverse = '402a6315-fe55-11e4-90a2-8ecb002f8f70';
const row = { bitrix24Id: 9, bitrix24Code: '796', moyskladId: canonical, moyskladCode: '796', status: 'configured', reverseMoyskladIds: [reverse] };

test('explicit reverse alternative resolves to the same B24 measure without replacing forward destination', () => {
  const [saved] = validateUnits([row]);
  assert.equal(saved.moyskladId, canonical);
  assert.equal(matchesReverseUnit(saved, reverse), true);
  assert.equal(matchesReverseUnit(saved, canonical), true);
  assert.equal(matchesReverseUnit(saved, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false);
  assert.equal(matchesReverseUnit({ ...saved, status: 'unmapped' }, reverse), false);
});

test('reverse alternatives cannot overlap canonical or alternative IDs of another measure', () => {
  const other = { ...row, bitrix24Id: 10, moyskladId: reverse, reverseMoyskladIds: undefined };
  assert.throws(() => validateUnits([row, other]));
  assert.throws(() => validateUnits([other, row]));
  assert.throws(() => validateUnits([{ ...row, reverseMoyskladIds: [canonical] }]));
  assert.throws(() => validateUnits([{ ...row, reverseMoyskladIds: [reverse, reverse] }]));
});

test('invalid or unconfigured reverse alternative is rejected; old configurations remain supported', () => {
  for (const value of ['not-an-array', ['not-uuid'], null]) assert.throws(() => validateUnits([{ ...row, reverseMoyskladIds: value }]));
  assert.throws(() => validateUnits([{ ...row, moyskladId: null }]));
  const [old] = validateUnits([{ ...row, reverseMoyskladIds: undefined }]);
  assert.equal(matchesReverseUnit(old, reverse), false);
  assert.equal(matchesReverseUnit(old, canonical), true);
});
