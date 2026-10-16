import { ConflictException, Inject, Injectable, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ClientSyncGateway } from './client-sync.gateway';
import { DatabaseService } from '../database.service';
import { lockEntityPairState } from '../pairs/pair-db-lock';
import { InboundEventProcessor, InboundEventMetadata } from '../event-dispatcher.service';
import { ProviderFailure, retryAtForFailure } from '../provider-failure';
import { assertApplyExternalWrite } from '../external-write-guard';

export const CLIENT_LIFECYCLE_GATEWAY = Symbol('CLIENT_LIFECYCLE_GATEWAY');
export type LifecycleSource = 'BITRIX24' | 'MOYSKLAD';

/** Pair tombstones preserve both native records and the exact confirmed relationship. */
@Injectable()
export class ClientLifecycleService implements InboundEventProcessor, OnApplicationBootstrap, OnModuleDestroy {
  private readonly active = new Set<string>();
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryScan: Promise<void> | null = null;
  constructor(
    private readonly database: DatabaseService,
    @Optional() @Inject(CLIENT_LIFECYCLE_GATEWAY) private readonly gateway?: ClientSyncGateway,
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
       (event.externalEntityType === 'contact' && event.eventType === 'ONCRMCONTACTDELETE'))) ||
      (event.source === 'MOYSKLAD' && event.eventType === 'DELETE' &&
        (event.externalEntityType === 'counterparty' || event.externalEntityType === 'contactperson'));
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
            { source: 'BITRIX24', eventType: { in: ['ONCRMCOMPANYDELETE', 'ONCRMCONTACTDELETE'] } },
            { source: 'MOYSKLAD', eventType: 'DELETE', externalEntityType: { in: ['counterparty', 'contactperson'] } },
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
      if (pair.entityType !== 'COMPANY' && pair.entityType !== 'CONTACT') continue;
      try { await this.ensureDeletionTimelineComment(pair.id, pair.entityType); } catch { /* retry on the next recovery scan */ }
    }
  }

  private async processDeleteEvent(eventId: string) {
    if (this.active.has(eventId)) return;
    this.active.add(eventId);
    let releasePairLease: (() => Promise<void>) | undefined;
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
      const entityType = event.externalEntityType === 'company' || event.externalEntityType === 'counterparty' ? 'COMPANY' : 'CONTACT';
      const pair = await this.database.entityPair.findFirst({ where: event.source === 'BITRIX24'
        ? { entityType, bitrix24Id: event.externalEntityId }
        : { entityType, moyskladId: event.externalEntityId },
        select: { id: true, bitrix24Id: true, moyskladId: true },
      });
      if (pair) releasePairLease = await this.acquireClientPairLease(pair, event.source as LifecycleSource, entityType, event.externalEntityId);
      const state = await this.readDeletionState(event.source as LifecycleSource, entityType, event.externalEntityType!, event.externalEntityId, event.payload);
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
      const result = await this.tombstoneByNativeId(event.source as LifecycleSource, entityType, event.externalEntityId, 'CONFIRMED_PROVIDER_DELETION');
      if (result.status === 'TOMBSTONED' && event.source === 'MOYSKLAD' && result.pairId) {
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
          const entityType = currentEvent.externalEntityType === 'company' || currentEvent.externalEntityType === 'counterparty' ? 'COMPANY' : 'CONTACT';
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
      await releasePairLease?.().catch(() => undefined);
      this.active.delete(eventId);
    }
  }

  private async acquireClientPairLease(
    pair: { id: string; bitrix24Id: string; moyskladId: string },
    eventSource: LifecycleSource,
    entityType: 'COMPANY' | 'CONTACT',
    eventNativeId: string,
  ): Promise<() => Promise<void>> {
    const counterpartSource = eventSource === 'BITRIX24' ? 'MOYSKLAD' : 'BITRIX24';
    const counterpartId = eventSource === 'BITRIX24' ? pair.moyskladId : pair.bitrix24Id;
    const keys = [
      clientLeaseKey(eventSource, entityType, eventNativeId),
      clientLeaseKey(counterpartSource, entityType, counterpartId),
      clientLeaseKey('BITRIX24', entityType, `pair:${pair.id}`),
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
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.database.inboundEntityLock.updateMany({
        where: { entityKey: { in: keys }, ownerToken: owner },
        data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
      }).then(() => { renewing = false; }, () => { renewing = false; });
    }, 15_000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await this.database.inboundEntityLock.deleteMany({ where: { entityKey: { in: keys }, ownerToken: owner } });
    };
  }

  private async readDeletionState(source: LifecycleSource, entityType: 'COMPANY' | 'CONTACT', nativeType: string, nativeId: string, payload: unknown): Promise<'PRESENT' | 'DELETED' | 'UNCERTAIN'> {
    if (source === 'MOYSKLAD') {
      const base = process.env.MOYSKLAD_API_BASE_URL;
      const token = process.env.MOYSKLAD_API_TOKEN;
      if (!base || !token) throw new ProviderFailure('MOYSKLAD', null);
      const parentId = entityType === 'CONTACT' && nativeType === 'contactperson' ? readParentId(payload) : null;
      if (nativeType === 'contactperson' && !parentId) return 'UNCERTAIN';
      const path = nativeType === 'contactperson'
        ? `entity/counterparty/${encodeURIComponent(parentId!)}/contactpersons/${encodeURIComponent(nativeId)}`
        : `entity/counterparty/${encodeURIComponent(nativeId)}`;
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
    const method = entityType === 'COMPANY' ? 'crm.company.get.json' : 'crm.contact.get.json';
    let response: Response;
    try {
      response = await fetch(new URL(method, withSlash(base)), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: nativeId }), redirect: 'error', signal: AbortSignal.timeout(10_000) });
    } catch { throw new ProviderFailure('BITRIX24', null); }
    if (response.status === 408 || response.status === 429 || response.status >= 500) throw new ProviderFailure('BITRIX24', response.status);
    if (!response.ok) return 'UNCERTAIN';
    const result: unknown = await response.json().catch(() => null);
    if (!isRecord(result)) return 'UNCERTAIN';
    if (isRecord(result.result) && String(result.result.ID ?? '') === nativeId) return 'PRESENT';
    const description = typeof result.error_description === 'string' ? result.error_description.trim().toLowerCase() : '';
    const notFound = new Set(['not found', 'company is not found', 'contact is not found', 'company not found', 'contact not found']);
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
  async tombstoneByNativeId(source: LifecycleSource, entityType: 'COMPANY' | 'CONTACT', nativeId: string, reason: string) {
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
        tombstoneReason: normalizeReason(reason), deletionMarkerStatus: 'NOT_CONFIGURED',
        deletionTimelineStatus: source === 'MOYSKLAD' ? 'PENDING' : 'NOT_REQUIRED',
      } });
      await tx.operationalLog.create({ data: {
        category: 'CLIENT_LIFECYCLE', referenceId: pair.id,
        message: `Client pair tombstoned after confirmed ${source} deletion; Bitrix deletion marker is not configured.`,
      } });
      return { status: 'TOMBSTONED' as const, pairId: pair.id, changed: true };
    });
  }

  private async ensureDeletionTimelineComment(pairId: string, entityType: 'COMPANY' | 'CONTACT') {
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
      const bitrixState = await this.readDeletionState('BITRIX24', entityType, entityType === 'COMPANY' ? 'company' : 'contact', pair.bitrix24Id, {});
      if (bitrixState !== 'PRESENT') {
        await this.database.entityPair.update({ where: { id: pairId }, data: { deletionTimelineStatus: bitrixState === 'DELETED' ? 'PARTNER_DELETED' : 'PARTNER_UNAVAILABLE', deletionTimelineLeaseUntil: null } });
        return;
      }
      const key = `[sync-tombstone:${pair.id}]`;
      const deletedAt = pair.tombstonedAt?.toISOString() ?? new Date().toISOString();
      const comment = `${key} Синхронизация приостановлена: связанная запись МойСклад ${pair.moyskladId} удалена (${deletedAt}). Пара сохранена в сервисе, связанная запись Bitrix24 не удалялась.`;
      let start = 0;
      let found = false;
      let complete = false;
      for (let page = 0; page < 100; page++) {
        const response = await this.bitrixRest('crm.timeline.comment.list.json', {
          'filter[ENTITY_ID]': pair.bitrix24Id,
          'filter[ENTITY_TYPE]': entityType === 'COMPANY' ? 'company' : 'contact',
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
      assertApplyExternalWrite('BITRIX24', 'CLIENT_DELETION_TIMELINE_COMMENT');
      const added = await this.bitrixRest('crm.timeline.comment.add.json', {
        'fields[ENTITY_ID]': pair.bitrix24Id,
        'fields[ENTITY_TYPE]': entityType === 'COMPANY' ? 'company' : 'contact',
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

  /** Manual restoration is intentionally tied to the existing row and both exact native IDs. */
  async restore(pairId: string, confirmed: boolean, actorId: string) {
    if (confirmed !== true) throw new ConflictException('EXPLICIT_RESTORE_CONFIRMATION_REQUIRED');
    if (!/^BITRIX24_USER:\d{1,20}$/.test(actorId)) throw new ConflictException('VERIFIED_ADMIN_IDENTITY_REQUIRED');
    if (!this.gateway) throw new ServiceUnavailableException('Client provider verification is unavailable');
    const pair = await this.database.entityPair.findUnique({ where: { id: pairId } });
    if (!pair) throw new NotFoundException('PAIR_NOT_FOUND');
    if (pair.lifecycleStatus !== 'TOMBSTONED') throw new ConflictException('PAIR_NOT_TOMBSTONED');
    if (pair.deletionMarkerStatus !== 'NOT_CONFIGURED') throw new ConflictException('DELETION_MARKER_CLEAR_REQUIRED');
    if (pair.entityType !== 'COMPANY' && pair.entityType !== 'CONTACT') throw new ConflictException('CLIENT_PAIR_REQUIRED');
    if (pair.moyskladType !== 'counterparty' && pair.moyskladType !== 'contactperson') throw new ConflictException('PAIR_TARGET_TYPE_UNSUPPORTED');
    const entity = pair.entityType as 'COMPANY' | 'CONTACT';
    const [bitrix, moysklad] = await Promise.all([
      this.gateway.readBitrix(entity, pair.bitrix24Id),
      this.gateway.readMoysklad(pair.moyskladType, pair.moyskladId, pair.moyskladParentId),
    ]);
    if (String(bitrix.ID ?? '') !== pair.bitrix24Id || String(moysklad.id ?? '') !== pair.moyskladId) {
      throw new ConflictException('PAIR_IDENTITY_VERIFICATION_FAILED');
    }
    return this.database.$transaction(async (tx) => {
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
        tombstoneReason: null, deletionMarkerStatus: 'NOT_CONFIGURED',
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
  }
}

function normalizeReason(value: string): string {
  return value.trim().slice(0, 500) || 'CONFIRMED_PROVIDER_DELETION';
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

function clientLeaseKey(sourceSystem: LifecycleSource, entityType: 'COMPANY' | 'CONTACT', sourceId: string): string {
  return `client:${createHash('sha256').update([sourceSystem, entityType, sourceId].join('\0')).digest('hex')}`;
}
