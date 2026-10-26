export type ClientRecord = Record<string, unknown>;
import { assertApplyExternalWrite } from '../external-write-guard';
import { ClientProviderOperation, ProviderFailure, providerResponseFailure } from '../provider-failure';
import { COMPANY_PRICE_TYPE_FIELD, COMPANY_PRICE_TYPE_IBLOCK, COMPANY_PRICE_TYPE_IBLOCK_TYPE, assertCompanyPriceTypeSchema, companyPriceTypeOptions, selectedCompanyPriceType, PriceTypeOption, normalizeMoyskladPriceType, encodeMoyskladPriceType } from './company-price-type';

export interface ClientSyncGateway {
  readBitrix(entity: 'COMPANY' | 'CONTACT', id: string): Promise<ClientRecord>;
  readMoysklad(type: 'counterparty' | 'contactperson', id: string, parentId: string | null): Promise<ClientRecord>;
  updateBitrix(entity: 'COMPANY' | 'CONTACT', id: string, fields: Record<string, unknown>, eventId?: string): Promise<void>;
  updateMoysklad(type: 'counterparty' | 'contactperson', id: string, parentId: string | null, fields: Record<string, unknown>, eventId?: string): Promise<void>;
}

import { DryRunWriteJournal } from '../dry-run-write-journal';

/** Runtime access is limited to exact IDs from an active pair and fields explicitly approved by field settings. */
export class HttpClientSyncGateway implements ClientSyncGateway {
  private companyPriceOptions: { at: number; options: PriceTypeOption[] } | null = null;
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly dryWrites?: DryRunWriteJournal) {}

  async readBitrix(entity: 'COMPANY' | 'CONTACT', id: string): Promise<ClientRecord> {
    const type = entity === 'COMPANY' ? 'company' : 'contact';
    const created = await this.dryWrites?.createdRecord('BITRIX24', type, id);
    if (created) return { ID: id, ...created };
    const method = entity === 'COMPANY' ? 'crm.company.get.json' : 'crm.contact.get.json';
    const payload = await this.bitrixRequest(method, { id }, entity === 'COMPANY' ? 'CLIENT_COMPANY_READ' : 'CLIENT_CONTACT_READ');
    if (!isRecord(payload)) throw new Error('BITRIX24_CLIENT_READ_INVALID');
    const fields = await this.dryWrites?.readback('BITRIX24', entity === 'COMPANY' ? 'company' : 'contact', id);
    const record = fields ? { ...payload, ...fields } : payload;
    if (entity !== 'COMPANY' || record[COMPANY_PRICE_TYPE_FIELD] === undefined || record[COMPANY_PRICE_TYPE_FIELD] === null || record[COMPANY_PRICE_TYPE_FIELD] === '' || record[COMPANY_PRICE_TYPE_FIELD] === false) return record;
    const refresh = async () => {
      const rows = await this.bitrixRequest('crm.company.userfield.list.json', new URLSearchParams({ 'filter[FIELD_NAME]': COMPANY_PRICE_TYPE_FIELD }), 'CLIENT_COMPANY_READ');
      if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0]) || !/^\d+$/.test(String(rows[0].ID))) throw new Error('COMPANY_PRICE_TYPE_FIELD_UNAVAILABLE');
      const meta = await this.bitrixRequest('crm.company.userfield.get.json', new URLSearchParams({ id: String(rows[0].ID) }), 'CLIENT_COMPANY_READ');
      assertCompanyPriceTypeSchema(meta);
      const all: unknown[] = [];
      for (let start = 0; start < 1000; start += 50) {
        const page = await this.bitrixRequest('lists.element.get.json', new URLSearchParams({ IBLOCK_ID: COMPANY_PRICE_TYPE_IBLOCK, IBLOCK_TYPE_ID: COMPANY_PRICE_TYPE_IBLOCK_TYPE, start: String(start) }), 'CLIENT_COMPANY_READ');
        if (!Array.isArray(page)) throw new Error('COMPANY_PRICE_TYPE_DIRECTORY_INVALID');
        all.push(...page);
        if (page.length < 50) { this.companyPriceOptions = { at: Date.now(), options: companyPriceTypeOptions(all) }; return; }
      }
      throw new Error('COMPANY_PRICE_TYPE_DIRECTORY_TOO_LARGE');
    };
    if (!this.companyPriceOptions || Date.now() - this.companyPriceOptions.at > 60_000) await refresh();
    if (!this.companyPriceOptions!.options.some(option => option.id === String(record[COMPANY_PRICE_TYPE_FIELD]))) await refresh();
    return { ...record, [COMPANY_PRICE_TYPE_FIELD]: selectedCompanyPriceType(record[COMPANY_PRICE_TYPE_FIELD], this.companyPriceOptions!.options) };
  }

  async readMoysklad(type: 'counterparty' | 'contactperson', id: string, parentId: string | null): Promise<ClientRecord> {
    const created = await this.dryWrites?.createdRecord('MOYSKLAD', type, id);
    if (created) return { id, ...created, meta: { type } };
    const payload = await this.moyskladRequest(moyskladRecordUrl(type, id, parentId), 'GET', undefined, type === 'counterparty' ? 'CLIENT_COUNTERPARTY_READ' : 'CLIENT_CONTACTPERSON_READ');
    if (!isRecord(payload)) throw new Error('MOYSKLAD_CLIENT_READ_INVALID');
    const fields = await this.dryWrites?.readback('MOYSKLAD', type, id);
    const record = fields ? { ...payload, ...fields } : payload;
    return type === 'counterparty' ? normalizeMoyskladPriceType(record, process.env.MOYSKLAD_API_BASE_URL) : record;
  }

  async updateBitrix(entity: 'COMPANY' | 'CONTACT', id: string, fields: Record<string, unknown>, eventId?: string): Promise<void> {
    if (await this.dryWrites?.propose({ eventId, provider: 'BITRIX24', entityType: entity === 'COMPANY' ? 'company' : 'contact', entityId: id, operation: 'UPDATE', fields })) return;
    assertApplyExternalWrite('BITRIX24', 'CLIENT_UPDATE', id, `client:${entity}`);
    const method = entity === 'COMPANY' ? 'crm.company.update.json' : 'crm.contact.update.json';
    const form = new URLSearchParams({ id });
    for (const [field, value] of Object.entries(fields)) appendFormValue(form, `fields[${field}]`, value);
    const payload = await this.bitrixRequest(method, form, entity === 'COMPANY' ? 'CLIENT_COMPANY_UPDATE' : 'CLIENT_CONTACT_UPDATE');
    if (payload !== true) throw new Error('BITRIX24_CLIENT_WRITE_REJECTED');
  }

  async updateMoysklad(type: 'counterparty' | 'contactperson', id: string, parentId: string | null, fields: Record<string, unknown>, eventId?: string): Promise<void> {
    if (await this.dryWrites?.propose({ eventId, provider: 'MOYSKLAD', entityType: type, entityId: id, operation: 'UPDATE', fields })) return;
    assertApplyExternalWrite('MOYSKLAD', 'CLIENT_UPDATE', id, `client:${type === 'counterparty' ? 'COMPANY' : 'CONTACT'}`);
    if (type === 'contactperson' && 'priceType' in fields) throw new Error('CLIENT_PRICE_TYPE_REQUIRES_COUNTERPARTY');
    await this.moyskladRequest(moyskladRecordUrl(type, id, parentId), 'PUT', encodeMoyskladPriceType(fields, process.env.MOYSKLAD_API_BASE_URL), type === 'counterparty' ? 'CLIENT_COUNTERPARTY_UPDATE' : 'CLIENT_CONTACTPERSON_UPDATE');
  }

  private async bitrixRequest(method: string, body: URLSearchParams | Record<string, string>, operation: ClientProviderOperation): Promise<unknown> {
    if (/\.(?:add|update|delete)(?:\.json)?$/i.test(method)) {
      const form = body instanceof URLSearchParams ? body : new URLSearchParams(body);
      const nativeId = /\.add(?:\.json)?$/i.test(method) ? null : form.get('id');
      const entity = method.startsWith('crm.company.') ? 'client:COMPANY' : method.startsWith('crm.contact.') ? 'client:CONTACT' : undefined;
      assertApplyExternalWrite('BITRIX24', 'CLIENT_REQUEST', nativeId, entity);
    }
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new Error('BITRIX24_REST_NOT_CONFIGURED');
    const form = body instanceof URLSearchParams ? body : new URLSearchParams(body);
    const response = await this.fetcher(new URL(method, withSlash(base)), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new ProviderFailure('BITRIX24', null, null, operation); });
    if (!response.ok) throw providerResponseFailure('BITRIX24', response.status, response.headers.get('retry-after'), operation);
    const payload: unknown = await response.json().catch(() => { throw new ProviderFailure('BITRIX24', null, null, operation); });
    if (!isRecord(payload) || payload.error || !('result' in payload)) throw new ProviderFailure('BITRIX24', 400, null, operation);
    return payload.result;
  }

  private async moyskladRequest(path: string, method: 'GET' | 'PUT', body: Record<string, unknown> | undefined, operation: ClientProviderOperation): Promise<unknown> {
    if (method !== 'GET') {
      const nativeId = new URL(path, 'https://local.invalid').pathname.match(/\/(?:counterparty|contactpersons)\/([^/]+)$/)?.[1] ?? null;
      const entity = path.includes('/contactpersons/') ? 'client:CONTACT' : 'client:COMPANY';
      assertApplyExternalWrite('MOYSKLAD', 'CLIENT_REQUEST', nativeId ? decodeURIComponent(nativeId) : null, entity);
    }
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new Error('MOYSKLAD_API_NOT_CONFIGURED');
    const response = await this.fetcher(new URL(path, withSlash(base)), {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/json;charset=utf-8', 'accept-encoding': 'gzip', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new ProviderFailure('MOYSKLAD', null, null, operation); });
    if (!response.ok) throw providerResponseFailure('MOYSKLAD', response.status, response.headers.get('retry-after'), operation);
    if (response.status === 204) return {};
    return await response.json().catch(() => { throw new ProviderFailure('MOYSKLAD', null, null, operation); });
  }
}

function moyskladRecordUrl(type: 'counterparty' | 'contactperson', id: string, parentId: string | null): string {
  if (type === 'counterparty') return `entity/counterparty/${encodeURIComponent(id)}`;
  if (!parentId) throw new Error('MOYSKLAD_CONTACTPERSON_PARENT_REQUIRED');
  return `entity/counterparty/${encodeURIComponent(parentId)}/contactpersons/${encodeURIComponent(id)}`;
}

function appendFormValue(form: URLSearchParams, key: string, value: unknown) {
  if (value === null || value === undefined) { form.append(key, ''); return; }
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendFormValue(form, `${key}[${index}]`, item));
    return;
  }
  if (isRecord(value)) {
    for (const [nestedKey, nestedValue] of Object.entries(value)) appendFormValue(form, `${key}[${nestedKey}]`, nestedValue);
    return;
  }
  form.append(key, String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withSlash(value: string) { return value.endsWith('/') ? value : `${value}/`; }
