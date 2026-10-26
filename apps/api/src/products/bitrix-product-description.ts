/** Bitrix's plain-text catalog field truncates at supplementary emoji on the
 * current portal. The approved policy omits those emoji, never the text after
 * them. Keep the raw MySklad description untouched and compare this projection.
 */
export class ProductDescriptionEncodingError extends Error {
  readonly reason = 'PRODUCT_DESCRIPTION_UNSUPPORTED_CHARACTER';
  constructor() { super('PRODUCT_DESCRIPTION_UNSUPPORTED_CHARACTER'); }
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const emoji = /\p{Emoji}/u;
const emojiComponent = /\p{Emoji_Component}/u;

export function bitrixProductDescription(value: string): string {
  let result = '';
  for (const { segment } of graphemes.segment(value)) {
    const supplementary = [...segment].filter(char => char.codePointAt(0)! > 0xffff);
    if ([...segment].some(char => /^[\uD800-\uDFFF]$/.test(char))) throw new ProductDescriptionEncodingError();
    if (!supplementary.length) { result += segment; continue; }
    // Remove an entire emoji grapheme (flags/modifiers/ZWJ included), not an
    // arbitrary UTF-16 surrogate pair or a non-emoji supplementary letter.
    if (!emoji.test(segment) || supplementary.some(char => !emoji.test(char) && !emojiComponent.test(char))) {
      throw new ProductDescriptionEncodingError();
    }
  }
  return result;
}
