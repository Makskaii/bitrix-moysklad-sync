import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bitrixProductDescription } from '../src/products/bitrix-product-description';

for (const [name, input, expected] of [
  ['beginning', '😀тест Ё END', 'тест Ё END'],
  ['middle', 'тест 😀 & <b>literal</b>\nEND', 'тест  & <b>literal</b>\nEND'],
  ['end', 'тест END😀', 'тест END'],
  ['graphemes', 'A👨‍👩‍👧‍👦B👍🏽C🇷🇺D', 'ABCD'],
  ['BMP control', 'Ё Ж © ♥ ☀ & <b>literal</b>\nEND', 'Ё Ж © ♥ ☀ & <b>literal</b>\nEND'],
  ['emoji only', '😀👨‍👩‍👧‍👦', ''],
] as const) test(`description projection preserves the suffix: ${name}`, () => {
  assert.equal(bitrixProductDescription(input), expected);
  assert.equal(bitrixProductDescription(expected), expected);
});

test('non-emoji supplementary letters and malformed UTF-16 are not silently removed', () => {
  for (const text of ['A𠀀B', 'A𝄞B', 'A\ud83dB', 'A\ude00B']) {
    assert.throws(() => bitrixProductDescription(text), /PRODUCT_DESCRIPTION_UNSUPPORTED_CHARACTER/);
  }
});
