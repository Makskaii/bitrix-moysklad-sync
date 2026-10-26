import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { assertApplyExternalWrite } from '../external-write-guard';
import { withServiceModeOn, ServiceModeNotOnError } from '../service-mode-transaction';
import { ProviderFailure, providerResponseFailure } from '../provider-failure';
import { writeOperationalLog } from '../monitoring-log';
import { COMPANY_PRICE_TYPE_FIELD, COMPANY_PRICE_TYPE_IBLOCK, COMPANY_PRICE_TYPE_IBLOCK_TYPE, assertCompanyPriceTypeSchema, companyPriceTypeOptions, PriceTypeOption } from './company-price-type';

export type NativePriceType = { id: string; name: string };
export function planCompanyPriceOptions(types: NativePriceType[], options: PriceTypeOption[]) {
  if (types.length > 1000 || types.some(t => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t.id) || !t.name.trim()) || new Set(types.map(t => t.id.toLowerCase())).size !== types.length) throw new Error('COMPANY_PRICE_TYPE_CATALOG_INVALID');
  const byId = new Map(types.map(t => [t.id.toLowerCase(), t]));
  let renamed = 0;
  const list: Array<{ ID?: string; CODE: string; NAME: string }> = options.map(o => {
    const name = byId.get(o.uuid)?.name ?? o.name;
    if (name !== o.name) renamed += 1;
    return { ID: o.id, CODE: o.uuid, NAME: name };
  });
  const known = new Set(options.map(o => o.uuid));
  for (const type of types) if (!known.has(type.id.toLowerCase())) list.push({ CODE: type.id.toLowerCase(), NAME: type.name });
  return { list, renamed, added: list.length - options.length, missing: options.filter(o => !byId.has(o.uuid)).map(o => o.uuid) };
}

/** Maintains option identities only; ordinary company events own the selected value. */
@Injectable()
export class CompanyPriceTypeDirectoryService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running: Promise<unknown> | null = null;
  private nextAttemptAt = 0;
  constructor(private readonly database: DatabaseService) {}
  private enabled() { return process.env.COMPANY_PRICE_TYPE_SYNC_ENABLED === 'enabled' && process.env.SYNC_MODE === 'apply' && process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled'; }
  onApplicationBootstrap() {
    if (!this.enabled()) return;
    const tick = () => {
      if (this.running || Date.now() < this.nextAttemptAt) return;
      this.running = this.runOnce().then(async result => {
        if (result) await writeOperationalLog(this.database, 'SCHEDULED', `Company price types: ${JSON.stringify(result)}`, 'company-price-type-directory');
      }).catch(async error => {
        this.nextAttemptAt = Math.max(Date.now() + 300_000, error instanceof ProviderFailure ? error.retryAfterAt?.getTime() ?? 0 : 0);
        const code = error instanceof ProviderFailure ? `${error.provider}_HTTP_${error.status ?? 'TRANSPORT'}` : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'READ_FAILURE';
        await writeOperationalLog(this.database, 'ERROR', `Company price-type directory held: ${code}`, 'company-price-type-directory');
      }).finally(() => { this.running = null; });
    };
    tick(); this.timer = setInterval(tick, 300_000); this.timer.unref();
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.running; }

  async runOnce() {
    if (!this.enabled()) return null;
    const setting = await this.database.syncSetting.findUnique({ where: { id: 'global' }, select: { serviceMode: true } });
    if (setting?.serviceMode !== 'on') return null;
    const rows = await this.request('BITRIX24', 'crm.company.userfield.list', { filter: { FIELD_NAME: COMPANY_PRICE_TYPE_FIELD } });
    if (!Array.isArray(rows) || rows.length !== 1 || !/^\d+$/.test(String(rows[0]?.ID))) throw new Error('COMPANY_PRICE_TYPE_FIELD_UNAVAILABLE');
    const id = String(rows[0].ID);
    assertCompanyPriceTypeSchema(await this.request('BITRIX24', 'crm.company.userfield.get', { id }));
    const listParams = { IBLOCK_ID: COMPANY_PRICE_TYPE_IBLOCK, IBLOCK_TYPE_ID: COMPANY_PRICE_TYPE_IBLOCK_TYPE };
    const schema = await this.request('BITRIX24', 'lists.field.get', listParams);
    const fields = schema && typeof schema === 'object' && !Array.isArray(schema) ? Object.values(schema) : [];
    if (fields.length !== 1 || !(fields[0] as any)?.FIELD_ID || (fields[0] as any).FIELD_ID !== 'NAME') throw new Error('COMPANY_PRICE_TYPE_DIRECTORY_SCHEMA_CHANGED');
    const options = await this.options();
    const native = await this.request('MOYSKLAD', 'context/companysettings/pricetype');
    if (!Array.isArray(native) || native.some(t => typeof t?.id !== 'string' || typeof t?.name !== 'string' || t.meta?.type !== 'pricetype')) throw new Error('COMPANY_PRICE_TYPE_CATALOG_INVALID');
    const types: NativePriceType[] = native.map(t => ({ id: t.id, name: t.name }));
    const plan = planCompanyPriceOptions(types, options);
    let added = 0, renamed = 0;
    const actions = plan.list.filter(row => !row.ID || options.some(o => o.id === row.ID && o.name !== row.NAME));
    for (const action of actions.slice(0, 5)) {
      // Re-read by native identity before every mutation, including retries after an uncertain ADD.
      const current = await this.options();
      const existing = current.find(o => o.uuid === action.CODE);
      if (existing?.name === action.NAME) continue;
      if (action.ID && existing?.id !== action.ID) throw new Error('COMPANY_PRICE_TYPE_ELEMENT_CHANGED');
      const method = existing ? 'lists.element.update' : 'lists.element.add';
      const ack = await this.request('BITRIX24', method, { ...listParams, ELEMENT_CODE: action.CODE, ...(existing ? { ELEMENT_ID: existing.id } : {}), FIELDS: { NAME: action.NAME } }, true);
      if (existing ? ack !== true : !/^\d+$/.test(String(ack))) throw new Error('COMPANY_PRICE_TYPE_OPTIONS_WRITE_REJECTED');
      const after = await this.options();
      if (current.some(old => !after.some(o => o.id === old.id && o.uuid === old.uuid)) || after.filter(o => o.uuid === action.CODE && o.name === action.NAME && (!existing || o.id === existing.id)).length !== 1) throw new Error('COMPANY_PRICE_TYPE_OPTIONS_READBACK_INVALID');
      if (existing) renamed++; else added++;
    }
    return { added, renamed, deferred: Math.max(0, actions.length - 5), missing: plan.missing.length, options: plan.list.length };
  }

  private async options() {
    const all: unknown[] = [];
    for (let start = 0; start < 1000; start += 50) {
      const page = await this.request('BITRIX24', 'lists.element.get', { IBLOCK_ID: COMPANY_PRICE_TYPE_IBLOCK, IBLOCK_TYPE_ID: COMPANY_PRICE_TYPE_IBLOCK_TYPE, start });
      if (!Array.isArray(page)) throw new Error('COMPANY_PRICE_TYPE_DIRECTORY_INVALID');
      all.push(...page);
      if (page.length < 50) return companyPriceTypeOptions(all);
    }
    throw new Error('COMPANY_PRICE_TYPE_DIRECTORY_TOO_LARGE');
  }

  private async request(provider: 'BITRIX24' | 'MOYSKLAD', method: string, body: Record<string, unknown> = {}, write = false): Promise<any> {
    const result = await withServiceModeOn(this.database, async () => {
      if (!this.enabled()) throw new ServiceModeNotOnError();
      if (write) assertApplyExternalWrite('BITRIX24', 'COMPANY_PRICE_TYPE_OPTIONS', String(body.ELEMENT_ID ?? body.ELEMENT_CODE), 'company-price-type-options');
      const base = provider === 'BITRIX24' ? process.env.BITRIX24_REST_BASE_URL : process.env.MOYSKLAD_API_BASE_URL;
      if (!base || new URL(base).protocol !== 'https:') throw new Error('COMPANY_PRICE_TYPE_PROVIDER_NOT_CONFIGURED');
      const response = await fetch(new URL(provider === 'BITRIX24' ? method + '.json' : method, base.replace(/\/?$/, '/')), {
        method: provider === 'BITRIX24' ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: provider === 'BITRIX24' ? { 'content-type': 'application/json' } : { authorization: `Bearer ${process.env.MOYSKLAD_API_TOKEN}`, accept: 'application/json;charset=utf-8', 'accept-encoding': 'gzip' },
        ...(provider === 'BITRIX24' ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw providerResponseFailure(provider, response.status, response.headers.get('retry-after'));
      const payload = await response.json();
      if (provider === 'BITRIX24') { if (payload?.error || !Object.prototype.hasOwnProperty.call(payload, 'result')) throw new Error('COMPANY_PRICE_TYPE_PROVIDER_REJECTED'); return payload.result; }
      return payload;
    });
    if (!result.enabled) throw new ServiceModeNotOnError();
    return result.value;
  }
}
