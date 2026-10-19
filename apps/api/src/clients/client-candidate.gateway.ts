import { Injectable } from '@nestjs/common';
import { assertApplyExternalWrite } from '../external-write-guard';
import { ProviderFailure, providerResponseFailure } from '../provider-failure';
import { DatabaseService } from '../database.service';
import { DryRunWriteJournal } from '../dry-run-write-journal';
import { randomUUID } from 'node:crypto';
import {
  ClientCandidate, ClientCandidateGateway, ClientEntity, ClientSystem, ClientTargetType,
} from './client-runtime-resolver';

export const CLIENT_CANDIDATE_GATEWAY = Symbol('CLIENT_CANDIDATE_GATEWAY');

export interface WritableClientCandidateGateway extends ClientCandidateGateway {
  readRecord(sourceSystem: ClientSystem, entity: ClientEntity, idValue: string, parentId?: string | null): Promise<Record<string, unknown>>;
  readCounterparty(id: string): Promise<Record<string, unknown>>;
  readCompanyInn(sourceSystem: ClientSystem, id: string): Promise<string | null>;
  unmarkedBitrixCompanyEquivalents(input: { id: string; name: string | null; phone: string | null; inn: string | null }): Promise<ClientCandidate[]>;
  createTarget(input: {
    entity: ClientEntity;
    targetSystem: ClientSystem;
    targetType: ClientTargetType | 'company' | 'contact';
    parentId: string | null;
    source: Record<string, unknown>;
    configuredFields: Record<string, unknown>;
    eventId?: string;
  }): Promise<string>;
}

/** Candidate lookup/create adapter used only for webhook-time client resolution. */
@Injectable()
export class HttpClientCandidateGateway implements WritableClientCandidateGateway {
  constructor(private readonly database: DatabaseService, private readonly fetcher: typeof fetch = fetch, private readonly dryWrites?: DryRunWriteJournal) {}

  async readCompanyInn(sourceSystem: ClientSystem, companyId: string): Promise<string | null> {
    if (sourceSystem === 'MOYSKLAD') {
      const record = await this.moyskladRequest(`entity/counterparty/${encodeURIComponent(companyId)}`, 'GET');
      return isRecord(record) ? stringValue(record.inn) : null;
    }
    const rows = await this.bitrixList('crm.requisite.list', {
      filter: { ENTITY_TYPE_ID: 4, ENTITY_ID: companyId }, select: ['RQ_INN'],
    });
    const values = [...new Set(rows.map((row) => stringValue(row.RQ_INN)).filter((value): value is string => Boolean(value)))];
    if (values.length > 1) throw new Error('CLIENT_COMPANY_INN_AMBIGUOUS');
    return values[0] ?? null;
  }

  async readCounterparty(counterpartyId: string): Promise<Record<string, unknown>> {
    const record = await this.moyskladRequest(`entity/counterparty/${encodeURIComponent(counterpartyId)}`, 'GET');
    if (!isRecord(record) || id(record.id) !== counterpartyId) throw new Error('SERVICE_COUNTERPARTY_ID_MISMATCH');
    return record;
  }

  async unmarkedBitrixCompanyEquivalents(input: { id: string; name: string | null; phone: string | null; inn: string | null }): Promise<ClientCandidate[]> {
    let rows: Record<string, unknown>[] = [];
    if (input.inn) {
      const requisites = await this.bitrixList('crm.requisite.list', { filter: { ENTITY_TYPE_ID: 4, RQ_INN: input.inn }, select: ['ENTITY_ID', 'RQ_INN'] });
      const ids = [...new Set(requisites.filter((row) => String(row.RQ_INN ?? '') === input.inn).map((row) => id(row.ENTITY_ID)).filter((value): value is string => Boolean(value)))];
      rows = await this.bitrixCompaniesByIds(ids);
      rows = rows.filter((row) => id(row.ID) !== input.id && duplicateMarker(row) === false);
    }
    if (!rows.length && input.name && input.phone) {
      rows = await this.bitrixList('crm.company.list', { filter: { TITLE: input.name, PHONE: input.phone }, select: ['ID', 'TITLE', 'PHONE', 'DATE_CREATE', 'UF_CRM_1789126724375'] });
      rows = rows.filter((row) => id(row.ID) !== input.id && duplicateMarker(row) === false
        && exactName(row.TITLE, input.name!) && hasExactPhone(row.PHONE, input.phone!));
      if (input.inn) {
        const inss = await Promise.all(rows.map(async (row) => [String(row.ID), await this.readCompanyInn('BITRIX24', String(row.ID))] as const));
        const innById = new Map(inss);
        rows = rows.filter((row) => !innById.get(String(row.ID)) || innById.get(String(row.ID)) === input.inn)
          .map((row) => ({ ...row, inn: innById.get(String(row.ID)) ?? null }));
      }
    }
    return this.candidates(rows.map((row) => ({ ...row, ...(input.inn && !row.inn ? { inn: input.inn } : {}) })), 'COMPANY', 'BITRIX24');
  }

  async findPair(entity: ClientEntity, sourceId: string, sourceSystem: ClientSystem = 'BITRIX24', companyTargetId?: string | null) {
    const pair = await this.database.entityPair.findFirst({
      where: { entityType: entity, active: true, ...(sourceSystem === 'BITRIX24' ? { bitrix24Id: sourceId } : { moyskladId: sourceId }),
        ...(entity === 'CONTACT' && sourceSystem === 'BITRIX24' && companyTargetId !== undefined ? { moyskladParentId: companyTargetId } : {}) },
      select: { bitrix24Id: true, moyskladId: true, moyskladType: true },
    });
    if (!pair) return null;
    return sourceSystem === 'BITRIX24'
      ? { targetId: pair.moyskladId, targetType: pair.moyskladType === 'contactperson' ? 'contactperson' as const : 'counterparty' as const }
      : { targetId: pair.bitrix24Id, targetType: entity === 'COMPANY' ? 'company' as const : 'contact' as const };
  }

  async companyByInn(inn: string, targetSystem: ClientSystem = 'MOYSKLAD'): Promise<ClientCandidate[]> {
    if (targetSystem === 'MOYSKLAD') {
      const rows = await this.moyskladList('entity/counterparty', { filter: `inn=${inn}` });
      return this.candidates(rows.filter((row) => row.companyType !== 'individual' && row.inn === inn), 'COMPANY', targetSystem);
    }
    const rows = await this.bitrixList('crm.requisite.list', {
      filter: { ENTITY_TYPE_ID: 4, RQ_INN: inn }, select: ['ENTITY_ID', 'RQ_INN'],
    });
    const entityIds = [...new Set(rows.filter((row) => String(row.RQ_INN ?? '') === inn).map((row) => id(row.ENTITY_ID)).filter(Boolean))] as string[];
    const companies = await this.bitrixCompaniesByIds(entityIds);
    return this.candidates(companies, 'COMPANY', targetSystem, (row) => ({ ...row, inn }));
  }

  async companyByExactNameAndPhone(name: string, phone: string, targetSystem: ClientSystem = 'MOYSKLAD'): Promise<ClientCandidate[]> {
    if (targetSystem === 'MOYSKLAD') {
      const rows = await this.moyskladList('entity/counterparty', { filter: `name=${name};phone=${phone}` });
      return this.candidates(rows.filter((row) => row.companyType !== 'individual' && exactName(row.name, name) && exactPhone(row.phone, phone)), 'COMPANY', targetSystem);
    }
    const rows = await this.bitrixList('crm.company.list', {
      filter: { TITLE: name, PHONE: phone }, select: ['ID', 'TITLE', 'PHONE', 'DATE_CREATE', 'UF_CRM_1789126724375'],
    });
    return this.candidates(rows.filter((row) => exactName(row.TITLE, name) && hasExactPhone(row.PHONE, phone)), 'COMPANY', targetSystem);
  }

  async contactByCompanyAndNamePhone(companyId: string, normalizedName: string, normalizedPhone: string, email?: string, targetSystem: ClientSystem = 'MOYSKLAD'): Promise<ClientCandidate[]> {
    if (targetSystem === 'MOYSKLAD') {
      const rows = await this.moyskladList(`entity/counterparty/${encodeURIComponent(companyId)}/contactpersons`, { search: normalizedName });
      return this.candidates(rows.filter((row) => exactPersonName(row.name, normalizedName) && exactPhone(row.phone, normalizedPhone) && (!email || !row.email || exactEmail(row.email, email))), 'CONTACT', targetSystem, (row) => ({ ...row, parentId: companyId }));
    }
    const rows = await this.bitrixContacts({ COMPANY_ID: companyId, PHONE: normalizedPhone }, ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'PHONE', 'EMAIL', 'DATE_CREATE']);
    return this.candidates(rows.filter((row) => exactB24PersonName(row, normalizedName) && hasExactPhone(row.PHONE, normalizedPhone) && (!email || !hasString(row.EMAIL) || hasExactEmail(row.EMAIL, email))), 'CONTACT', targetSystem);
  }

  async contactByCompanyAndNameEmail(companyId: string, normalizedName: string, normalizedEmail: string, targetSystem: ClientSystem = 'MOYSKLAD'): Promise<ClientCandidate[]> {
    if (targetSystem === 'MOYSKLAD') {
      const rows = await this.moyskladList(`entity/counterparty/${encodeURIComponent(companyId)}/contactpersons`, { search: normalizedName });
      return this.candidates(rows.filter((row) => exactPersonName(row.name, normalizedName) && exactEmail(row.email, normalizedEmail)), 'CONTACT', targetSystem, (row) => ({ ...row, parentId: companyId }));
    }
    const rows = await this.bitrixContacts({ COMPANY_ID: companyId, EMAIL: normalizedEmail }, ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'PHONE', 'EMAIL', 'DATE_CREATE']);
    return this.candidates(rows.filter((row) => exactB24PersonName(row, normalizedName) && hasExactEmail(row.EMAIL, normalizedEmail)), 'CONTACT', targetSystem);
  }

  async contactByStandaloneNamePhone(normalizedName: string, normalizedPhone: string, email?: string, targetSystem: ClientSystem = 'MOYSKLAD'): Promise<ClientCandidate[]> {
    if (targetSystem === 'MOYSKLAD') {
      const rows = await this.moyskladList('entity/counterparty', { search: normalizedName });
      return this.candidates(rows.filter((row) => row.companyType === 'individual' && exactPersonName(row.name, normalizedName) && exactPhone(row.phone, normalizedPhone) && (!email || !row.email || exactEmail(row.email, email))), 'CONTACT', targetSystem);
    }
    const rows = await this.bitrixContacts({ PHONE: normalizedPhone }, ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'PHONE', 'EMAIL', 'DATE_CREATE']);
    return this.candidates(rows.filter((row) => exactB24PersonName(row, normalizedName) && hasExactPhone(row.PHONE, normalizedPhone) && (!email || !hasString(row.EMAIL) || hasExactEmail(row.EMAIL, email))), 'CONTACT', targetSystem);
  }

  async contactByStandaloneNameEmail(normalizedName: string, normalizedEmail: string, targetSystem: ClientSystem = 'MOYSKLAD'): Promise<ClientCandidate[]> {
    if (targetSystem === 'MOYSKLAD') {
      const rows = await this.moyskladList('entity/counterparty', { search: normalizedName });
      return this.candidates(rows.filter((row) => row.companyType === 'individual' && exactPersonName(row.name, normalizedName) && exactEmail(row.email, normalizedEmail)), 'CONTACT', targetSystem);
    }
    const rows = await this.bitrixContacts({ EMAIL: normalizedEmail }, ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'PHONE', 'EMAIL', 'DATE_CREATE']);
    return this.candidates(rows.filter((row) => exactB24PersonName(row, normalizedName) && hasExactEmail(row.EMAIL, normalizedEmail)), 'CONTACT', targetSystem);
  }

  async createTarget(input: {
    entity: ClientEntity; targetSystem: ClientSystem; targetType: ClientTargetType | 'company' | 'contact'; parentId: string | null;
    source: Record<string, unknown>; configuredFields: Record<string, unknown>; eventId?: string;
  }): Promise<string> {
    if (input.targetSystem === 'MOYSKLAD') {
      const sourceName = input.entity === 'COMPANY'
        ? firstString(input.source.name, input.source.TITLE)
        : personName(input.source);
      if (!sourceName) throw new Error('CLIENT_CREATE_REQUIRED_NAME_MISSING');
      const body: Record<string, unknown> = process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled'
        ? { ...input.configuredFields, name: sourceName }
        : { name: sourceName, ...input.configuredFields };
      if (input.entity === 'CONTACT' && input.targetType === 'counterparty') body.companyType = 'individual';
      const path = input.targetType === 'contactperson'
        ? `entity/counterparty/${encodeURIComponent(required(input.parentId, 'CLIENT_CONTACT_PARENT_REQUIRED'))}/contactpersons`
        : 'entity/counterparty';
      if (process.env.SYNC_MODE === 'dry' && this.dryWrites) {
        const targetId = randomUUID();
        await this.dryWrites.propose({ eventId: input.eventId, provider: 'MOYSKLAD', entityType: input.targetType, entityId: targetId, operation: 'CREATE', fields: {
          id: targetId, ...body, ...(input.targetType === 'contactperson' ? { company: { id: input.parentId } } : {}),
        } });
        return targetId;
      }
      assertApplyExternalWrite('MOYSKLAD', 'CLIENT_CREATE', null);
      const created = await this.moyskladRequest(path, 'POST', body);
      const resultId = isRecord(created) ? id(created.id) : null;
      if (!resultId) throw new Error('CLIENT_CREATE_RESPONSE_INVALID');
      return resultId;
    }
    const method = input.entity === 'COMPANY' ? 'crm.company.add' : 'crm.contact.add';
    const sourceName = input.entity === 'COMPANY' ? firstString(input.source.TITLE, input.source.name) : personName(input.source);
    if (!sourceName) throw new Error('CLIENT_CREATE_REQUIRED_NAME_MISSING');
    const fields = input.entity === 'COMPANY'
      ? process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled' ? { ...input.configuredFields, TITLE: sourceName } : { TITLE: sourceName, ...input.configuredFields }
      : process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled'
        ? { ...input.configuredFields, ...(input.parentId ? { COMPANY_ID: input.parentId } : {}), NAME: sourceName }
        : { NAME: sourceName, ...input.configuredFields, ...(input.parentId ? { COMPANY_ID: input.parentId } : {}) };
    if (process.env.SYNC_MODE === 'dry' && this.dryWrites) {
      const targetId = `${Date.now()}${String(Math.floor(Math.random() * 1_000)).padStart(3, '0')}`;
      await this.dryWrites.propose({ eventId: input.eventId, provider: 'BITRIX24', entityType: input.entity.toLowerCase(), entityId: targetId, operation: 'CREATE', fields: { ID: targetId, ...fields } });
      return targetId;
    }
    assertApplyExternalWrite('BITRIX24', 'CLIENT_CREATE', null);
    const result = await this.bitrixRequest(method, { fields });
    const createdId = id(result);
    if (!createdId) throw new Error('CLIENT_CREATE_RESPONSE_INVALID');
    return createdId;
  }

  async readRecord(sourceSystem: ClientSystem, entity: ClientEntity, idValue: string, parentId: string | null = null): Promise<Record<string, unknown>> {
    const provider = sourceSystem === 'MOYSKLAD' ? 'MOYSKLAD' : 'BITRIX24';
    const type = sourceSystem === 'MOYSKLAD'
      ? entity === 'CONTACT' && parentId ? 'contactperson' : 'counterparty'
      : entity.toLowerCase();
    const created = await this.dryWrites?.createdRecord(provider, type, idValue);
    if (created) return created;
    if (sourceSystem === 'MOYSKLAD') {
      const path = entity === 'CONTACT' && parentId
        ? `entity/counterparty/${encodeURIComponent(parentId)}/contactpersons/${encodeURIComponent(idValue)}`
        : `entity/counterparty/${encodeURIComponent(idValue)}`;
      const row = await this.moyskladRequest(path, 'GET');
      if (!isRecord(row)) throw new Error('CLIENT_SOURCE_READ_INVALID');
      return row;
    }
    const method = entity === 'COMPANY' ? 'crm.company.get' : 'crm.contact.get';
    const row = await this.bitrixRequest(method, { id: idValue });
    if (!isRecord(row)) throw new Error('CLIENT_SOURCE_READ_INVALID');
    return row;
  }

  private async candidates(rows: Record<string, unknown>[], entity: ClientEntity, system: ClientSystem, enrich: (row: Record<string, unknown>) => Record<string, unknown> = (row) => row): Promise<ClientCandidate[]> {
    if (system === 'BITRIX24' && entity === 'COMPANY' && rows.some((row) => duplicateMarker(row) === null)) {
      throw new Error('CLIENT_COMPANY_DUPLICATE_MARKER_UNVERIFIED');
    }
    const candidates = rows.map(enrich).filter((row) => id(row.id ?? row.ID)).map((row) => ({
      id: id(row.id ?? row.ID)!,
      parentId: stringValue(row.parentId),
      type: system === 'MOYSKLAD' ? entity === 'COMPANY' || row.companyType === 'individual' ? 'counterparty' as const : row.parentId ? 'contactperson' as const : 'contactperson' as const : entity === 'COMPANY' ? 'company' as const : 'contact' as const,
      duplicateMarked: system === 'BITRIX24' && entity === 'COMPANY' ? duplicateMarker(row) : false,
      inn: stringValue(row.inn), name: stringValue(row.name ?? row.TITLE), phone: stringValue(row.phone), email: stringValue(row.email),
      createdAt: stringValue(row.created ?? row.DATE_CREATE) ?? 'invalid', usageCount: null as number | null,
      filledFields: countFilled(row), occupiedByPair: false,
    }));
    if (!candidates.length) return [];
    const occupied = system === 'MOYSKLAD'
      ? await this.database.entityPair.findMany({ where: { entityType: entity, active: true, moyskladId: { in: candidates.map((x) => x.id) } }, select: { moyskladId: true } })
      : await this.database.entityPair.findMany({ where: { entityType: entity, active: true, bitrix24Id: { in: candidates.map((x) => x.id) } }, select: { bitrix24Id: true } });
    const ids = new Set(occupied.map((row) => 'moyskladId' in row ? row.moyskladId : row.bitrix24Id));
    const withOccupancy = candidates.map((candidate) => ({ ...candidate, occupiedByPair: ids.has(candidate.id) }));
    const metricResults = await Promise.all(withOccupancy.map(async (candidate) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return { count: await this.usageCount(candidate.id, entity, system, candidate.type, candidate.parentId), unavailable: false }; }
        catch (error) {
          if (isSystemwideMetricUnavailable(error)) return { count: null, unavailable: true };
          if (attempt === 2) return { count: null, unavailable: false };
          await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 100 : 250));
        }
      }
      return { count: null, unavailable: false };
    }));
    const allUnavailable = metricResults.every((metric) => metric.unavailable);
    return withOccupancy.map((candidate, index) => ({
      ...candidate, usageCount: metricResults[index]?.count ?? null, usageMetricUnavailable: allUnavailable,
    }));
  }

  private async usageCount(targetId: string, entity: ClientEntity, system: ClientSystem, type: string, parentId: string | null): Promise<number> {
    if (system === 'MOYSKLAD') {
      // Customer orders are linked to an agent/company, not its contactperson.
      // Counting the parent's orders would rank every person in that company
      // identically and misrepresent a person-specific usage metric.
      if (type === 'contactperson') throw httpFailure(501);
      const href = this.moyskladUrl(`entity/counterparty/${encodeURIComponent(targetId)}`).toString();
      const payload = await this.moyskladRequest(`entity/customerorder?filter=agent=${encodeURIComponent(href)}&limit=1`, 'GET');
      const size = isRecord(payload) && isRecord(payload.meta) ? Number(payload.meta.size) : NaN;
      if (!Number.isFinite(size)) throw new Error('CLIENT_USAGE_METRIC_INVALID');
      return size;
    }
    const method = 'crm.deal.list';
    const filter = entity === 'COMPANY' ? { COMPANY_ID: targetId } : { CONTACT_ID: targetId };
    const payload = await this.bitrixJsonRequest(method, { filter, select: ['ID'], start: 0 });
    const total = isRecord(payload) ? Number(payload.total) : NaN;
    if (!Number.isFinite(total)) throw new Error('CLIENT_USAGE_METRIC_INVALID');
    return total;
  }

  private async moyskladList(path: string, query: Record<string, string>): Promise<Record<string, unknown>[]> {
    const url = this.moyskladUrl(path);
    url.searchParams.set('limit', '1000');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const payload = await this.moyskladRequestUrl(url, 'GET');
    if (!isRecord(payload) || !Array.isArray(payload.rows) || !isRecord(payload.meta)) throw new Error('CLIENT_CANDIDATE_SEARCH_INVALID');
    const size = Number(payload.meta.size);
    if (Number.isFinite(size) && size > payload.rows.length) throw new Error('CLIENT_CANDIDATE_SEARCH_INCOMPLETE');
    return payload.rows.filter(isRecord);
  }

  private async bitrixCompaniesByIds(ids: string[]) {
    if (!ids.length) return [];
    const rows: Record<string, unknown>[] = [];
    for (let start = 0; start < ids.length; start += 50) {
      rows.push(...await this.bitrixList('crm.company.list', { filter: { '@ID': ids.slice(start, start + 50) }, select: ['ID', 'TITLE', 'PHONE', 'DATE_CREATE', 'UF_CRM_1789126724375'] }));
    }
    return rows;
  }

  private async bitrixContacts(filter: Record<string, unknown>, select: string[]) {
    return this.bitrixList('crm.contact.list', { filter, select });
  }

  private async bitrixList(method: string, parameters: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let start = 0;
    for (let page = 0; page < 100; page++) {
      const result = await this.bitrixJsonRequest(method, { ...parameters, start });
      if (!isRecord(result) || !Array.isArray(result.result)) throw new Error('CLIENT_CANDIDATE_SEARCH_INVALID');
      rows.push(...result.result.filter(isRecord));
      const next = Number(result.next);
      if (!Number.isInteger(next)) return rows;
      if (next <= start) throw new Error('CLIENT_CANDIDATE_SEARCH_INVALID_PAGINATION');
      start = next;
    }
    throw new Error('CLIENT_CANDIDATE_SEARCH_INCOMPLETE');
  }

  private async bitrixJsonRequest(method: string, parameters: Record<string, unknown>): Promise<unknown> {
    if (/\.(?:add|update|delete)(?:\.json)?$/i.test(method)) {
      const nativeId = /\.add(?:\.json)?$/i.test(method) ? null : String(parameters.id ?? '');
      assertApplyExternalWrite('BITRIX24', /\.add(?:\.json)?$/i.test(method) ? 'CLIENT_CREATE' : 'CLIENT_CANDIDATE_REQUEST', nativeId);
    }
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new Error('BITRIX24_REST_NOT_CONFIGURED');
    const form = new URLSearchParams();
    appendForm(form, '', parameters);
    const response = await this.fetcher(new URL(method, withSlash(base)), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new ProviderFailure('BITRIX24', null); });
    if (!response.ok) throw providerResponseFailure('BITRIX24', response.status, response.headers.get('retry-after'));
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || payload.error || !('result' in payload)) throw new ProviderFailure('BITRIX24', 400);
    return payload;
  }

  private async bitrixRequest(method: string, parameters: Record<string, unknown>): Promise<unknown> {
    const payload = await this.bitrixJsonRequest(method, parameters);
    return isRecord(payload) ? payload.result : null;
  }

  private moyskladUrl(path: string): URL {
    const base = process.env.MOYSKLAD_API_BASE_URL;
    if (!base) throw new Error('MOYSKLAD_API_NOT_CONFIGURED');
    return new URL(path, withSlash(base));
  }

  private async moyskladRequest(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<unknown> {
    return this.moyskladRequestUrl(this.moyskladUrl(path), method, body);
  }

  private async moyskladRequestUrl(url: URL, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<unknown> {
    if (method !== 'GET') {
      const nativeId = url.pathname.match(/\/(?:counterparty|contactpersons)\/([^/]+)$/)?.[1] ?? null;
      assertApplyExternalWrite('MOYSKLAD', method === 'POST' ? 'CLIENT_CREATE' : 'CLIENT_CANDIDATE_REQUEST', nativeId ? decodeURIComponent(nativeId) : null);
    }
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!token) throw new Error('MOYSKLAD_API_NOT_CONFIGURED');
    const response = await this.fetcher(url, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
    if (!response.ok) throw providerResponseFailure('MOYSKLAD', response.status, response.headers.get('retry-after'));
    return response.json().catch(() => ({}));
  }
}

function appendForm(form: URLSearchParams, prefix: string, value: unknown) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) { value.forEach((item, index) => appendForm(form, `${prefix}[${index}]`, item)); return; }
  if (typeof value === 'object') { for (const [key, item] of Object.entries(value)) appendForm(form, prefix ? `${prefix}[${key}]` : key, item); return; }
  form.append(prefix, String(value));
}
function id(value: unknown): string | null { return typeof value === 'string' || typeof value === 'number' ? String(value) : null; }
function stringValue(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function firstString(...values: unknown[]) { return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim() ?? null; }
function personName(record: Record<string, unknown>) { return firstString(record.name, [record.LAST_NAME, record.NAME, record.SECOND_NAME].filter((part) => typeof part === 'string' && part.trim()).join(' ')); }
function exactName(actual: unknown, expected: string) { return typeof actual === 'string' && actual === expected; }
function isMarkedDuplicate(value: unknown) {
  return value === true || value === 1 || value === '1' || value === 'Y' || value === 'y' || value === 'true'
    || typeof value === 'string' && value.trim().toLocaleLowerCase('ru-RU') === 'дубль';
}
function duplicateMarker(row: Record<string, unknown>): boolean | null {
  if (!Object.prototype.hasOwnProperty.call(row, 'UF_CRM_1789126724375')) return null;
  const value = row.UF_CRM_1789126724375;
  if (isMarkedDuplicate(value)) return true;
  if (value === null || value === '' || value === 0 || value === '0' || value === false || value === 'N' || value === 'n' || value === 'false') return false;
  return null;
}
function exactPersonName(actual: unknown, expected: string) { return typeof actual === 'string' && normName(actual) === normName(expected); }
function exactPhone(actual: unknown, expected: string) { return phone(actual) === phone(expected); }
function exactEmail(actual: unknown, expected: string) { return typeof actual === 'string' && actual.trim().toLowerCase() === expected.trim().toLowerCase(); }
function hasExactPhone(actual: unknown, expected: string) { return Array.isArray(actual) ? actual.some((item) => isRecord(item) && exactPhone(item.VALUE, expected)) : exactPhone(actual, expected); }
function hasExactEmail(actual: unknown, expected: string) { return Array.isArray(actual) ? actual.some((item) => isRecord(item) && exactEmail(item.VALUE, expected)) : exactEmail(actual, expected); }
function hasString(value: unknown) { return Array.isArray(value) ? value.some((item) => isRecord(item) && typeof item.VALUE === 'string' && Boolean(item.VALUE.trim())) : typeof value === 'string' && value.trim().length > 0; }
function exactB24PersonName(row: Record<string, unknown>, expected: string) { return normName(personName(row) ?? '') === normName(expected); }
function normName(value: string) { return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru-RU'); }
function phone(value: unknown) { if (typeof value !== 'string') return ''; let digits = value.replace(/\D/g, ''); if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`; return digits.length >= 10 ? digits : ''; }
function countFilled(row: Record<string, unknown>) { return Object.entries(row).filter(([key, value]) => key !== 'id' && key !== 'ID' && key !== 'meta' && key !== 'created' && key !== 'DATE_CREATE' && value !== null && value !== undefined && value !== '').length; }
function httpFailure(status: number | undefined) { const error = new Error('CLIENT_CANDIDATE_HTTP_FAILURE') as Error & { status?: number }; error.name = 'ClientCandidateHttpError'; error.status = status; return error; }
function isSystemwideMetricUnavailable(error: unknown) {
  if (error instanceof ProviderFailure) return [404, 405, 501].includes(error.status ?? 0);
  return error instanceof Error && error.name === 'ClientCandidateHttpError' && [404, 405, 501].includes((error as Error & { status?: number }).status ?? 0);
}
function required(value: string | null, reason: string) { if (!value) throw new Error(reason); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function withSlash(value: string) { return value.endsWith('/') ? value : `${value}/`; }
