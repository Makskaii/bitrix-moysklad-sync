export type ClientRecord = Record<string, unknown>;
import { assertApplyExternalWrite } from '../external-write-guard';
import { ProviderFailure, providerResponseFailure } from '../provider-failure';

export interface ClientSyncGateway {
  readBitrix(entity: 'COMPANY' | 'CONTACT', id: string): Promise<ClientRecord>;
  readMoysklad(type: 'counterparty' | 'contactperson', id: string, parentId: string | null): Promise<ClientRecord>;
  updateBitrix(entity: 'COMPANY' | 'CONTACT', id: string, fields: Record<string, unknown>, eventId?: string): Promise<void>;
  updateMoysklad(type: 'counterparty' | 'contactperson', id: string, parentId: string | null, fields: Record<string, unknown>, eventId?: string): Promise<void>;
}

import { DryRunWriteJournal } from '../dry-run-write-journal';

/** Runtime access is limited to exact IDs from an active pair and fields explicitly approved by field settings. */
export class HttpClientSyncGateway implements ClientSyncGateway {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly dryWrites?: DryRunWriteJournal) {}

  async readBitrix(entity: 'COMPANY' | 'CONTACT', id: string): Promise<ClientRecord> {
    const type = entity === 'COMPANY' ? 'company' : 'contact';
    const created = await this.dryWrites?.createdRecord('BITRIX24', type, id);
    if (created) return { ID: id, ...created };
    const method = entity === 'COMPANY' ? 'crm.company.get.json' : 'crm.contact.get.json';
    const payload = await this.bitrixRequest(method, { id });
    if (!isRecord(payload)) throw new Error('BITRIX24_CLIENT_READ_INVALID');
    const fields = await this.dryWrites?.readback('BITRIX24', entity === 'COMPANY' ? 'company' : 'contact', id);
    return fields ? { ...payload, ...fields } : payload;
  }

  async readMoysklad(type: 'counterparty' | 'contactperson', id: string, parentId: string | null): Promise<ClientRecord> {
    const created = await this.dryWrites?.createdRecord('MOYSKLAD', type, id);
    if (created) return { id, ...created, meta: { type } };
    const payload = await this.moyskladRequest(moyskladRecordUrl(type, id, parentId), 'GET');
    if (!isRecord(payload)) throw new Error('MOYSKLAD_CLIENT_READ_INVALID');
    const fields = await this.dryWrites?.readback('MOYSKLAD', type, id);
    return fields ? { ...payload, ...fields } : payload;
  }

  async updateBitrix(entity: 'COMPANY' | 'CONTACT', id: string, fields: Record<string, unknown>, eventId?: string): Promise<void> {
    if (await this.dryWrites?.propose({ eventId, provider: 'BITRIX24', entityType: entity === 'COMPANY' ? 'company' : 'contact', entityId: id, operation: 'UPDATE', fields })) return;
    assertApplyExternalWrite('BITRIX24', 'CLIENT_UPDATE', id, `client:${entity}`);
    const method = entity === 'COMPANY' ? 'crm.company.update.json' : 'crm.contact.update.json';
    const form = new URLSearchParams({ id });
    for (const [field, value] of Object.entries(fields)) appendFormValue(form, `fields[${field}]`, value);
    const payload = await this.bitrixRequest(method, form);
    if (payload !== true) throw new Error('BITRIX24_CLIENT_WRITE_REJECTED');
  }

  async updateMoysklad(type: 'counterparty' | 'contactperson', id: string, parentId: string | null, fields: Record<string, unknown>, eventId?: string): Promise<void> {
    if (await this.dryWrites?.propose({ eventId, provider: 'MOYSKLAD', entityType: type, entityId: id, operation: 'UPDATE', fields })) return;
    assertApplyExternalWrite('MOYSKLAD', 'CLIENT_UPDATE', id, `client:${type === 'counterparty' ? 'COMPANY' : 'CONTACT'}`);
    await this.moyskladRequest(moyskladRecordUrl(type, id, parentId), 'PUT', fields);
  }

  private async bitrixRequest(method: string, body: URLSearchParams | Record<string, string>): Promise<unknown> {
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
    }).catch(() => { throw new ProviderFailure('BITRIX24', null); });
    if (!response.ok) throw providerResponseFailure('BITRIX24', response.status, response.headers.get('retry-after'));
    const payload: unknown = await response.json().catch(() => { throw new ProviderFailure('BITRIX24', null); });
    if (!isRecord(payload) || payload.error || !('result' in payload)) throw new ProviderFailure('BITRIX24', 400);
    return payload.result;
  }

  private async moyskladRequest(path: string, method: 'GET' | 'PUT', body?: Record<string, unknown>): Promise<unknown> {
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
    }).catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
    if (!response.ok) throw providerResponseFailure('MOYSKLAD', response.status, response.headers.get('retry-after'));
    if (response.status === 204) return {};
    return await response.json().catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
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
