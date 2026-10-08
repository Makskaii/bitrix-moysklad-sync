import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DEFAULT_FIELD_SETTINGS } from './approved-mappings';

export type CatalogCandidate = { id: string; code: string; label: string };
export type LiveFieldCatalogs = {
  units: { bitrix24: CatalogCandidate[]; moysklad: CatalogCandidate[] };
  priceTypes: { bitrix24: CatalogCandidate[]; moysklad: CatalogCandidate[] };
};
export type PairSnapshot = {
  sourceLabel: string;
  sourceValues: Record<string, unknown>;
  targetCurrent: Record<string, unknown>;
};
export type FieldCandidate = { code: string; title: string; type: string; writable: boolean | null };

const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class ReadOnlyFieldDataProvider {
  async catalogs(bitrixAccessToken: string): Promise<LiveFieldCatalogs> {
    const [b24Units, b24Prices, msUnits, msPrices] = await Promise.all([
      this.bitrixList(bitrixAccessToken, 'catalog.measure.list'),
      this.bitrixList(bitrixAccessToken, 'catalog.priceType.list'),
      this.moyskladList('/entity/uom'),
      this.moyskladList('/context/companysettings/pricetype'),
    ]);
    return {
      units: {
        bitrix24: b24Units.map((row) => ({ id: text(row.id), code: text(row.code ?? row.symbolIntl ?? row.symbol), label: text(row.name ?? row.title ?? row.symbolIntl ?? row.code) })),
        moysklad: msUnits.map((row) => ({ id: text(row.id), code: text(row.code), label: text(row.name ?? row.code) })),
      },
      priceTypes: {
        bitrix24: b24Prices.map((row) => ({ id: text(row.id), code: text(row.xmlId ?? row.code ?? row.name), label: text(row.name ?? row.code) })),
        moysklad: msPrices.map((row) => ({ id: text(row.id), code: text(row.externalCode ?? row.name), label: text(row.name) })),
      },
    };
  }

  async dictionaryCatalogs(bitrixAccessToken: string) {
    return Promise.all(DEFAULT_FIELD_SETTINGS.references.dictionaries.map(async (dictionary) => {
      const [bitrixRows, moyskladRows] = await Promise.all([
        this.bitrixListElements(bitrixAccessToken, dictionary.bitrix24ListId),
        this.moyskladList(`/entity/customentity/${encodeURIComponent(dictionary.moyskladDirectoryId)}`),
      ]);
      return {
        key: dictionary.key,
        bitrix24: bitrixRows.map((row) => ({ id: text(row.ID ?? row.id), title: text(row.NAME ?? row.name), code: text(row.CODE ?? row.code) })),
        moysklad: moyskladRows.map((row) => ({ id: text(row.id), title: text(row.name), code: text(row.code) })),
      };
    }));
  }

  async readPair(bitrixAccessToken: string, entity: string, sourceId: string, targetId: string): Promise<PairSnapshot> {
    const contract = pairContract(entity, sourceId, targetId);
    const [source, target] = await Promise.all([
      this.bitrixCall(bitrixAccessToken, contract.bitrixMethod, contract.bitrixParams),
      this.moyskladGet(contract.moyskladPath),
    ]);
    const sourceRecord = unwrapSource(entity, source);
    return {
      sourceLabel: sourceLabel(sourceRecord),
      sourceValues: sourceRecord,
      targetCurrent: asRecord(target),
    };
  }

  async fieldCatalogs(bitrixAccessToken: string, entity: string, sourceId: string, targetId: string) {
    const contract = pairContract(entity, sourceId, targetId);
    const snapshot = await this.readPair(bitrixAccessToken, entity, sourceId, targetId);
    const fieldParams = { ...contract.bitrixFieldsParams };
    if (entity === 'catalog') {
      const iblockId = snapshot.sourceValues.iblockId;
      if (typeof iblockId !== 'number' && typeof iblockId !== 'string') {
        throw new ServiceUnavailableException('Bitrix24 product did not include an information-block ID for field metadata');
      }
      fieldParams['filter[iblockId]'] = String(iblockId);
    }
    const bitrixResult = await this.bitrixCall(bitrixAccessToken, contract.bitrixFieldsMethod, fieldParams);
    const bitrix24 = describeBitrixFields(bitrixResult);
    const resourcePath = contract.moyskladPath.split('/').slice(0, -1).join('/');
    const metadata = await this.moyskladGet(`${resourcePath}/metadata/attributes`);
    const attributeRows = isRecord(metadata) && Array.isArray(metadata.rows) ? metadata.rows.filter(isRecord) : [];
    const moyskladAttributes: FieldCandidate[] = attributeRows.flatMap((row) => {
      if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.type !== 'string') return [];
      return [{ code: `attributes.${row.id}`, title: row.name, type: row.type, writable: null }];
    });
    const moyskladStandard: FieldCandidate[] = Object.entries(snapshot.targetCurrent)
      .filter(([code]) => !['meta', 'attributes', 'positions', 'files', 'owner', 'group', 'updated', 'created'].includes(code))
      .map(([code, value]) => ({ code, title: moyskladStandardFieldTitle(entity, code), type: valueType(value), writable: null }));
    return { entity, bitrix24, moysklad: deduplicateFields([...moyskladStandard, ...moyskladAttributes]) };
  }

  private async bitrixList(accessToken: string, method: string): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    let start = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const payload = await this.bitrixCall(accessToken, method, { start, 'order[id]': 'ASC' });
      const pageRows = Array.isArray(payload) ? payload : isRecord(payload)
        ? Object.values(payload).find((value) => Array.isArray(value)) as unknown[] | undefined
        : undefined;
      if (!pageRows) throw new ServiceUnavailableException(`Bitrix24 returned an invalid ${method} catalog`);
      rows.push(...pageRows.filter(isRecord));
      if (pageRows.length < PAGE_SIZE) return rows;
      start += PAGE_SIZE;
    }
    throw new ServiceUnavailableException(`Bitrix24 ${method} catalog exceeds the supported ${MAX_PAGES * PAGE_SIZE} records; use a narrower catalog filter`);
  }

  private async bitrixListElements(accessToken: string, listId: string): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    for (let page = 0, start = 0; page < MAX_PAGES; page += 1, start += PAGE_SIZE) {
      const result = await this.bitrixCall(accessToken, 'lists.element.get', {
        IBLOCK_TYPE_ID: 'lists', IBLOCK_ID: listId, start,
        'SELECT[0]': 'ID', 'SELECT[1]': 'CODE', 'SELECT[2]': 'NAME',
      });
      if (!Array.isArray(result)) throw new ServiceUnavailableException(`Bitrix24 returned an invalid list ${listId}`);
      const pageRows = result.filter(isRecord);
      rows.push(...pageRows);
      if (pageRows.length < PAGE_SIZE) return rows;
    }
    throw new ServiceUnavailableException(`Bitrix24 list ${listId} exceeds the supported ${MAX_PAGES * PAGE_SIZE} records`);
  }

  private async bitrixCall(accessToken: string, method: string, params: Record<string, string | number>): Promise<unknown> {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new ServiceUnavailableException('Bitrix24 read-only catalog provider is not configured');
    const form = new URLSearchParams({ auth: accessToken, ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])) });
    const response = await fetch(new URL(`${method}.json`, ensureSlash(base)), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => { throw new ServiceUnavailableException('Bitrix24 read-only request failed'); });
    if (!response.ok) throw new ServiceUnavailableException(`Bitrix24 read-only request failed (${response.status})`);
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || !('result' in payload) || 'error' in payload) throw new ServiceUnavailableException('Bitrix24 rejected the read-only request');
    return payload.result;
  }

  private async moyskladList(path: string): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    let url = new URL(path.replace(/^\//, ''), ensureSlash(process.env.MOYSKLAD_API_BASE_URL ?? 'https://api.moysklad.ru/api/remap/1.2/'));
    const visited = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const key = url.toString();
      if (visited.has(key)) throw new ServiceUnavailableException('MoySklad returned a repeating catalog page');
      visited.add(key);
      const payload = await this.moyskladGet(url.toString());
      if (!isRecord(payload) || !Array.isArray(payload.rows)) throw new ServiceUnavailableException('MoySklad returned an invalid catalog');
      rows.push(...payload.rows.filter(isRecord));
      const nextHref = isRecord(payload.meta) && typeof payload.meta.nextHref === 'string' ? payload.meta.nextHref : '';
      if (!nextHref) return rows;
      url = new URL(nextHref);
    }
    throw new ServiceUnavailableException(`MoySklad catalog exceeds ${MAX_PAGES} pages; use a narrower catalog filter`);
  }

  private async moyskladGet(path: string): Promise<unknown> {
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new ServiceUnavailableException('MoySklad read-only catalog provider is not configured');
    const url = path.startsWith('http') ? new URL(path) : new URL(path.replace(/^\//, ''), ensureSlash(base));
    const allowedOrigin = new URL(base).origin;
    if (url.origin !== allowedOrigin) throw new ServiceUnavailableException('MoySklad returned an untrusted pagination URL');
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .catch(() => { throw new ServiceUnavailableException('MoySklad read-only request failed'); });
    if (!response.ok) throw new ServiceUnavailableException(`MoySklad read-only request failed (${response.status})`);
    return response.json().catch(() => { throw new ServiceUnavailableException('MoySklad returned invalid JSON'); });
  }
}

function pairContract(entity: string, sourceId: string, targetId: string): {
  bitrixMethod: string;
  bitrixParams: Record<string, string | number>;
  bitrixFieldsMethod: string;
  bitrixFieldsParams: Record<string, string | number>;
  moyskladPath: string;
} {
  const msId = encodeURIComponent(targetId);
  switch (entity) {
    case 'contacts-companies':
    case 'contacts': return { bitrixMethod: 'crm.contact.get', bitrixParams: { id: sourceId }, bitrixFieldsMethod: 'crm.contact.fields', bitrixFieldsParams: {}, moyskladPath: `entity/counterparty/${msId}` };
    case 'companies': return { bitrixMethod: 'crm.company.get', bitrixParams: { id: sourceId }, bitrixFieldsMethod: 'crm.company.fields', bitrixFieldsParams: {}, moyskladPath: `entity/counterparty/${msId}` };
    case 'deals-orders': return { bitrixMethod: 'crm.deal.get', bitrixParams: { id: sourceId }, bitrixFieldsMethod: 'crm.deal.fields', bitrixFieldsParams: {}, moyskladPath: `entity/customerorder/${msId}` };
    case 'smart-invoices': return { bitrixMethod: 'crm.item.get', bitrixParams: { entityTypeId: 31, id: sourceId }, bitrixFieldsMethod: 'crm.item.fields', bitrixFieldsParams: { entityTypeId: 31 }, moyskladPath: `entity/invoiceout/${msId}` };
    case 'catalog': return { bitrixMethod: 'catalog.product.get', bitrixParams: { id: sourceId }, bitrixFieldsMethod: 'catalog.product.getFieldsByFilter', bitrixFieldsParams: {}, moyskladPath: `entity/product/${msId}` };
    default: throw new ServiceUnavailableException('This entity type has no read-only pair provider');
  }
}

function unwrapSource(entity: string, value: unknown): Record<string, unknown> {
  const root = asRecord(value);
  if (entity === 'smart-invoices' && isRecord(root.item)) return root.item;
  if (entity === 'catalog' && isRecord(root.product)) return root.product;
  return root;
}

function describeBitrixFields(value: unknown): FieldCandidate[] {
  const root = asRecord(value);
  const candidates = isRecord(root.fields) ? root.fields : isRecord(root.product) ? root.product : root;
  return Object.entries(candidates).flatMap(([code, definition]) => {
    if (!isRecord(definition) || code === 'time' || code === 'item') return [];
    const title = [definition.title, definition.formLabel, definition.listLabel, definition.filterLabel, definition.listColumnLabel, definition.name]
      .find((label): label is string => typeof label === 'string' && label.trim().length > 0)?.trim() ?? '';
    const type = typeof definition.type === 'string' ? definition.type : typeof definition.userTypeId === 'string' ? definition.userTypeId : 'unknown';
    return [{ code, title, type, writable: typeof definition.isReadOnly === 'boolean' ? !definition.isReadOnly : null }];
  });
}

function deduplicateFields(fields: FieldCandidate[]): FieldCandidate[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    if (seen.has(field.code)) return false;
    seen.add(field.code);
    return true;
  });
}

function valueType(value: unknown): string {
  if (value === null || value === undefined) return 'unknown';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

/** Labels for standard fields whose Russian meanings are documented for these resources.
 * Unknown standard fields keep their exact API code as their honest display title.
 */
function moyskladStandardFieldTitle(entity: string, code: string): string {
  const labels: Record<string, Record<string, string>> = {
    contacts: {
      name: 'Имя контрагента', companyType: 'Тип контрагента', legalTitle: 'Полное наименование',
      inn: 'ИНН', kpp: 'КПП', legalAddress: 'Юридический адрес', actualAddress: 'Фактический адрес',
      email: 'Электронная почта', phone: 'Телефон',
    },
    'contacts-companies': {
      name: 'Имя контрагента', companyType: 'Тип контрагента', legalTitle: 'Полное наименование',
      inn: 'ИНН', kpp: 'КПП', legalAddress: 'Юридический адрес', actualAddress: 'Фактический адрес',
      email: 'Электронная почта', phone: 'Телефон',
    },
    companies: {
      name: 'Имя контрагента', companyType: 'Тип контрагента', legalTitle: 'Полное наименование',
      inn: 'ИНН', kpp: 'КПП', legalAddress: 'Юридический адрес', actualAddress: 'Фактический адрес',
      email: 'Электронная почта', phone: 'Телефон',
    },
    'deals-orders': {
      name: 'Наименование заказа', code: 'Код заказа', moment: 'Момент заказа',
      deliveryPlannedMoment: 'Плановая отгрузка/доставка', state: 'Статус', sum: 'Сумма', description: 'Описание',
    },
    catalog: {
      name: 'Наименование товара', code: 'Код товара', article: 'Артикул', description: 'Описание',
      externalCode: 'Внешний код', vat: 'Ставка НДС',
    },
  };
  return labels[entity]?.[code] ?? code;
}

function sourceLabel(value: unknown): string {
  const row = asRecord(value);
  const person = [row.NAME, row.LAST_NAME, row.SECOND_NAME].filter((part) => typeof part === 'string' && part.trim()).join(' ');
  if (person) return person;
  return [row.TITLE, row.name, row.PRODUCT_NAME].find((part) => typeof part === 'string' && part.trim()) as string | undefined ?? 'Без подписи';
}
function asRecord(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): string { return value === null || value === undefined ? '' : String(value); }
function ensureSlash(value: string) { return value.endsWith('/') ? value : `${value}/`; }
