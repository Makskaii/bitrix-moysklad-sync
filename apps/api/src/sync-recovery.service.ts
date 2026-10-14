import { Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from './database.service';
import { ContactSyncProcessor } from './contact-sync.service';
import { SyncModeService } from './sync-mode.service';
import { writeOperationalLog } from './monitoring-log';
import { ClientSyncProcessor } from './clients/client-sync.processor';

const MOYSKLAD_PAGE_SIZE = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const NIGHTLY_TICK_MS = 5_000;
const NIGHTLY_WINDOW_MS = 24 * 60 * 60_000;
const NIGHTLY_TIME_ZONE = 'Europe/Moscow';

type RecordValue = Record<string, unknown>;

@Injectable()
export class SyncRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private nightlyRunning = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly database: DatabaseService,
    private readonly syncMode: SyncModeService,
    private readonly processor: ContactSyncProcessor,
    @Optional() private readonly clients?: ClientSyncProcessor,
  ) {}

  onApplicationBootstrap() {
    void this.cancelLegacyOffResumeJob();
    void this.clients?.recoverPending().catch(() => undefined);
    void this.processNightlySchedule().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.clients?.recoverPending().catch(() => undefined);
      void this.processNightlySchedule().catch(() => undefined);
    }, NIGHTLY_TICK_MS);
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
        resumeRetryAfter: true, resumeAttempts: true,
        nightlyScheduledDate: true, nightlyStatus: true, nightlyFrom: true, nightlyThrough: true,
        nightlyProvider: true, nightlyBitrixStart: true, nightlyMoyskladOffset: true,
        nightlyRetryAfter: true, nightlyAttempts: true, nightlyError: true,
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
      retryAfter: setting.resumeRetryAfter,
      attempts: setting.resumeAttempts,
      nightly: {
        scheduledDate: setting.nightlyScheduledDate,
        status: setting.nightlyStatus,
        from: setting.nightlyFrom,
        through: setting.nightlyThrough,
        provider: setting.nightlyProvider,
        bitrixStart: setting.nightlyBitrixStart,
        moyskladOffset: setting.nightlyMoyskladOffset,
        retryAfter: setting.nightlyRetryAfter,
        attempts: setting.nightlyAttempts,
        error: setting.nightlyError,
      },
    };
  }

  private async processNightlySchedule() {
    if (this.nightlyRunning) return;
    const now = new Date();
    const local = localScheduleParts(now);
    const setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } });
    if (!setting) return;

    if (setting.nightlyStatus === 'running') {
      await this.runNightlyJob();
      return;
    }
    if (setting.nightlyStatus === 'failed' && (!setting.nightlyRetryAfter || setting.nightlyRetryAfter <= now)) {
      await this.runNightlyJob();
      return;
    }
    if (local.hour !== 1 || local.minute !== 0 || setting.nightlyScheduledDate === local.date) return;

    const mode = await this.syncMode.read();
    const downtimeCutoff = new Date(now.getTime() - NIGHTLY_WINDOW_MS);
    const downtimeTouchedWindow =
      (setting.lastInactiveAt !== null && setting.lastInactiveAt >= downtimeCutoff) ||
      (setting.lastActiveAt !== null && setting.lastActiveAt >= downtimeCutoff);
    const enabled = mode.mode === 'on' && process.env.SYNC_MODE === 'apply' && !downtimeTouchedWindow;
    const windowFrom = enabled ? this.nightlyWindowStart(now) : null;
    const claim = await this.database.syncSetting.updateMany({
      where: {
        id: 'global',
        OR: [{ nightlyScheduledDate: null }, { nightlyScheduledDate: { not: local.date } }],
      },
      data: {
        nightlyScheduledDate: local.date,
        nightlyStatus: enabled ? 'pending' : 'skipped',
        nightlyFrom: windowFrom,
        nightlyThrough: enabled ? now : null,
        nightlyProvider: 'BITRIX24',
        nightlyBitrixStart: 0,
        nightlyMoyskladOffset: 0,
        nightlyRetryAfter: null,
        nightlyAttempts: 0,
        nightlyError: enabled ? null : downtimeTouchedWindow
          ? 'Skipped because the previous 24-hour window included OFF or PAUSE downtime.'
          : 'Skipped because synchronization was not On and in apply mode at the scheduled time.',
      },
    });
    if (claim.count === 1 && enabled) await this.runNightlyJob();
  }

  private nightlyWindowStart(now: Date): Date {
    return new Date(now.getTime() - NIGHTLY_WINDOW_MS);
  }

  private async runNightlyJob() {
    if (this.nightlyRunning) return;
    this.nightlyRunning = true;
    try {
      let setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } });
      if (!setting || !['pending', 'running', 'failed'].includes(setting.nightlyStatus) ||
          !setting.nightlyFrom || !setting.nightlyThrough) return;
      if (await this.nightlyMustSkip(setting, new Date())) {
        await this.database.syncSetting.update({
          where: { id: 'global' },
          data: { nightlyStatus: 'skipped', nightlyError: 'Stopped because synchronization left On/apply mode.' },
        });
        return;
      }
      if (setting.nightlyStatus === 'failed' && setting.nightlyRetryAfter && setting.nightlyRetryAfter > new Date()) return;
      setting = await this.database.syncSetting.update({
        where: { id: 'global' },
        data: {
          nightlyStatus: 'running', nightlyRetryAfter: null, nightlyError: null,
          nightlyAttempts: { increment: 1 },
        },
      });

      while (setting.nightlyProvider === 'BITRIX24') {
        const page = await this.readBitrixPage(setting.nightlyFrom!, setting.nightlyThrough!, setting.nightlyBitrixStart);
        setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } }) ?? setting;
        if (await this.nightlyMustSkip(setting, new Date())) {
          await this.markNightlySkipped();
          return;
        }
        await this.saveChangedEvents('BITRIX24', page.ids, setting.nightlyFrom!, setting.nightlyThrough!, `nightly:${setting.nightlyScheduledDate}`);
        setting = await this.database.syncSetting.update({
          where: { id: 'global' },
          data: page.next === null
            ? { nightlyProvider: 'MOYSKLAD', nightlyBitrixStart: 0 }
            : { nightlyBitrixStart: page.next },
        });
      }

      while (setting.nightlyProvider === 'MOYSKLAD') {
        const page = await this.readMoyskladPage(setting.nightlyFrom!, setting.nightlyThrough!, setting.nightlyMoyskladOffset);
        setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } }) ?? setting;
        if (await this.nightlyMustSkip(setting, new Date())) {
          await this.markNightlySkipped();
          return;
        }
        await this.saveChangedEvents('MOYSKLAD', page.ids, setting.nightlyFrom!, setting.nightlyThrough!, `nightly:${setting.nightlyScheduledDate}`);
        if (page.hasNext) {
          setting = await this.database.syncSetting.update({
            where: { id: 'global' },
            data: { nightlyMoyskladOffset: setting.nightlyMoyskladOffset + page.count },
          });
        } else {
          await this.database.syncSetting.update({
            where: { id: 'global' },
            data: {
              nightlyStatus: 'complete', nightlyProvider: 'COMPLETE', nightlyMoyskladOffset: 0,
              nightlyRetryAfter: null, nightlyError: null,
            },
          });
          return;
        }
      }
    } catch {
      const current = await this.database.syncSetting.findUnique({
        where: { id: 'global' }, select: { nightlyAttempts: true },
      });
      await this.database.syncSetting.update({
        where: { id: 'global' },
        data: {
          nightlyStatus: 'failed',
          nightlyError: 'Provider retrieval failed; the incomplete nightly page will be retried while synchronization is On.',
          nightlyRetryAfter: new Date(Date.now() + retryDelayMs(current?.nightlyAttempts ?? 1)),
        },
      }).catch(() => undefined);
    } finally {
      this.nightlyRunning = false;
    }
  }

  private async markNightlySkipped() {
    await this.database.syncSetting.update({
      where: { id: 'global' },
      data: { nightlyStatus: 'skipped', nightlyError: 'Stopped because synchronization left On mode.' },
    });
  }

  private async nightlyMustSkip(setting: { lastInactiveAt: Date | null; lastActiveAt: Date | null }, now: Date) {
    const mode = await this.syncMode.read();
    const cutoff = new Date(now.getTime() - NIGHTLY_WINDOW_MS);
    const downtimeTouchedWindow =
      (setting.lastInactiveAt !== null && setting.lastInactiveAt >= cutoff) ||
      (setting.lastActiveAt !== null && setting.lastActiveAt >= cutoff);
    return mode.mode !== 'on' || process.env.SYNC_MODE !== 'apply' || downtimeTouchedWindow;
  }

  private async cancelLegacyOffResumeJob() {
    await this.database.syncSetting.updateMany({
      where: { id: 'global', resumeStatus: { in: ['pending', 'running', 'failed'] } },
      data: {
        resumeStatus: 'skipped',
        resumeFrom: null,
        resumeThrough: null,
        resumeProvider: 'BITRIX24',
        resumeBitrixStart: 0,
        resumeMoyskladOffset: 0,
        resumeRetryAfter: null,
        resumeError: 'Events missed during OFF are intentionally not replayed.',
      },
    });
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

  private async saveChangedEvents(
    source: 'BITRIX24' | 'MOYSKLAD',
    ids: string[],
    from: Date,
    through: Date,
    jobKey = `off-resume:${from.toISOString()}:${through.toISOString()}`,
  ) {
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
      const deliveryKey = `${jobKey}:${externalEntityId}`;
      const row = await this.database.inboundEvent.upsert({
        where: { source_deliveryKey: { source, deliveryKey } },
        create: {
          source, deliveryKey,
          eventType: source === 'BITRIX24' ? 'ONCRMCONTACTUPDATE' : 'UPDATE',
          externalEntityId,
          externalEntityType: source === 'MOYSKLAD' ? 'counterparty' : null,
          payload: { recovery: jobKey.startsWith('nightly:') ? 'nightly' : 'off-resume', from: from.toISOString(), through: through.toISOString() } as Prisma.InputJsonValue,
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

function retryDelayMs(attempt: number): number {
  return Math.min(5_000 * (2 ** Math.max(0, attempt - 1)), 15 * 60_000);
}

function localScheduleParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NIGHTLY_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}
