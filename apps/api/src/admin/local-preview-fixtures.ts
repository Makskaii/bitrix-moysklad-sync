import { APPROVED_DICTIONARY_PAIRS, APPROVED_PRICE_TYPES, APPROVED_UNITS } from '../field-settings/approved-mappings';
import { FieldCandidate, LiveFieldCatalogs, PairSnapshot, ReadOnlyFieldDataProvider } from '../field-settings/read-only-field-data.provider';

/** Synthetic catalogs used only by the isolated local admin preview. */
export class LocalPreviewFixtureFieldDataProvider extends ReadOnlyFieldDataProvider {
  override async catalogs(_bitrixAccessToken: string): Promise<LiveFieldCatalogs> {
    return {
      units: {
        bitrix24: APPROVED_UNITS.map((unit) => ({ id: String(unit.bitrix24Id), code: unit.bitrix24Code, label: `Демо: единица ${unit.bitrix24Code}` })),
        moysklad: unique(APPROVED_UNITS.flatMap((unit) => unit.moyskladId ? [{ id: unit.moyskladId, code: unit.moyskladCode ?? unit.bitrix24Code, label: `Демо: единица ${unit.moyskladCode ?? unit.bitrix24Code}` }] : [])),
      },
      priceTypes: {
        bitrix24: APPROVED_PRICE_TYPES.map((price) => ({ id: String(price.bitrix24Id), code: price.bitrix24Code, label: `Демо: тип цены ${price.bitrix24Code}` })),
        moysklad: unique(APPROVED_PRICE_TYPES.flatMap((price) => price.moyskladId ? [{ id: price.moyskladId, code: price.bitrix24Code, label: `Демо: ${price.moyskladLabel ?? price.bitrix24Code}` }] : [])),
      },
    };
  }

  override async dictionaryCatalogs(_bitrixAccessToken: string) {
    return [
      { key: 'service', bitrix24: APPROVED_DICTIONARY_PAIRS.service.map(([id]) => ({ id: String(id), title: `Демо: услуга ${id}`, code: `demo-${id}` })), moysklad: APPROVED_DICTIONARY_PAIRS.service.map(([, id]) => ({ id, title: `Демо: услуга ${id}`, code: `demo-${id}` })) },
      { key: 'payment-method', bitrix24: APPROVED_DICTIONARY_PAIRS.paymentMethod.map(([id]) => ({ id: String(id), title: `Демо: оплата ${id}`, code: `demo-${id}` })), moysklad: APPROVED_DICTIONARY_PAIRS.paymentMethod.map(([, id]) => ({ id, title: `Демо: оплата ${id}`, code: `demo-${id}` })) },
    ];
  }

  override async fieldCatalogs(_bitrixAccessToken: string, entity: string) {
    const bitrix24: FieldCandidate[] = entity === 'catalog'
      ? [field('NAME', 'Демо: название товара'), field('property108', 'Демо: ключ склада'), field('PREVIEW_LABEL', 'Демо: подпись'), field('ID', 'ID', 'integer', false)]
      : [field('NAME', 'Демо: имя'), field('LAST_NAME', 'Демо: фамилия'), field('EMAIL', 'Демо: электронная почта'), field('PHONE', 'Демо: телефон'), field('TITLE', 'Демо: тема'), field('PREVIEW_LABEL', 'Демо: подпись'), field('ID', 'ID', 'integer', false)];
    const moysklad: FieldCandidate[] = [field('name', 'Демо: наименование'), field('description', 'Демо: описание'), field('externalCode', 'Демо: внешний код'), field('email', 'Демо: электронная почта'), field('phone', 'Демо: телефон'), field('attributes.preview-demo-attribute', 'Демо: дополнительный атрибут')];
    return { entity, bitrix24, moysklad };
  }

  override async readPair(_bitrixAccessToken: string, entity: string, sourceId: string, targetId: string): Promise<PairSnapshot> {
    return {
      sourceLabel: `Локальная демо-пара ${sourceId}`,
      sourceValues: entity === 'catalog'
        ? { id: sourceId, NAME: 'Демо: вентилятор', property108: 'DEMO-SKU-01', PREVIEW_LABEL: 'Локальный пример' }
        : { ID: sourceId, NAME: 'Демо', LAST_NAME: 'Контакт', EMAIL: 'demo@example.invalid', PHONE: '+7 000 000-00-00', TITLE: 'Демо-сделка', PREVIEW_LABEL: 'Локальный пример' },
      targetCurrent: entity === 'catalog'
        ? { id: targetId, name: 'Демо: вентилятор', description: 'Локальный пример', externalCode: 'DEMO-SKU-01' }
        : { id: targetId, name: 'Демо Контакт', email: 'demo@example.invalid', phone: '+7 000 000-00-00', description: 'Локальный пример' },
    };
  }
}

function field(code: string, title: string, type = 'string', writable: boolean | null = true): FieldCandidate {
  const custom = /^UF_CRM/i.test(code) || /^property\d+$/i.test(code) || code.startsWith('attributes.');
  return { code, title, type, writable, category: custom ? 'custom' : 'standard' };
}

function unique<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
