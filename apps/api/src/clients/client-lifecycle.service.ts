import { ConflictException, Inject, Injectable, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ClientSyncGateway } from './client-sync.gateway';
import { DatabaseService } from '../database.service';
import { lockEntityPairState } from '../pairs/pair-db-lock';
import { InboundEventProcessor, InboundEventMetadata } from '../event-dispatcher.service';
import { ProviderFailure, retryAtForFailure } from '../provider-failure';
import { assertApplyExternalWrite } from '../external-write-guard';
import { SyncModeService } from '../sync-mode.service';

export const CLIENT_LIFECYCLE_GATEWAY = Symbol('CLIENT_LIFECYCLE_GATEWAY');
export type LifecycleSource = 'BITRIX24' | 'MOYSKLAD';
type LifecycleEntityType = 'COMPANY' | 'CONTACT' | 'DEAL' | 'PRODUCT';
type EntityPairLease = { assertOwned(): Promise<void>; release(): Promise<void> };

/** Pair tombstones preserve both native records and the exact confirmed relationship. */
@Injectable()
export class ClientLifecycleService implements InboundEventProcessor, OnApplicationBootstrap, OnModuleDestroy {
  private readonly active = new Set<string>();
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryScan: Promise<void> | null = null;
  constructor(
    private readonly database: DatabaseService,
    @Optional() @Inject(CLIENT_LIFECYCLE_GATEWAY) private readonly gateway?: ClientSyncGateway,
    @Optional() private readonly syncMode?: SyncModeService,
  ) {}

  onApplicationBootstrap() {
    this.requestRecoveryScan();
    this.recoveryTimer = setInterval(() => this.requestRecoveryScan(), 2_000);
    this.recoveryTimer.unref();
  }

  async onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await this.recoveryScan;
  }

  supports(event: InboundEventMetadata): boolean {
    return (event.source === 'BITRIX24' &&
      ((event.externalEntityType === 'company' && event.eventType === 'ONCRMCOMPANYDELETE') ||
       (event.externalEntityType === 'contact' && event.eventType === 'ONCRMCONTACTDELETE') ||
       (event.externalEntityType === 'deal' && event.eventType === 'ONCRMDEALDELETE') ||
       (event.externalEntityType === 'product' && event.eventType === 'CATALOG.PRODUCT.ON.DELETE'))) ||
      (event.source === 'MOYSKLAD' && event.eventType === 'DELETE' &&
        (event.externalEntityType === 'counterparty' || event.externalEntityType === 'contactperson' || event.externalEntityType === 'customerorder' || event.externalEntityType === 'product' || event.externalEntityType === 'service'));
  }

  enqueue(eventId: string) {
    const timer = setTimeout(() => { void this.processDeleteEvent(eventId).catch(() => undefined); }, 0);
    timer.unref();
  }

  async assertPairActive(pairId: string, entityType?: string): Promise<void> {
    const pair = await this.database.entityPair.findUnique({ where: { id: pairId }, select: { active: true, lifecycleStatus: true, entityType: true } });
    if (!pair || (entityType && pair.entityType !== entityType)) throw new ConflictException('PAIR_NOT_AVAILABLE');
    if (pair.lifecycleStatus === 'TOMBSTONED') throw new ConflictException('PAIR_TOMBSTONED');
    if (!pair.active || pair.lifecycleStatus !== 'ACTIVE') throw new ConflictException('PAIR_INACTIVE');
  }

  /** Serializes one pair-owned provider mutation against a confirmed deletion event. */
  async withPairActiveLock<T>(pairId: string, entityType: LifecycleEntityType, work: () => Promise<T>): Promise<T> {
    const pair = await this.database.entityPair.findUnique({
      where: { id: pairId },
      select: { id: true, entityType: true, bitrix24Id: true, moyskladId: true },
    });
    if (!pair || pair.entityType !== entityType) throw new ConflictException('PAIR_NOT_AVAILABLE');
    const lease = await this.acquireEntityPairLease(pair, 'BITRIX24', entityType, pair.bitrix24Id);
    try {
      await lease.assertOwned();
      await this.assertPairActive(pairId, entityType);
      return await work();
    } finally {
      await lease.release();
    }
  }

  private requestRecoveryScan() {
    if (this.recoveryScan) return;
    this.recoveryScan = this.resumePendingDeleteEvents().catch(() => undefined).finally(() => { this.recoveryScan = null; });
  }

  private async resumePendingDeleteEvents() {
    const now = new Date();
    const pending = await this.database.inboundEvent.findMany({
      where: {
        AND: [
          { OR: [
            { source: 'BITRIX24', eventType: { in: ['ONCRMCOMPANYDELETE', 'ONCRMCONTACTDELETE', 'ONCRMDEALDELETE', 'CATALOG.PRODUCT.ON.DELETE'] } },
            { source: 'MOYSKLAD', eventType: 'DELETE', externalEntityType: { in: ['counterparty', 'contactperson', 'customerorder', 'product', 'service'] } },
          ] },
          { OR: [
            { status: 'RECEIVED' },
            { status: 'RETRYABLE_FAILURE', OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
            { status: 'PROCESSING', OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: new Date(now.getTime() - 60_000) } }] },
          ] },
        ],
      }, select: { id: true }, take: 100,
    });
    for (const event of pending) this.enqueue(event.id);

    const pendingComments = await this.database.entityPair.findMany({
      where: { lifecycleStatus: 'TOMBSTONED', tombstoneSource: 'MOYSKLAD', deletionTimelineStatus: { in: ['PENDING', 'WRITING', 'PARTNER_UNAVAILABLE'] }, OR: [{ deletionTimelineLeaseUntil: null }, { deletionTimelineLeaseUntil: { lte: now } }] },
      select: { id: true, entityType: true }, take: 50,
    });
    for (const pair of pendingComments) {
      if (!isCrmTimelineEntity(pair.entityType)) continue;
      try { await this.ensureDeletionTimelineComment(pair.id, pair.entityType); } catch { /* retry on the next recovery scan */ }
    }

    const pendingMarkers = await this.database.entityPair.findMany({
      where: { lifecycleStatus: 'TOMBSTONED', tombstoneSource: 'MOYSKLAD', OR: [
        { deletionMarkerStatus: { in: ['PENDING', 'WRITING'] } },
        { deletionMarkerStatus: 'FAILED', OR: [{ deletionMarkerRetryAfter: null }, { deletionMarkerRetryAfter: { lte: now } }] },
      ] },
      select: { id: true, entityType: true, bitrix24Id: true, moyskladId: true }, take: 50,
    });
    for (const pair of pendingMarkers) {
      if (!isLifecycleEntityType(pair.entityType)) continue;
      let lease: EntityPairLease | undefined;
      try {
        lease = await this.acquireEntityPairLease(pair, 'MOYSKLAD', pair.entityType, pair.moyskladId);
        await lease.assertOwned();
        await this.ensureDeletionMarker(pair.id, pair.entityType);
      } catch { /* retry on the next recovery scan */ }
      finally { await lease?.release().catch(() => undefined); }
    }
  }

  private async processDeleteEvent(eventId: string) {
    if (this.active.has(eventId)) return;
    this.active.add(eventId);
    let pairLease: EntityPairLease | undefined;
    try {
      const event = await this.database.inboundEvent.findUnique({ where: { id: eventId } });
      if (!event || !this.supports(event) || !event.externalEntityId) return;
      const now = new Date();
      const claim = await this.database.inboundEvent.updateMany({
        where: { id: eventId, OR: [
          { status: 'RECEIVED' },
          { status: 'RETRYABLE_FAILURE', OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
          { status: 'PROCESSING', OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: new Date(now.getTime() - 60_000) } }] },
        ] },
        data: { status: 'PROCESSING', processingStartedAt: now, attempts: { increment: 1 }, retryAfter: null },
      });
      if (claim.count !== 1) return;
      const entityType = lifecycleEntityForEvent(event.source, event.externalEntityType!);
      if (!entityType) throw new ProviderFailure(event.source as LifecycleSource, 400);
      const pair = await this.database.entityPair.findFirst({ where: event.source === 'BITRIX24'
        ? { entityType, bitrix24Id: event.externalEntityId }
        : { entityType, moyskladId: event.externalEntityId },
        select: { id: true, bitrix24Id: true, moyskladId: true, moyskladType: true },
      });
      if (pair) pairLease = await this.acquireEntityPairLease(pair, event.source as LifecycleSource, entityType, event.externalEntityId);
      const nativeType = event.source === 'BITRIX24' && entityType === 'PRODUCT' && pair?.moyskladType === 'service'
        ? 'service' : event.externalEntityType!;
      const state = await this.readDeletionState(event.source as LifecycleSource, entityType, nativeType, event.externalEntityId, event.payload);
      if (state === 'PRESENT') {
        await this.database.inboundEvent.update({ where: { id: eventId }, data: { status: 'UNCHANGED', processingStartedAt: null, lastErrorCategory: null } });
        return;
      }
      if (state === 'UNCERTAIN') {
        await this.database.$transaction(async (tx) => {
          await lockEntityPairState(tx);
          const existing = await tx.pairReviewCase.findFirst({ where: { entityType, sourceSystem: event.source, sourceEntityId: event.externalEntityId!, status: 'OPEN', reason: 'CLIENT_DELETE_STATE_UNCERTAIN' } });
          if (!existing) await tx.pairReviewCase.create({ data: { entityType, sourceSystem: event.source, sourceEntityId: event.externalEntityId!, eventId, reason: 'CLIENT_DELETE_STATE_UNCERTAIN' } });
          await tx.inboundEvent.update({ where: { id: eventId }, data: { status: 'MANUAL_REVIEW', processingStartedAt: null, lastErrorCategory: 'CLIENT_DELETE_STATE_UNCERTAIN' } });
        });
        return;
      }
      await pairLease?.assertOwned();
      const result = await this.tombstoneByNativeId(event.source as LifecycleSource, entityType, event.externalEntityId, 'CONFIRMED_PROVIDER_DELETION');
      if (result.status === 'TOMBSTONED' && event.source === 'MOYSKLAD' && result.pairId) {
        await this.ensureDeletionMarker(result.pairId, entityType);
      }
      if (result.status === 'TOMBSTONED' && event.source === 'MOYSKLAD' && result.pairId && isCrmTimelineEntity(entityType)) {
        await this.ensureDeletionTimelineComment(result.pairId, entityType);
      }
      await this.database.inboundEvent.update({ where: { id: eventId }, data: {
        status: result.status === 'UNPAIRED' ? 'UNCHANGED' : 'SUCCEEDED', processingStartedAt: null,
        lastErrorCategory: null, lastSuccessfulAt: new Date(),
      } });
    } catch (error) {
      if (error instanceof ProviderFailure && !error.retryable) {
        const currentEvent = await this.database.inboundEvent.findUnique({ where: { id: eventId } }).catch(() => null);
        if (currentEvent?.externalEntityId && this.supports(currentEvent)) {
          const entityType = lifecycleEntityForEvent(currentEvent.source, currentEvent.externalEntityType!);
          if (!entityType) return;
          await this.database.$transaction(async (tx) => {
            await lockEntityPairState(tx);
            const existing = await tx.pairReviewCase.findFirst({ where: { entityType, sourceSystem: currentEvent.source, sourceEntityId: currentEvent.externalEntityId!, status: 'OPEN', reason: 'CLIENT_LIFECYCLE_PROVIDER_REJECTED' } });
            if (!existing) await tx.pairReviewCase.create({ data: { entityType, sourceSystem: currentEvent.source, sourceEntityId: currentEvent.externalEntityId!, eventId, reason: 'CLIENT_LIFECYCLE_PROVIDER_REJECTED' } });
            await tx.inboundEvent.updateMany({ where: { id: eventId, status: 'PROCESSING' }, data: { status: 'MANUAL_REVIEW', processingStartedAt: null, lastErrorCategory: 'CLIENT_LIFECYCLE_PROVIDER_REJECTED' } });
          }).catch(() => undefined);
          return;
        }
      }
      const current = await this.database.inboundEvent.findUnique({ where: { id: eventId }, select: { attempts: true } }).catch(() => null);
      const retryAt = retryAtForFailure(error, current?.attempts ?? 1);
      await this.database.inboundEvent.updateMany({ where: { id: eventId, status: 'PROCESSING' }, data: {
        status: 'RETRYABLE_FAILURE', processingStartedAt: null, retryAfter: retryAt,
        lastErrorCategory: error instanceof ProviderFailure ? `${error.provider}_API_FAILURE` : 'CLIENT_LIFECYCLE_DATABASE_FAILURE',
      } }).catch(() => undefined);
    } finally {
      await pairLease?.release().catch(() => undefined);
      this.active.delete(eventId);
    }
  }

  private async acquireEntityPairLease(
    pair: { id: string; bitrix24Id: string; moyskladId: string },
    eventSource: LifecycleSource,
    entityType: LifecycleEntityType,
    eventNativeId: string,
  ): Promise<EntityPairLease> {
    const counterpartSource = eventSource === 'BITRIX24' ? 'MOYSKLAD' : 'BITRIX24';
    const counterpartId = eventSource === 'BITRIX24' ? pair.moyskladId : pair.bitrix24Id;
    const keys = [
      entityLeaseKey(eventSource, entityType, eventNativeId),
      entityLeaseKey(counterpartSource, entityType, counterpartId),
      entityLeaseKey('BITRIX24', entityType, `pair:${pair.id}`),
    ].sort();
    const owner = randomUUID();
    const acquired: string[] = [];
    try {
      for (const entityKey of keys) {
        const now = new Date();
        const leaseExpiresAt = new Date(now.getTime() + 60_000);
        const reclaimed = await this.database.inboundEntityLock.updateMany({ where: { entityKey, leaseExpiresAt: { lte: now } }, data: { ownerToken: owner, eventId: `lifecycle:${pair.id}`, leaseExpiresAt } });
        if (reclaimed.count !== 1) {
          try {
            await this.database.inboundEntityLock.create({ data: { entityKey, ownerToken: owner, eventId: `lifecycle:${pair.id}`, leaseExpiresAt } });
          } catch { throw new Error('CLIENT_ENTITY_LOCK_BUSY'); }
        }
        acquired.push(entityKey);
      }
    } catch (error) {
      await this.database.inboundEntityLock.deleteMany({ where: { entityKey: { in: acquired }, ownerToken: owner } }).catch(() => undefined);
      throw error;
    }
    let renewing = false;
    let leaseLost = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.database.inboundEntityLock.updateMany({
        where: { entityKey: { in: keys }, ownerToken: owner },
        data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
      }).then((result) => { if (result.count !== keys.length) leaseLost = true; renewing = false; }, () => { leaseLost = true; renewing = false; });
    }, 15_000);
    timer.unref();
    return {
      assertOwned: async () => {
        if (leaseLost) throw new Error('ENTITY_PAIR_LIFECYCLE_LEASE_LOST');
        const now = new Date();
        const renewed = await this.database.inboundEntityLock.updateMany({
          where: { entityKey: { in: keys }, ownerToken: owner, leaseExpiresAt: { gt: now } },
          data: { leaseExpiresAt: new Date(now.getTime() + 60_000) },
        });
        if (renewed.count !== keys.length) { leaseLost = true; throw new Error('ENTITY_PAIR_LIFECYCLE_LEASE_LOST'); }
      },
      release: async () => {
        clearInterval(timer);
        await this.database.inboundEntityLock.deleteMany({ where: { entityKey: { in: keys }, ownerToken: owner } });
      },
    };
  }

  private async readDeletionState(source: LifecycleSource, entityType: LifecycleEntityType, nativeType: string, nativeId: string, payload: unknown, knownParentId: string | null = null): Promise<'PRESENT' | 'DELETED' | 'UNCERTAIN'> {
    if (source === 'MOYSKLAD') {
      const base = process.env.MOYSKLAD_API_BASE_URL;
      const token = process.env.MOYSKLAD_API_TOKEN;
      if (!base || !token) throw new ProviderFailure('MOYSKLAD', null);
      const parentId = entityType === 'CONTACT' && nativeType === 'contactperson' ? knownParentId ?? readParentId(payload) : null;
      if (nativeType === 'contactperson' && !parentId) return 'UNCERTAIN';
      const path = nativeType === 'contactperson'
        ? `entity/counterparty/${encodeURIComponent(parentId!)}/contactpersons/${encodeURIComponent(nativeId)}`
        : `entity/${encodeURIComponent(nativeType)}/${encodeURIComponent(nativeId)}`;
      let response: Response;
      try {
        response = await fetch(new URL(path, withSlash(base)), { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      } catch { throw new ProviderFailure('MOYSKLAD', null); }
      if (response.status === 404) return 'DELETED';
      if (!response.ok) {
        if (response.status === 408 || response.status === 429 || response.status >= 500) throw new ProviderFailure('MOYSKLAD', response.status);
        return 'UNCERTAIN';
      }
      const record: unknown = await response.json().catch(() => null);
      return isRecord(record) && String(record.id ?? '') === nativeId ? 'PRESENT' : 'UNCERTAIN';
    }

    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new ProviderFailure('BITRIX24', null);
    const method = bitrixGetMethod(entityType, nativeType);
    let response: Response;
    try {
      response = await fetch(new URL(method, withSlash(base)), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: nativeId }), redirect: 'error', signal: AbortSignal.timeout(10_000) });
    } catch { throw new ProviderFailure('BITRIX24', null); }
    if (response.status === 408 || response.status === 429 || response.status >= 500) throw new ProviderFailure('BITRIX24', response.status);
    if (!response.ok) return 'UNCERTAIN';
    const result: unknown = await response.json().catch(() => null);
    if (!isRecord(result)) return 'UNCERTAIN';
    const resultKey = nativeType === 'service' ? 'service' : 'product';
    const nativeResult = isRecord(result.result) && isRecord(result.result[resultKey]) ? result.result[resultKey] : result.result;
    if (isRecord(nativeResult) && String(nativeResult.ID ?? nativeResult.id ?? '') === nativeId) return 'PRESENT';
    const description = typeof result.error_description === 'string' ? result.error_description.trim().toLowerCase() : '';
    const notFound = new Set(['not found', 'company is not found', 'contact is not found', 'deal is not found', 'product is not found', 'service is not found', 'company not found', 'contact not found', 'deal not found', 'product not found', 'service not found']);
    return typeof result.error === 'string' && notFound.has(description) ? 'DELETED' : 'UNCERTAIN';
  }

  async listTombstones() {
    return this.database.entityPair.findMany({
      where: { lifecycleStatus: 'TOMBSTONED' },
      orderBy: [{ tombstonedAt: 'desc' }, { id: 'asc' }],
      select: { id: true, entityType: true, bitrix24Id: true, moyskladId: true, moyskladType: true, moyskladParentId: true, lifecycleStatus: true, tombstonedAt: true, tombstoneSource: true, tombstoneReason: true, deletionMarkerStatus: true, deletionTimelineStatus: true },
    });
  }

  /** Call only after the provider's deletion event and current-state read agree. */
  async tombstoneByNativeId(source: LifecycleSource, entityType: LifecycleEntityType, nativeId: string, reason: string) {
    return this.database.$transaction(async (tx) => {
      await lockEntityPairState(tx);
      const pair = await tx.entityPair.findFirst({ where: {
        entityType,
        ...(source === 'BITRIX24' ? { bitrix24Id: nativeId } : { moyskladId: nativeId }),
      } });
      if (!pair) return { status: 'UNPAIRED' as const };
      if (pair.lifecycleStatus === 'TOMBSTONED') return { status: 'TOMBSTONED' as const, pairId: pair.id, changed: false };
      await tx.entityPair.update({ where: { id: pair.id }, data: {
        active: false, lifecycleStatus: 'TOMBSTONED', tombstonedAt: new Date(), tombstoneSource: source,
        tombstoneReason: normalizeReason(reason), deletionMarkerStatus: source === 'MOYSKLAD' ? 'PENDING' : 'NOT_REQUIRED',
        deletionTimelineStatus: source === 'MOYSKLAD' && isCrmTimelineEntity(entityType) ? 'PENDING' : 'NOT_REQUIRED',
      } });
      await tx.operationalLog.create({ data: {
        category: 'CLIENT_LIFECYCLE', referenceId: pair.id,
        message: `Entity pair ${entityType} tombstoned after confirmed ${source} deletion.`,
      } });
      return { status: 'TOMBSTONED' as const, pairId: pair.id, changed: true };
    });
  }

  /** Writes only the explicitly configured Bitrix24 user-field code; never guesses a field. */
  private async ensureDeletionMarker(pairId: string, entityType: LifecycleEntityType) {
    const pair = await this.database.entityPair.findUnique({ where: { id: pairId } });
    if (!pair || pair.lifecycleStatus !== 'TOMBSTONED' || pair.tombstoneSource !== 'MOYSKLAD' || pair.deletionMarkerStatus === 'MARKED') return;
    const fields = await this.readDeletionMarkerFields();
    const fieldCode = fields[entityType];
    if (!fieldCode) {
      if (pair.deletionMarkerStatus !== 'NOT_CONFIGURED') {
        await this.database.entityPair.updateMany({ where: { id: pairId, lifecycleStatus: 'TOMBSTONED' }, data: { deletionMarkerStatus: 'NOT_CONFIGURED', deletionMarkerRetryAfter: null } });
        await this.database.operationalLog.create({ data: { category: 'CLIENT_LIFECYCLE', referenceId: pairId, message: `Bitrix24 deletion marker is not configured for ${entityType}; pair remains tombstoned.` } });
      }
      return;
    }
    const claimed = await this.database.entityPair.updateMany({
      where: { id: pairId, lifecycleStatus: 'TOMBSTONED', tombstoneSource: 'MOYSKLAD', deletionMarkerStatus: { in: ['PENDING', 'FAILED', 'WRITING'] } },
      data: { deletionMarkerStatus: 'WRITING', deletionMarkerAttempts: { increment: 1 }, deletionMarkerRetryAfter: null },
    });
    if (claimed.count !== 1) return;
    try {
      if (process.env.SYNC_MODE !== 'apply' || !this.syncMode || (await this.syncMode.read()).mode !== 'on') {
        await this.database.entityPair.updateMany({ where: { id: pairId, deletionMarkerStatus: 'WRITING' }, data: { deletionMarkerStatus: 'PENDING' } });
        return;
      }
      assertApplyExternalWrite('BITRIX24', 'CLIENT_DELETION_MARKER');
      const result = await this.bitrixRest(bitrixUpdateMethod(entityType, pair.moyskladType === 'service' ? 'service' : undefined), { id: pair.bitrix24Id, [`fields[${fieldCode}]`]: 'Удалён' });
      if (result.result !== true && result.result !== 1) throw new ProviderFailure('BITRIX24', 400);
      await this.database.entityPair.updateMany({ where: { id: pairId, lifecycleStatus: 'TOMBSTONED', deletionMarkerStatus: 'WRITING' }, data: { deletionMarkerStatus: 'MARKED', deletionMarkerRetryAfter: null } });
    } catch (error) {
      await this.database.entityPair.updateMany({ where: { id: pairId, lifecycleStatus: 'TOMBSTONED', deletionMarkerStatus: 'WRITING' }, data: {
        deletionMarkerStatus: 'FAILED', deletionMarkerRetryAfter: retryAtForFailure(error, (pair.deletionMarkerAttempts ?? 0) + 1),
      } }).catch(() => undefined);
      throw error;
    }
  }

  async deletionMarkerFields() {
    return { fields: await this.readDeletionMarkerFields() };
  }

  async saveDeletionMarkerFields(value: unknown) {
    if (!isRecord(value)) throw new ConflictException('DELETION_MARKER_FIELDS_INVALID');
    const allowed = new Set(['COMPANY', 'CONTACT', 'DEAL', 'PRODUCT']);
    const fields: Partial<Record<LifecycleEntityType, string>> = {};
    for (const [entity, code] of Object.entries(value)) {
      if (!allowed.has(entity) || typeof code !== 'string' || !/^UF_[A-Z0-9_]{1,64}$/i.test(code)) throw new ConflictException('DELETION_MARKER_FIELDS_INVALID');
      fields[entity as LifecycleEntityType] = code;
    }
    const current = await this.readDeletionMarkerFields();
    const protectedTombstones = await this.database.entityPair.findMany({
      where: { lifecycleStatus: 'TOMBSTONED', deletionMarkerStatus: { in: ['PENDING', 'WRITING', 'FAILED', 'MARKED', 'CLEARING', 'CLEAR_FAILED'] } },
      select: { entityType: true },
    });
    for (const row of protectedTombstones) {
      if (current[row.entityType as LifecycleEntityType] && fields[row.entityType as LifecycleEntityType] !== current[row.entityType as LifecycleEntityType]) {
        throw new ConflictException('DELETION_MARKER_FIELD_IN_USE');
      }
    }
    await this.database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', clientDeletionMarkerFields: fields }, update: { clientDeletionMarkerFields: fields } });
    await this.database.entityPair.updateMany({
      where: { lifecycleStatus: 'TOMBSTONED', tombstoneSource: 'MOYSKLAD', deletionMarkerStatus: 'NOT_CONFIGURED' },
      data: { deletionMarkerStatus: 'PENDING', deletionMarkerRetryAfter: null },
    });
    return { fields };
  }

  private async readDeletionMarkerFields(): Promise<Partial<Record<LifecycleEntityType, string>>> {
    const setting = await this.database.syncSetting.findUnique({ where: { id: 'global' }, select: { clientDeletionMarkerFields: true } });
    if (!isRecord(setting?.clientDeletionMarkerFields)) return {};
    const fields: Partial<Record<LifecycleEntityType, string>> = {};
    for (const entity of ['COMPANY', 'CONTACT', 'DEAL', 'PRODUCT'] as const) {
      const code = setting.clientDeletionMarkerFields[entity];
      if (typeof code === 'string' && /^UF_[A-Z0-9_]{1,64}$/i.test(code)) fields[entity] = code;
    }
    return fields;
  }

  private async ensureDeletionTimelineComment(pairId: string, entityType: LifecycleEntityType) {
    if (!isCrmTimelineEntity(entityType)) return;
    const pair = await this.database.entityPair.findUnique({ where: { id: pairId } });
    if (!pair || pair.tombstoneSource !== 'MOYSKLAD' || pair.lifecycleStatus !== 'TOMBSTONED') return;
    if (pair.deletionTimelineStatus === 'POSTED' || pair.deletionTimelineStatus === 'MANUAL_REVIEW' || pair.deletionTimelineStatus === 'PARTNER_DELETED') return;
    const now = new Date();
    const claimed = await this.database.entityPair.updateMany({
      where: { id: pairId, lifecycleStatus: 'TOMBSTONED', deletionTimelineStatus: { in: ['PENDING', 'WRITING', 'PARTNER_UNAVAILABLE'] }, OR: [{ deletionTimelineLeaseUntil: null }, { deletionTimelineLeaseUntil: { lte: now } }] },
      data: { deletionTimelineStatus: 'WRITING', deletionTimelineLeaseUntil: new Date(now.getTime() + 60_000) },
    });
    if (claimed.count !== 1) return;
    try {
      if (process.env.SYNC_MODE !== 'apply') {
        await this.database.entityPair.update({ where: { id: pairId }, data: { deletionTimelineStatus: 'PENDING', deletionTimelineLeaseUntil: null } });
        return;
      }
      const bitrixState = await this.readDeletionState('BITRIX24', entityType, bitrixNativeType(entityType), pair.bitrix24Id, {});
      if (bitrixState !== 'PRESENT') {
        await this.database.entityPair.update({ where: { id: pairId }, data: { deletionTimelineStatus: bitrixState === 'DELETED' ? 'PARTNER_DELETED' : 'PARTNER_UNAVAILABLE', deletionTimelineLeaseUntil: null } });
        return;
      }
      const key = `[sync-tombstone:${pair.id}]`;
      const deletedAt = pair.tombstonedAt?.toISOString() ?? new Date().toISOString();
      const comment = `${key} Синхронизация приостановлена: связанная запись МойСклад ${pair.moyskladId} удалена (${deletedAt}); причина: ${pair.tombstoneReason ?? 'CONFIRMED_PROVIDER_DELETION'}. Пара сохранена в сервисе, связанная запись Bitrix24 не удалялась.`;
      let start = 0;
      let found = false;
      let complete = false;
      for (let page = 0; page < 100; page++) {
        const response = await this.bitrixRest('crm.timeline.comment.list.json', {
          'filter[ENTITY_ID]': pair.bitrix24Id,
          'filter[ENTITY_TYPE]': timelineEntityName(entityType),
          'select[0]': 'COMMENT',
          start: String(start),
        });
        if (!Array.isArray(response.result)) throw new ProviderFailure('BITRIX24', 400);
        if (readCommentList(response.result).some((entry) => entry.includes(key))) { found = true; break; }
        const next = Number(response.next);
        if (!Number.isFinite(next) || next <= start) { complete = true; break; }
        start = next;
      }
      if (!found && !complete) throw new ProviderFailure('BITRIX24', 400);
      if (found) {
        await this.database.entityPair.update({ where: { id: pairId }, data: { deletionTimelineStatus: 'POSTED', deletionTimelineLeaseUntil: null } });
        return;
      }
      if (!this.syncMode || (await this.syncMode.read()).mode !== 'on') {
        await this.database.entityPair.update({ where: { id: pairId }, data: { deletionTimelineStatus: 'PENDING', deletionTimelineLeaseUntil: null } });
        return;
      }
      assertApplyExternalWrite('BITRIX24', 'CLIENT_DELETION_TIMELINE_COMMENT');
      const added = await this.bitrixRest('crm.timeline.comment.add.json', {
        'fields[ENTITY_ID]': pair.bitrix24Id,
        'fields[ENTITY_TYPE]': timelineEntityName(entityType),
        'fields[COMMENT]': comment,
      });
      if (added.result === null || added.result === undefined || added.result === false) throw new ProviderFailure('BITRIX24', 400);
      await this.database.entityPair.update({ where: { id: pairId }, data: { deletionTimelineStatus: 'POSTED', deletionTimelineLeaseUntil: null } });
    } catch (error) {
      if (error instanceof ProviderFailure && !error.retryable) {
        await this.database.entityPair.update({ where: { id: pairId }, data: { deletionTimelineStatus: 'MANUAL_REVIEW', deletionTimelineLeaseUntil: null } }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async bitrixRest(method: string, fields: Record<string, string>): Promise<{ result: unknown; next?: number }> {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new ProviderFailure('BITRIX24', null);
    let response: Response;
    try {
      response = await fetch(new URL(method, withSlash(base)), {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
        redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new ProviderFailure('BITRIX24', null); }
    if (!response.ok) throw new ProviderFailure('BITRIX24', response.status);
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || payload.error) {
      const description = isRecord(payload) && typeof payload.error_description === 'string' ? payload.error_description : '';
      throw new ProviderFailure('BITRIX24', /limit|too many/i.test(description) ? 429 : 400);
    }
    return { result: payload.result, ...(typeof payload.next === 'number' ? { next: payload.next } : {}) };
  }

  /** Serialize identity confirmation and marker clearing against provider deletion and pair writes. */
  async restore(pairId: string, confirmed: boolean, actorId: string) {
    const pair = await this.database.entityPair.findUnique({ where: { id: pairId } });
    if (!pair) throw new NotFoundException('PAIR_NOT_FOUND');
    if (!isLifecycleEntityType(pair.entityType)) throw new ConflictException('PAIR_ENTITY_TYPE_UNSUPPORTED');
    const lease = await this.acquireEntityPairLease(pair, 'BITRIX24', pair.entityType, pair.bitrix24Id);
    try {
      await lease.assertOwned();
      return await this.restoreWhileLeased(pairId, confirmed, actorId);
    } finally {
      await lease.release();
    }
  }

  /** Manual restoration is intentionally tied to the existing row and both exact native IDs. */
  private async restoreWhileLeased(pairId: string, confirmed: boolean, actorId: string) {
    if (confirmed !== true) throw new ConflictException('EXPLICIT_RESTORE_CONFIRMATION_REQUIRED');
    if (!/^BITRIX24_USER:\d{1,20}$/.test(actorId)) throw new ConflictException('VERIFIED_ADMIN_IDENTITY_REQUIRED');
    const pair = await this.database.entityPair.findUnique({ where: { id: pairId } });
    if (!pair) throw new NotFoundException('PAIR_NOT_FOUND');
    if (pair.lifecycleStatus === 'ACTIVE' && pair.active) return { status: 'ALREADY_ACTIVE' as const, pairId };
    if (pair.lifecycleStatus !== 'TOMBSTONED') throw new ConflictException('PAIR_NOT_TOMBSTONED');
    if (!isLifecycleEntityType(pair.entityType)) throw new ConflictException('PAIR_ENTITY_TYPE_UNSUPPORTED');
    const entity = pair.entityType;
    const msNativeType = moyskladNativeType(entity, pair.moyskladType);
    if (!msNativeType) throw new ConflictException('PAIR_TARGET_TYPE_UNSUPPORTED');
    let identityVerified = false;
    try {
      if ((entity === 'COMPANY' || entity === 'CONTACT') && this.gateway &&
          (pair.moyskladType === 'counterparty' || pair.moyskladType === 'contactperson')) {
        const [bitrix, moysklad] = await Promise.all([
          this.gateway.readBitrix(entity, pair.bitrix24Id),
          this.gateway.readMoysklad(pair.moyskladType, pair.moyskladId, pair.moyskladParentId),
        ]);
        identityVerified = String(bitrix.ID ?? bitrix.id ?? '') === pair.bitrix24Id && String(moysklad.id ?? '') === pair.moyskladId;
      } else {
        const [bitrix, moysklad] = await Promise.all([
          this.readDeletionState('BITRIX24', entity, entity === 'PRODUCT' && pair.moyskladType === 'service' ? 'service' : bitrixNativeType(entity), pair.bitrix24Id, {}),
          this.readDeletionState('MOYSKLAD', entity, msNativeType, pair.moyskladId, {}, pair.moyskladParentId),
        ]);
        identityVerified = bitrix === 'PRESENT' && moysklad === 'PRESENT';
      }
    } catch (error) {
      if (error instanceof ProviderFailure) throw new ServiceUnavailableException('Provider identity verification is unavailable; retry the restore confirmation');
      throw error;
    }
    if (!identityVerified) {
      throw new ConflictException('PAIR_IDENTITY_VERIFICATION_FAILED');
    }
    const markerField = pair.tombstoneSource === 'MOYSKLAD' ? (await this.readDeletionMarkerFields())[entity] : undefined;
    if (markerField) {
      await this.database.entityPair.updateMany({ where: { id: pairId, lifecycleStatus: 'TOMBSTONED' }, data: { deletionMarkerStatus: 'CLEARING' } });
      try {
        if (process.env.SYNC_MODE !== 'apply') {
          await this.database.entityPair.updateMany({ where: { id: pairId, lifecycleStatus: 'TOMBSTONED', deletionMarkerStatus: 'CLEARING' }, data: { deletionMarkerStatus: 'CLEAR_FAILED' } });
          throw new ServiceUnavailableException('Apply mode is required to clear the Bitrix24 deletion marker');
        }
        assertApplyExternalWrite('BITRIX24', 'CLIENT_DELETION_MARKER_CLEAR');
        const clear = await this.bitrixRest(bitrixUpdateMethod(entity, entity === 'PRODUCT' && pair.moyskladType === 'service' ? 'service' : undefined), { id: pair.bitrix24Id, [`fields[${markerField}]`]: '' });
        if (clear.result !== true && clear.result !== 1) throw new ProviderFailure('BITRIX24', 400);
      } catch (error) {
        await this.database.entityPair.updateMany({ where: { id: pairId, lifecycleStatus: 'TOMBSTONED' }, data: { deletionMarkerStatus: 'CLEAR_FAILED' } }).catch(() => undefined);
        throw error instanceof ServiceUnavailableException ? error : new ServiceUnavailableException('Bitrix24 deletion marker could not be cleared; pair remains tombstoned');
      }
    }
    try {
      return await this.database.$transaction(async (tx) => {
        await lockEntityPairState(tx);
        const current = await tx.entityPair.findUnique({ where: { id: pairId } });
        if (!current || current.lifecycleStatus !== 'TOMBSTONED' || current.bitrix24Id !== pair.bitrix24Id || current.moyskladId !== pair.moyskladId) {
          throw new ConflictException('PAIR_LIFECYCLE_CHANGED');
        }
        const occupied = await tx.entityPair.findFirst({
          where: { id: { not: pairId }, entityType: pair.entityType, active: true, OR: [{ bitrix24Id: pair.bitrix24Id }, { moyskladId: pair.moyskladId }] },
        });
        if (occupied) throw new ConflictException('PAIR_NATIVE_ID_ALREADY_ASSIGNED');
        const before = {
          lifecycleStatus: current.lifecycleStatus,
          tombstonedAt: current.tombstonedAt?.toISOString?.() ?? null,
          tombstoneSource: current.tombstoneSource,
          tombstoneReason: current.tombstoneReason,
        };
        await tx.entityPair.update({ where: { id: pairId }, data: {
          active: true, lifecycleStatus: 'ACTIVE', tombstonedAt: null, tombstoneSource: null,
          tombstoneReason: null, deletionMarkerStatus: markerField ? 'CLEARED' : 'NOT_REQUIRED',
        } });
        const audit = (tx as unknown as { adminAuditEntry?: { create(input: { data: Record<string, unknown> }): Promise<unknown> } }).adminAuditEntry;
        if (!audit) throw new ServiceUnavailableException('Lifecycle audit storage is unavailable');
        await audit.create({ data: {
          actorId,
          action: 'CLIENT_LIFECYCLE_RESTORED',
          targetType: current.entityType,
          targetId: current.id,
          reason: 'VERIFIED_BOTH_NATIVE_IDS',
          before,
          after: { lifecycleStatus: 'ACTIVE', bitrix24Id: current.bitrix24Id, moyskladId: current.moyskladId },
        } });
        return { status: 'RESTORED' as const, pairId };
      });
    } catch (error) {
      if (markerField) {
        await this.database.entityPair.updateMany({ where: { id: pairId, lifecycleStatus: 'TOMBSTONED' }, data: { deletionMarkerStatus: 'CLEAR_FAILED' } }).catch(() => undefined);
      }
      throw error;
    }
  }
}

function normalizeReason(value: string): string {
  return value.trim().slice(0, 500) || 'CONFIRMED_PROVIDER_DELETION';
}

function lifecycleEntityForEvent(source: string, nativeType: string): LifecycleEntityType | null {
  if (source === 'BITRIX24') {
    if (nativeType === 'company') return 'COMPANY';
    if (nativeType === 'contact') return 'CONTACT';
    if (nativeType === 'deal') return 'DEAL';
    if (nativeType === 'product' || nativeType === 'service') return 'PRODUCT';
  }
  if (source === 'MOYSKLAD') {
    if (nativeType === 'counterparty') return 'COMPANY';
    if (nativeType === 'contactperson') return 'CONTACT';
    if (nativeType === 'customerorder') return 'DEAL';
    if (nativeType === 'product' || nativeType === 'service') return 'PRODUCT';
  }
  return null;
}

function isLifecycleEntityType(value: string): value is LifecycleEntityType {
  return value === 'COMPANY' || value === 'CONTACT' || value === 'DEAL' || value === 'PRODUCT';
}

function isCrmTimelineEntity(value: string): value is 'COMPANY' | 'CONTACT' | 'DEAL' {
  return value === 'COMPANY' || value === 'CONTACT' || value === 'DEAL';
}

function bitrixNativeType(entity: LifecycleEntityType): string {
  switch (entity) {
    case 'COMPANY': return 'company';
    case 'CONTACT': return 'contact';
    case 'DEAL': return 'deal';
    case 'PRODUCT': return 'product';
  }
}

function bitrixGetMethod(entity: LifecycleEntityType, nativeType?: string): string {
  switch (entity) {
    case 'COMPANY': return 'crm.company.get.json';
    case 'CONTACT': return 'crm.contact.get.json';
    case 'DEAL': return 'crm.deal.get.json';
    case 'PRODUCT': return nativeType === 'service' ? 'catalog.product.service.get.json' : 'catalog.product.get.json';
  }
}

function bitrixUpdateMethod(entity: LifecycleEntityType, nativeType?: string): string {
  switch (entity) {
    case 'COMPANY': return 'crm.company.update.json';
    case 'CONTACT': return 'crm.contact.update.json';
    case 'DEAL': return 'crm.deal.update.json';
    case 'PRODUCT': return nativeType === 'service' ? 'catalog.product.service.update.json' : 'catalog.product.update.json';
  }
}

function moyskladNativeType(entity: LifecycleEntityType, configuredType: string | null): string | null {
  if (entity === 'COMPANY' && configuredType === 'counterparty') return configuredType;
  if (entity === 'CONTACT' && (configuredType === 'counterparty' || configuredType === 'contactperson')) return configuredType;
  if (entity === 'DEAL' && configuredType === 'customerorder') return configuredType;
  if (entity === 'PRODUCT' && configuredType === 'product') return configuredType;
  if (entity === 'PRODUCT' && configuredType === 'service') return configuredType;
  return null;
}

function timelineEntityName(entity: 'COMPANY' | 'CONTACT' | 'DEAL'): string {
  return entity.toLowerCase();
}

function readParentId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const meta = isRecord(payload.meta) ? payload.meta : {};
  const href = typeof meta.href === 'string' ? meta.href : '';
  const parts = href.split('/').filter(Boolean);
  const contactpersonsIndex = parts.lastIndexOf('contactpersons');
  return contactpersonsIndex > 0 ? decodeURIComponent(parts[contactpersonsIndex - 1]!) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function readCommentList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isRecord).map((row) => typeof row.COMMENT === 'string' ? row.COMMENT : '') : [];
}

function entityLeaseKey(sourceSystem: LifecycleSource, entityType: LifecycleEntityType, sourceId: string): string {
  return `client:${createHash('sha256').update([sourceSystem, entityType, sourceId].join('\0')).digest('hex')}`;
}
