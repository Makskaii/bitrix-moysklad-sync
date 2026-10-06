import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from './database.service';
import { ContactSyncProcessor } from './contact-sync.service';
import { SyncModeService } from './sync-mode.service';
import { writeOperationalLog } from './monitoring-log';

const MOYSKLAD_PAGE_SIZE = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

type RecordValue = Record<string, unknown>;

@Injectable()
export class SyncRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private running = false;
  private rerunRequested = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly database: DatabaseService,
    private readonly syncMode: SyncModeService,
    private readonly processor: ContactSyncProcessor,
  ) {}

  onApplicationBootstrap() {
    void this.processPending();
    this.timer = setInterval(() => { void this.processPending(); }, 5_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async readStatus() {
    const setting = await this.database.syncSetting.upsert({
      where: { id: 'global' }, create: {}, update: {},
      select: {
        resumeStatus: true, resumeFrom: true, resumeThrough: true,
        resumeProvider: true, resumeBitrixStart: true, resumeMoyskladOffset: true, resumeError: true,
      },
    });
    return {
      status: setting.resumeStatus,
      from: setting.resumeFrom,
      through: setting.resumeThrough,
      provider: setting.resumeProvider,
      bitrixStart: setting.resumeBitrixStart,
      moyskladOffset: setting.resumeMoyskladOffset,
      error: setting.resumeError,
    };
  }

  async processPending() {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    if ((await this.syncMode.read()).mode !== 'on') return;
    this.running = true;
    try {
      let setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } });
      if (!setting || !['pending', 'running', 'failed'].includes(setting.resumeStatus) ||
          !setting.resumeFrom || !setting.resumeThrough) return;
      const resumeFrom = setting.resumeFrom;
      const resumeThrough = setting.resumeThrough;
      await this.database.syncSetting.update({ where: { id: 'global' }, data: { resumeStatus: 'running', resumeError: null } });
      await writeOperationalLog(this.database, 'SCHEDULED', 'Off-period recovery started');

      while (setting.resumeProvider === 'BITRIX24') {
        const page = await this.readBitrixPage(resumeFrom, resumeThrough, setting.resumeBitrixStart);
        await this.saveChangedEvents('BITRIX24', page.ids, resumeFrom, resumeThrough);
        setting = await this.database.syncSetting.update({
          where: { id: 'global' },
          data: page.next === null
            ? { resumeProvider: 'MOYSKLAD', resumeBitrixStart: 0 }
            : { resumeBitrixStart: page.next },
        });
      }

      while (setting.resumeProvider === 'MOYSKLAD') {
        const page = await this.readMoyskladPage(resumeFrom, resumeThrough, setting.resumeMoyskladOffset);
        await this.saveChangedEvents('MOYSKLAD', page.ids, resumeFrom, resumeThrough);
        if (page.hasNext) {
          setting = await this.database.syncSetting.update({
            where: { id: 'global' }, data: { resumeMoyskladOffset: setting.resumeMoyskladOffset + page.count },
          });
        } else {
          await this.database.syncSetting.update({
            where: { id: 'global' }, data: { resumeStatus: 'complete', resumeProvider: 'COMPLETE', resumeMoyskladOffset: 0, resumeError: null, offSince: null },
          });
          await writeOperationalLog(this.database, 'SCHEDULED', 'Off-period recovery completed');
          return;
        }
      }
    } catch {
      await this.database.syncSetting.update({
        where: { id: 'global' }, data: { resumeStatus: 'failed', resumeError: 'Provider retrieval failed; the resume cursor was not advanced past the incomplete page.' },
      }).catch(() => undefined);
      await writeOperationalLog(this.database, 'ERROR', 'Off-period recovery failed');
    } finally {
      this.running = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        void this.processPending();
      }
    }
  }

  private async readBitrixPage(from: Date, through: Date, start: number): Promise<{ ids: string[]; next: number | null }> {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new Error('Bitrix24 API is not configured');
    const url = new URL('crm.contact.list.json', base.endsWith('/') ? base : `${base}/`);
    const form = new URLSearchParams({
      'filter[>=DATE_MODIFY]': from.toISOString(),
      'filter[<=DATE_MODIFY]': through.toISOString(),
      'order[DATE_MODIFY]': 'ASC',
      'order[ID]': 'ASC',
      'select[]': 'ID',
      start: String(start),
    });
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      await this.recordApiAttempt('BITRIX24', 'crm.contact.list', 'POST', null, false);
      throw error;
    }
    await this.recordApiAttempt('BITRIX24', 'crm.contact.list', 'POST', response.status, response.ok);
    if (!response.ok) throw new Error('Bitrix24 changed-record query failed');
    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.error || !Array.isArray(payload.result)) throw new Error('Bitrix24 changed-record query failed');
    const ids = payload.result.map((row) => isRecord(row) ? readId(row.ID) : null);
    if (ids.some((id) => id === null)) throw new Error('Invalid Bitrix24 changed-record row');
    const next = typeof payload.next === 'number' && Number.isInteger(payload.next) && payload.next > start ? payload.next : null;
    if (payload.next !== undefined && next === null) throw new Error('Invalid Bitrix24 page cursor');
    return { ids: ids as string[], next };
  }

  private async readMoyskladPage(from: Date, through: Date, offset: number): Promise<{ ids: string[]; count: number; hasNext: boolean }> {
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new Error('MoySklad API is not configured');
    const url = new URL('entity/counterparty', base.endsWith('/') ? base : `${base}/`);
    url.searchParams.set('filter', `updated>=${from.toISOString()};updated<=${through.toISOString()}`);
    url.searchParams.set('order', 'updated,asc');
    url.searchParams.set('limit', String(MOYSKLAD_PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      await this.recordApiAttempt('MOYSKLAD', 'entity/counterparty', 'GET', null, false);
      throw error;
    }
    await this.recordApiAttempt('MOYSKLAD', 'entity/counterparty', 'GET', response.status, response.ok);
    if (!response.ok) throw new Error('MoySklad changed-record query failed');
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.rows) || !isRecord(payload.meta) || typeof payload.meta.size !== 'number') {
      throw new Error('Invalid MoySklad changed-record page');
    }
    const ids = payload.rows.map((row) => isRecord(row) ? readId(row.id) : null);
    if (ids.some((id) => id === null)) throw new Error('Invalid MoySklad changed-record row');
    const hasNext = offset + payload.rows.length < payload.meta.size;
    if (hasNext && payload.rows.length === 0) throw new Error('MoySklad page cursor did not advance');
    if (offset + payload.rows.length > payload.meta.size) throw new Error('Invalid MoySklad page size');
    return { ids: ids as string[], count: payload.rows.length, hasNext };
  }

  private async saveChangedEvents(source: 'BITRIX24' | 'MOYSKLAD', ids: string[], from: Date, through: Date) {
    if (!ids.length) return;
    const pairs = await this.database.contactPair.findMany({
      where: source === 'BITRIX24'
        ? { active: true, bitrix24ContactId: { in: ids } }
        : { active: true, moyskladCounterpartyId: { in: ids } },
      select: { bitrix24ContactId: true, moyskladCounterpartyId: true, moyskladType: true },
    });
    for (const pair of pairs) {
      if (source === 'MOYSKLAD' && pair.moyskladType !== 'COUNTERPARTY') continue;
      const externalEntityId = source === 'BITRIX24' ? pair.bitrix24ContactId : pair.moyskladCounterpartyId;
      const direction = source === 'BITRIX24' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
      const enabled = await this.syncMode.isDirectionEnabled('contacts-companies', direction);
      const deliveryKey = `off-resume:${from.toISOString()}:${through.toISOString()}:${externalEntityId}`;
      const row = await this.database.inboundEvent.upsert({
        where: { source_deliveryKey: { source, deliveryKey } },
        create: {
          source, deliveryKey,
          eventType: source === 'BITRIX24' ? 'ONCRMCONTACTUPDATE' : 'UPDATE',
          externalEntityId,
          externalEntityType: source === 'MOYSKLAD' ? 'counterparty' : null,
          payload: { recovery: 'off-resume', from: from.toISOString(), through: through.toISOString() } as Prisma.InputJsonValue,
          status: enabled ? 'RECEIVED' : 'SKIPPED_DIRECTION_DISABLED',
          lastErrorCategory: enabled ? null : 'DIRECTION_DISABLED',
        },
        update: {},
        select: { id: true, status: true },
      });
      if (enabled && ['RECEIVED', 'RETRYABLE_FAILURE'].includes(row.status)) this.processor.enqueue(row.id);
    }
  }

  private async recordApiAttempt(provider: string, operation: string, method: string, statusCode: number | null, succeeded: boolean) {
    try {
      await this.database.apiAttempt.create({ data: { provider, operation, method, statusCode, succeeded } });
    } catch {
      // API history is supplementary; a logging failure cannot change recovery behavior.
    }
  }
}

function readId(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
