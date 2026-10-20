import { Injectable } from '@nestjs/common';
import { assertApplyExternalWrite } from '../external-write-guard';
import { DryRunWriteJournal } from '../dry-run-write-journal';
import { ProductCardApi, ProductCardManualReviewError, ProductCardSnapshot } from './product-card-sync.service';
import { ProviderFailure, providerResponseFailure } from '../provider-failure';

const REQUEST_TIMEOUT_MS = 10_000;

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
  constructor(private readonly dryWrites?: DryRunWriteJournal) {}

  async readBitrix24PriceProductId(priceId: string): Promise<string> {
    if (!/^\d{1,20}$/.test(priceId)) throw new Error('PRODUCT_PRICE_ID_INVALID');
    const result = asRecord(await this.bitrixCall('catalog.price.get', { id: priceId }));
    const price = isRecord(result.price) ? result.price : result;
    const productId = scalarId(price.productId);
    if (!productId || !/^\d{1,20}$/.test(productId)) throw new Error('PRODUCT_PRICE_PRODUCT_ID_UNAVAILABLE');
    return productId;
  }

  async readBitrix24(id: string, kind: 'product' | 'service' = 'product'): Promise<ProductCardSnapshot> {
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
      updatedAt: nullableString(product.dateModify ?? product.dateCreate),
      createdAt: nullableString(product.dateCreate),
    };
    return values;
  }

  async readMoysklad(id: string, kind: 'product' | 'service' = 'product'): Promise<ProductCardSnapshot> {
    if (!isUuid(id)) throw new Error('PRODUCT_ID_INVALID');
    const product = asRecord(await this.moyskladRequest(`entity/${kind}/${encodeURIComponent(id)}`, 'GET'));
    if (product.id !== id || !isRecord(product.meta)) throw new Error('PRODUCT_CARD_READ_INVALID');
    if (product.meta.type !== kind) throw new ProductCardManualReviewError('PRODUCT_CARD_TYPE_UNSUPPORTED');
    const uom = isRecord(product.uom) && isRecord(product.uom.meta) ? idFromHref(product.uom.meta.href) : null;
    const prices = Array.isArray(product.salePrices) ? await Promise.all(product.salePrices.filter(isRecord).map(async (price) => {
      const typeMeta = isRecord(price.priceType) && isRecord(price.priceType.meta) ? price.priceType.meta : {};
      const typeId = idFromHref(typeMeta.href);
      const value = finiteNumber(price.value);
      if (!typeId || value === null) throw new Error('PRODUCT_PRICE_READ_INVALID');
      const rawCurrency = isRecord(price.currency) ? price.currency : undefined;
      const currencyId = isRecord(rawCurrency?.meta) ? idFromHref(rawCurrency.meta.href) : null;
      let currencyCode = explicitIsoCode(rawCurrency);
      if (!currencyCode && currencyId) {
        const currency = asRecord(await this.moyskladRequest(`entity/currency/${encodeURIComponent(currencyId)}`, 'GET'));
        currencyCode = explicitIsoCode(currency);
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
      updatedAt: nullableString(product.updated),
      createdAt: nullableString(product.created),
    };
    const proposedPrices = Array.isArray(proposed?.salePrices) ? proposed.salePrices.filter(isRecord).map((price) => {
      const typeMeta = isRecord(price.priceType) && isRecord(price.priceType.meta) ? price.priceType.meta : {};
      const typeId = idFromHref(typeMeta.href);
      const current = typeId ? values.prices.find((entry) => entry.typeId === typeId) : undefined;
      const value = finiteNumber(price.value);
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

  private async bitrixCall(method: string, params: Record<string, unknown>): Promise<unknown> {
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
    return payload.result;
  }

  private async moyskladRequest(path: string, method: 'GET' | 'PUT', body?: Record<string, unknown>): Promise<unknown> {
    if (method !== 'GET') assertApplyExternalWrite('MOYSKLAD', 'PRODUCT_REQUEST');
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new Error('MOYSKLAD_PRODUCT_API_NOT_CONFIGURED');
    const url = new URL(path, ensureSlash(base));
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
    if (!response.ok) throw providerResponseFailure('MOYSKLAD', response.status, response.headers.get('retry-after'));
    if (response.status === 204 && method !== 'GET') return {};
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
