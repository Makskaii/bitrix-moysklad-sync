import { Injectable } from '@nestjs/common';
import { DryRunWriteJournal } from '../dry-run-write-journal';
import { ProviderFailure, providerResponseFailure } from '../provider-failure';
import { assertApplyExternalWrite } from '../external-write-guard';

const REQUEST_TIMEOUT_MS = 10_000;
export type InvoiceRecord = Record<string, unknown>;

@Injectable()
export class InvoiceHttpApi {
  constructor(private readonly dryWrites?: DryRunWriteJournal) {}

  async readBitrix24(id: string): Promise<InvoiceRecord> {
    if (!/^\d{1,20}$/.test(id)) throw new Error('INVOICE_ID_INVALID');
    const result = record(await this.bitrixCall('crm.item.get', { entityTypeId: 31, id }));
    const item = record(result.item ?? result);
    if (String(item.id ?? '') !== id) throw new Error('INVOICE_BITRIX_READBACK_INVALID');
    const proposed = await this.dryWrites?.readback('BITRIX24', 'crm_dynamic_31', id);
    return { ...item, ...(proposed ?? {}) };
  }

  async readMoysklad(id: string): Promise<InvoiceRecord> {
    if (!isUuid(id)) throw new Error('INVOICE_ID_INVALID');
    const item = record(await this.moyskladRequest(`entity/invoiceout/${encodeURIComponent(id)}`, 'GET'));
    if (item.id !== id || record(item.meta).type !== 'invoiceout') throw new Error('INVOICE_MOYSKLAD_READBACK_INVALID');
    const proposed = await this.dryWrites?.readback('MOYSKLAD', 'invoiceout', id);
    return { ...item, ...(proposed ?? {}) };
  }

  async findMoyskladByExternalCode(externalCode: string): Promise<InvoiceRecord[]> {
    const url = new URL('entity/invoiceout', ensureSlash(requiredEnv('MOYSKLAD_API_BASE_URL')));
    url.searchParams.set('filter', `externalCode=${externalCode}`);
    url.searchParams.set('limit', '2');
    const response = await this.moyskladRequestUrl(url, 'GET');
    const root = record(response);
    return Array.isArray(root.rows) ? root.rows.filter(isRecord) : [];
  }

  async findBitrix24ByOrigin(sourceId: string): Promise<InvoiceRecord[]> {
    const result = record(await this.bitrixCall('crm.item.list', {
      entityTypeId: 31,
      filter: { originatorId: 'MOYSKLAD', originId: sourceId },
      select: ['id', 'originId', 'originatorId'],
      order: { id: 'ASC' },
      start: 0,
      limit: 2,
    }));
    return Array.isArray(result.items) ? result.items.filter(isRecord) : [];
  }

  async createMoysklad(sourceId: string, orderId: string, fields: InvoiceRecord): Promise<string> {
    const base = ensureSlash(requiredEnv('MOYSKLAD_API_BASE_URL'));
    const body = { ...moyskladFields(fields, base), externalCode: sourceId, customerOrder: { meta: meta(base, 'customerorder', orderId) } };
    if (await this.dryWrites?.propose({ provider: 'MOYSKLAD', entityType: 'invoiceout', entityId: `externalCode:${sourceId}`, operation: 'CREATE', fields: body })) return `dry:${sourceId}`;
    assertApplyExternalWrite('MOYSKLAD', 'INVOICE_CREATE', null, 'invoice');
    const created = record(await this.moyskladRequest('entity/invoiceout', 'POST', body));
    const id = typeof created.id === 'string' && isUuid(created.id) ? created.id : '';
    if (!id) throw new Error('INVOICE_CREATE_RESPONSE_INVALID');
    return id;
  }

  async updateMoysklad(id: string, fields: InvoiceRecord): Promise<void> {
    const body = moyskladFields(fields, ensureSlash(requiredEnv('MOYSKLAD_API_BASE_URL')));
    if (Object.keys(body).length === 0) return;
    if (await this.dryWrites?.propose({ provider: 'MOYSKLAD', entityType: 'invoiceout', entityId: id, operation: 'UPDATE', fields: body })) return;
    assertApplyExternalWrite('MOYSKLAD', 'INVOICE_UPDATE', id, 'invoice');
    await this.moyskladRequest(`entity/invoiceout/${encodeURIComponent(id)}`, 'PUT', body);
  }

  async createBitrix24(sourceId: string, dealId: string, fields: InvoiceRecord): Promise<string> {
    const body = { ...fields, parentId2: Number(dealId), originatorId: 'MOYSKLAD', originId: sourceId };
    if (await this.dryWrites?.propose({ provider: 'BITRIX24', entityType: 'crm_dynamic_31', entityId: `origin:${sourceId}`, operation: 'CREATE', fields: body })) return `dry:${sourceId}`;
    assertApplyExternalWrite('BITRIX24', 'INVOICE_CREATE', null, 'invoice');
    const created = record(await this.bitrixCall('crm.item.add', { entityTypeId: 31, fields: body }));
    const item = record(created.item ?? created);
    const id = scalarId(item.id);
    if (!id || !/^\d{1,20}$/.test(id)) throw new Error('INVOICE_CREATE_RESPONSE_INVALID');
    return id;
  }

  async updateBitrix24(id: string, fields: InvoiceRecord): Promise<void> {
    if (!/^\d{1,20}$/.test(id)) throw new Error('INVOICE_ID_INVALID');
    if (Object.keys(fields).length === 0) return;
    if (await this.dryWrites?.propose({ provider: 'BITRIX24', entityType: 'crm_dynamic_31', entityId: id, operation: 'UPDATE', fields })) return;
    assertApplyExternalWrite('BITRIX24', 'INVOICE_UPDATE', id, 'invoice');
    await this.bitrixCall('crm.item.update', { entityTypeId: 31, id, fields });
  }

  async readDeal(id: string): Promise<InvoiceRecord> {
    if (!/^\d{1,20}$/.test(id)) throw new Error('DEAL_ID_INVALID');
    const result = record(await this.bitrixCall('crm.deal.get', { id }));
    const deal = record(result.deal ?? result);
    if (String(deal.ID ?? deal.id ?? '') !== id) throw new Error('DEAL_READBACK_INVALID');
    return deal;
  }

  async readCustomerOrder(id: string): Promise<InvoiceRecord> {
    if (!isUuid(id)) throw new Error('CUSTOMER_ORDER_ID_INVALID');
    const order = record(await this.moyskladRequest(`entity/customerorder/${encodeURIComponent(id)}`, 'GET'));
    if (order.id !== id || record(order.meta).type !== 'customerorder') throw new Error('CUSTOMER_ORDER_READBACK_INVALID');
    return order;
  }

  private async bitrixCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (/\.(?:add|update)(?:\.json)?$/i.test(method)) assertApplyExternalWrite('BITRIX24', /\.add$/i.test(method) ? 'INVOICE_CREATE' : 'INVOICE_UPDATE', /\.add$/i.test(method) ? null : scalarId(params.id), 'invoice');
    const base = requiredEnv('BITRIX24_REST_BASE_URL');
    const url = new URL(`${method}.json`, ensureSlash(base));
    const form = new URLSearchParams();
    appendForm(form, params);
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .catch(() => { throw new ProviderFailure('BITRIX24', null); });
    if (!response.ok) throw providerResponseFailure('BITRIX24', response.status, response.headers.get('retry-after'));
    const payload: unknown = await response.json().catch(() => { throw new ProviderFailure('BITRIX24', null); });
    if (!isRecord(payload) || 'error' in payload || !('result' in payload)) throw new ProviderFailure('BITRIX24', 400);
    return payload.result;
  }

  private async moyskladRequest(path: string, method: 'GET' | 'POST' | 'PUT', body?: InvoiceRecord): Promise<unknown> {
    return this.moyskladRequestUrl(new URL(path, ensureSlash(requiredEnv('MOYSKLAD_API_BASE_URL'))), method, body);
  }

  private async moyskladRequestUrl(url: URL, method: 'GET' | 'POST' | 'PUT', body?: InvoiceRecord): Promise<unknown> {
    if (method !== 'GET') assertApplyExternalWrite('MOYSKLAD', method === 'POST' ? 'INVOICE_CREATE' : 'INVOICE_UPDATE', method === 'POST' ? null : url.pathname.split('/').at(-1), 'invoice');
    const token = requiredEnv('MOYSKLAD_API_TOKEN');
    const response = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json;charset=utf-8', 'accept-encoding': 'gzip', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
    if (!response.ok) throw providerResponseFailure('MOYSKLAD', response.status, response.headers.get('retry-after'));
    if (response.status === 204) return {};
    const payload: unknown = await response.json().catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
    if (!isRecord(payload)) throw new ProviderFailure('MOYSKLAD', 400);
    return payload;
  }
}

function moyskladFields(fields: InvoiceRecord, base: string): InvoiceRecord {
  const output: InvoiceRecord = {};
  const attributes: Array<{ meta: { href: string; type: 'attributemetadata'; mediaType: 'application/json' }; value: unknown }> = [];
  for (const [key, value] of Object.entries(fields)) {
    const match = key.match(/^attributes\.([0-9a-f-]{36})$/i);
    if (match) attributes.push({ meta: { href: new URL(`entity/invoiceout/metadata/attributes/${match[1]}`, base).href, type: 'attributemetadata', mediaType: 'application/json' }, value });
    else if (key.toLowerCase() !== 'payedSum'.toLowerCase() && key.toLowerCase() !== 'shippedSum'.toLowerCase() && !['payments', 'shipment'].includes(key.toLowerCase())) output[key] = value;
  }
  if (attributes.length) output.attributes = attributes;
  return output;
}
function appendForm(form: URLSearchParams, value: unknown, prefix = ''): void {
  if (Array.isArray(value)) value.forEach((item, index) => appendForm(form, item, `${prefix}[${index}]`));
  else if (isRecord(value)) for (const [key, child] of Object.entries(value)) appendForm(form, child, prefix ? `${prefix}[${key}]` : key);
  else if (prefix && value !== undefined && value !== null) form.set(prefix, String(value));
}
function meta(base: string, type: string, id: string) { return { href: new URL(`entity/${type}/${encodeURIComponent(id)}`, base).href, type, mediaType: 'application/json' }; }
function ensureSlash(value: string): string { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('INVOICE_API_BASE_INVALID'); return url.href.endsWith('/') ? url.href : `${url.href}/`; }
function requiredEnv(name: string): string { const value = process.env[name]; if (!value) throw new Error(`INVOICE_API_NOT_CONFIGURED:${name}`); return value; }
function record(value: unknown): InvoiceRecord { return isRecord(value) ? value : {}; }
function scalarId(value: unknown): string | null { return typeof value === 'string' || typeof value === 'number' ? String(value) : null; }
function isRecord(value: unknown): value is InvoiceRecord { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
