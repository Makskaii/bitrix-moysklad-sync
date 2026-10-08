import { Injectable } from '@nestjs/common';
import { ProductCardApi, ProductCardManualReviewError, ProductCardSnapshot } from './product-card-sync.service';

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
  async readBitrix24PriceProductId(priceId: string): Promise<string> {
    if (!/^\d{1,20}$/.test(priceId)) throw new Error('PRODUCT_PRICE_ID_INVALID');
    const result = asRecord(await this.bitrixCall('catalog.price.get', { id: priceId }));
    const price = isRecord(result.price) ? result.price : result;
    const productId = scalarId(price.productId);
    if (!productId || !/^\d{1,20}$/.test(productId)) throw new Error('PRODUCT_PRICE_PRODUCT_ID_UNAVAILABLE');
    return productId;
  }

  async readBitrix24(id: string): Promise<ProductCardSnapshot> {
    if (!/^\d{1,20}$/.test(id)) throw new Error('PRODUCT_ID_INVALID');
    const result = asRecord(await this.bitrixCall('catalog.product.get', { id }));
    const product = isRecord(result.product) ? result.product : result;
    if (String(product.id ?? product.ID ?? '') !== id) throw new Error('PRODUCT_CARD_READ_INVALID');
    if (Number(product.type) !== 1) throw new ProductCardManualReviewError('PRODUCT_CARD_TYPE_UNSUPPORTED');
    const pricesResult = asRecord(await this.bitrixCall('catalog.price.list', {
      select: ['id', 'productId', 'catalogGroupId', 'price', 'currency'],
      filter: { productId: Number(id) },
      order: { id: 'ASC' },
      start: 0,
    }));
    const prices = Array.isArray(pricesResult.prices) ? pricesResult.prices.filter(isRecord).map((price) => {
      const idValue = scalarId(price.id);
      const typeId = scalarId(price.catalogGroupId);
      const value = finiteNumber(price.price);
      const currency = typeof price.currency === 'string' ? price.currency : '';
      if (!idValue || !typeId || value === null) throw new Error('PRODUCT_PRICE_READ_INVALID');
      return { priceId: idValue, typeId, value, currency };
    }) : [];
    return {
      name: nullableString(product.name),
      detailText: nullableString(product.detailText),
      unitId: product.measure === null || product.measure === undefined ? null : scalarId(product.measure),
      prices,
      updatedAt: nullableString(product.dateModify ?? product.dateCreate),
    };
  }

  async readMoysklad(id: string): Promise<ProductCardSnapshot> {
    if (!isUuid(id)) throw new Error('PRODUCT_ID_INVALID');
    const product = asRecord(await this.moyskladRequest(`entity/product/${encodeURIComponent(id)}`, 'GET'));
    if (product.id !== id || !isRecord(product.meta)) throw new Error('PRODUCT_CARD_READ_INVALID');
    if (product.meta.type !== 'product') throw new ProductCardManualReviewError('PRODUCT_CARD_TYPE_UNSUPPORTED');
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
    return {
      name: nullableString(product.name),
      detailText: nullableString(product.description),
      unitId: uom,
      prices,
      updatedAt: nullableString(product.updated),
    };
  }

  async updateBitrix24(id: string, fields: Record<string, unknown>): Promise<void> {
    if (!/^\d{1,20}$/.test(id)) throw new Error('PRODUCT_ID_INVALID');
    if (Object.keys(fields).some((key) => !['name', 'detailText', 'measure'].includes(key))) throw new Error('PRODUCT_FIELD_NOT_ALLOWED');
    await this.bitrixCall('catalog.product.update', { id, fields });
  }

  async updateBitrix24Price(priceId: string, value: number, currency: string): Promise<void> {
    if (!/^\d{1,20}$/.test(priceId) || !Number.isFinite(value) || !currency) throw new Error('PRODUCT_PRICE_UPDATE_INVALID');
    await this.bitrixCall('catalog.price.update', { id: priceId, fields: { price: value, currency } });
  }

  async updateMoysklad(id: string, fields: Record<string, unknown>): Promise<void> {
    if (!isUuid(id)) throw new Error('PRODUCT_ID_INVALID');
    if (Object.keys(fields).some((key) => !['name', 'description', 'uom', 'salePrices'].includes(key))) throw new Error('PRODUCT_FIELD_NOT_ALLOWED');
    await this.moyskladRequest(`entity/product/${encodeURIComponent(id)}`, 'PUT', fields);
  }

  private async bitrixCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new Error('BITRIX24_PRODUCT_API_NOT_CONFIGURED');
    const url = new URL(`${method}.json`, ensureSlash(base));
    const body = new URLSearchParams();
    addFormValues(body, params);
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
      redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(payload) || 'error' in payload || !('result' in payload)) throw new Error('BITRIX24_PRODUCT_API_FAILED');
    return payload.result;
  }

  private async moyskladRequest(path: string, method: 'GET' | 'PUT', body?: Record<string, unknown>): Promise<unknown> {
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new Error('MOYSKLAD_PRODUCT_API_NOT_CONFIGURED');
    const url = new URL(path, ensureSlash(base));
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(payload)) throw new Error('MOYSKLAD_PRODUCT_API_FAILED');
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
