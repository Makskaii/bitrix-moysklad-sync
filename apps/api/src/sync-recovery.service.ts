import { Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from './database.service';
import { ContactSyncProcessor } from './contact-sync.service';
import { SyncModeService } from './sync-mode.service';
import { writeOperationalLog } from './monitoring-log';
import { ClientSyncProcessor } from './clients/client-sync.processor';
import { FieldSettingsService } from './field-settings/field-settings.service';
import { EventDispatcherService } from './event-dispatcher.service';

const MOYSKLAD_PAGE_SIZE = 1_000;
const MOYSKLAD_CONTACTPERSON_MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 15_000;
const NIGHTLY_TICK_MS = 5_000;
const NIGHTLY_REQUEST_INTERVAL_MS = 1_000;
const NIGHTLY_LEASE_MS = 60_000;
const NIGHTLY_WINDOW_MS = 24 * 60 * 60_000;
const NIGHTLY_TIME_ZONE = 'Europe/Moscow';

type RecordValue = Record<string, unknown>;
type NightlyScope = 'contacts-companies' | 'deals-orders' | 'invoices' | 'products-variations';

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
    @Optional() private readonly dispatcher?: EventDispatcherService,
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

    // Feed completion means events were durably enqueued, not that their
    // processors finished. Keep the run visibly pending until every event
    // created by this nightly window has left a retryable/in-flight state.
    if (setting.nightlyStatus === 'awaiting_processing') {
      const pending = await this.database.inboundEvent.count({
        where: {
          deliveryKey: { startsWith: `nightly:${setting.nightlyScheduledDate}:` },
          status: { in: ['RECEIVED', 'PROCESSING', 'RETRYABLE_FAILURE'] },
        },
      });
      if (pending === 0) {
        await this.database.syncSetting.updateMany({
          where: { id: 'global', nightlyScheduledDate: setting.nightlyScheduledDate, nightlyStatus: 'awaiting_processing' },
          data: { nightlyStatus: 'complete_with_limitations', nightlyError: 'Nightly feeds covered active pairs; delete and archival changes remain outside this slice.' },
        });
      }
      return;
    }

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
      await this.runAcceptedEventRecheck(setting.nightlyFrom, setting.nightlyThrough, `nightly:${setting.nightlyScheduledDate}`, leaseToken);
      const final = await this.database.syncSetting.findUnique({ where: { id: 'global' } });
      const failed = final?.nightlyBitrixStatus === 'failed' || final?.nightlyMoyskladStatus === 'failed';
      const complete = final?.nightlyBitrixStatus === 'complete' && final?.nightlyMoyskladStatus === 'complete';
      const retryAfter = final?.nightlyRetryAfter && final.nightlyRetryAfter > new Date()
        ? final.nightlyRetryAfter
        : new Date(Date.now() + retryDelayMs(final?.nightlyAttempts ?? 1));
      await this.database.syncSetting.updateMany({
        where: { id: 'global', nightlyLeaseToken: leaseToken },
        data: {
          nightlyStatus: final?.nightlyStatus === 'skipped' ? 'skipped' : complete ? 'awaiting_processing' : failed ? 'failed' : 'running',
          nightlyProvider: complete ? 'COMPLETE' : 'BITRIX24',
          nightlyRetryAfter: failed ? retryAfter : null,
          ...(complete ? { nightlyError: 'Provider feeds are queued for active pairs; waiting for event processing. Delete and archival changes remain outside this slice.' } : {}),
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
            : { nightlyMoyskladOffset: 0 },
        });
        if (result.count !== 1) throw new Error('Nightly lease or MoySklad cursor changed before checkpoint');
        setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } }) ?? setting;
        if (!page.hasNext) break;
      }
      await this.runMoyskladContactpersonFeed(setting.nightlyFrom!, setting.nightlyThrough!, `nightly:${setting.nightlyScheduledDate}`, leaseToken);
      const latest = await this.database.syncSetting.findUnique({ where: { id: 'global' } });
      if (latest?.nightlyStatus === 'skipped') return;
      const completed = await this.database.syncSetting.updateMany({
        where: { id: 'global', nightlyLeaseToken: leaseToken, nightlyLeaseExpiresAt: { gt: new Date() } },
        data: { nightlyMoyskladStatus: 'complete', nightlyMoyskladOffset: 0 },
      });
      if (completed.count !== 1) throw new Error('Nightly lease was lost before MoySklad feed completion');
    } catch (error) {
      await this.markProviderFailed('MOYSKLAD', error, leaseToken);
    }
  }

  private async runMoyskladContactpersonFeed(from: Date, through: Date, jobKey: string, leaseToken: string) {
    const entityPairs = await this.database.entityPair.findMany({
      where: { entityType: 'COMPANY', active: true, moyskladType: 'counterparty' },
      select: { moyskladId: true },
    });
    const parents = [...new Set(entityPairs.map((pair) => pair.moyskladId))].filter(Boolean).sort();
    const changed: Array<{ id: string; parentId: string }> = [];
    for (const parentId of parents) {
      let offset = 0;
      let expectedSize: number | null = null;
      let pageNumber = 0;
      while (true) {
        if (++pageNumber > MOYSKLAD_CONTACTPERSON_MAX_PAGES) {
          throw new UnsupportedPaginationError('MoySklad contact-person collection exceeds the 20-page nightly safety bound; no contact-person events were queued.');
        }
        await this.renewNightlyLease(leaseToken);
        const page = await this.readMoyskladContactpersonPage(parentId, offset);
        await this.renewNightlyLease(leaseToken);
        const current = await this.database.syncSetting.findUnique({ where: { id: 'global' } });
        if (!current || await this.nightlyMustSkip(current, new Date())) { await this.markNightlySkipped(leaseToken); return; }
        if (expectedSize === null) expectedSize = page.size;
        if (page.size !== expectedSize) {
          throw new UnsupportedPaginationError('MoySklad contact-person collection changed during pagination; no contact-person events were queued.');
        }
        for (const row of page.rows) {
          const updatedAt = moyskladMoment(row.updated);
          if (updatedAt === null) throw new Error('MoySklad contact-person row has an invalid updated timestamp');
          if (updatedAt >= from.getTime() && updatedAt <= through.getTime()) changed.push({ id: row.id, parentId });
        }
        if (offset + page.rows.length >= page.size) break;
        if (page.rows.length === 0) throw new UnsupportedPaginationError('MoySklad contact-person pagination returned an empty page before the advertised total; no contact-person events were queued.');
        offset += page.rows.length;
      }
    }
    await this.saveMoyskladContactpersonEvents(changed, jobKey, leaseToken);
  }

  /** Recheck durable events accepted in this window and attached to a pair.
   * Delete events retain their lifecycle type so the lifecycle processor can
   * reread current state by exact native ID before changing pair state. */
  private async runAcceptedEventRecheck(from: Date | null, through: Date | null, jobKey: string, leaseToken: string) {
    if (!from || !through || !this.fieldSettings) return;
    const take = 500;
    let cursor: { receivedAt: Date; id: string } | undefined;
    type CandidateEvent = {
      id: string; source: string; eventType: string | null;
      externalEntityType: string | null; externalEntityId: string | null; receivedAt: Date;
    };
    const candidates = new Map<string, { event: CandidateEvent; entity: string; scope: NightlyScope; directionEnabled: boolean }>();
    while (true) {
      await this.renewNightlyLease(leaseToken);
      const setting = await this.database.syncSetting.findUnique({ where: { id: 'global' } });
      if (!setting || await this.nightlyMustSkip(setting, new Date())) { await this.markNightlySkipped(leaseToken); return; }
      const scopes = new Map((await this.syncMode.readEntitySettings()).map((item) => [item.key, item]));
      const events = await this.database.inboundEvent.findMany({
        where: {
          receivedAt: { gte: from, lte: through },
          ...(cursor ? { AND: [{ OR: [
            { receivedAt: { gt: cursor.receivedAt } },
            { receivedAt: cursor.receivedAt, id: { gt: cursor.id } },
          ] }] } : {}),
          NOT: { deliveryKey: { startsWith: 'nightly:' } },
          status: { in: ['SUCCEEDED', 'UNCHANGED', 'SYNCED'] },
          OR: [
            { source: 'BITRIX24', externalEntityType: { in: ['contact', 'company', 'deal', 'invoice', 'product'] } },
            { source: 'MOYSKLAD', externalEntityType: { in: ['counterparty', 'contactperson', 'customerorder', 'invoiceout', 'product'] } },
          ],
        },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take,
        select: { id: true, source: true, eventType: true, externalEntityType: true, externalEntityId: true, receivedAt: true },
      });
      if (!events.length) break;
      cursor = { receivedAt: events[events.length - 1].receivedAt, id: events[events.length - 1].id };
      for (const event of events) {
        if (!event.externalEntityId) continue;
        const direction = event.source === 'BITRIX24' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
        for (const mapped of acceptedRecheckEntities(event.source, event.eventType, event.externalEntityType)) {
          const control = scopes.get(mapped.scope);
          const identity = `${mapped.entity}:${event.source}:${event.externalEntityType}:${event.externalEntityId}`;
          const previous = candidates.get(identity);
          if (!previous || isLaterAcceptedEvent(event, previous.event)) {
            candidates.set(identity, { event, ...mapped, directionEnabled: Boolean(control?.ready && control[direction]) });
          }
        }
      }
      if (events.length < take) break;
    }

    // Do not enqueue while paging: a later accepted action may live on a later
    // page. Recheck controls and the service mode after the complete scan.
    await this.renewNightlyLease(leaseToken);
    const latestSetting = await this.database.syncSetting.findUnique({ where: { id: 'global' } });
    if (!latestSetting || await this.nightlyMustSkip(latestSetting, new Date())) { await this.markNightlySkipped(leaseToken); return; }
    let scopes = new Map((await this.syncMode.readEntitySettings()).map((item) => [item.key, item]));
    let processed = 0;
    for (const candidate of candidates.values()) {
      if (processed > 0 && processed % take === 0) {
        await this.renewNightlyLease(leaseToken);
        const currentSetting = await this.database.syncSetting.findUnique({ where: { id: 'global' } });
        if (!currentSetting || await this.nightlyMustSkip(currentSetting, new Date())) { await this.markNightlySkipped(leaseToken); return; }
        scopes = new Map((await this.syncMode.readEntitySettings()).map((item) => [item.key, item]));
      }
      processed++;
      const direction = candidate.event.source === 'BITRIX24' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
      const control = scopes.get(candidate.scope);
      if (!candidate.directionEnabled || !control?.ready || !control[direction]) continue;
      const { event, entity } = candidate;
      const sourceId = event.externalEntityId!;
      const isDelete = isAcceptedDelete(event.source, event.eventType);
      const pair = await this.database.entityPair.findFirst({
        where: {
          entityType: entity,
          ...(!isDelete ? { active: true, lifecycleStatus: 'ACTIVE' } : {}),
          ...(event.source === 'BITRIX24' ? { bitrix24Id: sourceId } : {
            moyskladId: sourceId, moyskladType: event.externalEntityType,
          }),
        },
        select: { id: true, entityType: true, bitrix24Id: true, moyskladId: true, moyskladType: true, lifecycleStatus: true },
      });
      if (!pair) {
        if (isDelete) continue;
        if (entity !== 'CONTACT' || event.source === 'MOYSKLAD' && event.externalEntityType === 'contactperson') continue;
        const legacy = await this.database.contactPair.findFirst({
          where: event.source === 'BITRIX24'
            ? { active: true, bitrix24ContactId: sourceId }
            : { active: true, moyskladCounterpartyId: sourceId, moyskladType: 'COUNTERPARTY' },
          select: { id: true, bitrix24ContactId: true, moyskladCounterpartyId: true },
        });
        if (!legacy) continue;
        const externalEntityId = event.source === 'BITRIX24' ? legacy.bitrix24ContactId : legacy.moyskladCounterpartyId;
        await this.enqueueAcceptedRecheck({
          event, entity, externalEntityId,
          pairId: legacy.id, eventType: syntheticUpdateType(event.source, entity, event.externalEntityType)!, externalEntityType: event.externalEntityType,
          jobKey, leaseToken,
        });
        continue;
      }
      const side = event.source === 'BITRIX24' ? 'bitrix24Id' : 'moyskladId';
      const externalEntityId = isDelete ? sourceId : pair[side];
      const eventType = isDelete ? event.eventType : syntheticUpdateType(event.source, entity, event.externalEntityType);
      if (!externalEntityId || !eventType) continue;
      const payload: Prisma.InputJsonValue = event.source === 'BITRIX24' && entity === 'PRODUCT'
        ? { recovery: 'nightly', entity, acceptedEventId: event.id, data: { FIELDS: { ID: externalEntityId, TYPE: 1 } } }
        : event.source === 'BITRIX24' && entity === 'INVOICE'
          ? { recovery: 'nightly', entity, acceptedEventId: event.id, data: { ENTITY_TYPE_ID: 31, FIELDS: { ID: externalEntityId } } }
          : { recovery: 'nightly', entity, acceptedEventId: event.id };
      await this.enqueueAcceptedRecheck({
        event, entity, externalEntityId, pairId: pair.id, eventType,
        externalEntityType: event.externalEntityType, payload, jobKey, leaseToken,
        currentState: pair.lifecycleStatus,
      });
    }
  }

  private async enqueueAcceptedRecheck(input: {
    event: { id: string; source: string };
    entity: string;
    externalEntityId: string;
    pairId: string;
    eventType: string;
    externalEntityType: string | null;
    payload?: Prisma.InputJsonValue;
    currentState?: string;
    jobKey: string;
    leaseToken: string;
  }) {
    if (!this.fieldSettings) return;
    let payload = input.payload ?? { recovery: 'nightly', entity: input.entity, acceptedEventId: input.event.id } as Prisma.InputJsonValue;
    if (input.externalEntityType === 'contactperson') {
      const pair = await this.database.entityPair.findUnique({ where: { id: input.pairId }, select: { moyskladParentId: true } });
      const base = process.env.MOYSKLAD_API_BASE_URL;
      if (!pair?.moyskladParentId || !base) return;
      const root = base.endsWith('/') ? base : `${base}/`;
      payload = {
        recovery: 'nightly', entity: 'CONTACT', acceptedEventId: input.event.id,
        meta: { href: new URL(`entity/counterparty/${encodeURIComponent(pair.moyskladParentId)}/contactpersons/${encodeURIComponent(input.externalEntityId)}`, root).href },
      };
    }
    const row = await this.fieldSettings.saveAcceptedEvent({
      source: input.event.source as 'BITRIX24' | 'MOYSKLAD',
      deliveryKey: `${input.jobKey}:${input.entity}:${input.eventType}:${input.currentState ?? 'ACTIVE'}:${input.externalEntityId}`,
      eventType: input.eventType, externalEntityId: input.externalEntityId,
      externalEntityType: input.externalEntityType, payload,
      directionDisabled: false, requireServiceNotOff: true, nightlyLeaseToken: input.leaseToken,
    });
    await this.dispatcher?.dispatch(row.id);
  }

  private async readMoyskladContactpersonPage(parentId: string, offset: number): Promise<{ rows: Array<{ id: string; updated: string }>; size: number }> {
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new Error('MoySklad API is not configured');
    const url = new URL(`entity/counterparty/${encodeURIComponent(parentId)}/contactpersons`, base.endsWith('/') ? base : `${base}/`);
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
      await this.recordApiAttempt('MOYSKLAD', 'entity/counterparty/{id}/contactpersons', 'GET', null, false);
      throw error;
    }
    await this.recordApiAttempt('MOYSKLAD', 'entity/counterparty/{id}/contactpersons', 'GET', response.status, response.ok);
    if (!response.ok) throw providerFeedError(response);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.rows) || !isRecord(payload.meta) ||
        !Number.isInteger(payload.meta.size) || typeof payload.meta.size !== 'number' ||
        payload.meta.limit !== MOYSKLAD_PAGE_SIZE || payload.meta.offset !== offset) {
      throw new UnsupportedPaginationError('MoySklad returned invalid contact-person pagination metadata; no contact-person events were queued.');
    }
    if (payload.meta.size < 0 || payload.meta.size > MOYSKLAD_PAGE_SIZE * MOYSKLAD_CONTACTPERSON_MAX_PAGES ||
        payload.rows.length > MOYSKLAD_PAGE_SIZE || payload.rows.length !== Math.min(MOYSKLAD_PAGE_SIZE, payload.meta.size - offset)) {
      throw new UnsupportedPaginationError('MoySklad contact-person page did not match its advertised size; no contact-person events were queued.');
    }
    const rows = payload.rows.map((row) => isRecord(row) && readId(row.id) !== null && typeof row.updated === 'string'
      ? { id: readId(row.id)!, updated: row.updated }
      : null);
    if (rows.some((row) => row === null)) throw new Error('Invalid MoySklad contact-person row');
    return { rows: rows as Array<{ id: string; updated: string }>, size: payload.meta.size };
  }

  private async saveMoyskladContactpersonEvents(records: Array<{ id: string; parentId: string }>, jobKey: string, leaseToken: string) {
    const unique = [...new Map(records.map((record) => [record.id, record])).values()];
    if (!unique.length) return;
    const enabled = await this.syncMode.isDirectionEnabled('contacts-companies', 'moyskladToBitrix24');
    const base = process.env.MOYSKLAD_API_BASE_URL;
    if (!base) throw new Error('MoySklad API is not configured');
    const root = base.endsWith('/') ? base : `${base}/`;
    const failures: unknown[] = [];
    for (const record of unique) {
      try {
        const event = {
          source: 'MOYSKLAD' as const,
          deliveryKey: `${jobKey}:CONTACT:${record.id}`,
          eventType: 'UPDATE',
          externalEntityId: record.id,
          externalEntityType: 'contactperson',
          payload: {
            recovery: 'nightly', entity: 'CONTACT',
            meta: { href: new URL(`entity/counterparty/${encodeURIComponent(record.parentId)}/contactpersons/${encodeURIComponent(record.id)}`, root).href },
          } as Prisma.InputJsonValue,
        };
        const row = this.fieldSettings
          ? await this.fieldSettings.saveAcceptedEvent({ ...event, directionDisabled: !enabled, requireServiceNotOff: true, nightlyLeaseToken: leaseToken })
          : await this.database.inboundEvent.upsert({
            where: { source_deliveryKey: { source: event.source, deliveryKey: event.deliveryKey } },
            create: { ...event, status: enabled ? 'RECEIVED' : 'SKIPPED_DIRECTION_DISABLED', lastErrorCategory: enabled ? null : 'DIRECTION_DISABLED' },
            update: {}, select: { id: true },
          });
        if (enabled) this.clients?.enqueue(row.id);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new Error(`Could not durably queue ${failures.length} changed MoySklad contact-person event(s)`);
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
          if (this.dispatcher) await this.dispatcher.dispatch(row.id);
          else if (this.clients) this.clients.enqueue(row.id);
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

function isLaterAcceptedEvent(candidate: { receivedAt: Date; id: string }, current: { receivedAt: Date; id: string }) {
  return candidate.receivedAt.getTime() > current.receivedAt.getTime() ||
    candidate.receivedAt.getTime() === current.receivedAt.getTime() && candidate.id > current.id;
}

export function acceptedRecheckEntities(source: string, eventType: string | null, externalEntityType: string | null): Array<{ entity: string; scope: NightlyScope }> {
  if (source === 'BITRIX24') {
    if (externalEntityType === 'contact' && /^ONCRMCONTACT(?:ADD|UPDATE|DELETE)$/.test(eventType ?? '')) return [{ entity: 'CONTACT', scope: 'contacts-companies' }];
    if (externalEntityType === 'company' && /^ONCRMCOMPANY(?:ADD|UPDATE|DELETE)$/.test(eventType ?? '')) return [{ entity: 'COMPANY', scope: 'contacts-companies' }];
    if (externalEntityType === 'deal' && /^ONCRMDEAL(?:ADD|UPDATE|DELETE)$/.test(eventType ?? '')) return [{ entity: 'DEAL', scope: 'deals-orders' }];
    if (externalEntityType === 'invoice' && /^ONCRMDYNAMICITEM(?:ADD|UPDATE)$/.test(eventType ?? '')) return [{ entity: 'INVOICE', scope: 'invoices' }];
    if (externalEntityType === 'product' && ['CATALOG.PRODUCT.ON.UPDATE', 'CATALOG.PRODUCT.ON.DELETE'].includes(eventType ?? '')) return [{ entity: 'PRODUCT', scope: 'products-variations' }];
    return [];
  }
  if (source !== 'MOYSKLAD' || !['CREATE', 'UPDATE', 'DELETE'].includes(eventType ?? '')) return [];
  if (externalEntityType === 'counterparty') return [
    { entity: 'COMPANY', scope: 'contacts-companies' }, { entity: 'CONTACT', scope: 'contacts-companies' },
  ];
  if (externalEntityType === 'contactperson') return [{ entity: 'CONTACT', scope: 'contacts-companies' }];
  if (externalEntityType === 'customerorder') return [{ entity: 'DEAL', scope: 'deals-orders' }];
  if (externalEntityType === 'invoiceout') return [{ entity: 'INVOICE', scope: 'invoices' }];
  if (externalEntityType === 'product') return [{ entity: 'PRODUCT', scope: 'products-variations' }];
  return [];
}

function isAcceptedDelete(source: string, eventType: string | null) {
  return source === 'BITRIX24'
    ? ['ONCRMCONTACTDELETE', 'ONCRMCOMPANYDELETE', 'ONCRMDEALDELETE', 'CATALOG.PRODUCT.ON.DELETE'].includes(eventType ?? '')
    : source === 'MOYSKLAD' && eventType === 'DELETE';
}

function syntheticUpdateType(source: string, entity: string, externalEntityType: string | null): string | null {
  if (source === 'BITRIX24') {
    if (entity === 'CONTACT') return 'ONCRMCONTACTUPDATE';
    if (entity === 'COMPANY') return 'ONCRMCOMPANYUPDATE';
    if (entity === 'DEAL') return 'ONCRMDEALUPDATE';
    if (entity === 'INVOICE') return 'ONCRMDYNAMICITEMUPDATE';
    if (entity === 'PRODUCT') return 'CATALOG.PRODUCT.ON.UPDATE';
    return null;
  }
  if (entity === 'CONTACT' || entity === 'COMPANY' || entity === 'DEAL' || entity === 'INVOICE' || entity === 'PRODUCT') {
    return externalEntityType === 'contactperson' || externalEntityType === 'customerorder' || externalEntityType === 'invoiceout' ||
      externalEntityType === 'product' || externalEntityType === 'counterparty' ? 'UPDATE' : null;
  }
  return null;
}

function moyskladMoment(value: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)$/.exec(value);
  if (!match) return null;
  const timestamp = Date.parse(`${match[1]}T${match[2]}+03:00`);
  if (!Number.isFinite(timestamp)) return null;
  const [year, month, day] = match[1].split('-').map(Number);
  const [hour, minute, secondsAndMillis] = match[2].split(':');
  const [second, fraction = '000'] = secondsAndMillis.split('.');
  const local = new Date(timestamp + 3 * 60 * 60_000);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() + 1 !== month || local.getUTCDate() !== day ||
      local.getUTCHours() !== Number(hour) || local.getUTCMinutes() !== Number(minute) ||
      local.getUTCSeconds() !== Number(second) || local.getUTCMilliseconds() !== Number(fraction.padEnd(3, '0'))) return null;
  return timestamp;
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
