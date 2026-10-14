import { randomUUID } from 'node:crypto';
import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from './database.service';
import { assertApplyExternalWrite } from './external-write-guard';
import { SyncModeService } from './sync-mode.service';
import { FieldSettingsService } from './field-settings/field-settings.service';
import { EventWorkerLeaseContext, EventWorkerLeaseService } from './event-worker-lease.service';
import { DryRunWriteJournal } from './dry-run-write-journal';

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
    @Optional() @Inject(FieldSettingsService) private readonly fieldSettings?: FieldSettingsService,
    @Optional() private readonly workerLease?: EventWorkerLeaseService,
    @Optional() private readonly dryWrites?: DryRunWriteJournal,
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
    const timer = setTimeout(() => { void this.process(eventId).catch(() => undefined); }, EVENT_BATCH_DELAY_MS);
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
    if (this.workerLease) return this.workerLease.run(eventId, (workerLease) => this.processWithLease(eventId, workerLease));
    return this.processWithLease(eventId);
  }

  private async processWithLease(eventId: string, workerLease?: EventWorkerLeaseContext) {
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
      await workerLease?.assertOwned();
      if (await this.skipIfDirectionDisabled(candidate, workerLease)) return;
      const latestEventId = await this.coalescePendingEvents(candidate, eventId, workerLease);
      const now = new Date();
      const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
      const claim = await this.commitWithEntityLease(entityKey && lockOwner ? { entityKey, ownerToken: lockOwner } : null, (tx) => tx.inboundEvent.updateMany({
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
      }), workerLease);
      if (claim.count !== 1) return;
      const event = await this.database.inboundEvent.findUnique({ where: { id: latestEventId } });
      if (!event) return;
      if (await this.skipIfDirectionDisabled(event, workerLease)) return;
      const attempt = event.attempts;

      try {
        const pinnedSettings = await this.fieldSettings?.eventConfig(event.id);
        await this.syncContactEmail(event, attempt, entityKey && lockOwner ? { entityKey, ownerToken: lockOwner } : null, pinnedSettings?.config, workerLease);
      } catch (error) {
        if (error instanceof Error && error.message === 'EVENT_WORKER_LEASE_LOST') return;
        if (error instanceof EntityLockLostError) return;
        if (error instanceof EntityMappingChangedError) {
          try {
            await workerLease?.assertOwned();
            await this.commitWithEntityLease(entityKey && lockOwner ? { entityKey, ownerToken: lockOwner } : null, (tx) =>
              tx.inboundEvent.update({
                where: { id: latestEventId },
                data: { status: 'RECEIVED', processingStartedAt: null, lastErrorCategory: null, retryAfter: null },
              }), workerLease);
          } catch (commitError) {
            if (!(commitError instanceof EntityLockLostError)) throw commitError;
          }
          return;
        }
        const category = errorCategory(error);
        try {
          await workerLease?.assertOwned();
          await this.commitWithEntityLease(
            entityKey && lockOwner ? { entityKey, ownerToken: lockOwner } : null,
            async (tx) => {
              if (category === 'REVIEW_REQUIRED') {
                const review = error instanceof ReviewRequiredError ? error : new ReviewRequiredError('UNSPECIFIED_REVIEW_REQUIRED');
                await tx.manualReviewCase.upsert({
                  where: { eventId: event.id },
                  create: {
                    eventId: event.id,
                    source: event.source,
                    eventType: event.eventType,
                    externalEntityId: event.externalEntityId,
                    externalEntityType: event.externalEntityType,
                    reason: review.reason,
                    diagnostic: review.diagnostic,
                  },
                  update: { reason: review.reason, diagnostic: review.diagnostic },
                });
              }
              return tx.inboundEvent.update({
                where: { id: latestEventId },
                data: {
                  status: category === 'REVIEW_REQUIRED' ? 'MANUAL_REVIEW' : 'RETRYABLE_FAILURE',
                  lastErrorCategory: category,
                  retryAfter: category === 'REVIEW_REQUIRED' ? null : retryAfterFrom(error) ?? new Date(Date.now() + retryDelayMs(attempt)),
                },
              });
            }, workerLease,
          );
          await this.commitWithEntityLease(
            entityKey && lockOwner ? { entityKey, ownerToken: lockOwner } : null,
            (tx) => tx.operationalLog.create({
              data: { category: 'ERROR', message: `Sync attempt failed: ${category}`, referenceId: event.id },
            }),
            workerLease,
          );
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
    workerLease?: EventWorkerLeaseContext,
  ): Promise<T> {
    if (!lease && !workerLease) return commit(this.database as unknown as Prisma.TransactionClient);
    return this.database.$transaction(async (transaction) => {
      if (workerLease?.assertOwnedIn) await workerLease.assertOwnedIn(transaction);
      else await workerLease?.assertOwned();
      if (!lease) return commit(transaction);
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
    workerLease?: EventWorkerLeaseContext,
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
      await this.commitWithEntityLease(null, (tx) => tx.inboundEvent.updateMany({
        where: { id: { in: supersededIds }, status: { in: ['RECEIVED', 'RETRYABLE_FAILURE'] } },
        data: { status: 'SUPERSEDED', processingStartedAt: null, lastErrorCategory: null, retryAfter: null },
      }), workerLease);
    }
    return latestEventId;
  }

  private async isApplyEnabled(): Promise<boolean> {
    return (process.env.SYNC_MODE === 'apply' || process.env.SYNC_MODE === 'dry') && (await this.syncMode.read()).mode === 'on';
  }

  private async deferIfModeIsNoLongerOn(eventId: string, workerLease?: EventWorkerLeaseContext): Promise<boolean> {
    if (await this.isApplyEnabled()) return false;
    await this.commitWithEntityLease(null, (tx) => tx.inboundEvent.updateMany({
      where: { id: eventId, status: 'PROCESSING' },
      data: { status: 'RECEIVED', processingStartedAt: null, lastErrorCategory: null },
    }), workerLease);
    return true;
  }

  private async skipIfDirectionDisabled(event: {
    id: string; source: string; eventType: string | null; externalEntityType: string | null; status: string;
  }, workerLease?: EventWorkerLeaseContext): Promise<boolean> {
    const direction = event.source === 'BITRIX24' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
    if (await this.syncMode.isDirectionEnabled('contacts-companies', direction)) return false;
    const skipped = await this.commitWithEntityLease(null, (tx) => tx.inboundEvent.updateMany({
      where: { id: event.id, status: event.status },
      data: { status: 'SKIPPED_DIRECTION_DISABLED', lastErrorCategory: 'DIRECTION_DISABLED', processingStartedAt: null },
    }), workerLease);
    return skipped.count === 1;
  }

  private async syncContactEmail(
    event: { id: string; source: string; externalEntityId: string | null },
    attempt: number,
    lease: EntityLeaseIdentity | null,
    pinnedConfig?: unknown,
    workerLease?: EventWorkerLeaseContext,
  ) {
    const sourceEntityId = event.externalEntityId;
    if (!sourceEntityId) throw new ReviewRequiredError('SOURCE_ENTITY_ID_MISSING');
    const pair = await this.database.contactPair.findUnique({
      where: event.source === 'BITRIX24'
        ? { bitrix24ContactId: sourceEntityId }
        : { moyskladCounterpartyId: sourceEntityId },
      include: { snapshot: true },
    });
    if (!pair) throw new ReviewRequiredError('CONTACT_PAIR_NOT_FOUND');
    if (!pair.active) throw new ReviewRequiredError('CONTACT_PAIR_INACTIVE');
    if (pair.moyskladType !== 'COUNTERPARTY') throw new ReviewRequiredError('UNSUPPORTED_MOYSKLAD_ENTITY_TYPE');
    if (!pair.snapshot) throw new ReviewRequiredError('CONTACT_SNAPSHOT_MISSING', { pairId: pair.id });
    // If a pair was added or rebound since key resolution, requeue before any provider reads or writes.
    if (lease && lease.entityKey !== `CONTACT_PAIR:${pair.id}`) throw new EntityMappingChangedError();

    const [bitrixContact, moyskladCounterparty] = await Promise.all([
      this.readBitrixContact(event.id, pair.bitrix24ContactId),
      this.readMoyskladCounterparty(event.id, pair.moyskladCounterpartyId),
    ]);
    const bitrixEmailField = readSingleBitrixEmail(bitrixContact.EMAIL);
    const bitrixEmail = bitrixEmailField?.email ?? null;
    const moyskladEmail = readEmail(moyskladCounterparty.email);
    if (!bitrixEmail || !moyskladEmail) throw new ReviewRequiredError('SYNC_EMAIL_MISSING', {
      bitrixEmailPresent: Boolean(bitrixEmail),
      moyskladEmailPresent: Boolean(moyskladEmail),
      bitrixEmailFieldCount: Array.isArray(bitrixContact.EMAIL) ? bitrixContact.EMAIL.length : 0,
      snapshotRevision: pair.snapshot.revision,
    });

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
      await workerLease?.assertOwned();
      await this.commitWithEntityLease(lease, (tx) => tx.inboundEvent.update({
        where: { id: event.id },
        data: { status: 'UNCHANGED', attempts: attempt, direction: null, snapshotRevision: snapshot.revision },
      }), workerLease);
      await this.resolveManualReview(event.id, workerLease);
      return;
    }

    if (bitrixEmail === moyskladEmail) {
      const now = new Date();
      const newRevision = snapshot.revision + 1;
      await workerLease?.assertOwned();
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
      }, workerLease);
      await this.resolveManualReview(event.id, workerLease);
      return;
    }

    let value = direction === 'BITRIX24_TO_MOYSKLAD' ? bitrixEmail : moyskladEmail;
    const configuredTransform = this.fieldSettings?.transformField(
      pinnedConfig,
      'contacts',
      direction,
      direction === 'BITRIX24_TO_MOYSKLAD' ? 'email' : 'EMAIL',
      direction === 'BITRIX24_TO_MOYSKLAD' ? { EMAIL: bitrixContact.EMAIL, email: bitrixEmail } : { email: moyskladEmail },
    );
    if (configuredTransform) {
      if (configuredTransform.error || typeof configuredTransform.value !== 'string' || !configuredTransform.value.trim()) {
        throw new ReviewRequiredError('FIELD_TRANSFORM_FAILED', { transform: configuredTransform.transform, snapshotRevision: snapshot.revision });
      }
      value = configuredTransform.value;
    }
    const configuredDirection = direction === 'BITRIX24_TO_MOYSKLAD' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
    if (!await this.syncMode.isDirectionEnabled('contacts-companies', configuredDirection)) {
      await workerLease?.assertOwned();
      await this.commitWithEntityLease(lease, (tx) => tx.inboundEvent.update({
        where: { id: event.id },
        data: { status: 'SKIPPED_DIRECTION_DISABLED', lastErrorCategory: 'DIRECTION_DISABLED', processingStartedAt: null },
      }), workerLease);
      return;
    }
    if (await this.deferIfModeIsNoLongerOn(event.id, workerLease)) return;
    await workerLease?.assertOwned();
    await this.assertEntityLockOwner(lease);
    if (direction === 'BITRIX24_TO_MOYSKLAD') {
      await workerLease?.assertOwned();
      await this.assertEntityLockOwner(lease);
      const result = await this.writeMoyskladEmail(event.id, pair.moyskladCounterpartyId, value);
      if (readEmail(result.email) !== value) throw new Error('EXTERNAL_API_FAILURE');
    } else {
      if (!bitrixEmailField) throw new ReviewRequiredError('BITRIX_EMAIL_FIELD_NOT_WRITABLE', {
        bitrixEmailPresent: Boolean(bitrixEmail),
        moyskladEmailPresent: Boolean(moyskladEmail),
        snapshotRevision: snapshot.revision,
      });
      await workerLease?.assertOwned();
      await this.assertEntityLockOwner(lease);
      await this.writeBitrixEmail(event.id, pair.bitrix24ContactId, bitrixEmailField, value);
    }

    const now = new Date();
    const bitrixTimestamp = readTimestamp(bitrixContact.DATE_MODIFY);
    const moyskladTimestamp = readTimestamp(moyskladCounterparty.updated);
    const newRevision = snapshot.revision + 1;
    await workerLease?.assertOwned();
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
    }, workerLease);
    await this.resolveManualReview(event.id, workerLease);
  }

  private async readBitrixContact(eventId: string, contactId: string): Promise<JsonRecord> {
    const result = await this.bitrixRequest(eventId, 'crm.contact.get.json', { id: contactId });
    if (!isRecord(result)) throw new Error('EXTERNAL_API_FAILURE');
    const proposed = await this.dryWrites?.readback('BITRIX24', 'contact', contactId);
    return proposed?.EMAIL ? { ...result, EMAIL: proposed.EMAIL } : result;
  }

  private async writeBitrixEmail(
    eventId: string,
    contactId: string,
    currentEmail: { id: string; valueType: string },
    email: string,
  ): Promise<void> {
    if (await this.dryWrites?.propose({ eventId, provider: 'BITRIX24', entityType: 'contact', entityId: contactId, operation: 'UPDATE', fields: {
      EMAIL: [{ ID: currentEmail.id, VALUE: email, VALUE_TYPE: currentEmail.valueType }],
    } })) return;
    assertApplyExternalWrite('BITRIX24', 'CONTACT_EMAIL_UPDATE');
    await this.bitrixRequest(eventId, 'crm.contact.update.json', {
      id: contactId,
      'fields[EMAIL][0][ID]': currentEmail.id,
      'fields[EMAIL][0][VALUE]': email,
      'fields[EMAIL][0][VALUE_TYPE]': currentEmail.valueType,
    });
  }

  private async bitrixRequest(eventId: string, method: string, fields: Record<string, string>): Promise<unknown> {
    if (/\.update(?:\.json)?$/i.test(method)) assertApplyExternalWrite('BITRIX24', 'CONTACT_REQUEST');
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new Error('EXTERNAL_API_FAILURE');
    let response: Response;
    try {
      response = await fetch(new URL(method, ensureTrailingSlash(base)), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
        signal: AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      await this.recordApiAttempt(eventId, 'BITRIX24', method.replace(/\.json$/, ''), 'POST', null, false);
      throw error;
    }
    if (!response.ok) {
      await this.recordApiAttempt(eventId, 'BITRIX24', method.replace(/\.json$/, ''), 'POST', response.status, false);
      throw providerFailure(response);
    }
    let payload: unknown;
    try { payload = await response.json(); } catch (error) {
      await this.recordApiAttempt(eventId, 'BITRIX24', method.replace(/\.json$/, ''), 'POST', response.status, false);
      throw error;
    }
    const accepted = acceptsBitrixResponse(method, payload);
    await this.recordApiAttempt(eventId, 'BITRIX24', method.replace(/\.json$/, ''), 'POST', response.status, accepted);
    if (!accepted || !isRecord(payload) || !('result' in payload)) throw new Error('EXTERNAL_API_FAILURE');
    return payload.result;
  }

  private async readMoyskladCounterparty(eventId: string, counterpartyId: string): Promise<JsonRecord> {
    const response = await this.moyskladRequest(eventId, counterpartyId, 'GET', undefined, isMoyskladCounterparty);
    if (!isRecord(response)) throw new Error('EXTERNAL_API_FAILURE');
    return { ...response, ...(await this.dryWrites?.readback('MOYSKLAD', 'counterparty', counterpartyId)) };
  }

  private async writeMoyskladEmail(eventId: string, counterpartyId: string, email: string): Promise<JsonRecord> {
    if (await this.dryWrites?.propose({ eventId, provider: 'MOYSKLAD', entityType: 'counterparty', entityId: counterpartyId, operation: 'UPDATE', fields: { email } })) {
      const current = await this.readMoyskladCounterparty(eventId, counterpartyId);
      return { ...current, email };
    }
    assertApplyExternalWrite('MOYSKLAD', 'CONTACT_EMAIL_UPDATE');
    const response = await this.moyskladRequest(eventId, counterpartyId, 'PUT', { email }, (payload) => isMoyskladCounterparty(payload) && readEmail(payload.email) === email);
    if (!isRecord(response)) throw new Error('EXTERNAL_API_FAILURE');
    return response;
  }

  private async moyskladRequest(eventId: string, counterpartyId: string, method: 'GET' | 'PUT', body?: JsonRecord, accepts: (payload: unknown) => boolean = isRecord): Promise<unknown> {
    if (method !== 'GET') assertApplyExternalWrite('MOYSKLAD', 'CONTACT_REQUEST');
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new Error('EXTERNAL_API_FAILURE');
    const url = new URL(`entity/counterparty/${encodeURIComponent(counterpartyId)}`, ensureTrailingSlash(base));
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      await this.recordApiAttempt(eventId, 'MOYSKLAD', 'entity/counterparty/{id}', method, null, false);
      throw error;
    }
    if (!response.ok) {
      await this.recordApiAttempt(eventId, 'MOYSKLAD', 'entity/counterparty/{id}', method, response.status, false);
      throw providerFailure(response);
    }
    let payload: unknown;
    try { payload = await response.json(); } catch (error) {
      await this.recordApiAttempt(eventId, 'MOYSKLAD', 'entity/counterparty/{id}', method, response.status, false);
      throw error;
    }
    const accepted = accepts(payload);
    await this.recordApiAttempt(eventId, 'MOYSKLAD', 'entity/counterparty/{id}', method, response.status, accepted);
    if (!accepted) throw new Error('EXTERNAL_API_FAILURE');
    return payload;
  }

  private async recordApiAttempt(
    eventId: string,
    provider: string,
    operation: string,
    method: string,
    statusCode: number | null,
    succeeded: boolean,
  ) {
    try {
      await this.database.apiAttempt.create({
        data: { eventId, provider, operation, method, statusCode, succeeded },
      });
    } catch {
      // The history is supplementary and cannot change the external API result.
    }
  }

  private async resolveManualReview(eventId: string, workerLease?: EventWorkerLeaseContext) {
    try {
      await this.commitWithEntityLease(null, (tx) => tx.manualReviewCase.updateMany({
        where: { eventId, status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      }), workerLease);
    } catch {
      // Incident history is separate from event processing; an auxiliary update cannot undo a successful sync.
    }
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
  if (!Number.isFinite(date.getTime())) throw new ReviewRequiredError('SOURCE_MODIFIED_TIMESTAMP_INVALID');
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
  return error instanceof ReviewRequiredError
    ? 'REVIEW_REQUIRED'
    : 'EXTERNAL_API_FAILURE';
}

function acceptsBitrixResponse(method: string, payload: unknown): boolean {
  if (!isRecord(payload) || payload.error || !('result' in payload)) return false;
  if (method.includes('.get.')) {
    return isRecord(payload.result)
      && readString(payload.result.ID) !== null
      && isValidTimestamp(payload.result.DATE_MODIFY);
  }
  return payload.result === true;
}

function isMoyskladCounterparty(payload: unknown): payload is JsonRecord {
  return isRecord(payload) && readString(payload.id) !== null && isValidTimestamp(payload.updated);
}

function isValidTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

class ReviewRequiredError extends Error {
  constructor(readonly reason: string, readonly diagnostic: Record<string, string | number | boolean> = {}) {
    super('REVIEW_REQUIRED');
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)), RETRY_MAX_DELAY_MS);
}

function providerFailure(response: Response): Error & { retryAfterAt?: Date } {
  const error = new Error('EXTERNAL_API_FAILURE') as Error & { retryAfterAt?: Date };
  const value = response.headers.get('retry-after');
  if (value) {
    const seconds = Number(value);
    const timestamp = Number.isFinite(seconds)
      ? Date.now() + Math.max(0, seconds) * 1_000
      : Date.parse(value);
    if (Number.isFinite(timestamp)) error.retryAfterAt = new Date(timestamp);
  }
  return error;
}

function retryAfterFrom(error: unknown): Date | null {
  if (typeof error !== 'object' || error === null || !('retryAfterAt' in error)) return null;
  const value = (error as { retryAfterAt?: unknown }).retryAfterAt;
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'P2002';
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
