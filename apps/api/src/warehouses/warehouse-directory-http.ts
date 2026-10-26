import { providerResponseFailure } from '../provider-failure';
import { WarehouseElement, WarehouseStore, warehouseUuid } from './warehouse-directory-plan';

type RecordValue = Record<string, unknown>;
export class WarehouseDirectoryError extends Error {}
export const WAREHOUSE_IBLOCK_ID = '38';
const listParams = { IBLOCK_ID: WAREHOUSE_IBLOCK_ID, IBLOCK_TYPE_ID: 'rest_entity' };

/** Requests are supplied by the service so every HTTP call crosses its ON/recovery gate. */
export class WarehouseDirectoryHttp {
  constructor(private readonly request: (provider: 'BITRIX24' | 'MOYSKLAD', path: string, params?: Record<string, string>, write?: boolean) => Promise<RecordValue>) {}

  async verifySchema(): Promise<void> {
    const type = await this.request('BITRIX24', 'lists.get.iblock.type.id', { IBLOCK_ID: WAREHOUSE_IBLOCK_ID });
    if (type.result !== 'rest_entity') throw new WarehouseDirectoryError('WAREHOUSE_IBLOCK_TYPE_CHANGED');
    const payload = await this.request('BITRIX24', 'lists.field.get', listParams);
    if (!record(payload.result)) throw new WarehouseDirectoryError('WAREHOUSE_SCHEMA_INVALID');
    const fields = Object.values(payload.result);
    // lists.element.update replaces all configured fields. Never erase new properties.
    if (fields.length !== 1 || !record(fields[0]) || fields[0].FIELD_ID !== 'NAME' || fields[0].TYPE !== 'NAME') {
      throw new WarehouseDirectoryError('WAREHOUSE_SCHEMA_UNSUPPORTED');
    }
  }

  async stores(): Promise<WarehouseStore[]> {
    const rows: WarehouseStore[] = [];
    let expected: number | null = null;
    for (let offset = 0; offset < 1000;) {
      const body = await this.request('MOYSKLAD', `entity/store?limit=100&offset=${offset}`);
      const meta = record(body.meta) ? body.meta : {};
      if (!Array.isArray(body.rows) || !Number.isSafeInteger(meta.size) || Number(meta.size) < 0 || Number(meta.size) > 1000 || body.rows.length > 100) throw new WarehouseDirectoryError('WAREHOUSE_SOURCE_PAGE_INVALID');
      if (expected !== null && expected !== meta.size) throw new WarehouseDirectoryError('WAREHOUSE_SOURCE_CHANGED');
      expected = Number(meta.size);
      rows.push(...body.rows.map(parseStore));
      offset += body.rows.length;
      if (offset === expected) return rows;
      if (!body.rows.length || offset > expected) throw new WarehouseDirectoryError('WAREHOUSE_SOURCE_PAGE_INVALID');
    }
    throw new WarehouseDirectoryError('WAREHOUSE_SOURCE_TOO_LARGE');
  }

  async store(id: string): Promise<WarehouseStore> {
    const row = parseStore(await this.request('MOYSKLAD', `entity/store/${id}`));
    if (row.id !== id) throw new WarehouseDirectoryError('WAREHOUSE_SOURCE_ID_CHANGED');
    return row;
  }

  async elements(extra: Record<string, string> = {}): Promise<WarehouseElement[]> {
    const rows: WarehouseElement[] = [];
    const seen = new Set<string>();
    for (let start = 0, page = 0; page < 20; page += 1) {
      const body = await this.request('BITRIX24', 'lists.element.get', { ...listParams, ...extra, start: String(start),
        'SELECT[0]': 'ID', 'SELECT[1]': 'CODE', 'SELECT[2]': 'NAME', 'SELECT[3]': 'IBLOCK_ID' });
      if (!Array.isArray(body.result)) throw new WarehouseDirectoryError('WAREHOUSE_TARGET_PAGE_INVALID');
      for (const value of body.result) {
        if (!record(value) || !/^\d{1,20}$/.test(String(value.ID)) || String(value.IBLOCK_ID) !== WAREHOUSE_IBLOCK_ID || typeof value.NAME !== 'string' || typeof value.CODE !== 'string' || seen.has(String(value.ID))) throw new WarehouseDirectoryError('WAREHOUSE_TARGET_PAGE_INVALID');
        seen.add(String(value.ID));
        rows.push({ id: String(value.ID), code: value.CODE, name: value.NAME });
      }
      if (body.next !== undefined && body.next !== null) {
        if (!Number.isSafeInteger(body.next) || Number(body.next) <= start || !body.result.length) throw new WarehouseDirectoryError('WAREHOUSE_TARGET_CURSOR_INVALID');
        start = Number(body.next);
      } else if (body.result.length < 50 || extra.ELEMENT_ID || extra.ELEMENT_CODE) return rows;
      else start += body.result.length;
    }
    throw new WarehouseDirectoryError('WAREHOUSE_TARGET_TOO_LARGE');
  }

  async add(store: WarehouseStore): Promise<string> {
    const body = await this.request('BITRIX24', 'lists.element.add', { ...listParams, ELEMENT_CODE: store.id, 'FIELDS[NAME]': store.name }, true);
    if (!/^\d{1,20}$/.test(String(body.result))) throw new WarehouseDirectoryError('WAREHOUSE_ADD_ACK_INVALID');
    return String(body.result);
  }

  async rename(element: WarehouseElement, name: string): Promise<void> {
    const body = await this.request('BITRIX24', 'lists.element.update', { ...listParams, ELEMENT_ID: element.id, ELEMENT_CODE: element.code, 'FIELDS[NAME]': name }, true);
    if (body.result !== true) throw new WarehouseDirectoryError('WAREHOUSE_UPDATE_ACK_INVALID');
  }
}

function parseStore(value: unknown): WarehouseStore {
  if (!record(value) || typeof value.id !== 'string' || !warehouseUuid(value.id) || typeof value.name !== 'string' || !value.name.trim() || !record(value.meta) || value.meta.type !== 'store' || value.archived !== undefined && typeof value.archived !== 'boolean') throw new WarehouseDirectoryError('WAREHOUSE_SOURCE_INVALID');
  return { id: value.id.toLowerCase(), name: value.name, archived: value.archived === true };
}
export function record(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export async function warehouseFetch(provider: 'BITRIX24' | 'MOYSKLAD', path: string, params: Record<string, string> = {}): Promise<RecordValue> {
  const base = provider === 'BITRIX24' ? process.env.BITRIX24_REST_BASE_URL : process.env.MOYSKLAD_API_BASE_URL;
  if (!base || new URL(base).protocol !== 'https:') throw new WarehouseDirectoryError('WAREHOUSE_PROVIDER_NOT_CONFIGURED');
  const token = process.env.MOYSKLAD_API_TOKEN;
  if (provider === 'MOYSKLAD' && !token) throw new WarehouseDirectoryError('WAREHOUSE_PROVIDER_NOT_CONFIGURED');
  const url = new URL(provider === 'BITRIX24' ? `${path}.json` : path, base.replace(/\/?$/, '/'));
  const response = await fetch(url, { method: provider === 'BITRIX24' ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: provider === 'BITRIX24' ? { 'content-type': 'application/x-www-form-urlencoded' }
      : { authorization: `Bearer ${token}`, accept: 'application/json;charset=utf-8', 'accept-encoding': 'gzip' },
    ...(provider === 'BITRIX24' ? { body: new URLSearchParams(params) } : {}),
  });
  if (!response.ok) throw providerResponseFailure(provider, response.status, response.headers.get('retry-after'));
  const body: unknown = await response.json();
  if (!record(body)) throw new WarehouseDirectoryError('WAREHOUSE_PROVIDER_RESPONSE_INVALID');
  if (provider === 'BITRIX24' && body.error) {
    const code = typeof body.error === 'string' && /^[A-Z_]{1,80}$/.test(body.error) ? body.error : 'REJECTED';
    throw new WarehouseDirectoryError(`WAREHOUSE_BITRIX_${code}`);
  }
  return body;
}
