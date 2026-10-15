import { Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from './database.service';
import { ContactSyncProcessor } from './contact-sync.service';
import { SyncModeService } from './sync-mode.service';
import { writeOperationalLog } from './monitoring-log';
import { ClientSyncProcessor } from './clients/client-sync.processor';
import { FieldSettingsService } from './field-settings/field-settings.service';

const MOYSKLAD_PAGE_SIZE = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const NIGHTLY_TICK_MS = 5_000;
const NIGHTLY_REQUEST_INTERVAL_MS = 1_000;
const NIGHTLY_LEASE_MS = 60_000;
const NIGHTLY_WINDOW_MS = 24 * 60 * 60_000;
const NIGHTLY_TIME_ZONE = 'Europe/Moscow';

type RecordValue = Record<string, unknown>;

@Injectable()
export class SyncRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private nightlyRunning = false;
  private lastNightlyRequestAt = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly database: DatabaseService,
    private readonly syncMode: SyncModeService,
    private readonly processor: ContactSyncProcessor,
    @Optional() private readonly clients?: ClientSyncProcessor,
    @Optional() private readonly fieldSettings?: FieldSettingsService,
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
        nightlyBitrixEntityTypeId: true, nightlyBitrixLastId: true, nightlyBitrixStatus: true, nightlyMoyskladStatus: true,
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
        bitrixEntityTypeId: setting.nightlyBitrixEntityTypeId,
        bitrixLastId: setting.nightlyBitrixLastId,
        moyskladOffset: setting.nightlyMoyskladOffset,
        bitrixStatus: setting.nightlyBitrixStatus,
        moyskladStatus: setting.nightlyMoyskladStatus,
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
    const clientScope = (await this.syncMode.readEntitySettings()).find((entity) => entity.key === 'contacts-companies');
    const downtimeCutoff = new Date(now.getTime() - NIGHTLY_WINDOW_MS);
    const downtimeTouchedWindow =
      (setting.lastInactiveAt !== null && setting.lastInactiveAt >= downtimeCutoff) ||
      (setting.lastActiveAt !== null && setting.lastActiveAt >= downtimeCutoff);
    const configuredMode = process.env.SYNC_MODE === 'apply' || process.env.SYNC_MODE === 'dry';
    const enabled = mode.mode === 'on' && configuredMode && !downtimeTouchedWindow &&
      clientScope?.ready === true && (clientScope.bitrix24ToMoysklad || clientScope.moyskladToBitrix24);
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
        nightlyBitrixEntityTypeId: 3,
        nightlyBitrixLastId: null,
        nightlyMoyskladOffset: 0,
        nightlyBitrixStatus: enabled ? 'pending' : 'skipped',
        nightlyMoyskladStatus: enabled ? 'pending' : 'skipped',
        nightlyRetryAfter: null,
        nightlyAttempts: 0,
        nightlyError: enabled ? null : downtimeTouchedWindow
          ? 'Skipped because the previous 24-hour window included OFF or PAUSE downtime.'
          : mode.mode !== 'on' || !configuredMode
            ? 'Skipped because synchronization was not On and configured for dry or apply at the scheduled time.'
            : 'Skipped because the contacts-companies entity or both directions are disabled.',
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
    const leaseToken = randomUUID();
    try {
      const current = await this.database.syncSetting.findUnique({ where: { id: 'global' } });
      if (!current) return;
      const now = new Date();
      if (current.nightlyStatus === 'failed' && current.nightlyRetryAfter && current.nightlyRetryAfter > now) return;
      const lease = await this.database.$executeRaw`
        UPDATE "SyncSetting"
        SET "nightlyLeaseToken" = ${leaseToken}, "nightlyLeaseExpiresAt" = NOW() + INTERVAL '60 seconds',
            "nightlyStatus" = 'running', "nightlyRetryAfter" = NULL, "nightlyError" = NULL,
            "nightlyAttempts" = "nightlyAttempts" + 1, "updatedAt" = NOW()
        WHERE "id" = 'global' AND "nightlyScheduledDate" IS NOT DISTINCT FROM ${current.nightlyScheduledDate}
          AND "nightlyStatus" IN ('pending', 'running', 'failed')
          AND ("nightlyLeaseToken" IS NULL OR "nightlyLeaseExpiresAt" <= NOW())
      `;
      if (lease !== 1) return;
      let setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } });
      if (!setting || !['pending', 'running', 'failed'].includes(setting.nightlyStatus) ||
          !setting.nightlyFrom || !setting.nightlyThrough) return;
      if (await this.nightlyMustSkip(setting, new Date())) {
        await this.database.syncSetting.updateMany({
          where: { id: 'global', nightlyLeaseToken: leaseToken },
          data: { nightlyStatus: 'skipped', nightlyError: 'Stopped because synchronization left On/apply mode.' },
        });
        return;
      }
      await this.runBitrixFeed(setting, leaseToken);
      await this.runMoyskladFeed(setting, leaseToken);
      const final = await this.database.syncSetting.findUnique({ where: { id: 'global' } });
      const failed = final?.nightlyBitrixStatus === 'failed' || final?.nightlyMoyskladStatus === 'failed';
      const complete = final?.nightlyBitrixStatus === 'complete' && final?.nightlyMoyskladStatus === 'complete';
      const retryAfter = final?.nightlyRetryAfter && final.nightlyRetryAfter > new Date()
        ? final.nightlyRetryAfter
        : new Date(Date.now() + retryDelayMs(final?.nightlyAttempts ?? 1));
      await this.database.syncSetting.updateMany({
        where: { id: 'global', nightlyLeaseToken: leaseToken },
        data: {
          nightlyStatus: final?.nightlyStatus === 'skipped' ? 'skipped' : complete ? 'complete_with_limitations' : failed ? 'failed' : 'running',
          nightlyProvider: complete ? 'COMPLETE' : 'BITRIX24',
          nightlyRetryAfter: failed ? retryAfter : null,
          ...(complete ? { nightlyError: 'Nightly feeds cover updates for active contact/company pairs. Delete events and MoySklad contact-person changed-record feeds are outside this slice.' } : {}),
        },
      });
    } catch {
      const current = await this.database.syncSetting.findFirst({
        where: { id: 'global', nightlyLeaseToken: leaseToken }, select: { nightlyAttempts: true },
      });
      if (current) await this.database.syncSetting.updateMany({
        where: { id: 'global', nightlyLeaseToken: leaseToken },
        data: {
          nightlyStatus: 'failed',
          nightlyError: 'Provider retrieval failed; the incomplete nightly page will be retried while synchronization is On.',
          nightlyRetryAfter: new Date(Date.now() + retryDelayMs(current?.nightlyAttempts ?? 1)),
        },
      }).catch(() => undefined);
    } finally {
      await this.database.syncSetting.updateMany({
        where: { id: 'global', nightlyLeaseToken: leaseToken },
        data: { nightlyLeaseToken: null, nightlyLeaseExpiresAt: null },
      }).catch(() => undefined);
      this.nightlyRunning = false;
    }
  }

  private async runBitrixFeed(initial: NonNullable<Awaited<ReturnType<DatabaseService['syncSetting']['findUnique']>>>, leaseToken: string) {
    let setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } }) ?? initial;
    if (setting.nightlyBitrixStatus === 'complete') return;
    if (setting.nightlyStatus === 'skipped') return;
    try {
      while (setting.nightlyBitrixEntityTypeId <= 4) {
        const queriedEntityTypeId = setting.nightlyBitrixEntityTypeId;
        const queriedLastId = setting.nightlyBitrixLastId;
        await this.renewNightlyLease(leaseToken);
        const page = await this.readBitrixPage(setting.nightlyFrom!, setting.nightlyThrough!, queriedEntityTypeId, queriedLastId);
        await this.renewNightlyLease(leaseToken);
        setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } }) ?? setting;
        if (await this.nightlyMustSkip(setting, new Date())) { await this.markNightlySkipped(leaseToken); return; }
        await this.saveChangedEvents('BITRIX24', queriedEntityTypeId === 3 ? 'CONTACT' : 'COMPANY', page.ids, `nightly:${setting.nightlyScheduledDate}`, leaseToken);
        const result = await this.database.syncSetting.updateMany({
          where: { id: 'global', nightlyLeaseToken: leaseToken, nightlyBitrixEntityTypeId: queriedEntityTypeId, nightlyBitrixLastId: queriedLastId },
          data: page.nextId !== null
            ? { nightlyBitrixLastId: page.nextId }
            : queriedEntityTypeId === 3
              ? { nightlyBitrixEntityTypeId: 4, nightlyBitrixStart: 0, nightlyBitrixLastId: null }
              : { nightlyBitrixStatus: 'complete', nightlyBitrixEntityTypeId: 5, nightlyBitrixStart: 0, nightlyBitrixLastId: null },
        });
        if (result.count !== 1) throw new Error('Nightly lease or Bitrix cursor changed before checkpoint');
        setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } }) ?? setting;
      }
    } catch (error) {
      await this.markProviderFailed('BITRIX24', error, leaseToken);
    }
  }

  private async runMoyskladFeed(initial: NonNullable<Awaited<ReturnType<DatabaseService['syncSetting']['findUnique']>>>, leaseToken: string) {
    let setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } }) ?? initial;
    if (setting.nightlyMoyskladStatus === 'complete') return;
    if (setting.nightlyStatus === 'skipped') return;
    try {
      while (true) {
        const queriedOffset = setting.nightlyMoyskladOffset;
        await this.renewNightlyLease(leaseToken);
        const page = await this.readMoyskladPage(setting.nightlyFrom!, setting.nightlyThrough!, queriedOffset);
        await this.renewNightlyLease(leaseToken);
        setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } }) ?? setting;
        if (await this.nightlyMustSkip(setting, new Date())) { await this.markNightlySkipped(leaseToken); return; }
        await this.saveChangedEvents('MOYSKLAD', 'COMPANY', page.ids, `nightly:${setting.nightlyScheduledDate}`, leaseToken);
        const result = await this.database.syncSetting.updateMany({
          where: { id: 'global', nightlyLeaseToken: leaseToken, nightlyLeaseExpiresAt: { gt: new Date() }, nightlyMoyskladOffset: queriedOffset },
          data: page.hasNext
            ? { nightlyMoyskladOffset: setting.nightlyMoyskladOffset + page.count }
            : { nightlyMoyskladStatus: 'complete', nightlyMoyskladOffset: 0 },
        });
        if (result.count !== 1) throw new Error('Nightly lease or MoySklad cursor changed before checkpoint');
        setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } }) ?? setting;
        if (!page.hasNext) return;
      }
    } catch (error) {
      await this.markProviderFailed('MOYSKLAD', error, leaseToken);
    }
  }

  private async markProviderFailed(provider: 'BITRIX24' | 'MOYSKLAD', error: unknown, leaseToken: string) {
    const current = await this.database.syncSetting.findUnique({ where: { id: 'global' }, select: { nightlyAttempts: true } });
    await this.database.syncSetting.updateMany({
      where: { id: 'global', nightlyLeaseToken: leaseToken },
      data: {
        nightlyStatus: 'failed',
        ...(provider === 'BITRIX24' ? { nightlyBitrixStatus: 'failed' } : { nightlyMoyskladStatus: 'failed' }),
        nightlyError: error instanceof UnsupportedPaginationError
          ? error.message
          : `${provider} changed-record feed failed; its incomplete page remains retryable.`,
        nightlyRetryAfter: new Date(Date.now() + (error instanceof ProviderFeedError && error.retryAfterMs !== null
          ? error.retryAfterMs
          : retryDelayMs(current?.nightlyAttempts ?? 1))),
      },
    });
  }

  private async markNightlySkipped(leaseToken: string) {
    await this.database.$executeRaw`
      UPDATE "SyncSetting"
      SET "nightlyStatus" = 'skipped',
          "nightlyBitrixStatus" = CASE WHEN "nightlyBitrixStatus" = 'complete' THEN 'complete' ELSE 'skipped' END,
          "nightlyMoyskladStatus" = CASE WHEN "nightlyMoyskladStatus" = 'complete' THEN 'complete' ELSE 'skipped' END,
          "nightlyError" = 'Stopped because synchronization left On mode.', "updatedAt" = NOW()
      WHERE "id" = 'global' AND "nightlyLeaseToken" = ${leaseToken}
    `;
  }

  private async renewNightlyLease(leaseToken: string) {
    const renewed = await this.database.$executeRaw`
      UPDATE "SyncSetting" SET "nightlyLeaseExpiresAt" = NOW() + INTERVAL '60 seconds', "updatedAt" = NOW()
      WHERE "id" = 'global' AND "nightlyLeaseToken" = ${leaseToken} AND "nightlyLeaseExpiresAt" > NOW()
    `;
    if (renewed !== 1) throw new Error('Nightly run lease was lost');
  }

  private async nightlyMustSkip(setting: { lastInactiveAt: Date | null; lastActiveAt: Date | null }, now: Date) {
    const mode = await this.syncMode.read();
    const cutoff = new Date(now.getTime() - NIGHTLY_WINDOW_MS);
    const downtimeTouchedWindow =
      (setting.lastInactiveAt !== null && setting.lastInactiveAt >= cutoff) ||
      (setting.lastActiveAt !== null && setting.lastActiveAt >= cutoff);
    return mode.mode !== 'on' || (process.env.SYNC_MODE !== 'apply' && process.env.SYNC_MODE !== 'dry') || downtimeTouchedWindow;
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

  private async readBitrixPage(from: Date, through: Date, entityTypeId: number, lastId: string | null): Promise<{ ids: string[]; nextId: string | null }> {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new Error('Bitrix24 API is not configured');
    const url = new URL('crm.item.list.json', base.endsWith('/') ? base : `${base}/`);
    const filter: Record<string, unknown> = {
      '>=updatedTime': from.toISOString(), '<=updatedTime': through.toISOString(),
      ...(lastId === null ? {} : { '>id': lastId }),
    };
    const body = {
      entityTypeId,
      filter,
      order: { id: 'ASC' },
      select: ['id'],
      start: -1,
    };
    let response: Response;
    try {
      await this.waitForNightlyRequestSlot();
      response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      await this.recordApiAttempt('BITRIX24', 'crm.item.list', 'POST', null, false);
      throw error;
    }
    await this.recordApiAttempt('BITRIX24', 'crm.item.list', 'POST', response.status, response.ok);
    if (!response.ok) throw providerFeedError(response);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.error || !isRecord(payload.result) || !Array.isArray(payload.result.items)) throw new Error('Bitrix24 changed-record query failed');
    const ids = payload.result.items.map((row) => isRecord(row) ? readId(row.id) : null);
    if (ids.some((id) => id === null)) throw new Error('Invalid Bitrix24 changed-record row');
    const itemIds = ids as string[];
    return { ids: itemIds, nextId: itemIds.length === 50 ? itemIds[itemIds.length - 1] : null };
  }

  private async readMoyskladPage(from: Date, through: Date, offset: number): Promise<{ ids: string[]; count: number; hasNext: boolean }> {
    if (offset !== 0) throw new UnsupportedPaginationError('MoySklad saved offset pagination is unsupported in this safe nightly slice; feed stopped without enqueue or cursor advancement.');
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new Error('MoySklad API is not configured');
    const url = new URL('entity/counterparty', base.endsWith('/') ? base : `${base}/`);
    url.searchParams.set('filter', `updated>=${moyskladDate(from)};updated<=${moyskladDate(through)}`);
    url.searchParams.set('order', 'updated,asc');
    url.searchParams.set('limit', String(MOYSKLAD_PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    let response: Response;
    try {
      await this.waitForNightlyRequestSlot();
      response = await fetch(url, {
        method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      await this.recordApiAttempt('MOYSKLAD', 'entity/counterparty', 'GET', null, false);
      throw error;
    }
    await this.recordApiAttempt('MOYSKLAD', 'entity/counterparty', 'GET', response.status, response.ok);
    if (!response.ok) throw providerFeedError(response);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.rows) || !isRecord(payload.meta) || typeof payload.meta.size !== 'number' ||
        typeof payload.meta.limit !== 'number' || typeof payload.meta.offset !== 'number') {
      throw new Error('Invalid MoySklad changed-record page');
    }
    const ids = payload.rows.map((row) => isRecord(row) ? readId(row.id) : null);
    if (ids.some((id) => id === null)) throw new Error('Invalid MoySklad changed-record row');
    if (payload.meta.limit !== MOYSKLAD_PAGE_SIZE || payload.meta.offset !== 0) {
      throw new UnsupportedPaginationError('MoySklad returned unexpected limit/offset metadata; feed stopped without enqueue or cursor advancement.');
    }
    if (payload.meta.size > MOYSKLAD_PAGE_SIZE || typeof payload.meta.nextHref === 'string') {
      throw new UnsupportedPaginationError('MoySklad returned more than 1,000 changed counterparties; stable keyset pagination is not verified, so this feed is stopped without enqueue or cursor advancement.');
    }
    if (!Number.isInteger(payload.meta.size) || payload.meta.size < 0 || payload.meta.size !== payload.rows.length) {
      throw new UnsupportedPaginationError('MoySklad changed-record total is inconsistent with the returned page; feed stopped without enqueue or cursor advancement.');
    }
    return { ids: ids as string[], count: payload.rows.length, hasNext: false };
  }

  private async saveChangedEvents(
    source: 'BITRIX24' | 'MOYSKLAD',
    entity: 'CONTACT' | 'COMPANY',
    ids: string[],
    jobKey = 'nightly:unknown',
    leaseToken?: string,
  ) {
    if (!ids.length) return;
    const uniqueIds = [...new Set(ids)];
    const pairs = await this.database.entityPair.findMany({
      where: source === 'BITRIX24'
        ? { active: true, entityType: entity, bitrix24Id: { in: uniqueIds } }
        : { active: true, entityType: 'COMPANY', moyskladId: { in: uniqueIds }, moyskladType: 'counterparty' },
      select: { entityType: true, bitrix24Id: true, moyskladId: true, moyskladType: true },
    });
    const legacyPairs = source === 'BITRIX24' && entity === 'CONTACT'
      ? await this.database.contactPair.findMany({
      where: source === 'BITRIX24'
        ? { active: true, bitrix24ContactId: { in: uniqueIds } }
        : { active: true, moyskladCounterpartyId: { in: uniqueIds } },
      select: { bitrix24ContactId: true, moyskladCounterpartyId: true, moyskladType: true },
    }) : source === 'MOYSKLAD'
      ? await this.database.contactPair.findMany({
        where: { active: true, moyskladCounterpartyId: { in: uniqueIds }, moyskladType: 'COUNTERPARTY' },
        select: { bitrix24ContactId: true, moyskladCounterpartyId: true, moyskladType: true },
      }) : [];
    const queued: string[] = [];
    const failures: unknown[] = [];
    const candidates = [
      ...pairs.map((pair) => ({ entity: pair.entityType as 'CONTACT' | 'COMPANY', bitrix24Id: pair.bitrix24Id, moyskladId: pair.moyskladId, moyskladType: pair.moyskladType })),
      ...legacyPairs.map((pair) => ({ entity: 'CONTACT' as const, bitrix24Id: pair.bitrix24ContactId, moyskladId: pair.moyskladCounterpartyId, moyskladType: pair.moyskladType.toLowerCase() })),
    ];
    for (const pair of candidates) {
      const externalEntityId = source === 'BITRIX24' ? pair.bitrix24Id : pair.moyskladId;
      if (!externalEntityId || (source === 'MOYSKLAD' && pair.moyskladType !== 'counterparty')) continue;
      const direction = source === 'BITRIX24' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
      const enabled = await this.syncMode.isDirectionEnabled('contacts-companies', direction);
      const deliveryKey = `${jobKey}:${pair.entity}:${externalEntityId}`;
      try {
        const event = {
          source, deliveryKey,
          eventType: source === 'BITRIX24' ? pair.entity === 'CONTACT' ? 'ONCRMCONTACTUPDATE' : 'ONCRMCOMPANYUPDATE' : 'UPDATE',
          externalEntityId,
          externalEntityType: source === 'MOYSKLAD' ? pair.moyskladType : pair.entity === 'CONTACT' ? 'contact' : 'company',
          payload: { recovery: jobKey.startsWith('nightly:') ? 'nightly' : 'off-resume', entity: pair.entity } as Prisma.InputJsonValue,
        };
        const row = this.fieldSettings
          ? await this.fieldSettings.saveAcceptedEvent({ ...event, directionDisabled: !enabled, requireServiceNotOff: true, nightlyLeaseToken: leaseToken })
          : await this.database.inboundEvent.upsert({
            where: { source_deliveryKey: { source, deliveryKey } },
            create: { ...event, status: enabled ? 'RECEIVED' : 'SKIPPED_DIRECTION_DISABLED', lastErrorCategory: enabled ? null : 'DIRECTION_DISABLED' },
            update: {}, select: { id: true },
          });
        if (enabled) {
          if (this.clients) this.clients.enqueue(row.id);
          else if (pair.entity === 'CONTACT') this.processor.enqueue(row.id);
        }
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new Error(`Could not durably queue ${failures.length} changed client pair event(s)`);
  }

  private async recordApiAttempt(provider: string, operation: string, method: string, statusCode: number | null, succeeded: boolean) {
    try {
      await this.database.apiAttempt.create({ data: { provider, operation, method, statusCode, succeeded } });
    } catch {
      // API history is supplementary; a logging failure cannot change recovery behavior.
    }
  }

  private async waitForNightlyRequestSlot() {
    const waitMs = Math.max(0, NIGHTLY_REQUEST_INTERVAL_MS - (Date.now() - this.lastNightlyRequestAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.lastNightlyRequestAt = Date.now();
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

class ProviderFeedError extends Error {
  constructor(readonly retryAfterMs: number | null) { super('Provider changed-record feed failed'); }
}

class UnsupportedPaginationError extends Error {}

function providerFeedError(response: Response): ProviderFeedError {
  const raw = response.headers.get('retry-after');
  if (!raw) return new ProviderFeedError(null);
  const seconds = Number(raw);
  const retryAt = Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1_000 : Date.parse(raw);
  if (!Number.isFinite(retryAt)) return new ProviderFeedError(null);
  return new ProviderFeedError(Math.min(60 * 60_000, Math.max(0, retryAt - Date.now())));
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

function moyskladDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: NIGHTLY_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}
