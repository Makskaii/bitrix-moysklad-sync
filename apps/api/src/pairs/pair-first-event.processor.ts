import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { PairResolutionInput, PairResolutionResult, PairResolver, PAIR_RESOLVER } from './pair-resolver';
import { lockEntityPairState } from './pair-db-lock';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { DealOrderBaselineService } from '../deals-orders/deal-order-baseline.service';
import { DealOrderHeaderSyncProcessor } from '../deals-orders/deal-order-header-sync.processor';
import { EventWorkerLeaseContext, EventWorkerLeaseService } from '../event-worker-lease.service';
import { SyncModeService } from '../sync-mode.service';
import { CLIENT_DEPENDENCY_RESOLVER, ClientDependencyResolver } from '../clients/client-dependency-resolver';
import type { DocumentClientResolution } from '../clients/document-client-contract';
import { DryRunDocumentReader } from '../dry-run-document-reader';
import { ProviderFailure, isRetryableFailure, retryAtForFailure } from '../provider-failure';
import { DatabaseRecoveryService } from '../database-recovery.service';
import { writeOperationalLog } from '../monitoring-log';
import { DealOrderCreationPreparer } from '../deals-orders/deal-order-creation-preparer.service';
import { DealOrderCreateOperationService } from '../deals-orders/deal-order-create-operation.service';
import { DealOrderPositionRuntimeService } from '../deals-orders/deal-order-position-runtime.service';
import { DealOrderFieldRuntimeService } from '../deals-orders/deal-order-field-runtime.service';
import { DealOrderReverseCreateService, DealOrderReverseManualReviewError } from '../deals-orders/deal-order-reverse-create.service';
import { DealOrderTotalReconciliationHandler } from '../deals-orders/deal-order-total-reconciliation';
import { bitrixDocumentTotal, moyskladDocumentTotal, DOCUMENT_TOTAL_UNIT } from '../deals-orders/document-total-snapshot';
import { withDealOrderPairLock } from '../deals-orders/deal-order-pair-lock';
import { DryRunWriteJournal } from '../dry-run-write-journal';
import { assertApplyExternalWrite } from '../external-write-guard';
import { ControlledLiveTestAdmissionService } from '../controlled-live-test-admission.service';
import { ServiceModeNotOnError, serviceModeBoundProvider, withServiceModeOn } from '../service-mode-transaction';
import { productIdentityUserAction } from '../products/document-product-identity';
import { ForwardOrderPairPendingError, ForwardOrderOwnershipConflictError, forwardOrderOwnership } from '../deals-orders/forward-order-origin';

const logger = new Logger('PairFirstEventProcessor');
const EVENT_LEASE_MS = 60_000;
const RECOVERY_INTERVAL_MS = 1_000;

type PairFirstResult = PairResolutionResult & { documentClient?: DocumentClientResolution };
type DocumentDependencyResult =
  | { status: 'RESOLVED'; reason: string; client: DocumentClientResolution }
  | { status: 'RETRY'; reason: string; retryAfter?: Date }
  | { status: 'REVIEW'; reason: string };

/**
 * Resolves persisted deal/order webhook events before any sync work can be
 * considered. Eligible unpaired Bitrix deal ADD/UPDATE events may create one
 * durable customer order; other unresolved identities are held for review.
 */
@Injectable()
export class PairFirstEventProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly active = new Set<string>();
  private readonly documentReader?: DryRunDocumentReader;
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
    @Optional() documentReader?: DryRunDocumentReader,
    @Optional() private readonly databaseRecovery?: DatabaseRecoveryService,
    @Optional() private readonly creationPreparer?: DealOrderCreationPreparer,
    @Optional() private readonly createOperation?: DealOrderCreateOperationService,
    @Optional() private readonly positionRuntime?: DealOrderPositionRuntimeService,
    @Optional() private readonly fieldRuntime?: DealOrderFieldRuntimeService,
    @Optional() private readonly reverseCreate?: DealOrderReverseCreateService,
    @Optional() private readonly totalRuntime?: DealOrderTotalReconciliationHandler,
    @Optional() private readonly dryWrites?: DryRunWriteJournal,
    @Optional() private readonly controlledAdmission?: ControlledLiveTestAdmissionService,
  ) {
    this.documentReader = documentReader ? serviceModeBoundProvider(database, documentReader) : undefined;
  }

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
      const scan = await withServiceModeOn(this.database, async (transaction) => {
        const now = new Date();
        const staleBefore = new Date(now.getTime() - EVENT_LEASE_MS);
        return transaction.inboundEvent.findMany({
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
      });
      if (!scan.enabled) return;
      for (const event of scan.value) this.enqueue(event.id);
    } catch {
      // Pending rows remain durable; the next scan retries discovery.
    }
  }

  async process(eventId: string): Promise<PairFirstResult | null> {
    const execute = async (workerLease?: EventWorkerLeaseContext) => {
      if (!this.controlledAdmission || process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return this.processWithLease(eventId, workerLease);
      const event = await this.database.inboundEvent.findUnique({ where: { id: eventId }, select: { id: true, source: true, eventType: true, externalEntityType: true, externalEntityId: true, status: true } });
      if (!event || !event.externalEntityId || !isDealOrderEvent(event)) return this.processWithLease(eventId, workerLease);
      if (process.env.SYNC_MODE !== 'apply') {
        await this.finishBeforeClaim(event, 'MANUAL_REVIEW', 'CONTROLLED_LIVE_TEST_APPLY_MODE_REQUIRED');
        return null;
      }
      const mode = await withServiceModeOn(this.database, async () => true);
      if (!mode.enabled || (this.syncMode && (await this.syncMode.read()).mode !== 'on')) return null;
      try {
        await this.prepareControlledAdmission(event);
      } catch (error) {
        if (error instanceof ServiceModeNotOnError) return null;
        const retryable = error instanceof ProviderFailure && isRetryableFailure(error);
        await this.finishBeforeClaim(event, retryable ? 'RETRYABLE_FAILURE' : 'MANUAL_REVIEW', retryable ? 'CONTROLLED_LIVE_TEST_SOURCE_READ_RETRYABLE' : 'CONTROLLED_LIVE_TEST_ADMISSION_REQUIRED',
          retryable ? retryAtForFailure(error, 1) : null);
        return null;
      }
      return this.controlledAdmission.runForEvent(eventId, () => this.processWithLease(eventId, workerLease));
    };
    if (this.workerLease) return this.workerLease.run(eventId, execute);
    return execute();
  }

  private async prepareControlledAdmission(event: { id: string; source: string; externalEntityId: string | null }) {
    if (!this.controlledAdmission || !this.documentReader) throw new Error('CONTROLLED_LIVE_TEST_ADMISSION_SERVICE_UNAVAILABLE');
    if (!event.externalEntityId) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_ID_REQUIRED');
    const sourceId = event.externalEntityId;
    const sourceSystem = event.source === 'BITRIX24' ? 'BITRIX24' : 'MOYSKLAD';
    const source = await this.controlledAdmission.withCurrentSourceRead(event.id, sourceSystem, sourceId, 'deal-order',
      () => this.documentReader!.readDealOrderForControlledAdmission(sourceSystem, sourceId));
    if (!source || source.nativeId !== sourceId) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_METADATA_INVALID');
    await this.controlledAdmission.admit(event.id, { entity: 'deal-order', sourceSystem, sourceNativeId: sourceId,
      currentNativeId: source.nativeId, currentName: source.name, sourceCreatedAt: source.createdAt });
  }

  private async processWithLease(eventId: string, workerLease?: EventWorkerLeaseContext): Promise<PairFirstResult | null> {
    const event = await this.database.inboundEvent.findUnique({
      where: { id: eventId },
      select: { id: true, source: true, eventType: true, externalEntityType: true, externalEntityId: true, status: true, attempts: true, processingStartedAt: true, retryAfter: true, lastErrorCategory: true },
    });
    if (!event || !event.externalEntityId || !isDealOrderEvent(event) || !isDue(event.status, event.retryAfter, event.processingStartedAt)) return null;
    const mode = await withServiceModeOn(this.database, async () => true);
    if (!mode.enabled || (this.syncMode && (await this.syncMode.read()).mode !== 'on')) return null;

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
        if (error instanceof ServiceModeNotOnError) return null;
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
    const claim = await withServiceModeOn(this.database, async (transaction) => {
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
    if (!claim.enabled || claim.value.count !== 1) return null;

    const input: PairResolutionInput = {
      entityType: 'DEAL',
      sourceSystem: event.source === 'BITRIX24' ? 'BITRIX24' : 'MOYSKLAD',
      externalId: event.externalEntityId,
      eventId: event.id,
      eventType: event.eventType,
    };

    let result: PairResolutionResult;
    // A native UPDATE can arrive even before CREATE and before its POST
    // response is saved locally. Probe only while an attempted unbound forward
    // journal exists, and trust only its exact native syncId. No marker bypass.
    if (input.sourceSystem === 'MOYSKLAD' && ['CREATE', 'UPDATE'].includes(input.eventType ?? '')) {
      try {
        const paired = await this.database.entityPair.findFirst({ where: { entityType: 'DEAL', moyskladId: input.externalId, active: true }, select: { id: true } });
        const unbound = !paired && await this.database.dealOrderCreateOperation.findFirst({
          where: { status: 'PENDING', attemptedAt: { not: null }, moyskladOrderId: null }, select: { bitrix24DealId: true },
        });
        if (unbound) {
          if (!this.documentReader) throw new ProviderFailure('MOYSKLAD', null);
          const native = await this.documentReader.readMoySkladCustomerOrderForBaseline(input.externalId);
          if (native.id !== input.externalId) throw new ProviderFailure('MOYSKLAD', null);
          const ownership = await forwardOrderOwnership(this.database, input.externalId, native.syncId);
          if (ownership === 'PENDING') {
            await this.deferForForwardOrderPair(event.id, workerLease, event.lastErrorCategory);
            return { status: 'unavailable', reason: 'FORWARD_ORDER_PAIR_PENDING' };
          }
          if (ownership === 'CONFLICT') {
            await this.finish(event.id, 'MANUAL_REVIEW', 'FORWARD_ORDER_OWNERSHIP_CONFLICT', workerLease);
            return null;
          }
        }
      } catch (error) {
        if (error instanceof ServiceModeNotOnError) return null;
        await this.finish(event.id, isRetryableFailure(error) ? 'RETRYABLE_FAILURE' : 'MANUAL_REVIEW', 'FORWARD_ORDER_ORIGIN_READ_FAILED', workerLease,
          isRetryableFailure(error) ? retryAtForFailure(error, event.attempts + 1) : null);
        return null;
      }
    }
    try {
      result = await this.resolver.resolve(input);
    } catch {
      result = { status: 'unavailable', reason: 'PAIR_STORE_UNAVAILABLE' };
    }

    if (result.status === 'unavailable' && result.reason === 'FORWARD_ORDER_PAIR_PENDING') {
      await this.deferForForwardOrderPair(event.id, workerLease, event.lastErrorCategory);
      return result;
    }
    if (result.status === 'unavailable' && result.reason === 'PAIR_CREATE_PENDING') {
      await this.finish(event.id, 'RETRYABLE_FAILURE', 'PAIR_CREATE_PENDING', workerLease,
        retryAtForFailure(new Error('PAIR_CREATE_PENDING'), event.attempts + 1));
      return result;
    }

    let partialDealOrderCreation = false;
    // A post-boundary, unpaired Bitrix deal is eligible to create exactly one
    // customer order. The operation is durable and provider-idempotent; all
    // other unresolved cases retain the ordinary manual-review behavior.
    if (result.status === 'unmatched' && input.sourceSystem === 'BITRIX24' && this.creationPreparer && this.createOperation && this.fieldSettings) {
      if (process.env.SYNC_MODE !== 'apply') {
        await this.finish(event.id, 'SKIPPED_DISABLED', 'DEAL_ORDER_CREATE_REQUIRES_APPLY_MODE', workerLease);
        return null;
      }
      try {
        const config = await this.fieldSettings.eventConfig(event.id);
        const prepared = await this.creationPreparer.prepare({ bitrix24DealId: input.externalId, eventId: event.id, eventConfig: config, attempt: event.attempts + 1 }, workerLease);
        if (prepared.status === 'MANUAL_REVIEW') {
          const operation = await this.createOperation.recordWaiting(input.externalId, config.version, prepared.reason);
          if (operation?.status === 'PENDING' && operation.attemptedAt) {
            // This event may own an uncertain provider write. Preserve the
            // pre-existing recovery path/journal rather than relabel its result.
            await this.finish(event.id, 'RETRYABLE_FAILURE', prepared.reason, workerLease, retryAtForFailure(new Error(prepared.reason), event.attempts + 1));
            return null;
          }
          await this.finishProductIdentityReview(event.id, prepared.reason, prepared.userAction, workerLease);
          return null;
        }
        if (prepared.status === 'WAITING') {
          const operation = await this.createOperation.recordWaiting(input.externalId, config.version, prepared.reason);
          // Only bounded preflight identity reads: never terminalize an
          // uncertain, already-sent order CREATE or change its recovery path.
          if (prepared.productIdentityReadFailure && event.attempts + 1 >= 8 && !(operation?.status === 'PENDING' && operation.attemptedAt)) {
            const reason = 'PRODUCT_UUID_READ_RETRY_LIMIT_EXCEEDED';
            await this.finishProductIdentityReview(event.id, reason, productIdentityUserAction(reason), workerLease);
            return null;
          }
          const inactiveStage = prepared.reason === 'STAGE_NOT_READY';
          const unconfiguredStage = prepared.reason === 'STAGE_NOT_CONFIGURED';
          const invalidOrigin = ['REVERSE_DEAL_ORIGIN_INVALID', 'REVERSE_DEAL_ORIGIN_UNRESOLVED'].includes(prepared.reason);
          await this.finish(event.id, inactiveStage ? 'SUCCEEDED' : unconfiguredStage || invalidOrigin ? 'MANUAL_REVIEW' : 'RETRYABLE_FAILURE',
            inactiveStage ? 'DEAL_ORDER_STAGE_NOT_ENABLED' : prepared.reason, workerLease,
            inactiveStage || unconfiguredStage || invalidOrigin ? null : prepared.retryAfter ?? retryAtForFailure(new Error(prepared.reason), event.attempts + 1));
          return null;
        }
        if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
          const scope = await this.controlledAdmission.scopeForEvent(event.id);
          prepared.input.payload.description = scope.admittedSourceName;
        }
        await workerLease?.assertOwned();
        const creation = await this.createOperation.createAndPair(prepared.input, workerLease ? async () => { await workerLease.assertOwned(); return true; } : undefined);
        partialDealOrderCreation = creation.status === 'PARTIAL';
        result = await this.resolver.resolve(input);
      } catch (error) {
        if (error instanceof ServiceModeNotOnError) return null;
        if (await this.finishForWriteGateError(event.id, error, workerLease)) return null;
        const reason = error instanceof Error ? error.message : 'CUSTOMER_ORDER_CREATE_FAILED';
        await this.finish(event.id, 'RETRYABLE_FAILURE', 'CUSTOMER_ORDER_CREATE_RETRY', workerLease,
          retryAtForFailure(error, event.attempts + 1));
        logger.warn(JSON.stringify({ eventId: event.id, reason, ...(error instanceof ProviderFailure ? { provider: error.provider, status: error.status } : {}) }));
        return null;
      }
    }
    if (result.status === 'unmatched' && input.sourceSystem === 'MOYSKLAD' && event.eventType === 'CREATE' && this.reverseCreate && this.fieldSettings) {
      if (process.env.SYNC_MODE !== 'apply') {
        await this.finish(event.id, 'SKIPPED_DISABLED', 'DEAL_ORDER_CREATE_REQUIRES_APPLY_MODE', workerLease);
        return null;
      }
      try {
        const eventConfig = await this.fieldSettings.eventConfig(event.id);
        const reverseInput = { moyskladOrderId: input.externalId, eventId: event.id, eventConfig, workerLease, assertWorkerLease: workerLease ? async () => { await workerLease.assertOwned(); } : undefined,
          ...(this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled' ? { controlledSyntheticName: (await this.controlledAdmission.scopeForEvent(event.id)).admittedSourceName } : {}) };
        const reverseResult = await this.reverseCreate.createAndPair(reverseInput);
        partialDealOrderCreation = reverseResult.status === 'PARTIAL';
        result = await this.resolver.resolve(input);
      } catch (error) {
        if (error instanceof ServiceModeNotOnError) return null;
        if (await this.finishForWriteGateError(event.id, error, workerLease)) return null;
        const reason = error instanceof Error ? error.message : 'REVERSE_DEAL_CREATE_FAILED';
        if (error instanceof ForwardOrderPairPendingError) {
          await this.deferForForwardOrderPair(event.id, workerLease, event.lastErrorCategory);
        } else if (error instanceof DealOrderReverseManualReviewError || error instanceof ForwardOrderOwnershipConflictError) {
          await this.finish(event.id, 'MANUAL_REVIEW', 'REVERSE_DEAL_CREATE_REVIEW', workerLease);
        } else {
          await this.finish(event.id, 'RETRYABLE_FAILURE', 'REVERSE_DEAL_CREATE_RETRY', workerLease,
            retryAtForFailure(error, event.attempts + 1));
        }
        logger.warn(JSON.stringify({ eventId: event.id, reason, ...(error instanceof ProviderFailure ? { provider: error.provider, status: error.status } : {}) }));
        return null;
      }
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

    let documentClient: DocumentClientResolution | undefined;
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
        documentClient = dependencyResult?.client;
        const baseline = await this.baseline.ensureForConfirmedPair({ pair: result.pair, eventId: event.id, eventConfig, attempt });
        if (baseline.status === 'STALE_PINNED_EVENT') {
          // Preserve the event's immutable historical pin, but never let an
          // older retry overwrite a newer pair baseline or compare snapshots
          // from incompatible semantic projections.
          await this.finish(event.id, 'UNCHANGED', 'SETTINGS_PIN_SUPERSEDED', workerLease);
          return result;
        }
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
        } else if (this.headerSync || this.positionRuntime || this.fieldRuntime) {
          if (this.syncMode && (await this.syncMode.read()).mode !== 'on') {
            await this.deferWhileInactive(event.id, workerLease);
            return result;
          }
          const runtimeInput = { eventId: event.id, pair: result.pair, eventConfig, baselineId: baseline.baselineId, attempt, assertWorkerLease: workerLease?.assertOwned };
          const clientResult = this.headerSync ? await this.headerSync.processClient(runtimeInput) : 'UNSUPPORTED';
          const headerResult = this.headerSync ? await this.headerSync.process(runtimeInput) : 'DISABLED';
          const retryResult = [clientResult, headerResult].find((item) => typeof item !== 'string' && item.status === 'RETRYABLE_FAILURE');
          if (retryResult && typeof retryResult !== 'string') {
            await this.finish(event.id, 'RETRYABLE_FAILURE', 'DEAL_ORDER_RUNTIME_RETRY', workerLease, retryResult.retryAfter);
          } else {
            const holdReason = headerHoldReason(headerResult as string);
            const clientHoldReason = clientHoldReasonFor(clientResult as string);
            const positions = process.env.SYNC_MODE === 'apply' && this.positionRuntime
              ? await this.positionRuntime.process({ pair: result.pair, eventId: event.id, eventConfig, workerLease })
              : { status: 'SYNCED' as const };
            const partialPositionRows = positions.status === 'PARTIAL';
            const fields = process.env.SYNC_MODE === 'apply' && this.fieldRuntime
              ? await this.fieldRuntime.process({ pair: result.pair, eventId: event.id, eventConfig })
              : { status: 'SYNCED' as const, heldRules: 0 };
            const totals = positions.status === 'SYNCED' && !partialDealOrderCreation && process.env.SYNC_MODE === 'apply' && this.totalRuntime
              ? await this.reconcileDealOrderTotal({ pair: result.pair, eventId: event.id, eventSource: event.source as 'BITRIX24' | 'MOYSKLAD', eventConfig, rowValuesChanged: positions.rowValuesChanged === true, assertWorkerLease: workerLease?.assertOwned })
              : { status: 'SYNCED' as const };
            const runtimeHold = [positions, fields, totals].find((item) => item.status === 'MANUAL_REVIEW') as { status: 'MANUAL_REVIEW'; reason: string } | undefined;
            const runtimeRetry = [positions, fields, totals].find((item) => item.status === 'RETRY') as { status: 'RETRY'; reason: string } | undefined;
            const writeGate = runtimeRetry?.reason.match(/^DEAL_ORDER_WRITE_BLOCKED_(PAUSE|OFF|RECOVERY|DIRECTION|LEASE|NOT_APPLY)$/)?.[1];
            if (writeGate === 'PAUSE') await this.deferWhileInactive(event.id, workerLease);
            else if (writeGate === 'OFF') await this.finish(event.id, 'SKIPPED_DISABLED', runtimeRetry!.reason, workerLease);
            else if (writeGate === 'RECOVERY') await this.finish(event.id, 'RETRYABLE_FAILURE', runtimeRetry!.reason, workerLease, retryAtForFailure(new Error(runtimeRetry!.reason), attempt));
            else if (writeGate === 'DIRECTION') await this.finish(event.id, 'MANUAL_REVIEW', runtimeRetry!.reason, workerLease);
            else if (runtimeRetry) await this.finish(event.id, 'RETRYABLE_FAILURE', runtimeRetry.reason, workerLease, retryAtForFailure(new Error(runtimeRetry.reason), attempt));
            else if (clientHoldReason || holdReason || runtimeHold || partialDealOrderCreation || partialPositionRows) await this.finish(event.id, 'MANUAL_REVIEW', clientHoldReason ?? holdReason ?? runtimeHold?.reason ?? (partialPositionRows ? positions.reason : 'DEAL_ORDER_PARTIAL_ROWS'), workerLease);
            else await this.finish(event.id, 'SUCCEEDED', null, workerLease);
          }
        } else {
          await this.finish(event.id, 'SUCCEEDED', null, workerLease);
        }
      } catch (error) {
        if (error instanceof ServiceModeNotOnError) return result;
        if (await this.finishForWriteGateError(event.id, error, workerLease)) return result;
        await this.database.$transaction(async (transaction) => {
          await assertWorkerFenceInTransaction(workerLease, transaction);
          await transaction.inboundEvent.updateMany({
            where: { id: event.id, status: 'PROCESSING' },
            data: { status: 'RETRYABLE_FAILURE', lastErrorCategory: 'BASELINE_SETTINGS_UNAVAILABLE', processingStartedAt: null, retryAfter: retryAtForFailure(new Error('BASELINE_SETTINGS_UNAVAILABLE'), event.attempts + 1) },
          });
        });
      }
    } else {
      await this.finish(event.id, partialDealOrderCreation ? 'MANUAL_REVIEW' : 'SUCCEEDED', partialDealOrderCreation ? 'DEAL_ORDER_PARTIAL_ROWS' : null, workerLease);
    }

    logger.log(JSON.stringify({ eventId: event.id, source: event.source, entityType: 'DEAL', resolution: result.status }));
    return documentClient && result.status === 'confirmed' ? { ...result, documentClient } : result;
  }

  private async reconcileDealOrderTotal(input: {
    pair: Extract<PairResolutionResult, { status: 'confirmed' }>['pair']; eventId: string; eventSource: 'BITRIX24' | 'MOYSKLAD';
    eventConfig: Awaited<ReturnType<FieldSettingsService['eventConfig']>>; rowValuesChanged: boolean;
    assertWorkerLease?: () => Promise<void>;
  }): Promise<{ status: 'SYNCED' } | { status: 'MANUAL_REVIEW'; reason: string } | { status: 'RETRY'; reason: string }> {
    if (!this.totalRuntime || !this.documentReader || input.pair.entityType !== 'DEAL') return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_TOTAL_RUNTIME_UNAVAILABLE' };
    const outcome = await withDealOrderPairLock(this.database, input.pair.id, input.eventId, async (lease) => {
      const baseline = await this.database.entityPairBaseline.findUnique({ where: { pairId: input.pair.id } });
      if (!baseline || baseline.settingsVersion !== input.eventConfig.version) return { status: 'MANUAL_REVIEW' as const, reason: 'DEAL_ORDER_TOTAL_BASELINE_MISSING' };
      const syncState = await this.database.entityPairSyncState.findUnique({ where: { pairId: input.pair.id } });
      const baselineB24 = jsonRecord(baseline.bitrix24Values)['deal-order-total'];
      const baselineMs = jsonRecord(baseline.moyskladValues)['deal-order-total'];
      const stateB24 = jsonRecord(syncState?.bitrix24Values)['deal-order-total'];
      const stateMs = jsonRecord(syncState?.moyskladValues)['deal-order-total'];
      const stateB24Total = totalValue(stateB24); const stateMsTotal = totalValue(stateMs);
      const baselineB24Total = totalValue(baselineB24); const baselineMsTotal = totalValue(baselineMs);
      if (!baselineB24Total || !baselineMsTotal) return { status: 'MANUAL_REVIEW' as const, reason: 'DEAL_ORDER_TOTAL_LEGACY_BASELINE_REVIEW_REQUIRED' };
      const prior = stateB24Total && stateMsTotal ? { settingsVersion: syncState!.settingsVersion, bitrix24: stateB24Total, moysklad: stateMsTotal }
        : baselineB24Total && baselineMsTotal ? { settingsVersion: baseline.settingsVersion, bitrix24: baselineB24Total, moysklad: baselineMsTotal } : null;
      const readCurrent = async () => {
        await input.assertWorkerLease?.();
        const [b24, ms] = await Promise.all([
          this.documentReader!.readBitrix24DealForBaseline(input.pair.bitrix24Id),
          this.documentReader!.readMoySkladCustomerOrderForBaseline(input.pair.moyskladId),
        ]);
        return {
          bitrix24: bitrixDocumentTotal(b24),
          moysklad: moyskladDocumentTotal(ms, input.eventConfig.config),
        };
      };
      const initial = await readCurrent();
      const result = await this.totalRuntime!.process({
        pairId: input.pair.id, eventId: input.eventId, eventSource: input.eventSource, pinnedConfig: { version: input.eventConfig.version },
        bitrix24Current: initial.bitrix24, moyskladCurrent: initial.moysklad, priorBaseline: prior,
        completeRows: true, rowValuesChanged: input.rowValuesChanged,
        adapter: {
          readCurrent,
          writeBitrix24Opportunity: async (amount) => {
            const mutation = async () => {
              await this.syncMode?.assertDealOrderExternalWriteAllowed('moyskladToBitrix24', async () => {
              await input.assertWorkerLease?.(); return lease.assertOwner();
              }, { id: input.pair.id, entityType: 'DEAL' });
              assertApplyExternalWrite('BITRIX24', 'DEAL_ORDER_TOTAL_UPDATE');
              const base = providerBase(process.env.BITRIX24_REST_BASE_URL);
              if (!base || !/^\d{1,20}$/.test(input.pair.bitrix24Id)) throw new Error('DEAL_ORDER_TOTAL_PROVIDER_NOT_CONFIGURED');
              const response = await fetch(new URL('crm.deal.update.json', withSlash(base)), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ id: input.pair.bitrix24Id, 'fields[OPPORTUNITY]': String(amount) }), redirect: 'error', signal: AbortSignal.timeout(10_000) });
              if (!response.ok) throw new Error(`DEAL_ORDER_TOTAL_PROVIDER_HTTP_${response.status}`);
              const body: unknown = await response.json().catch(() => null);
              if (!isRecord(body) || body.error || body.result !== true) throw new Error('DEAL_ORDER_TOTAL_PROVIDER_REJECTED');
            };
            if (this.syncMode) await this.syncMode.runDealOrderExternalWrite('moyskladToBitrix24', async () => {
              await input.assertWorkerLease?.(); return lease.assertOwner();
            }, { id: input.pair.id, entityType: 'DEAL' }, mutation);
            else await mutation();
          },
          persistState: async (state) => {
            const saved = await lease.commit(async (transaction) => {
              const existing = await transaction.entityPairSyncState.findUnique({ where: { pairId: input.pair.id } });
              await transaction.entityPairSyncState.upsert({ where: { pairId: input.pair.id },
                create: { pairId: input.pair.id, settingsVersion: state.settingsVersion, bitrix24Values: { 'deal-order-total': { ...state.bitrix24, amountUnit: DOCUMENT_TOTAL_UNIT } } as Prisma.InputJsonValue, moyskladValues: { 'deal-order-total': { ...state.moysklad, amountUnit: DOCUMENT_TOTAL_UNIT } } as Prisma.InputJsonValue },
                update: { settingsVersion: state.settingsVersion,
                  bitrix24Values: { ...jsonRecord(existing?.bitrix24Values), 'deal-order-total': { ...state.bitrix24, amountUnit: DOCUMENT_TOTAL_UNIT } } as Prisma.InputJsonValue,
                  moyskladValues: { ...jsonRecord(existing?.moyskladValues), 'deal-order-total': { ...state.moysklad, amountUnit: DOCUMENT_TOTAL_UNIT } } as Prisma.InputJsonValue } });
            });
            if (!saved.committed) throw new Error('DEAL_ORDER_TOTAL_PAIR_LOCK_LOST');
          },
          recordHistory: async (history) => writeOperationalLog(this.database, 'EVENT', JSON.stringify({ type: 'DEAL_ORDER_TOTAL', ...history }), input.eventId),
        },
        assertLease: async () => { await input.assertWorkerLease?.(); return lease.assertOwner(); },
      });
      return result.status === 'SYNCED' ? { status: 'SYNCED' as const } : result;
    });
    return outcome ?? { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_BUSY' };
  }

  private async resolveDocumentDependencies(
    event: { id: string; source: string },
    pair: Extract<PairResolutionResult, { status: 'confirmed' }>['pair'],
    workerLease?: EventWorkerLeaseContext,
    attempt = 1,
  ): Promise<DocumentDependencyResult | null> {
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
      const eventSettings = await this.fieldSettings?.eventConfig(event.id);
      const serviceCounterpartyId = typeof eventSettings?.config.serviceCounterpartyId === 'string' ? eventSettings.config.serviceCounterpartyId : null;
      if (sourceSystem === 'BITRIX24' && !dependencies.some((dependency) => dependency.sourceId) && !serviceCounterpartyId) {
        return { status: 'REVIEW' as const, reason: 'SERVICE_COUNTERPARTY_NOT_CONFIGURED' };
      }
      if (sourceSystem === 'BITRIX24' && !dependencies.some((dependency) => dependency.sourceId) && serviceCounterpartyId) {
        if (!this.clientDependencies.verifyServiceCounterparty) return { status: 'RETRY' as const, reason: 'SERVICE_COUNTERPARTY_VALIDATION_UNAVAILABLE' };
        try {
          if (!await this.clientDependencies.verifyServiceCounterparty(serviceCounterpartyId)) {
            return { status: 'REVIEW' as const, reason: 'SERVICE_COUNTERPARTY_INVALID' };
          }
        } catch (error) {
          if (error instanceof ProviderFailure && isRetryableFailure(error)) {
            return { status: 'RETRY' as const, reason: 'SERVICE_COUNTERPARTY_VALIDATION_FAILED', retryAfter: retryAtForFailure(error, attempt) };
          }
          if (isRetryableFailure(error)) return { status: 'RETRY' as const, reason: 'SERVICE_COUNTERPARTY_VALIDATION_FAILED', retryAfter: retryAtForFailure(error, attempt) };
          return { status: 'REVIEW' as const, reason: 'SERVICE_COUNTERPARTY_INVALID' };
        }
        await writeOperationalLog(this.database, 'EVENT', `Document has no client; configured service counterparty ${serviceCounterpartyId} is available.`, event.id);
      }
      let companyPair: import('@prisma/client').EntityPair | null = null;
      let contactPair: import('@prisma/client').EntityPair | null = null;
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
          optionalDependency: dependency.entity === 'CONTACT',
        }, workerLease);
        await workerLease?.assertOwned();
        if ((resolved.status === 'RETRY' || resolved.status === 'REVIEW') && dependency.entity === 'CONTACT') {
          await this.clientDependencies.scheduleOptionalContactRetry({
            eventId: event.id, sourceSystem, entity: 'CONTACT', sourceId: dependency.sourceId,
            primaryCompanySourceId: dependency.primaryCompanySourceId, optionalDependency: true,
          }, resolved.reason, resolved.status === 'RETRY' ? resolved.retryAfter : undefined);
          continue;
        }
        if (resolved.status === 'RETRY' || resolved.status === 'REVIEW') return resolved;
        if (dependency.entity === 'COMPANY' && resolved.status === 'RESOLVED') companyPair = resolved.pair;
        if (dependency.entity === 'CONTACT') {
          if (resolved.status === 'RESOLVED') {
            contactPair = resolved.pair;
            companyPair ??= resolved.companyPair;
          } else if (resolved.status === 'OMITTED') companyPair ??= resolved.companyPair;
        }
      }
      return {
        status: 'RESOLVED' as const,
        reason: 'CLIENT_DEPENDENCIES_RESOLVED',
        client: {
          company: companyPair,
          contact: contactPair,
          serviceCounterpartyId: !companyPair && !contactPair ? serviceCounterpartyId : null,
        },
      };
    } catch (error) {
      if (error instanceof ServiceModeNotOnError) throw error;
      if (error instanceof ProviderFailure && !isRetryableFailure(error)) {
        return { status: 'REVIEW' as const, reason: 'CLIENT_DEPENDENCY_READ_REJECTED' };
      }
      return { status: 'RETRY' as const, reason: 'CLIENT_DEPENDENCY_READ_FAILED', retryAfter: retryAtForFailure(error, attempt) };
    }
  }

  private async finishProductIdentityReview(eventId: string, reason: string, userAction: string, workerLease?: EventWorkerLeaseContext) {
    await withServiceModeOn(this.database, async (transaction) => {
      await assertWorkerFenceInTransaction(workerLease, transaction);
      const event = await transaction.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
      const changed = await transaction.inboundEvent.updateMany({ where: { id: eventId, status: 'PROCESSING' },
        data: { status: 'MANUAL_REVIEW', lastErrorCategory: reason, processingStartedAt: null, retryAfter: null } });
      if (changed.count !== 1) return;
      // Event-specific incident, not an entity PairReviewCase: a corrected
      // source is eligible via a NEW genuine callback without replaying this one.
      const diagnostic = { fieldTitle: 'Товары UUID', userAction, continuation: 'NEW_SOURCE_EVENT_AFTER_CORRECTION' };
      await transaction.manualReviewCase.upsert({ where: { eventId }, create: {
        eventId, source: event.source, eventType: event.eventType, externalEntityType: event.externalEntityType,
        externalEntityId: event.externalEntityId, reason, fieldTitle: 'Товары UUID', diagnostic,
      }, update: { reason, diagnostic } });
      await transaction.operationalLog.create({ data: { category: 'ERROR', referenceId: eventId, message: `${reason}: ${userAction}` } });
    });
  }

  private async deferForForwardOrderPair(eventId: string, workerLease?: EventWorkerLeaseContext, previousReason?: string | null) {
    await withServiceModeOn(this.database, async (transaction) => {
      await assertWorkerFenceInTransaction(workerLease, transaction);
      const deferred = await transaction.inboundEvent.updateMany({ where: { id: eventId, status: 'PROCESSING', attempts: { gt: 0 } }, data: {
        status: 'RETRYABLE_FAILURE', lastErrorCategory: 'FORWARD_ORDER_PAIR_PENDING', processingStartedAt: null,
        retryAfter: new Date(Date.now() + 5_000), attempts: { decrement: 1 },
      } });
      if (deferred.count === 1 && previousReason !== 'FORWARD_ORDER_PAIR_PENDING') await transaction.operationalLog.create({ data: {
        category: 'EVENT', referenceId: eventId, message: JSON.stringify({ type: 'FORWARD_ORDER_ECHO_DEFERRED', eventId, reason: 'FORWARD_ORDER_PAIR_PENDING' }),
      } });
    });
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

  private async finishForWriteGateError(eventId: string, error: unknown, workerLease?: EventWorkerLeaseContext): Promise<boolean> {
    const reason = error instanceof Error ? error.message : '';
    const mode = reason.match(/^DEAL_ORDER_WRITE_BLOCKED_(PAUSE|OFF|RECOVERY|DIRECTION|LEASE|NOT_APPLY)$/)?.[1];
    if (!mode) return false;
    if (mode === 'PAUSE') await this.deferWhileInactive(eventId, workerLease);
    else if (mode === 'OFF') return true;
    else if (mode === 'DIRECTION') await this.finish(eventId, 'MANUAL_REVIEW', reason, workerLease);
    else await this.finish(eventId, 'RETRYABLE_FAILURE', reason, workerLease, retryAtForFailure(new Error(reason), 1));
    return true;
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

function clientHoldReasonFor(result: string): string | null {
  switch (result) {
    case 'BASELINE_INITIALIZED': case 'NOOP': case 'UPDATED': case 'DISABLED': case 'UNSUPPORTED': return null;
    case 'BASELINE_MISSING': return 'DEAL_ORDER_CLIENT_BASELINE_MISSING';
    case 'HOLD_CONFLICT': return 'DEAL_ORDER_CLIENT_CONFLICT';
    case 'HOLD_READ_FAILED': return 'DEAL_ORDER_CLIENT_READ_FAILED';
    case 'HOLD_WRITE_FAILED': return 'DEAL_ORDER_CLIENT_WRITE_FAILED';
    default: return result.startsWith('HOLD_') ? `DEAL_ORDER_CLIENT_${result.slice(5)}` : null;
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
  if (typeof value === 'string' && value.trim() && value.trim() !== '0' && value.length <= 200) return value.trim();
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

function jsonRecord(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function totalValue(value: unknown): { amount: unknown; currencyCode: unknown } | null {
  return isRecord(value) && value.amountUnit === DOCUMENT_TOTAL_UNIT && 'amount' in value && 'currencyCode' in value ? { amount: value.amount, currencyCode: value.currencyCode } : null;
}
function withSlash(url: URL): string { return url.href.endsWith('/') ? url.href : `${url.href}/`; }
function providerBase(value?: string): URL | null {
  try {
    const url = new URL(value ?? '');
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.hash ? url : null;
  } catch { return null; }
}
async function assertWorkerFenceInTransaction(
  workerLease: EventWorkerLeaseContext | undefined,
  transaction: Parameters<NonNullable<EventWorkerLeaseContext['assertOwnedIn']>>[0],
): Promise<void> {
  if (workerLease?.assertOwnedIn) await workerLease.assertOwnedIn(transaction);
  else await workerLease?.assertOwned();
}
