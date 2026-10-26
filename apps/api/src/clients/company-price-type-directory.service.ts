import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { assertApplyExternalWrite } from '../external-write-guard';
import { withServiceModeOn, ServiceModeNotOnError } from '../service-mode-transaction';
import { ProviderFailure, providerResponseFailure } from '../provider-failure';
import { writeOperationalLog } from '../monitoring-log';
import { COMPANY_PRICE_TYPE_FIELD, companyPriceTypeOptions, PriceTypeOption } from './company-price-type';

export type NativePriceType = { id: string; name: string };
export function planCompanyPriceOptions(types: NativePriceType[], options: PriceTypeOption[]) {
  if (types.length > 1000 || types.some(t => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t.id) || !t.name.trim()) || new Set(types.map(t => t.id.toLowerCase())).size !== types.length) throw new Error('COMPANY_PRICE_TYPE_CATALOG_INVALID');
  const byId = new Map(types.map(t => [t.id.toLowerCase(), t]));
  let renamed = 0;
  const list: Array<{ ID?: string; XML_ID: string; VALUE: string; DEF: string; SORT: number }> = options.map((o, i) => {
    const name = byId.get(o.uuid)?.name ?? o.name;
    if (name !== o.name) renamed += 1;
    return { ID: o.id, XML_ID: o.uuid, VALUE: name, DEF: 'N', SORT: (i + 1) * 100 };
  });
  const known = new Set(options.map(o => o.uuid));
  for (const type of types) if (!known.has(type.id.toLowerCase())) list.push({ XML_ID: type.id.toLowerCase(), VALUE: type.name, DEF: 'N', SORT: (list.length + 1) * 100 });
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
    const options = companyPriceTypeOptions(await this.request('BITRIX24', 'userfieldconfig.get', { moduleId: 'crm', id }));
    const native = await this.request('MOYSKLAD', 'context/companysettings/pricetype');
    if (!Array.isArray(native) || native.some(t => typeof t?.id !== 'string' || typeof t?.name !== 'string' || t.meta?.type !== 'pricetype')) throw new Error('COMPANY_PRICE_TYPE_CATALOG_INVALID');
    const types: NativePriceType[] = native.map(t => ({ id: t.id, name: t.name }));
    const plan = planCompanyPriceOptions(types, options);
    if (plan.added || plan.renamed) {
      // Re-read immediately before replacement; never clobber a concurrent option edit.
      const before = companyPriceTypeOptions(await this.request('BITRIX24', 'userfieldconfig.get', { moduleId: 'crm', id }));
      if (JSON.stringify(before) !== JSON.stringify(options)) throw new Error('COMPANY_PRICE_TYPE_OPTIONS_CHANGED');
      const ack = await this.request('BITRIX24', 'crm.company.userfield.update', { id, fields: { LIST: plan.list } }, true);
      if (ack !== true) throw new Error('COMPANY_PRICE_TYPE_OPTIONS_WRITE_REJECTED');
      const after = companyPriceTypeOptions(await this.request('BITRIX24', 'userfieldconfig.get', { moduleId: 'crm', id }));
      if (options.some(old => !after.some(o => o.id === old.id && o.uuid === old.uuid)) || types.some(type => after.filter(o => o.uuid === type.id.toLowerCase() && o.name === type.name).length !== 1)) throw new Error('COMPANY_PRICE_TYPE_OPTIONS_READBACK_INVALID');
    }
    return { added: plan.added, renamed: plan.renamed, missing: plan.missing.length, options: plan.list.length };
  }

  private async request(provider: 'BITRIX24' | 'MOYSKLAD', method: string, body: Record<string, unknown> = {}, write = false): Promise<any> {
    const result = await withServiceModeOn(this.database, async () => {
      if (!this.enabled()) throw new ServiceModeNotOnError();
      if (write) assertApplyExternalWrite('BITRIX24', 'COMPANY_PRICE_TYPE_OPTIONS', String(body.id), 'company-price-type-options');
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
