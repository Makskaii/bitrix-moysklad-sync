import { Injectable } from '@nestjs/common';
import { assertApplyExternalWrite } from '../external-write-guard';
import { DryRunWriteJournal } from '../dry-run-write-journal';
import { ProductCardApi, ProductCardManualReviewError, ProductCardSnapshot } from './product-card-sync.service';
import { ProviderFailure, providerResponseFailure } from '../provider-failure';
import { bitrixProductDescription, ProductDescriptionEncodingError } from './bitrix-product-description';

const REQUEST_TIMEOUT_MS = 10_000;
const EXACT_NAME_CANDIDATE_LIMIT = 25;

/**
 * Direct API adapter for an existing product card. Bitrix24's catalog methods
 * and MySklad's Remap product resource are documented at:
 * https://apidocs.bitrix24.com/api-reference/catalog/product/catalog-product-get.html
 * https://apidocs.bitrix24.com/api-reference/catalog/product/catalog-product-update.html
 * https://apidocs.bitrix24.com/api-reference/catalog/price/catalog-price-list.html
 * https://apidocs.bitrix24.com/api-reference/catalog/price/catalog-price-get.html
 * https://apidocs.bitrix24.com/api-reference/catalog/price/catalog-price-update.html
 * https://dev.moysklad.ru/doc/api/remap/1.2/
 */
@Injectable()
export class ProductCardHttpApi implements ProductCardApi {
  private readonly bitrixVatRates = new Map<string, number>();
  private readonly bitrixCatalogVatIds = new Map<string, string | null>();

  constructor(private readonly dryWrites?: DryRunWriteJournal) {}

  async readBitrix24CreateEchoCard(id: string, kind: 'product' | 'service'): Promise<Record<string, unknown>> {
    if (!/^\d{1,20}$/.test(id)) throw new Error('PRODUCT_ID_INVALID');
    const result = asRecord(await this.bitrixCall(kind === 'service' ? 'catalog.product.service.get' : 'catalog.product.get', { id }));
    const card = isRecord(result[kind]) ? result[kind] : result;
    if (String(card.id ?? '') !== id) throw new ProductCardManualReviewError('PRODUCT_IMPORT_ECHO_IDENTITY_MISMATCH');
    if (Number(card.type) !== (kind === 'service' ? 7 : 1)) throw new ProductCardManualReviewError('PRODUCT_CARD_TYPE_UNSUPPORTED');
    return card;
  }

  async findBitrix24CreateEchoIds(catalogId: string, xmlId: string, kind: 'product' | 'service'): Promise<string[]> {
    if (!/^\d{1,20}$/.test(catalogId) || !/^MOYSKLAD_(PRODUCT|SERVICE)_[0-9a-f-]{36}$/i.test(xmlId)) throw new Error('PRODUCT_IMPORT_ECHO_IDENTITY_INVALID');
    const result = asRecord(await this.bitrixCall(kind === 'service' ? 'catalog.product.service.list' : 'catalog.product.list', {
      select: ['id', 'iblockId', 'xmlId', 'type'], filter: { iblockId: Number(catalogId), xmlId }, order: { id: 'ASC' }, start: 0,
    }, true));
    const rows = result[kind === 'service' ? 'services' : 'products'];
    if (!Array.isArray(rows) || !Number.isInteger(result.total) || Number(result.total) < 0) throw new ProductCardManualReviewError('PRODUCT_IMPORT_ECHO_IDENTITY_UNAVAILABLE');
    if (Number(result.total) > 1) throw new ProductCardManualReviewError('PRODUCT_IMPORT_ECHO_AMBIGUOUS');
    if (rows.length !== result.total || rows.some(row => !isRecord(row) || !scalarId(row.id) || !/^\d{1,20}$/.test(String(row.id)) ||
      String(row.iblockId) !== catalogId || row.xmlId !== xmlId || Number(row.type) !== (kind === 'service' ? 7 : 1))) throw new ProductCardManualReviewError('PRODUCT_IMPORT_ECHO_IDENTITY_MISMATCH');
    return rows.map(row => String(row.id));
  }

  async readBitrix24PriceProductId(priceId: string): Promise<string> {
    if (!/^\d{1,20}$/.test(priceId)) throw new Error('PRODUCT_PRICE_ID_INVALID');
    const result = asRecord(await this.bitrixCall('catalog.price.get', { id: priceId }));
    const price = isRecord(result.price) ? result.price : result;
    const productId = scalarId(price.productId);
    if (!productId || !/^\d{1,20}$/.test(productId)) throw new Error('PRODUCT_PRICE_PRODUCT_ID_UNAVAILABLE');
    return productId;
  }

  async findBitrix24ProductsByExactName(name: string, kind: 'product' | 'service'): Promise<Array<{ id: string; name: string; createdAt: string | null }>> {
    const rows: Array<{ id: string; name: string; createdAt: string | null }> = [];
    let start = 0;
    let total: number | null = null;
    for (let page = 0; page < 10; page += 1) {
      const method = kind === 'service' ? 'catalog.product.service.list' : 'catalog.product.list';
      const response = asRecord(await this.bitrixCall(method, {
        select: ['id', 'name', 'type', 'dateCreate'], filter: { name }, order: { id: 'ASC' }, start,
      }));
      const key = kind === 'service' ? 'services' : 'products';
      const values = Array.isArray(response[key]) ? response[key].filter(isRecord) : null;
      if (!values || typeof response.total !== 'number' || !Number.isInteger(response.total) || response.total < 0) {
        throw new ProductCardManualReviewError('PRODUCT_MATCH_CANDIDATE_SEARCH_INVALID');
      }
      if (total === null) total = response.total;
      else if (response.total !== total) throw new ProductCardManualReviewError('PRODUCT_MATCH_CANDIDATE_SEARCH_CHANGED');
      for (const row of values) {
        const id = scalarId(row.id);
        if (row.name !== name || !id || !/^\d{1,20}$/.test(id) || Number(row.type) !== (kind === 'service' ? 7 : 1)) continue;
        rows.push({ id, name, createdAt: nullableString(row.dateCreate) });
      }
      if (total > EXACT_NAME_CANDIDATE_LIMIT) throw new ProductCardManualReviewError('PRODUCT_MATCH_CANDIDATE_SET_TOO_LARGE');
      if (start + values.length >= total) return rows;
      if (!values.length) throw new ProductCardManualReviewError('PRODUCT_MATCH_CANDIDATE_SEARCH_INCOMPLETE');
      start += values.length;
    }
    throw new ProductCardManualReviewError('PRODUCT_MATCH_CANDIDATE_SEARCH_TOO_LARGE');
  }

  async findMoyskladProductsByExactName(name: string, kind: 'product' | 'service'): Promise<Array<{ id: string; name: string; createdAt: string | null }>> {
    const base = process.env.MOYSKLAD_API_BASE_URL;
    if (!base) throw new Error('MOYSKLAD_PRODUCT_API_NOT_CONFIGURED');
    const url = new URL(`entity/${kind}`, ensureSlash(base));
    url.searchParams.set('filter', `name=${name}`);
    url.searchParams.set('limit', String(EXACT_NAME_CANDIDATE_LIMIT + 1));
    url.searchParams.set('offset', '0');
    const page = asRecord(await this.moyskladRequestUrl(url));
    const rows = Array.isArray(page.rows) ? page.rows.filter(isRecord) : null;
    const meta = isRecord(page.meta) ? page.meta : {};
    const size = typeof meta.size === 'number' ? meta.size : null;
    if (!rows || size === null || !Number.isInteger(size) || size < 0) throw new ProductCardManualReviewError('PRODUCT_MATCH_CANDIDATE_SEARCH_INVALID');
    if (size > EXACT_NAME_CANDIDATE_LIMIT) throw new ProductCardManualReviewError('PRODUCT_MATCH_CANDIDATE_SET_TOO_LARGE');
    return rows.flatMap((row) => {
      if (row.name !== name || !isUuid(String(row.id ?? '')) || !isRecord(row.meta) || row.meta.type !== kind) return [];
      return [{ id: String(row.id), name, createdAt: nullableString(row.created) }];
    });
  }

  async readBitrix24(id: string, kind: 'product' | 'service' = 'product', options: { includeTaxSemantics?: boolean } = {}): Promise<ProductCardSnapshot> {
    if (!/^\d{1,20}$/.test(id)) throw new Error('PRODUCT_ID_INVALID');
    const result = asRecord(await this.bitrixCall(kind === 'service' ? 'catalog.product.service.get' : 'catalog.product.get', { id }));
    const product = isRecord(result[kind]) ? result[kind] : result;
    if (String(product.id ?? product.ID ?? '') !== id) throw new Error('PRODUCT_CARD_READ_INVALID');
    if (Number(product.type) !== (kind === 'service' ? 7 : 1)) throw new ProductCardManualReviewError('PRODUCT_CARD_TYPE_UNSUPPORTED');
    const pricesResult = asRecord(await this.bitrixCall('catalog.price.list', {
      select: ['id', 'productId', 'catalogGroupId', 'price', 'currency'],
      filter: { productId: Number(id) },
      order: { id: 'ASC' },
      start: 0,
    }));
    const prices = Array.isArray(pricesResult.prices) ? await Promise.all(pricesResult.prices.filter(isRecord).map(async (price) => {
      const idValue = scalarId(price.id);
      if (scalarId(price.productId) !== id) throw new ProductCardManualReviewError('PRODUCT_PRICE_PRODUCT_MISMATCH');
      const typeId = scalarId(price.catalogGroupId);
      const proposed = idValue ? await this.dryWrites?.readback('BITRIX24', 'price', idValue) : undefined;
      const value = finiteNumber(proposed?.value ?? price.price);
      const currencyValue = proposed?.currency ?? price.currency;
      const currency = typeof currencyValue === 'string' ? currencyValue : '';
      if (!idValue || !typeId || value === null) throw new Error('PRODUCT_PRICE_READ_INVALID');
      return { priceId: idValue, typeId, value, currency };
    })) : [];
    const proposed = await this.dryWrites?.readback('BITRIX24', kind, id);
    const scalarFields = primitiveFields({ ...product, ...(proposed ?? {}) });
    const values = {
      name: nullableString(proposed?.name ?? product.name),
      code: nullableString(proposed?.code ?? product.code),
      detailText: nullableString(proposed?.detailText ?? product.detailText),
      unitId: proposed?.measure === null ? null : proposed?.measure === undefined ? (product.measure === null || product.measure === undefined ? null : scalarId(product.measure)) : scalarId(proposed.measure),
      fields: scalarFields,
      prices,
      ...(options.includeTaxSemantics ? { taxSemantics: await this.bitrixTaxSemantics(product).catch(() => null) } : {}),
      updatedAt: nullableString(product.dateModify ?? product.dateCreate),
      createdAt: nullableString(product.dateCreate),
    };
    return values;
  }

  private async bitrixTaxSemantics(product: Record<string, unknown>): Promise<string | null> {
    const included = booleanValue(product.vatIncluded);
    const iblockId = scalarId(product.iblockId);
    if (included === null || !iblockId || !/^\d{1,20}$/.test(iblockId)) return null;

    let vatId = positiveIntegerId(product.vatId);
    if (!vatId) {
      if (!this.bitrixCatalogVatIds.has(iblockId)) {
        const response = asRecord(await this.bitrixCall('catalog.catalog.get', { id: iblockId }));
        const catalog = isRecord(response.catalog) ? response.catalog : response;
        this.bitrixCatalogVatIds.set(iblockId, positiveIntegerId(catalog.vatId));
      }
      vatId = this.bitrixCatalogVatIds.get(iblockId) ?? null;
    }

    if (!vatId) return JSON.stringify({ rate: 0, enabled: false, included });
    let rate = this.bitrixVatRates.get(vatId);
    if (rate === undefined) {
      const response = asRecord(await this.bitrixCall('catalog.vat.get', { id: vatId }));
      const vat = isRecord(response.vat) ? response.vat : response;
      const parsed = finiteNumber(vat.rate);
      if (parsed === null || parsed < 0) return null;
      rate = parsed;
      this.bitrixVatRates.set(vatId, rate);
    }
    return JSON.stringify({ rate, enabled: true, included });
  }

  async readMoysklad(id: string, kind: 'product' | 'service' = 'product'): Promise<ProductCardSnapshot> {
    if (!isUuid(id)) throw new Error('PRODUCT_ID_INVALID');
    const product = asRecord(await this.moyskladRequest(`entity/${kind}/${encodeURIComponent(id)}`, 'GET'));
    if (product.id !== id || !isRecord(product.meta)) throw new Error('PRODUCT_CARD_READ_INVALID');
    if (product.meta.type !== kind) throw new ProductCardManualReviewError('PRODUCT_CARD_TYPE_UNSUPPORTED');
    const uom = isRecord(product.uom) && isRecord(product.uom.meta) ? idFromHref(product.uom.meta.href) : null;
    // Coalesce repeated currency relations only within this snapshot. Twelve
    // price types commonly refer to the same currency; no cross-event cache.
    const currencies = new Map<string, Promise<string | null>>();
    const prices = Array.isArray(product.salePrices) ? await Promise.all(product.salePrices.filter(isRecord).map(async (price) => {
      const typeMeta = isRecord(price.priceType) && isRecord(price.priceType.meta) ? price.priceType.meta : {};
      const typeId = idFromHref(typeMeta.href);
      // Remap salePrices.value is in minor units; catalog.price uses major units.
      const nativeMinorValue = finiteNumber(price.value);
      const value = nativeMinorValue === null || nativeMinorValue < 0 ? null : nativeMinorValue / 100;
      if (!typeId || value === null) throw new Error('PRODUCT_PRICE_READ_INVALID');
      const rawCurrency = isRecord(price.currency) ? price.currency : undefined;
      const currencyId = isRecord(rawCurrency?.meta) ? idFromHref(rawCurrency.meta.href) : null;
      let currencyCode = explicitIsoCode(rawCurrency);
      if (!currencyCode && currencyId) {
        if (!currencies.has(currencyId)) currencies.set(currencyId, this.moyskladRequest(`entity/currency/${encodeURIComponent(currencyId)}`, 'GET').then(currency => explicitIsoCode(asRecord(currency))));
        currencyCode = await currencies.get(currencyId)!;
      }
      const currencyRef = currencyId ? { meta: {
        href: `https://api.moysklad.ru/api/remap/1.2/entity/currency/${currencyId}`,
        type: 'currency', mediaType: 'application/json',
      } } : undefined;
      return { priceId: typeId, typeId, value, currency: currencyCode ?? '', currencyRef };
    })) : [];
    const proposed = await this.dryWrites?.readback('MOYSKLAD', kind, id);
    const scalarFields = primitiveFields({ ...product, ...(proposed ?? {}) });
    const values = {
      name: nullableString(proposed?.name ?? product.name),
      code: nullableString(proposed?.code ?? product.code),
      detailText: nullableString(proposed?.description ?? product.description),
      unitId: isRecord(proposed?.uom) && isRecord(proposed.uom.meta) ? idFromHref(proposed.uom.meta.href) : uom,
      fields: scalarFields,
      prices,
      taxSemantics: moyskladTaxSemantics(product),
      updatedAt: nullableString(product.updated),
      createdAt: nullableString(product.created),
    };
    const proposedPrices = Array.isArray(proposed?.salePrices) ? proposed.salePrices.filter(isRecord).map((price) => {
      const typeMeta = isRecord(price.priceType) && isRecord(price.priceType.meta) ? price.priceType.meta : {};
      const typeId = idFromHref(typeMeta.href);
      const current = typeId ? values.prices.find((entry) => entry.typeId === typeId) : undefined;
      const nativeMinorValue = finiteNumber(price.value);
      const value = nativeMinorValue === null || nativeMinorValue < 0 ? null : nativeMinorValue / 100;
      if (!typeId || value === null) return null;
      return {
        priceId: typeId, typeId, value,
        currency: current?.currency ?? '',
        ...(isRecord(price.currency) ? { currencyRef: price.currency } : {}),
      };
    }).filter((price): price is NonNullable<typeof price> => price !== null) : null;
    return { ...values, ...(proposedPrices ? { prices: proposedPrices } : {}) };
  }

  async readMoyskladRecord(id: string, kind: 'product' | 'service' = 'product'): Promise<Record<string, unknown>> {
    if (!isUuid(id)) throw new Error('PRODUCT_ID_INVALID');
    const record = asRecord(await this.moyskladRequest(`entity/${kind}/${encodeURIComponent(id)}`, 'GET'));
    if (record.id !== id || !isRecord(record.meta) || record.meta.type !== kind) {
      throw new ProductCardManualReviewError('PRODUCT_CARD_TYPE_UNSUPPORTED');
    }
    return record;
  }

  async updateBitrix24(id: string, fields: Record<string, unknown>, kind: 'product' | 'service' = 'product'): Promise<void> {
    if (!/^\d{1,20}$/.test(id)) throw new Error('PRODUCT_ID_INVALID');
    if (Object.keys(fields).some((key) => key === 'measure' ? !isSafeUnitValue(fields[key]) : !isSafeCatalogScalarField(key, fields[key]))) throw new Error('PRODUCT_FIELD_NOT_ALLOWED');
    if (typeof fields.detailText === 'string' || fields.detailText === null) {
      try { fields = { ...fields, detailText: bitrixProductDescription(fields.detailText ?? ''), detailTextType: 'text' }; }
      catch (error) {
        if (error instanceof ProductDescriptionEncodingError) throw new ProductCardManualReviewError(error.reason);
        throw error;
      }
    }
    if (await this.dryWrites?.propose({ provider: 'BITRIX24', entityType: kind, entityId: id, operation: 'UPDATE', fields })) return;
    assertApplyExternalWrite('BITRIX24', 'PRODUCT_UPDATE');
    await this.bitrixCall(kind === 'service' ? 'catalog.product.service.update' : 'catalog.product.update', { id, fields });
  }

  async updateBitrix24Price(priceId: string, value: number, currency: string): Promise<void> {
    if (!/^\d{1,20}$/.test(priceId) || !Number.isFinite(value) || !currency) throw new Error('PRODUCT_PRICE_UPDATE_INVALID');
    if (await this.dryWrites?.propose({ provider: 'BITRIX24', entityType: 'price', entityId: priceId, operation: 'UPDATE', fields: { value, currency } })) return;
    assertApplyExternalWrite('BITRIX24', 'PRODUCT_PRICE_UPDATE');
    await this.bitrixCall('catalog.price.update', { id: priceId, fields: { price: value, currency } });
  }

  async updateMoysklad(id: string, fields: Record<string, unknown>, kind: 'product' | 'service' = 'product'): Promise<void> {
    if (!isUuid(id)) throw new Error('PRODUCT_ID_INVALID');
    if (Object.keys(fields).some((key) => !['name', 'description', 'uom', 'salePrices'].includes(key))) throw new Error('PRODUCT_FIELD_NOT_ALLOWED');
    if (await this.dryWrites?.propose({ provider: 'MOYSKLAD', entityType: kind, entityId: id, operation: 'UPDATE', fields })) return;
    assertApplyExternalWrite('MOYSKLAD', 'PRODUCT_UPDATE');
    await this.moyskladRequest(`entity/${kind}/${encodeURIComponent(id)}`, 'PUT', fields);
  }

  private async bitrixCall(method: string, params: Record<string, unknown>, includePagination = false): Promise<unknown> {
    if (/\.update(?:\.json)?$/i.test(method)) assertApplyExternalWrite('BITRIX24', 'PRODUCT_REQUEST');
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new Error('BITRIX24_PRODUCT_API_NOT_CONFIGURED');
    const url = new URL(`${method}.json`, ensureSlash(base));
    const body = new URLSearchParams();
    addFormValues(body, params);
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
      redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => { throw new ProviderFailure('BITRIX24', null); });
    if (!response.ok) throw providerResponseFailure('BITRIX24', response.status, response.headers.get('retry-after'));
    const payload: unknown = await response.json().catch(() => { throw new ProviderFailure('BITRIX24', null); });
    if (!isRecord(payload) || 'error' in payload || !('result' in payload)) throw new ProviderFailure('BITRIX24', 400);
    return includePagination && isRecord(payload.result)
      ? { ...(typeof payload.total === 'number' ? { total: payload.total } : {}), ...payload.result }
      : payload.result;
  }

  private async moyskladRequest(path: string, method: 'GET' | 'PUT', body?: Record<string, unknown>): Promise<unknown> {
    if (method !== 'GET') assertApplyExternalWrite('MOYSKLAD', 'PRODUCT_REQUEST');
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new Error('MOYSKLAD_PRODUCT_API_NOT_CONFIGURED');
    const url = new URL(path, ensureSlash(base));
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json;charset=utf-8', 'accept-encoding': 'gzip', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
    if (!response.ok) throw providerResponseFailure('MOYSKLAD', response.status, response.headers.get('retry-after'));
    if (response.status === 204 && method !== 'GET') return {};
    const payload: unknown = await response.json().catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
    if (!isRecord(payload)) throw new ProviderFailure('MOYSKLAD', 400);
    return payload;
  }

  private async moyskladRequestUrl(url: URL): Promise<unknown> {
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!token) throw new Error('MOYSKLAD_PRODUCT_API_NOT_CONFIGURED');
    const response = await fetch(url, {
      method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
    if (!response.ok) throw providerResponseFailure('MOYSKLAD', response.status, response.headers.get('retry-after'));
    const payload: unknown = await response.json().catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
    if (!isRecord(payload)) throw new ProviderFailure('MOYSKLAD', 400);
    return payload;
  }
}

function addFormValues(form: URLSearchParams, value: unknown, prefix = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => addFormValues(form, item, `${prefix}[${index}]`));
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) addFormValues(form, child, prefix ? `${prefix}[${key}]` : key);
  } else if (prefix && value !== undefined && value !== null) form.set(prefix, String(value));
}

function ensureSlash(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('PRODUCT_API_BASE_INVALID');
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : typeof value === 'string' ? value : null; }
function primitiveFields(value: Record<string, unknown>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child === null || typeof child === 'string' || typeof child === 'boolean' || typeof child === 'number' && Number.isFinite(child))) as Record<string, string | number | boolean | null>;
}
function isSafeCatalogScalarField(key: string, value: unknown): boolean {
  const blocked = new Set([
    'id', 'meta', 'type', 'iblockId', 'iblockSection', 'iblockSectionId',
    'detailPicture', 'previewPicture', 'quantity', 'quantityReserved', 'quantityTrace',
    'available', 'active', 'xmlId', 'createdBy', 'modifiedBy', 'dateCreate', 'timestampX',
    'dateActiveFrom', 'dateActiveTo', 'priceType', 'purchasingPrice', 'purchasingCurrency',
  ]);
  return /^[A-Za-z][A-Za-z0-9]*$/.test(key) && !blocked.has(key) &&
    (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value));
}
function isSafeUnitValue(value: unknown): boolean { return Number.isInteger(value) && Number(value) > 0; }
function scalarId(value: unknown): string | null { return typeof value === 'string' || typeof value === 'number' ? String(value) : null; }
function finiteNumber(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function positiveIntegerId(value: unknown): string | null {
  const candidate = scalarId(value);
  return candidate && /^\d{1,20}$/.test(candidate) && Number(candidate) > 0 ? candidate : null;
}
function booleanValue(value: unknown): boolean | null {
  if (value === true || value === 'Y') return true;
  if (value === false || value === 'N') return false;
  return null;
}
function moyskladTaxSemantics(product: Record<string, unknown>): string | null {
  const enabled = booleanValue(product.vatEnabled);
  const included = booleanValue(product.vatIncluded);
  const rate = finiteNumber(product.vat);
  if (enabled === null || included === null || rate === null || rate < 0) return null;
  return JSON.stringify({ rate, enabled, included });
}
function explicitIsoCode(value: Record<string, any> | undefined): string | null {
  if (!value) return null;
  const code = typeof value.isoCode === 'string' ? value.isoCode : typeof value.iso_code === 'string' ? value.iso_code : null;
  return code && /^[A-Za-z]{3}$/.test(code.trim()) ? code.trim().toUpperCase() : null;
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function idFromHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const id = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    return isUuid(id) ? id : null;
  } catch { return null; }
}
function asRecord(value: unknown): Record<string, any> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
