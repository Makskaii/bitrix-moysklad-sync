import { randomUUID } from 'node:crypto';
import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from './database.service';
import { SyncModeService } from './sync-mode.service';

type JsonRecord = Record<string, unknown>;
type EntityLeaseIdentity = { entityKey: string; ownerToken: string };

class EntityLockLostError extends Error {
  constructor() {
    super('Entity processing lease was lost');
  }
}

class EntityMappingChangedError extends Error {
  constructor() {
    super('Contact pair mapping changed while the event was being claimed');
  }
}
const PROCESSING_LEASE_MS = 60_000;
const ENTITY_LOCK_LEASE_MS = 60_000;
const ENTITY_LOCK_RENEW_INTERVAL_MS = 15_000;
const EXTERNAL_REQUEST_TIMEOUT_MS = 15_000;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 15 * 60_000;
const EVENT_BATCH_DELAY_MS = 250;

@Injectable()
export class ContactSyncProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly active = new Set<string>();
  private readonly activeEntities = new Set<string>();
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryScan: Promise<void> | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly syncMode: SyncModeService,
  ) {}

  onApplicationBootstrap() {
    this.requestRecoveryScan();
    this.recoveryTimer = setInterval(() => this.requestRecoveryScan(), 1_000);
    this.recoveryTimer.unref();
  }

  async onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await this.recoveryScan;
  }

  private requestRecoveryScan() {
    if (this.recoveryScan) return;
    this.recoveryScan = this.resumeReceivedContactEvents()
      .catch(() => undefined)
      .finally(() => { this.recoveryScan = null; });
  }

  enqueue(eventId: string) {
    const timer = setTimeout(() => { void this.process(eventId); }, EVENT_BATCH_DELAY_MS);
    timer.unref();
  }

  private async resumeReceivedContactEvents() {
    if (!await this.isApplyEnabled()) return;
    try {
      const now = new Date();
      const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
      const pending = await this.database.inboundEvent.findMany({
        where: {
          AND: [
            { OR: [
              { source: 'BITRIX24', eventType: { startsWith: 'ONCRMCONTACT' } },
              { source: 'MOYSKLAD', eventType: 'UPDATE', externalEntityType: 'counterparty' },
            ] },
            { OR: [
              { status: 'RECEIVED' },
              { status: 'RETRYABLE_FAILURE', OR: [
                { retryAfter: null },
                { retryAfter: { lte: now } },
              ] },
              { status: 'PROCESSING', OR: [
                { processingStartedAt: null },
                { processingStartedAt: { lt: staleBefore } },
              ] },
            ] },
          ],
        },
        select: { id: true },
      });
      for (const event of pending) this.enqueue(event.id);
    } catch {
      // A later event delivery can enqueue pending work again; do not block app startup.
    }
  }

  async process(eventId: string) {
    if (this.active.has(eventId)) return;
    if (!await this.isApplyEnabled()) return;
    const candidate = await this.database.inboundEvent.findUnique({ where: { id: eventId } });
    if (!candidate || !isContactEmailEvent(candidate.source, candidate.eventType, candidate.externalEntityType)) return;
    const entityKey = await this.entityLeaseKey(candidate);
    if (entityKey && this.activeEntities.has(entityKey)) return;
    this.active.add(eventId);
    if (entityKey) this.activeEntities.add(entityKey);
    const lockOwner = entityKey ? randomUUID() : null;
    let lockRenewalTimer: NodeJS.Timeout | undefined;
    try {
      if (entityKey && lockOwner) {
        const acquired = await this.acquireEntityLock(entityKey, lockOwner, eventId);
        if (!acquired) return;
        lockRenewalTimer = this.renewEntityLockWhileProcessing(entityKey, lockOwner);
      }
      if (await this.skipIfDirectionDisabled(candidate)) return;
      const latestEventId = await this.coalescePendingEvents(candidate, eventId);
      const now = new Date();
      const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
      const claim = await this.database.inboundEvent.updateMany({
        where: {
          id: latestEventId,
          OR: [
            { status: 'RECEIVED' },
            { status: 'RETRYABLE_FAILURE', OR: [
              { retryAfter: null },
              { retryAfter: { lte: now } },
            ] },
            { status: 'PROCESSING', processingStartedAt: null },
            { status: 'PROCESSING', processingStartedAt: { lt: staleBefore } },
          ],
        },
        data: {
          status: 'PROCESSING',
          processingStartedAt: now,
          attempts: { increment: 1 },
          lastErrorCategory: null,
          retryAfter: null,
        },
      });
      if (claim.count !== 1) return;
      const event = await this.database.inboundEvent.findUnique({ where: { id: latestEventId } });
      if (!event) return;
      if (await this.skipIfDirectionDisabled(event)) return;
      const attempt = event.attempts;

      try {
        await this.syncContactEmail(event, attempt, entityKey && lockOwner ? { entityKey, ownerToken: lockOwner } : null);
      } catch (error) {
        if (error instanceof EntityLockLostError) return;
        if (error instanceof EntityMappingChangedError) {
          try {
            await this.commitWithEntityLease(entityKey && lockOwner ? { entityKey, ownerToken: lockOwner } : null, (tx) =>
              tx.inboundEvent.update({
                where: { id: latestEventId },
                data: { status: 'RECEIVED', processingStartedAt: null, lastErrorCategory: null, retryAfter: null },
              }));
          } catch (commitError) {
            if (!(commitError instanceof EntityLockLostError)) throw commitError;
          }
          return;
        }
        const category = errorCategory(error);
        try {
          await this.commitWithEntityLease(entityKey && lockOwner ? { entityKey, ownerToken: lockOwner } : null, (tx) =>
            tx.inboundEvent.update({
              where: { id: latestEventId },
              data: {
                status: category === 'REVIEW_REQUIRED' ? 'MANUAL_REVIEW' : 'RETRYABLE_FAILURE',
                lastErrorCategory: category,
                retryAfter: category === 'REVIEW_REQUIRED' ? null : new Date(Date.now() + retryDelayMs(attempt)),
              },
            }));
        } catch (commitError) {
          if (!(commitError instanceof EntityLockLostError)) throw commitError;
        }
      }
    } finally {
      if (lockRenewalTimer) clearInterval(lockRenewalTimer);
      if (entityKey && lockOwner) {
        await this.releaseEntityLock(entityKey, lockOwner).catch(() => undefined);
      }
      this.active.delete(eventId);
      if (entityKey) this.activeEntities.delete(entityKey);
    }
  }

  private async entityLeaseKey(candidate: { source: string; externalEntityId: string | null }): Promise<string | null> {
    if (!candidate.externalEntityId) return null;
    // Confirmed pairs have a shared cross-source identity; unmapped IDs cannot yet be safely correlated.
    const pair = await this.database.contactPair.findUnique({
      where: candidate.source === 'BITRIX24'
        ? { bitrix24ContactId: candidate.externalEntityId }
        : { moyskladCounterpartyId: candidate.externalEntityId },
      select: { id: true },
    });
    return pair
      ? `CONTACT_PAIR:${pair.id}`
      : `${candidate.source}:${candidate.externalEntityId}`;
  }

  private async acquireEntityLock(entityKey: string, ownerToken: string, eventId: string): Promise<boolean> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + ENTITY_LOCK_LEASE_MS);
    const reclaimed = await this.database.inboundEntityLock.updateMany({
      where: { entityKey, leaseExpiresAt: { lte: now } },
      data: { ownerToken, eventId, leaseExpiresAt },
    });
    if (reclaimed.count === 1) return true;
    try {
      await this.database.inboundEntityLock.create({ data: { entityKey, ownerToken, eventId, leaseExpiresAt } });
      return true;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  private renewEntityLockWhileProcessing(entityKey: string, ownerToken: string): NodeJS.Timeout {
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.database.inboundEntityLock.updateMany({
        where: { entityKey, ownerToken },
        data: { leaseExpiresAt: new Date(Date.now() + ENTITY_LOCK_LEASE_MS) },
      }).then(() => { renewing = false; }, () => { renewing = false; });
    }, ENTITY_LOCK_RENEW_INTERVAL_MS);
    timer.unref();
    return timer;
  }

  private async releaseEntityLock(entityKey: string, ownerToken: string) {
    await this.database.inboundEntityLock.deleteMany({ where: { entityKey, ownerToken } });
  }

  private async assertEntityLockOwner(lease: EntityLeaseIdentity | null) {
    if (!lease) return;
    const current = await this.database.inboundEntityLock.findUnique({
      where: { entityKey: lease.entityKey }, select: { ownerToken: true, leaseExpiresAt: true },
    });
    if (!current || current.ownerToken !== lease.ownerToken || current.leaseExpiresAt <= new Date()) {
      throw new EntityLockLostError();
    }
  }

  private async commitWithEntityLease<T>(
    lease: EntityLeaseIdentity | null,
    commit: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!lease) return commit(this.database as unknown as Prisma.TransactionClient);
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ ownerToken: string; leaseExpiresAt: Date }>>`
        SELECT "ownerToken", "leaseExpiresAt"
        FROM "InboundEntityLock"
        WHERE "entityKey" = ${lease.entityKey}
        FOR UPDATE
      `;
      const owner = rows[0];
      if (!owner || owner.ownerToken !== lease.ownerToken || owner.leaseExpiresAt <= new Date()) {
        throw new EntityLockLostError();
      }
      return commit(transaction);
    });
  }

  private async coalescePendingEvents(
    candidate: { id: string; source: string; externalEntityId: string | null },
    fallbackId: string,
  ): Promise<string> {
    if (!candidate.externalEntityId) return fallbackId;
    const now = new Date();
    const pending = await this.database.inboundEvent.findMany({
      where: {
        source: candidate.source,
        externalEntityId: candidate.externalEntityId,
        ...(candidate.source === 'BITRIX24'
          ? { eventType: { startsWith: 'ONCRMCONTACT' } }
          : { eventType: 'UPDATE', externalEntityType: 'counterparty' }),
        OR: [
          { status: 'RECEIVED' },
          { status: 'RETRYABLE_FAILURE', OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
        ],
      },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    const latestEventId = pending[0]?.id ?? fallbackId;
    const supersededIds = pending.slice(1).map((event) => event.id);
    if (supersededIds.length) {
      await this.database.inboundEvent.updateMany({
        where: { id: { in: supersededIds }, status: { in: ['RECEIVED', 'RETRYABLE_FAILURE'] } },
        data: { status: 'SUPERSEDED', processingStartedAt: null, lastErrorCategory: null, retryAfter: null },
      });
    }
    return latestEventId;
  }

  private async isApplyEnabled(): Promise<boolean> {
    return process.env.SYNC_MODE === 'apply' && (await this.syncMode.read()).mode === 'on';
  }

  private async deferIfModeIsNoLongerOn(eventId: string): Promise<boolean> {
    if (await this.isApplyEnabled()) return false;
    await this.database.inboundEvent.updateMany({
      where: { id: eventId, status: 'PROCESSING' },
      data: { status: 'RECEIVED', processingStartedAt: null, lastErrorCategory: null },
    });
    return true;
  }

  private async skipIfDirectionDisabled(event: {
    id: string; source: string; eventType: string | null; externalEntityType: string | null; status: string;
  }): Promise<boolean> {
    const direction = event.source === 'BITRIX24' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
    if (await this.syncMode.isDirectionEnabled('contacts-companies', direction)) return false;
    const skipped = await this.database.inboundEvent.updateMany({
      where: { id: event.id, status: event.status },
      data: { status: 'SKIPPED_DIRECTION_DISABLED', lastErrorCategory: 'DIRECTION_DISABLED', processingStartedAt: null },
    });
    return skipped.count === 1;
  }

  private async syncContactEmail(
    event: { id: string; source: string; externalEntityId: string | null },
    attempt: number,
    lease: EntityLeaseIdentity | null,
  ) {
    const sourceEntityId = event.externalEntityId;
    if (!sourceEntityId) throw new Error('REVIEW_REQUIRED');
    const pair = await this.database.contactPair.findUnique({
      where: event.source === 'BITRIX24'
        ? { bitrix24ContactId: sourceEntityId }
        : { moyskladCounterpartyId: sourceEntityId },
      include: { snapshot: true },
    });
    if (!pair || !pair.active || pair.moyskladType !== 'COUNTERPARTY' || !pair.snapshot) {
      throw new Error('REVIEW_REQUIRED');
    }
    // If a pair was added or rebound since key resolution, requeue before any provider reads or writes.
    if (lease && lease.entityKey !== `CONTACT_PAIR:${pair.id}`) throw new EntityMappingChangedError();

    const [bitrixContact, moyskladCounterparty] = await Promise.all([
      this.readBitrixContact(pair.bitrix24ContactId),
      this.readMoyskladCounterparty(pair.moyskladCounterpartyId),
    ]);
    const bitrixEmailField = readSingleBitrixEmail(bitrixContact.EMAIL);
    const bitrixEmail = bitrixEmailField?.email ?? null;
    const moyskladEmail = readEmail(moyskladCounterparty.email);
    if (!bitrixEmail || !moyskladEmail) throw new Error('REVIEW_REQUIRED');

    const snapshot = pair.snapshot;
    const bitrixChanged = bitrixEmail !== snapshot.bitrix24Email;
    const moyskladChanged = moyskladEmail !== snapshot.moyskladEmail;
    const direction = chooseDirection(
      bitrixChanged,
      moyskladChanged,
      bitrixContact.DATE_MODIFY,
      moyskladCounterparty.updated,
    );
    if (!direction) {
      await this.commitWithEntityLease(lease, (tx) => tx.inboundEvent.update({
        where: { id: event.id },
        data: { status: 'UNCHANGED', attempts: attempt, direction: null, snapshotRevision: snapshot.revision },
      }));
      return;
    }

    if (bitrixEmail === moyskladEmail) {
      const now = new Date();
      const newRevision = snapshot.revision + 1;
      await this.commitWithEntityLease(lease, async (tx) => {
        await tx.contactSnapshot.update({
          where: { pairId: pair.id },
          data: {
            bitrix24Email: bitrixEmail,
            moyskladEmail,
            bitrix24UpdatedAt: readTimestamp(bitrixContact.DATE_MODIFY),
            moyskladUpdatedAt: readTimestamp(moyskladCounterparty.updated),
            revision: newRevision,
            lastSuccessfulAt: now,
          },
        });
        return tx.inboundEvent.update({
          where: { id: event.id },
          data: {
            status: 'SUCCEEDED',
            attempts: attempt,
            direction: null,
            snapshotRevision: newRevision,
            lastSuccessfulAt: now,
            lastErrorCategory: null,
          },
        });
      });
      return;
    }

    const value = direction === 'BITRIX24_TO_MOYSKLAD' ? bitrixEmail : moyskladEmail;
    const configuredDirection = direction === 'BITRIX24_TO_MOYSKLAD' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
    if (!await this.syncMode.isDirectionEnabled('contacts-companies', configuredDirection)) {
      await this.commitWithEntityLease(lease, (tx) => tx.inboundEvent.update({
        where: { id: event.id },
        data: { status: 'SKIPPED_DIRECTION_DISABLED', lastErrorCategory: 'DIRECTION_DISABLED', processingStartedAt: null },
      }));
      return;
    }
    if (await this.deferIfModeIsNoLongerOn(event.id)) return;
    await this.assertEntityLockOwner(lease);
    if (direction === 'BITRIX24_TO_MOYSKLAD') {
      const result = await this.writeMoyskladEmail(pair.moyskladCounterpartyId, value);
      if (readEmail(result.email) !== value) throw new Error('EXTERNAL_API_FAILURE');
    } else {
      if (!bitrixEmailField) throw new Error('REVIEW_REQUIRED');
      await this.writeBitrixEmail(pair.bitrix24ContactId, bitrixEmailField, value);
    }

    const now = new Date();
    const bitrixTimestamp = readTimestamp(bitrixContact.DATE_MODIFY);
    const moyskladTimestamp = readTimestamp(moyskladCounterparty.updated);
    const newRevision = snapshot.revision + 1;
    await this.commitWithEntityLease(lease, async (tx) => {
      await tx.contactSnapshot.update({
        where: { pairId: pair.id },
        data: {
          bitrix24Email: value,
          moyskladEmail: value,
          bitrix24UpdatedAt: direction === 'BITRIX24_TO_MOYSKLAD' ? bitrixTimestamp : now,
          moyskladUpdatedAt: direction === 'MOYSKLAD_TO_BITRIX24' ? moyskladTimestamp : now,
          revision: newRevision,
          lastSuccessfulAt: now,
        },
      });
      return tx.inboundEvent.update({
        where: { id: event.id },
        data: {
          status: 'SUCCEEDED',
          attempts: attempt,
          direction,
          snapshotRevision: newRevision,
          lastSuccessfulAt: now,
          lastErrorCategory: null,
        },
      });
    });
  }

  private async readBitrixContact(contactId: string): Promise<JsonRecord> {
    const result = await this.bitrixRequest('crm.contact.get.json', { id: contactId });
    if (!isRecord(result)) throw new Error('EXTERNAL_API_FAILURE');
    return result;
  }

  private async writeBitrixEmail(
    contactId: string,
    currentEmail: { id: string; valueType: string },
    email: string,
  ): Promise<void> {
    await this.bitrixRequest('crm.contact.update.json', {
      id: contactId,
      'fields[EMAIL][0][ID]': currentEmail.id,
      'fields[EMAIL][0][VALUE]': email,
      'fields[EMAIL][0][VALUE_TYPE]': currentEmail.valueType,
    });
  }

  private async bitrixRequest(method: string, fields: Record<string, string>): Promise<unknown> {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new Error('EXTERNAL_API_FAILURE');
    const response = await fetch(new URL(method, ensureTrailingSlash(base)), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('EXTERNAL_API_FAILURE');
    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.error || !('result' in payload)) throw new Error('EXTERNAL_API_FAILURE');
    return payload.result;
  }

  private async readMoyskladCounterparty(counterpartyId: string): Promise<JsonRecord> {
    const response = await this.moyskladRequest(counterpartyId, 'GET');
    if (!isRecord(response)) throw new Error('EXTERNAL_API_FAILURE');
    return response;
  }

  private async writeMoyskladEmail(counterpartyId: string, email: string): Promise<JsonRecord> {
    const response = await this.moyskladRequest(counterpartyId, 'PUT', { email });
    if (!isRecord(response)) throw new Error('EXTERNAL_API_FAILURE');
    return response;
  }

  private async moyskladRequest(counterpartyId: string, method: 'GET' | 'PUT', body?: JsonRecord): Promise<unknown> {
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new Error('EXTERNAL_API_FAILURE');
    const url = new URL(`entity/counterparty/${encodeURIComponent(counterpartyId)}`, ensureTrailingSlash(base));
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('EXTERNAL_API_FAILURE');
    return response.json();
  }
}

@Injectable()
export class ContactSyncStatusReader {
  constructor(private readonly database: DatabaseService) {}

  async read(eventId: string) {
    const event = await this.database.inboundEvent.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        status: true,
        attempts: true,
        direction: true,
        snapshotRevision: true,
        lastSuccessfulAt: true,
        lastErrorCategory: true,
      },
    });
    return event;
  }
}

function isContactEmailEvent(source: string, eventType: string | null, externalEntityType: string | null): boolean {
  return (source === 'BITRIX24' && eventType?.startsWith('ONCRMCONTACT') === true) ||
    (source === 'MOYSKLAD' && eventType === 'UPDATE' && externalEntityType === 'counterparty');
}

function readSingleBitrixEmail(value: unknown): { email: string; id: string; valueType: string } | null {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) return null;
  const email = readEmail(value[0].VALUE);
  const id = readString(value[0].ID);
  const valueType = readString(value[0].VALUE_TYPE);
  return email && id && valueType ? { email, id, valueType } : null;
}

function readEmail(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function readTimestamp(value: unknown): Date {
  const date = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(date.getTime())) throw new Error('REVIEW_REQUIRED');
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

function chooseDirection(
  bitrixChanged: boolean,
  moyskladChanged: boolean,
  bitrixUpdated: unknown,
  moyskladUpdated: unknown,
): 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24' | null {
  if (!bitrixChanged && !moyskladChanged) return null;
  if (bitrixChanged && !moyskladChanged) return 'BITRIX24_TO_MOYSKLAD';
  if (moyskladChanged && !bitrixChanged) return 'MOYSKLAD_TO_BITRIX24';
  return readTimestamp(bitrixUpdated).getTime() > readTimestamp(moyskladUpdated).getTime()
    ? 'BITRIX24_TO_MOYSKLAD'
    : 'MOYSKLAD_TO_BITRIX24';
}

function errorCategory(error: unknown): string {
  return error instanceof Error && error.message === 'REVIEW_REQUIRED'
    ? 'REVIEW_REQUIRED'
    : 'EXTERNAL_API_FAILURE';
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)), RETRY_MAX_DELAY_MS);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'P2002';
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
