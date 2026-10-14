import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { PairResolutionInput, PairResolutionResult, PairResolver, PAIR_RESOLVER } from './pair-resolver';
import { lockEntityPairState } from './pair-db-lock';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { DealOrderBaselineService } from '../deals-orders/deal-order-baseline.service';
import { DealOrderHeaderSyncProcessor } from '../deals-orders/deal-order-header-sync.processor';
import { EventWorkerLeaseContext, EventWorkerLeaseService } from '../event-worker-lease.service';
import { SyncModeService } from '../sync-mode.service';
import { CLIENT_DEPENDENCY_RESOLVER, ClientDependencyResolver } from '../clients/client-dependency-resolver';
import { DryRunDocumentReader } from '../dry-run-document-reader';
import { ProviderFailure, isRetryableFailure, retryAtForFailure } from '../provider-failure';
import { DatabaseRecoveryService } from '../database-recovery.service';
import { writeOperationalLog } from '../monitoring-log';

const logger = new Logger('PairFirstEventProcessor');
const EVENT_LEASE_MS = 60_000;
const RECOVERY_INTERVAL_MS = 1_000;

/**
 * Resolves persisted deal/order webhook events before any sync work can be
 * considered. This temporary intake gate deliberately has no writer: it
 * resolves pair identity only, while downstream baseline readiness belongs to
 * the baseline processor. Unresolved identities are durably held for review.
 */
@Injectable()
export class PairFirstEventProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly active = new Set<string>();
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryScan: Promise<void> | null = null;

  constructor(
    private readonly database: DatabaseService,
    @Inject(PAIR_RESOLVER) private readonly resolver: PairResolver,
    @Optional() private readonly fieldSettings?: FieldSettingsService,
    @Optional() private readonly baseline?: DealOrderBaselineService,
    @Optional() private readonly headerSync?: DealOrderHeaderSyncProcessor,
    @Optional() private readonly workerLease?: EventWorkerLeaseService,
    @Optional() private readonly syncMode?: SyncModeService,
    @Optional() @Inject(CLIENT_DEPENDENCY_RESOLVER) private readonly clientDependencies?: ClientDependencyResolver,
    @Optional() private readonly documentReader?: DryRunDocumentReader,
    @Optional() private readonly databaseRecovery?: DatabaseRecoveryService,
  ) {}

  onApplicationBootstrap() {
    this.requestRecoveryScan();
    this.recoveryTimer = setInterval(() => this.requestRecoveryScan(), RECOVERY_INTERVAL_MS);
    this.recoveryTimer.unref();
  }

  async onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await this.recoveryScan;
  }

  enqueue(eventId: string): void {
    if (this.active.has(eventId)) return;
    this.active.add(eventId);
    void this.process(eventId)
      .catch(() => logger.error(JSON.stringify({ eventId, resolution: 'PAIR_STORE_UNAVAILABLE' })))
      .finally(() => this.active.delete(eventId));
  }

  private requestRecoveryScan() {
    if (this.recoveryScan) return;
    this.recoveryScan = this.resumePendingEvents().catch(() => undefined).finally(() => { this.recoveryScan = null; });
  }

  private async resumePendingEvents() {
    try {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - EVENT_LEASE_MS);
      const pending = await this.database.inboundEvent.findMany({
        where: {
          AND: [
            { OR: [
              { source: 'BITRIX24', eventType: { startsWith: 'ONCRMDEAL' } },
              { source: 'MOYSKLAD', externalEntityType: 'customerorder', eventType: { in: ['CREATE', 'UPDATE', 'DELETE'] } },
            ] },
            { OR: [
              { status: 'RECEIVED' },
              { status: 'RETRYABLE_FAILURE', OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
              { status: 'PROCESSING', OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: staleBefore } }] },
            ] },
          ],
        },
        select: { id: true },
        take: 100,
      });
      for (const event of pending) this.enqueue(event.id);
    } catch {
      // Pending rows remain durable; the next scan retries discovery.
    }
  }

  async process(eventId: string): Promise<PairResolutionResult | null> {
    if (this.workerLease) return this.workerLease.run(eventId, (workerLease) => this.processWithLease(eventId, workerLease));
    return this.processWithLease(eventId);
  }

  private async processWithLease(eventId: string, workerLease?: EventWorkerLeaseContext): Promise<PairResolutionResult | null> {
    // Pairing and synchronization are both deferred while paused or Off. The
    // durable RECEIVED event remains eligible when the service returns On.
    if (this.syncMode && (await this.syncMode.read()).mode !== 'on') return null;
    const event = await this.database.inboundEvent.findUnique({
      where: { id: eventId },
      select: { id: true, source: true, eventType: true, externalEntityType: true, externalEntityId: true, status: true, attempts: true, processingStartedAt: true, retryAfter: true },
    });
    if (!event || !event.externalEntityId || !isDealOrderEvent(event) || !isDue(event.status, event.retryAfter, event.processingStartedAt)) return null;

    if (this.databaseRecovery) {
      const boundary = await this.databaseRecovery.launchBoundary().catch(() => null);
      if (!boundary || !this.documentReader) {
        await this.finishBeforeClaim(event, 'MANUAL_REVIEW', 'LAUNCH_BOUNDARY_GUARD_UNAVAILABLE');
        return null;
      }
      let createdAt: Date | null;
      try {
        createdAt = await this.documentReader.readDealOrderCreationTimestamp(
          event.source === 'BITRIX24' ? 'BITRIX24' : 'MOYSKLAD', event.externalEntityId,
        );
      } catch (error) {
        if (error instanceof ProviderFailure && isRetryableFailure(error)) {
          await this.finishBeforeClaim(event, 'RETRYABLE_FAILURE', 'CREATION_TIMESTAMP_READ_RETRYABLE', retryAtForFailure(error, event.attempts + 1));
        } else {
          await this.finishBeforeClaim(event, 'MANUAL_REVIEW', 'CREATION_TIMESTAMP_UNAVAILABLE');
        }
        return null;
      }
      if (!createdAt) {
        await this.finishBeforeClaim(event, 'MANUAL_REVIEW', 'CREATION_TIMESTAMP_UNAVAILABLE');
        return null;
      }
      if (createdAt.getTime() < boundary.getTime()) {
        await this.finishBeforeClaim(event, 'SKIPPED_PRE_LAUNCH', 'PRE_LAUNCH_DOCUMENT');
        return null;
      }
    }

    const staleBefore = new Date(Date.now() - EVENT_LEASE_MS);
    await workerLease?.assertOwned();
    const claim = await this.database.$transaction(async (transaction) => {
      await assertWorkerFenceInTransaction(workerLease, transaction);
      return transaction.inboundEvent.updateMany({
        where: {
          id: event.id,
          OR: [
            { status: 'RECEIVED' },
            { status: 'RETRYABLE_FAILURE', OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }] },
            { status: 'PROCESSING', OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: staleBefore } }] },
          ],
        },
        data: { status: 'PROCESSING', processingStartedAt: new Date(), attempts: { increment: 1 }, retryAfter: null, lastErrorCategory: null },
      });
    });
    if (claim.count !== 1) return null;

    const input: PairResolutionInput = {
      entityType: 'DEAL',
      sourceSystem: event.source === 'BITRIX24' ? 'BITRIX24' : 'MOYSKLAD',
      externalId: event.externalEntityId,
      eventId: event.id,
    };

    let result: PairResolutionResult;
    try {
      result = await this.resolver.resolve(input);
    } catch {
      result = { status: 'unavailable', reason: 'PAIR_STORE_UNAVAILABLE' };
    }

    if (result.status !== 'confirmed') {
      await workerLease?.assertOwned();
      result = await this.database.$transaction(async (transaction) => {
        await lockEntityPairState(transaction);
        const side = input.sourceSystem === 'BITRIX24' ? 'bitrix24Id' : 'moyskladId';
        const currentPair = await transaction.entityPair.findFirst({
          where: { entityType: input.entityType, [side]: input.externalId, active: true },
        });
        if (currentPair) {
          return {
            status: 'confirmed',
            pair: {
              id: currentPair.id,
              entityType: input.entityType,
              bitrix24Id: currentPair.bitrix24Id,
              moyskladId: currentPair.moyskladId,
              status: currentPair.source === 'MANUAL' ? 'MANUAL' : 'CONFIRMED',
              source: 'PERSISTED',
            },
          };
        }
        const unavailable = result.status === 'unavailable';
        await assertWorkerFenceInTransaction(workerLease, transaction);
        await transaction.inboundEvent.updateMany({
          where: { id: event.id, status: 'PROCESSING' },
          data: unavailable
            ? { status: 'RETRYABLE_FAILURE', lastErrorCategory: 'PAIR_RESOLUTION_UNAVAILABLE', processingStartedAt: null, retryAfter: retryAtForFailure(new Error('PAIR_RESOLUTION_UNAVAILABLE'), event.attempts + 1) }
            : { status: 'MANUAL_REVIEW', lastErrorCategory: 'PAIR_REVIEW_REQUIRED', processingStartedAt: null, retryAfter: null },
        });
        return result;
      });
    }

    if (result.status === 'confirmed' && this.fieldSettings && this.baseline) {
      try {
        await workerLease?.assertOwned();
        if (this.syncMode && (await this.syncMode.read()).mode !== 'on') {
          await this.deferWhileInactive(event.id, workerLease);
          return result;
        }
        const eventConfig = await this.fieldSettings.eventConfig(event.id);
        const attempt = event.attempts + 1;
        const dependencyResult = await this.resolveDocumentDependencies(event, result.pair, workerLease, attempt);
        if (dependencyResult && dependencyResult.status !== 'RESOLVED') {
          await this.finish(
            event.id,
            dependencyResult.status === 'RETRY' ? 'RETRYABLE_FAILURE' : 'MANUAL_REVIEW',
            dependencyResult.reason,
            workerLease,
            dependencyResult.status === 'RETRY' ? dependencyResult.retryAfter ?? retryAtForFailure(new Error(dependencyResult.reason), attempt) : null,
          );
          return result;
        }
        const baseline = await this.baseline.ensureForConfirmedPair({ pair: result.pair, eventId: event.id, eventConfig, attempt });
        if (baseline.status !== 'READY') {
          if (baseline.status === 'DATABASE_FAILURE') {
            // Leave the claimed PROCESSING row untouched. The lease-expiry
            // recovery scan can retry it once PostgreSQL is available again.
            return result;
          } else if (baseline.status === 'RETRYABLE_FAILURE') {
            await this.finish(event.id, 'RETRYABLE_FAILURE', `BASELINE_${baseline.reason}`, workerLease, baseline.retryAfter);
          } else {
            await this.finish(event.id, 'MANUAL_REVIEW', `BASELINE_${baseline.reason}`, workerLease);
          }
        } else if (this.headerSync) {
          if (this.syncMode && (await this.syncMode.read()).mode !== 'on') {
            await this.deferWhileInactive(event.id, workerLease);
            return result;
          }
          const headerResult = await this.headerSync.process({ eventId: event.id, pair: result.pair, eventConfig, baselineId: baseline.baselineId, attempt, assertWorkerLease: workerLease?.assertOwned });
          if (typeof headerResult !== 'string' && headerResult.status === 'RETRYABLE_FAILURE') {
            await this.finish(event.id, 'RETRYABLE_FAILURE', 'DEAL_ORDER_HEADER_RETRY', workerLease, headerResult.retryAfter);
          } else {
            const holdReason = headerHoldReason(headerResult as string);
            if (holdReason) await this.finish(event.id, 'MANUAL_REVIEW', holdReason, workerLease);
            else await this.finish(event.id, headerResult === 'DISABLED' ? 'SKIPPED_DISABLED' : 'SUCCEEDED', headerResult === 'DISABLED' ? 'DEAL_ORDER_HEADER_DISABLED' : null, workerLease);
          }
        } else {
          await this.finish(event.id, 'SUCCEEDED', null, workerLease);
        }
      } catch {
        await this.database.$transaction(async (transaction) => {
          await assertWorkerFenceInTransaction(workerLease, transaction);
          await transaction.inboundEvent.updateMany({
            where: { id: event.id, status: 'PROCESSING' },
            data: { status: 'RETRYABLE_FAILURE', lastErrorCategory: 'BASELINE_SETTINGS_UNAVAILABLE', processingStartedAt: null, retryAfter: retryAtForFailure(new Error('BASELINE_SETTINGS_UNAVAILABLE'), event.attempts + 1) },
          });
        });
      }
    } else {
      await this.finish(event.id, 'SUCCEEDED', null, workerLease);
    }

    logger.log(JSON.stringify({ eventId: event.id, source: event.source, entityType: 'DEAL', resolution: result.status }));
    return result;
  }

  private async resolveDocumentDependencies(
    event: { id: string; source: string },
    pair: Extract<PairResolutionResult, { status: 'confirmed' }>['pair'],
    workerLease?: EventWorkerLeaseContext,
    attempt = 1,
  ) {
    if (!this.clientDependencies || !this.documentReader) return null;
    try {
      await workerLease?.assertOwned();
      const sourceSystem = event.source === 'BITRIX24' ? 'BITRIX24' : 'MOYSKLAD';
      const record = sourceSystem === 'BITRIX24'
        ? await this.documentReader.readBitrix24DealForBaseline(pair.bitrix24Id)
        : await this.documentReader.readMoySkladCustomerOrderForBaseline(pair.moyskladId);
      await workerLease?.assertOwned();
      const dependencies = sourceSystem === 'BITRIX24'
        ? [
            { entity: 'COMPANY' as const, sourceId: idValue(record.COMPANY_ID), primaryCompanySourceId: null },
            { entity: 'CONTACT' as const, sourceId: idValue(record.CONTACT_ID), primaryCompanySourceId: idValue(record.COMPANY_ID) },
          ]
        : [
            { entity: 'COMPANY' as const, sourceId: referenceId(record.agent, 'counterparty'), primaryCompanySourceId: null },
          ];
      for (const dependency of dependencies) {
        if (!dependency.sourceId) continue;
        await workerLease?.assertOwned();
        const resolved = await this.clientDependencies.resolveForDocument({
          eventId: event.id,
          sourceSystem,
          entity: dependency.entity,
          sourceId: dependency.sourceId,
          primaryCompanySourceId: dependency.primaryCompanySourceId,
          attempt,
        }, workerLease);
        await workerLease?.assertOwned();
        if (resolved.status === 'RETRY' || resolved.status === 'REVIEW') return resolved;
      }
      return { status: 'RESOLVED' as const, reason: 'CLIENT_DEPENDENCIES_RESOLVED' };
    } catch (error) {
      if (error instanceof ProviderFailure && !isRetryableFailure(error)) {
        return { status: 'REVIEW' as const, reason: 'CLIENT_DEPENDENCY_READ_REJECTED' };
      }
      return { status: 'RETRY' as const, reason: 'CLIENT_DEPENDENCY_READ_FAILED', retryAfter: retryAtForFailure(error, attempt) };
    }
  }

  private async finish(eventId: string, status: string, reason: string | null, workerLease?: EventWorkerLeaseContext, retryAfter?: Date | null) {
    await this.database.$transaction(async (transaction) => {
      await assertWorkerFenceInTransaction(workerLease, transaction);
      await transaction.inboundEvent.updateMany({
        where: { id: eventId, status: 'PROCESSING' },
        data: { status, lastErrorCategory: reason, processingStartedAt: null, retryAfter: retryAfter ?? null },
      });
    });
  }

  private async finishBeforeClaim(
    event: { id: string; status: string }, status: string, reason: string, retryAfter?: Date | null,
  ) {
    await this.database.inboundEvent.updateMany({
      where: { id: event.id, status: event.status },
      data: { status, lastErrorCategory: reason, processingStartedAt: null, retryAfter: retryAfter ?? null },
    });
    await writeOperationalLog(this.database, status === 'SKIPPED_PRE_LAUNCH' ? 'EVENT' : 'ERROR', reason, event.id);
  }

  private async deferWhileInactive(eventId: string, workerLease?: EventWorkerLeaseContext) {
    await this.database.$transaction(async (transaction) => {
      await assertWorkerFenceInTransaction(workerLease, transaction);
      await transaction.inboundEvent.updateMany({
        where: { id: eventId, status: 'PROCESSING' },
        data: { status: 'RECEIVED', processingStartedAt: null, retryAfter: null, lastErrorCategory: null },
      });
    });
  }
}

function headerHoldReason(result: string): string | null {
  switch (result) {
    case 'UNSUPPORTED': return 'DEAL_ORDER_HEADER_UNSUPPORTED';
    case 'BASELINE_MISSING': return 'DEAL_ORDER_BASELINE_MISSING';
    case 'HOLD_CONFLICT': return 'DEAL_ORDER_HEADER_CONFLICT';
    case 'HOLD_READ_FAILED': return 'DEAL_ORDER_HEADER_READ_FAILED';
    case 'HOLD_WRITE_FAILED': return 'DEAL_ORDER_HEADER_WRITE_FAILED';
    default: return null;
  }
}

function isDealOrderEvent(event: { source: string; eventType: string | null; externalEntityType: string | null }): boolean {
  if (event.source === 'BITRIX24') return event.externalEntityType === 'deal' && /^ONCRMDEAL(?:ADD|UPDATE|DELETE)$/.test(event.eventType ?? '');
  return event.source === 'MOYSKLAD' && event.externalEntityType === 'customerorder' && ['CREATE', 'UPDATE', 'DELETE'].includes(event.eventType ?? '');
}

function isDue(status: string, retryAfter: Date | null, processingStartedAt: Date | null): boolean {
  const now = Date.now();
  return status === 'RECEIVED' ||
    (status === 'RETRYABLE_FAILURE' && (!retryAfter || retryAfter.getTime() <= now)) ||
    (status === 'PROCESSING' && (!processingStartedAt || processingStartedAt.getTime() < now - EVENT_LEASE_MS));
}

function idValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() && value.length <= 200) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function referenceId(value: unknown, expectedType: string): string | null {
  if (!isRecord(value) || !isRecord(value.meta) || value.meta.type !== expectedType) return null;
  const href = value.meta.href;
  if (typeof href !== 'string') return null;
  const match = href.match(new RegExp(`/entity/${expectedType}/([^/?#]+)$`));
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function assertWorkerFenceInTransaction(
  workerLease: EventWorkerLeaseContext | undefined,
  transaction: Parameters<NonNullable<EventWorkerLeaseContext['assertOwnedIn']>>[0],
): Promise<void> {
  if (workerLease?.assertOwnedIn) await workerLease.assertOwnedIn(transaction);
  else await workerLease?.assertOwned();
}
