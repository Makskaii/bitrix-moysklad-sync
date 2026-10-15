import { BadRequestException } from '@nestjs/common';
import { ProviderFailure, providerResponseFailure } from '../provider-failure';
import { ClientChildResourceBindingDto } from '../field-settings/field-settings.dto';

export type ClientChildSyncDirection = 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24';
export type ClientChildSyncResult =
  | { status: 'BASELINE' | 'SYNCED' | 'JOURNALED' | 'UNCHANGED'; bindingId: string; fields: string[]; state: ClientChildResourceSnapshot }
  | { status: 'MANUAL_REVIEW'; reason: 'CHILD_RESOURCE_BINDING_MISSING' | 'CHILD_RESOURCE_BINDING_AMBIGUOUS' | 'CHILD_RESOURCE_ID_MISSING'; bindingId?: string };

export type ClientChildResourceSnapshot = { bitrix24: { requisite: RecordValue; bankDetail: RecordValue }; moysklad: { counterparty: RecordValue; account: RecordValue } };

export interface ChildWriteJournal {
  propose(input: { eventId: string; provider: 'BITRIX24' | 'MOYSKLAD'; entityType: string; entityId: string; operation: string; fields: Record<string, unknown> }): Promise<boolean>;
  readback?(provider: 'BITRIX24' | 'MOYSKLAD', entityType: string, entityId: string): Promise<RecordValue>;
}

type RecordValue = Record<string, unknown>;
const REQUISITE_FIELDS = new Set(['RQ_COMPANY_NAME', 'RQ_COMPANY_FULL_NAME', 'RQ_INN', 'RQ_KPP', 'RQ_OGRN', 'RQ_OKPO']);
const COUNTERPARTY_FIELDS = new Set(['legalTitle', 'inn', 'kpp', 'ogrn', 'okpo']);
const BANK_FIELDS = new Set(['RQ_BANK_NAME', 'RQ_BANK_ADDR', 'RQ_BIK', 'RQ_BIC', 'RQ_ACC_NUM', 'RQ_COR_ACC_NUM']);
const ACCOUNT_FIELDS = new Set(['bankName', 'bankLocation', 'bic', 'accountNumber', 'correspondentAccount']);

/**
 * Handles only explicitly bound company child resources. It never lists or creates
 * requisites/accounts, selects a primary bank account, or guesses a country/preset.
 */
export class ClientChildResourceSync {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly journal?: ChildWriteJournal,
  ) {}

  async syncForPair(input: {
    eventId: string; direction: ClientChildSyncDirection; bindings: ClientChildResourceBindingDto[] | undefined;
    bitrix24CompanyId: string; moyskladCounterpartyId: string; fallbackMatch?: 'exact_name_and_phone'; prior?: ClientChildResourceSnapshot | null;
  }): Promise<ClientChildSyncResult> {
    const matches = (input.bindings ?? []).filter((binding) => binding.bitrix24CompanyId === input.bitrix24CompanyId && binding.moyskladCounterpartyId === input.moyskladCounterpartyId);
    if (matches.length === 0) return { status: 'MANUAL_REVIEW', reason: 'CHILD_RESOURCE_BINDING_MISSING' };
    if (matches.length > 1) return { status: 'MANUAL_REVIEW', reason: 'CHILD_RESOURCE_BINDING_AMBIGUOUS' };
    return this.sync({ ...input, binding: matches[0] });
  }

  async sync(input: {
    eventId: string;
    direction: ClientChildSyncDirection;
    binding: ClientChildResourceBindingDto | null | undefined;
    bitrix24CompanyId: string;
    moyskladCounterpartyId: string;
    fallbackMatch?: 'exact_name_and_phone';
    prior?: ClientChildResourceSnapshot | null;
  }): Promise<ClientChildSyncResult> {
    const { binding } = input;
    if (!binding) return { status: 'MANUAL_REVIEW', reason: 'CHILD_RESOURCE_BINDING_MISSING' };
    if (binding.bitrix24CompanyId !== input.bitrix24CompanyId || binding.moyskladCounterpartyId !== input.moyskladCounterpartyId) {
      return { status: 'MANUAL_REVIEW', reason: 'CHILD_RESOURCE_ID_MISSING', bindingId: binding.id };
    }
    const configError = validateBinding(binding);
    if (configError) throw new BadRequestException(configError);

    const isForward = input.direction === 'BITRIX24_TO_MOYSKLAD';
    const legalEnabled = binding.legalFields.length > 0;
    const bankEnabled = Boolean(binding.bankDetail?.fields.length);
    if (!legalEnabled && !bankEnabled) return { status: 'UNCHANGED', bindingId: binding.id, fields: [], state: emptySnapshot() };
    if (bankEnabled && (!binding.bankDetail?.bitrix24Id || !binding.bankDetail.moyskladAccountId)) {
      return { status: 'MANUAL_REVIEW', reason: 'CHILD_RESOURCE_ID_MISSING', bindingId: binding.id };
    }

    const changed: string[] = [];
    let currentRequisite: RecordValue = {};
    let currentBankDetail: RecordValue = {};
    let currentCounterparty: RecordValue = {};
    let currentAccount: RecordValue = {};
    if (legalEnabled) {
      const [requisite, counterparty] = await Promise.all([
        this.bitrixRead('crm.requisite.get.json', { id: binding.bitrix24RequisiteId }),
        this.msRead(`entity/counterparty/${encodeURIComponent(binding.moyskladCounterpartyId)}`),
      ]);
      assertRecordId(requisite, 'ID', binding.bitrix24RequisiteId, 'BITRIX24_REQUISITE_ID_MISMATCH');
      assertRecordId(counterparty, 'id', input.moyskladCounterpartyId, 'MOYSKLAD_COUNTERPARTY_ID_MISMATCH');
      if (String(requisite.ENTITY_TYPE_ID ?? '') !== '4') throw new ProviderFailure('BITRIX24', 404);
      assertParent(requisite, 'ENTITY_ID', input.bitrix24CompanyId, 'BITRIX24_REQUISITE_PARENT_MISMATCH');
      currentRequisite = requisite; currentCounterparty = counterparty;
      if (input.prior) {
      const result = await this.transfer({
        eventId: input.eventId, bindingId: binding.id, direction: input.direction,
        source: isForward ? requisite : counterparty, target: isForward ? counterparty : requisite,
        previousSource: isForward ? input.prior.bitrix24.requisite : input.prior.moysklad.counterparty,
        previousTarget: isForward ? input.prior.moysklad.counterparty : input.prior.bitrix24.requisite,
        fields: binding.legalFields, b24Allowed: REQUISITE_FIELDS, msAllowed: COUNTERPARTY_FIELDS,
        targetResource: isForward ? 'MOYSKLAD_COUNTERPARTY' : 'BITRIX24_REQUISITE',
        parentId: isForward ? input.moyskladCounterpartyId : input.bitrix24CompanyId,
        childId: isForward ? '' : binding.bitrix24RequisiteId,
        fallbackSuppressInn: Boolean(input.fallbackMatch && isForward),
      });
      changed.push(...result);
      }
    }
    if (bankEnabled && binding.bankDetail) {
      const [bankDetail, account] = await Promise.all([
        this.bitrixRead('crm.requisite.bankdetail.get.json', { id: binding.bankDetail.bitrix24Id }),
        this.msRead(`entity/counterparty/${encodeURIComponent(binding.moyskladCounterpartyId)}/accounts/${encodeURIComponent(binding.bankDetail.moyskladAccountId)}`),
      ]);
      assertRecordId(bankDetail, 'ID', binding.bankDetail.bitrix24Id, 'BITRIX24_BANK_DETAIL_ID_MISMATCH');
      assertRecordId(account, 'id', binding.bankDetail.moyskladAccountId, 'MOYSKLAD_ACCOUNT_ID_MISMATCH');
      assertParent(bankDetail, 'ENTITY_ID', binding.bitrix24RequisiteId, 'BITRIX24_BANK_DETAIL_PARENT_MISMATCH');
      currentBankDetail = bankDetail; currentAccount = account;
      if (input.prior) {
      const result = await this.transfer({
        eventId: input.eventId, bindingId: binding.id, direction: input.direction,
        source: isForward ? bankDetail : account, target: isForward ? account : bankDetail,
        previousSource: isForward ? input.prior.bitrix24.bankDetail : input.prior.moysklad.account,
        previousTarget: isForward ? input.prior.moysklad.account : input.prior.bitrix24.bankDetail,
        fields: binding.bankDetail.fields, b24Allowed: BANK_FIELDS, msAllowed: ACCOUNT_FIELDS,
        targetResource: isForward ? 'MOYSKLAD_ACCOUNT' : 'BITRIX24_BANK_DETAIL',
        parentId: isForward ? input.moyskladCounterpartyId : binding.bitrix24RequisiteId,
        childId: isForward ? binding.bankDetail.moyskladAccountId : binding.bankDetail.bitrix24Id,
        fallbackSuppressInn: false,
      });
      changed.push(...result);
      }
    }
    const state = snapshot(binding, currentRequisite, currentBankDetail, currentCounterparty, currentAccount);
    if (!input.prior) return { status: 'BASELINE', bindingId: binding.id, fields: [], state };
    return { status: changed.length ? (process.env.SYNC_MODE === 'dry' ? 'JOURNALED' : 'SYNCED') : 'UNCHANGED', bindingId: binding.id, fields: changed, state };
  }

  private async transfer(input: {
    eventId: string; bindingId: string; direction: ClientChildSyncDirection; source: RecordValue; target: RecordValue; previousSource: RecordValue; previousTarget: RecordValue;
    fields: Array<{ bitrix24Field: string; moyskladField: string }>; b24Allowed: Set<string>; msAllowed: Set<string>;
    targetResource: 'MOYSKLAD_COUNTERPARTY' | 'MOYSKLAD_ACCOUNT' | 'BITRIX24_REQUISITE' | 'BITRIX24_BANK_DETAIL';
    parentId: string; childId: string; fallbackSuppressInn: boolean;
  }): Promise<string[]> {
    const output: RecordValue = {};
    for (const field of input.fields) {
      const sourceField = input.direction === 'BITRIX24_TO_MOYSKLAD' ? field.bitrix24Field : field.moyskladField;
      const targetField = input.direction === 'BITRIX24_TO_MOYSKLAD' ? field.moyskladField : field.bitrix24Field;
      if (!(sourceField in input.source)) continue;
      if (same(input.source[sourceField], input.previousSource[sourceField])) continue;
      // If both sides changed since baseline, preserve the existing policy: MySklad wins.
      if (!same(input.target[targetField], input.previousTarget[targetField])) continue;
      if (input.fallbackSuppressInn && field.bitrix24Field === 'RQ_INN' && field.moyskladField === 'inn' && !present(input.target.inn)) continue;
      if (!input.b24Allowed.has(field.bitrix24Field) || !input.msAllowed.has(field.moyskladField)) {
        throw new BadRequestException(`Unsupported or read-only child field mapping ${field.bitrix24Field} → ${field.moyskladField}`);
      }
      const value = input.source[sourceField];
      if (value === null || value === undefined) continue;
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        throw new BadRequestException(`Child field ${sourceField} must be a direct scalar`);
      }
      if (!same(input.target[targetField], value)) output[targetField] = value;
    }
    if (!Object.keys(output).length) return [];
    if (process.env.SYNC_MODE === 'dry') {
      if (!this.journal) throw new Error('CHILD_RESOURCE_DRY_JOURNAL_REQUIRED');
      const accepted = await this.journal.propose({ eventId: input.eventId, provider: input.targetResource.startsWith('BITRIX24') ? 'BITRIX24' : 'MOYSKLAD',
        entityType: input.targetResource, entityId: `${input.parentId}/${input.childId || 'root'}`, operation: 'UPDATE', fields: output });
      if (!accepted) throw new Error('CHILD_RESOURCE_DRY_JOURNAL_REJECTED');
      Object.assign(input.target, output);
      return Object.keys(output);
    }
    if (input.targetResource.startsWith('MOYSKLAD')) {
      const path = input.targetResource === 'MOYSKLAD_ACCOUNT'
        ? `entity/counterparty/${encodeURIComponent(input.parentId)}/accounts/${encodeURIComponent(input.childId)}`
        : `entity/counterparty/${encodeURIComponent(input.parentId)}`;
      try { await this.msWrite(path, output); }
      catch (error) {
        const readback = await this.msRead(path).catch(() => null);
        if (!readback || !matches(readback, output)) throw error;
      }
      const readback = await this.msRead(path);
      if (!matches(readback, output)) throw new ProviderFailure('MOYSKLAD', null);
      Object.assign(input.target, readback);
    } else {
      const method = input.targetResource === 'BITRIX24_BANK_DETAIL' ? 'crm.requisite.bankdetail.update.json' : 'crm.requisite.update.json';
      const endpoint = input.targetResource === 'BITRIX24_BANK_DETAIL' ? 'crm.requisite.bankdetail.get.json' : 'crm.requisite.get.json';
      const id = input.childId;
      try { await this.bitrixUpdate(method, id, output); }
      catch (error) {
        const readback = await this.bitrixRead(endpoint, { id }).catch(() => null);
        if (!readback || !matches(readback, output)) throw error;
      }
      const readback = await this.bitrixRead(endpoint, { id });
      if (!matches(readback, output)) throw new ProviderFailure('BITRIX24', null);
      Object.assign(input.target, readback);
    }
    return Object.keys(output);
  }

  private async bitrixRead(method: string, params: Record<string, string>): Promise<RecordValue> {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new Error('BITRIX24_REST_NOT_CONFIGURED');
    const form = new URLSearchParams(params);
    const response = await this.fetcher(new URL(method, base.endsWith('/') ? base : `${base}/`), { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => { throw new ProviderFailure('BITRIX24', null); });
    if (!response.ok) throw providerResponseFailure('BITRIX24', response.status, response.headers.get('retry-after'));
    const payload = await response.json().catch(() => null) as RecordValue | null;
    const result = payload && isRecord(payload.result) ? payload.result : null;
    if (!result || payload?.error) throw new ProviderFailure('BITRIX24', 400);
    return result;
  }

  private async bitrixUpdate(method: string, id: string, fields: RecordValue) {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new Error('BITRIX24_REST_NOT_CONFIGURED');
    const form = new URLSearchParams({ id });
    for (const [key, value] of Object.entries(fields)) form.append(`fields[${key}]`, String(value ?? ''));
    const response = await this.fetcher(new URL(method, base.endsWith('/') ? base : `${base}/`), { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => { throw new ProviderFailure('BITRIX24', null); });
    if (!response.ok) throw providerResponseFailure('BITRIX24', response.status, response.headers.get('retry-after'));
    const payload = await response.json().catch(() => null) as RecordValue | null;
    if (!payload || payload.error || payload.result !== true) throw new ProviderFailure('BITRIX24', 400);
  }

  private async msRead(path: string): Promise<RecordValue> {
    const response = await this.msRequest(path, 'GET');
    const payload = await response.json().catch(() => null) as RecordValue | null;
    if (!payload) throw new ProviderFailure('MOYSKLAD', null);
    return payload;
  }

  private async msWrite(path: string, fields: RecordValue) {
    const response = await this.msRequest(path, 'PUT', fields);
    if (response.status === 204) return;
    await response.json().catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
  }

  private async msRequest(path: string, method: 'GET' | 'PUT', fields?: RecordValue): Promise<Response> {
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new Error('MOYSKLAD_API_NOT_CONFIGURED');
    const response = await this.fetcher(new URL(path, base.endsWith('/') ? base : `${base}/`), { method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(fields ? { 'content-type': 'application/json' } : {}) },
      ...(fields ? { body: JSON.stringify(fields) } : {}), redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
    if (!response.ok) throw providerResponseFailure('MOYSKLAD', response.status, response.headers.get('retry-after'));
    return response;
  }
}

/** Pins child-resource mappings to the accepted event's immutable settings version. */
export async function syncPinnedClientChildResources(input: {
  adapter: ClientChildResourceSync;
  settings: { eventConfig(eventId: string): Promise<{ version: number; config: { childResourceBindings?: ClientChildResourceBindingDto[] } }> };
  eventId: string; direction: ClientChildSyncDirection; bitrix24CompanyId: string; moyskladCounterpartyId: string;
  prior?: ClientChildResourceSnapshot | null; fallbackMatch?: 'exact_name_and_phone';
}): Promise<{ settingsVersion: number; result: ClientChildSyncResult }> {
  const pinned = await input.settings.eventConfig(input.eventId);
  const result = await input.adapter.syncForPair({ eventId: input.eventId, direction: input.direction,
    bindings: pinned.config.childResourceBindings, bitrix24CompanyId: input.bitrix24CompanyId,
    moyskladCounterpartyId: input.moyskladCounterpartyId, prior: input.prior, fallbackMatch: input.fallbackMatch });
  return { settingsVersion: pinned.version, result };
}

export function validateChildResourceBindings(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return 'childResourceBindings must be an array';
  const ids = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || item.entity !== 'companies' || !isString(item.id) || !isDigits(item.bitrix24CompanyId) || !isDigits(item.bitrix24RequisiteId) || !isString(item.moyskladCounterpartyId) || !Array.isArray(item.legalFields)) return 'Each child binding requires explicit company, requisite, and counterparty IDs';
    if (ids.has(item.id)) return `Child resource binding ${item.id} is duplicated`;
    ids.add(item.id);
    if (!isUuid(item.moyskladCounterpartyId)) return `MoySklad counterparty ID in ${item.id} must be a UUID`;
    if (item.bankDetail !== undefined && (!isRecord(item.bankDetail) || !isDigits(item.bankDetail.bitrix24Id) || !isUuid(item.bankDetail.moyskladAccountId) || !Array.isArray(item.bankDetail.fields))) return `Bank detail binding ${item.id} requires explicit Bitrix24 and MySklad child IDs`;
    const error = validateBinding(item as unknown as ClientChildResourceBindingDto);
    if (error) return error;
  }
  return null;
}

function validateBinding(binding: ClientChildResourceBindingDto): string | null {
  if (!isRecord(binding) || !isString(binding.id) || binding.entity !== 'companies' || !isDigits(binding.bitrix24CompanyId) || !isDigits(binding.bitrix24RequisiteId) || !isUuid(binding.moyskladCounterpartyId) || !Array.isArray(binding.legalFields)) return 'Child binding parent IDs are invalid';
  const seen = new Set<string>();
  const legalSources = new Set<string>(); const legalTargets = new Set<string>();
  for (const map of binding.legalFields) {
    if (!isRecord(map) || !isString(map.bitrix24Field) || !isString(map.moyskladField) || !REQUISITE_FIELDS.has(map.bitrix24Field) || !COUNTERPARTY_FIELDS.has(map.moyskladField)) return `Unsupported or read-only requisite mapping ${String((map as RecordValue)?.bitrix24Field ?? '')} → ${String((map as RecordValue)?.moyskladField ?? '')}`;
    const key = `${map.bitrix24Field}:${map.moyskladField}`;
    if (seen.has(key)) return `Duplicate child field mapping ${key}`;
    if (legalSources.has(map.bitrix24Field) || legalTargets.has(map.moyskladField)) return `Child field mappings must be one-to-one: ${key}`;
    seen.add(key);
    legalSources.add(map.bitrix24Field); legalTargets.add(map.moyskladField);
  }
  if (binding.bankDetail) {
    if (!isDigits(binding.bankDetail.bitrix24Id) || !isUuid(binding.bankDetail.moyskladAccountId) || !Array.isArray(binding.bankDetail.fields)) return 'Bank detail and account IDs must be explicitly configured';
    const bankSources = new Set<string>(); const bankTargets = new Set<string>();
    for (const map of binding.bankDetail.fields) {
      if (!isRecord(map) || !isString(map.bitrix24Field) || !isString(map.moyskladField) || !BANK_FIELDS.has(map.bitrix24Field) || !ACCOUNT_FIELDS.has(map.moyskladField)) return `Unsupported or read-only bank mapping ${String((map as RecordValue)?.bitrix24Field ?? '')} → ${String((map as RecordValue)?.moyskladField ?? '')}`;
      const key = `${map.bitrix24Field}:${map.moyskladField}`;
      if (seen.has(key)) return `Duplicate child field mapping ${key}`;
      if (bankSources.has(map.bitrix24Field) || bankTargets.has(map.moyskladField)) return `Child field mappings must be one-to-one: ${key}`;
      seen.add(key);
      bankSources.add(map.bitrix24Field); bankTargets.add(map.moyskladField);
    }
  }
  return null;
}

function assertParent(record: RecordValue, field: string, expected: string, reason: string) {
  if (String(record[field] ?? '') !== expected) throw new ProviderFailure(reason.includes('BITRIX24') ? 'BITRIX24' : 'MOYSKLAD', 404);
}
function assertRecordId(record: RecordValue, field: string, expected: string, _reason: string) {
  const actual = record[field] ?? (field === 'id' ? record.accountId : undefined);
  if (String(actual ?? '') !== expected) throw new ProviderFailure(field === 'ID' ? 'BITRIX24' : 'MOYSKLAD', 404);
}
function snapshot(binding: ClientChildResourceBindingDto, requisite: RecordValue, bankDetail: RecordValue, counterparty: RecordValue, account: RecordValue): ClientChildResourceSnapshot {
  const copy = (record: RecordValue, fields: string[]) => Object.fromEntries(fields.filter((field) => field in record).map((field) => [field, record[field]]));
  return {
    bitrix24: {
      requisite: copy(requisite, binding.legalFields.map((field) => field.bitrix24Field)),
      bankDetail: copy(bankDetail, binding.bankDetail?.fields.map((field) => field.bitrix24Field) ?? []),
    },
    moysklad: {
      counterparty: copy(counterparty, binding.legalFields.map((field) => field.moyskladField)),
      account: copy(account, binding.bankDetail?.fields.map((field) => field.moyskladField) ?? []),
    },
  };
}
function emptySnapshot(): ClientChildResourceSnapshot { return { bitrix24: { requisite: {}, bankDetail: {} }, moysklad: { counterparty: {}, account: {} } }; }
function present(value: unknown) { return value !== null && value !== undefined && value !== ''; }
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function matches(record: RecordValue, expected: RecordValue) { return Object.entries(expected).every(([field, value]) => same(record[field], value)); }
function isRecord(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function isDigits(value: unknown): value is string { return typeof value === 'string' && /^\d+$/.test(value); }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
