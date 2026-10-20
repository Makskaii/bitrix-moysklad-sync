import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { SyncModeService } from '../sync-mode.service';
import { ClientRecord, ClientSyncGateway } from './client-sync.gateway';
import { chooseCandidate, ClientResolution, ClientRuntimeResolver, ClientSource, ClientSystem } from './client-runtime-resolver';
import { CLIENT_CANDIDATE_GATEWAY, WritableClientCandidateGateway } from './client-candidate.gateway';
import { lockEntityPairState } from '../pairs/pair-db-lock';
import { ClientDependencyInput, ClientDependencyResolution, ClientDependencyResolver } from './client-dependency-resolver';
import { EventWorkerLeaseContext, EventWorkerLeaseService } from '../event-worker-lease.service';
import { ProviderFailure, isRetryableFailure, retryAtForFailure } from '../provider-failure';
import { ClientChildResourceSync, ClientChildResourceSnapshot, syncPinnedClientChildResources } from './client-child-resource-sync';
import { manualReviewFields, sanitizeReviewDiagnosticForStorage } from '../admin/manual-review-details';
import { ControlledLiveTestAdmissionService } from '../controlled-live-test-admission.service';
import { enterControlledLiveEventScope } from '../controlled-live-test-policy';
import { ServiceModeNotOnError, serviceModeBoundProvider, withServiceModeOn } from '../service-mode-transaction';
import { parseClientMoyskladTimestamp } from './client-moysklad-date';

const logger = new Logger('ClientSyncProcessor');
export const CLIENT_SYNC_GATEWAY = Symbol('CLIENT_SYNC_GATEWAY');

type PersistedEvent = {
  id: string; source: string; eventType: string | null; externalEntityType: string | null;
  externalEntityId: string | null; status: string; lastErrorCategory: string | null; attempts: number; processingStartedAt?: Date | null; payload?: unknown;
};
const CLIENT_EVENT_LEASE_MS = 60_000;

/**
 * Pair-first client event processor. It intentionally does not perform fuzzy
 * matching during webhook handling: only an active, persisted EntityPair can
 * authorize reads or writes to either service.
 */
@Injectable()
export class ClientSyncProcessor implements ClientDependencyResolver {
  private readonly active = new Set<string>();
  private readonly gateway?: ClientSyncGateway;
  private readonly candidateGateway?: WritableClientCandidateGateway;
  private readonly childResources?: ClientChildResourceSync;
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: FieldSettingsService,
    private readonly syncMode: SyncModeService,
    @Optional() @Inject(CLIENT_SYNC_GATEWAY) gateway?: ClientSyncGateway,
    @Optional() @Inject(CLIENT_CANDIDATE_GATEWAY) candidateGateway?: WritableClientCandidateGateway,
    @Optional() private readonly workerLease?: EventWorkerLeaseService,
    @Optional() childResources?: ClientChildResourceSync,
    @Optional() private readonly controlledAdmission?: ControlledLiveTestAdmissionService,
  ) {
    this.gateway = gateway ? serviceModeBoundProvider(database, gateway) : undefined;
    this.candidateGateway = candidateGateway ? serviceModeBoundProvider(database, candidateGateway) : undefined;
    this.childResources = childResources;
    childResources?.setProviderModeGate(async (work) => {
      const result = await withServiceModeOn(database, async () => work());
      if (!result.enabled) throw new ServiceModeNotOnError();
      return result.value;
    });
  }

  async verifyServiceCounterparty(counterpartyId: string): Promise<boolean> {
    if (!this.candidateGateway) throw new Error('CLIENT_CANDIDATE_GATEWAY_UNAVAILABLE');
    const record = await this.candidateGateway.readCounterparty(counterpartyId);
    return isRecord(record.meta) && record.meta.type === 'counterparty' && idFromMeta(record) === counterpartyId;
  }

  supports(event: { source?: string; eventType?: string | null; externalEntityType?: string | null }): boolean {
    return Boolean(entityForEvent(event));
  }

  async recoverPending(): Promise<void> {
    const scan = await withServiceModeOn(this.database, async (transaction) => {
      const now = new Date();
      const pending = await transaction.inboundEvent.findMany({
      where: {
        AND: [
          { OR: [
            { source: 'BITRIX24', eventType: { in: ['ONCRMCOMPANYADD', 'ONCRMCOMPANYUPDATE', 'ONCRMCONTACTADD', 'ONCRMCONTACTUPDATE'] } },
            { source: 'MOYSKLAD', eventType: { in: ['CREATE', 'UPDATE'] }, externalEntityType: { in: ['counterparty', 'contactperson'] } },
          ] },
          { OR: [
            { status: 'RECEIVED' },
            { status: 'RETRYABLE_FAILURE', OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
            { status: 'PROCESSING', OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: new Date(now.getTime() - CLIENT_EVENT_LEASE_MS) } }] },
          ] },
        ],
      },
      select: { id: true, status: true },
      take: 100,
      });
      return { now, pending };
    });
    if (!scan.enabled) return;
    const { now, pending } = scan.value;
    for (const event of pending) {
      if (event.status === 'RETRYABLE_FAILURE') {
        const reset = await withServiceModeOn(this.database, (transaction) => transaction.inboundEvent.updateMany({
          where: { id: event.id, status: 'RETRYABLE_FAILURE', OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
          data: { status: 'RECEIVED', retryAfter: null, lastErrorCategory: null },
        }));
        if (!reset.enabled || reset.value.count !== 1) continue;
      }
      this.enqueue(event.id);
    }
    const retryScan = await withServiceModeOn(this.database, async (transaction) => transaction.clientDependencyRetry.findMany({
      where: { OR: [
        { status: 'PENDING', retryAfter: { lte: now } },
        { status: 'RUNNING', updatedAt: { lt: new Date(now.getTime() - CLIENT_EVENT_LEASE_MS) } },
      ] }, orderBy: { retryAfter: 'asc' }, take: 50,
    }));
    if (!retryScan.enabled) return;
    for (const retry of retryScan.value) {
      const claim = await withServiceModeOn(this.database, (transaction) => transaction.clientDependencyRetry.updateMany({
        where: { id: retry.id, status: retry.status, ...(retry.status === 'PENDING' ? { retryAfter: { lte: now } } : { updatedAt: { lt: new Date(now.getTime() - CLIENT_EVENT_LEASE_MS) } }) },
        data: { status: 'RUNNING', attempts: { increment: 1 } },
      }));
      if (!claim.enabled || claim.value.count !== 1) continue;
      const result = await this.resolveForDocument({
        eventId: retry.eventId, sourceSystem: retry.sourceSystem as ClientSystem, entity: 'CONTACT',
        sourceId: retry.sourceEntityId, primaryCompanySourceId: retry.companySourceId || null,
        attempt: retry.attempts + 1, optionalRetry: true, optionalDependency: true,
      });
      const complete = result.status === 'RESOLVED' || result.status === 'OMITTED';
      const nextAttempt = retry.attempts + 1;
      await withServiceModeOn(this.database, (transaction) => transaction.clientDependencyRetry.updateMany({ where: { id: retry.id, status: 'RUNNING' }, data: {
        status: complete ? 'SUCCEEDED' : 'PENDING', reason: result.status === 'RESOLVED' ? result.reason : result.reason,
        retryAfter: complete ? now : result.status === 'RETRY' && result.retryAfter ? result.retryAfter : retryAtForFailure(new Error(result.reason), nextAttempt),
      } }));
    }
  }

  async scheduleOptionalContactRetry(input: ClientDependencyInput, reason: string, retryAfter?: Date): Promise<void> {
    if (input.entity !== 'CONTACT') throw new Error('Only contact document dependencies may be retried independently');
    const companySourceId = input.primaryCompanySourceId ?? '';
    const key = { eventId: input.eventId, sourceSystem: input.sourceSystem, sourceEntityId: input.sourceId, companySourceId };
    const dueAt = retryAfter ?? new Date();
    await withServiceModeOn(this.database, async (transaction) => {
      await transaction.clientDependencyRetry.createMany({ data: [{ ...key, reason, retryAfter: dueAt }], skipDuplicates: true });
      await transaction.clientDependencyRetry.updateMany({ where: { ...key, status: 'PENDING' }, data: { reason, retryAfter: dueAt } });
      await transaction.operationalLog.create({ data: {
        category: 'CLIENT_DEPENDENCY', referenceId: input.eventId,
        message: `Optional contactperson dependency queued for separate retry (${input.sourceSystem} ${input.sourceId}; company ${companySourceId || 'none'}): ${reason}.`,
      } });
    });
  }

  async resolveForDocument(input: ClientDependencyInput, workerLease?: EventWorkerLeaseContext): Promise<ClientDependencyResolution> {
    const event = await this.database.inboundEvent.findUnique({ where: { id: input.eventId } }) as PersistedEvent | null;
    const expectedStatus = workerLease ? 'PROCESSING' : 'RECEIVED';
    if (!event || (!input.optionalRetry && event.status !== expectedStatus) || (input.optionalRetry && !['SUCCEEDED', 'UNCHANGED', 'SKIPPED_DISABLED'].includes(event.status))) return { status: 'REVIEW', reason: 'CLIENT_OWNER_EVENT_NOT_CLAIMED' };
    await workerLease?.assertOwned();
    if ((await this.syncMode.read()).mode !== 'on') return { status: 'RETRY', reason: 'CLIENT_SYNC_MODE_NOT_ON' };
    if (!this.gateway || !this.candidateGateway) return { status: 'RETRY', reason: 'CLIENT_RUNTIME_GATEWAY_UNAVAILABLE' };
    let sourceLease: ClientRuntimeLease | undefined;
    let gateway = this.gateway;
    let candidateGateway = this.candidateGateway;
    let fence: EventWorkerLeaseContext | undefined;

    try {
      sourceLease = await this.acquireRuntimeLease(input.sourceSystem, input.entity, input.sourceId, input.eventId);
      const assertOwned = async () => { await workerLease?.assertOwned(); await sourceLease?.assertOwned(); };
      fence = {
        assertOwned,
        assertOwnedIn: async (transaction: Parameters<NonNullable<EventWorkerLeaseContext['assertOwnedIn']>>[0]) => {
          if (workerLease?.assertOwnedIn) await workerLease.assertOwnedIn(transaction);
          else await workerLease?.assertOwned();
          await sourceLease?.assertOwnedIn(transaction);
        },
      };
      const holdDependency = (reason: string, diagnostic: Record<string, unknown>) => input.optionalDependency
        ? this.optionalDependencyHold(event, reason, diagnostic, fence)
        : this.dependencyHold(event, reason, diagnostic, fence ?? workerLease);
      gateway = leaseProxy(this.gateway, fence);
      candidateGateway = leaseProxy(this.candidateGateway, fence);
      await assertOwned();
      const pinned = await this.settings.eventConfig(input.eventId);
      const unresolvedCreate = await this.database.pairReviewCase.findFirst({
        where: { entityType: input.entity, sourceSystem: input.sourceSystem, sourceEntityId: input.sourceId, status: 'OPEN', reason: 'CLIENT_CREATE_IN_PROGRESS' },
      });
      if (unresolvedCreate) {
        return await holdDependency('CLIENT_CREATE_RESPONSE_UNCERTAIN', { entity: input.entity, sourceId: input.sourceId, pairReviewId: unresolvedCreate.id });
      }
      let selectedSourceId = input.sourceId;
      const sourceParentId = input.sourceSystem === 'MOYSKLAD' && input.entity === 'CONTACT'
        ? input.primaryCompanySourceId ?? parentIdFromEvent(event)
        : null;
      if (input.sourceSystem === 'MOYSKLAD' && input.entity === 'CONTACT' && !sourceParentId) {
        return await holdDependency('CLIENT_CONTACT_SOURCE_PARENT_MISSING', { sourceId: selectedSourceId });
      }
      const sourceRecord = await readSourceRecord(gateway, input.sourceSystem, input.entity, selectedSourceId, sourceParentId);
      const primaryCompanySourceId = input.entity === 'CONTACT'
        ? input.primaryCompanySourceId ?? (input.sourceSystem === 'BITRIX24' ? stringValue(sourceRecord.COMPANY_ID) : sourceParentId)
        : null;
      let companyTargetId: string | null = null;
      let resolvedCompanyPair: Awaited<ReturnType<ClientSyncProcessor['findPersistedPair']>> = null;
      if (primaryCompanySourceId) {
        const companyPair = await this.findPersistedPair('COMPANY', primaryCompanySourceId, input.sourceSystem);
        if (!companyPair) return await holdDependency('CLIENT_CONTACT_PRIMARY_COMPANY_UNRESOLVED', { sourceId: selectedSourceId, companySourceId: input.primaryCompanySourceId });
        companyTargetId = companyPair.moyskladId;
        resolvedCompanyPair = companyPair;
      }
      const savedPairBeforeRead = input.entity === 'CONTACT'
        ? await this.findPersistedPair(input.entity, selectedSourceId, input.sourceSystem, companyTargetId)
        : null;

      if (input.sourceSystem === 'BITRIX24' && input.entity === 'CONTACT' && isMarkedDuplicate(sourceRecord.UF_CRM_1789126649744)) {
        const companyId = input.primaryCompanySourceId ?? stringValue(sourceRecord.COMPANY_ID) ?? null;
        if (!companyId) return await holdDependency('DUPLICATE_CONTACT_WITHOUT_VALID_COMPANY', { sourceId: input.sourceId });
        const companyResolution = await this.resolveForDocument({ ...input, entity: 'COMPANY', sourceId: companyId, primaryCompanySourceId: null }, workerLease);
        if (companyResolution.status !== 'RESOLVED') return { status: 'REVIEW', reason: 'DUPLICATE_CONTACT_COMPANY_UNRESOLVED' };
        const companyPair = companyResolution.pair;
        try { await gateway.readMoysklad('counterparty', companyPair.moyskladId, null); }
        catch (error) {
          if (error instanceof ServiceModeNotOnError) throw error;
          if (isRetryableFailure(error)) return { status: 'RETRY', reason: 'DUPLICATE_CONTACT_COMPANY_TARGET_UNAVAILABLE', retryAfter: retryAtForFailure(error, input.attempt ?? event.attempts) };
          return await holdDependency('DUPLICATE_CONTACT_COMPANY_TARGET_UNAVAILABLE', { companyId, pairId: companyPair.id });
        }
        await this.logDependencyResolution(event.id, input, companyPair, 'DUPLICATE_CONTACT_OMITTED', fence);
        return { status: 'OMITTED', reason: 'DUPLICATE_CONTACT', companyPair };
      }

      if (input.sourceSystem === 'BITRIX24' && input.entity === 'COMPANY' && isMarkedDuplicate(sourceRecord.UF_CRM_1789126724375)) {
        const inn = await candidateGateway.readCompanyInn('BITRIX24', input.sourceId);
        const equivalents = await candidateGateway.unmarkedBitrixCompanyEquivalents({
          id: input.sourceId, name: stringValue(sourceRecord.TITLE), phone: firstValue(sourceRecord.PHONE), inn,
        });
        const eligibleEquivalents = equivalents.filter((candidate) => !candidate.occupiedByPair);
        if (eligibleEquivalents.length) {
          const choice = chooseCandidate(eligibleEquivalents, inn ? 'unmarked_duplicate_company_exact_inn' : 'unmarked_duplicate_company_exact_name_and_phone', 'BITRIX24');
          if (!choice || choice.action === 'MANUAL_REVIEW') {
            const candidates = choice?.action === 'MANUAL_REVIEW' ? choice.candidates : eligibleEquivalents.map((candidate) => candidate.id);
            return await holdDependency('DUPLICATE_COMPANY_CANONICAL_AMBIGUOUS', { sourceId: input.sourceId, candidates });
          }
          if (choice.action === 'USE_CANDIDATE') selectedSourceId = choice.targetId;
        } else if (equivalents.length === 1 && equivalents[0]?.occupiedByPair) {
          // A canonical equivalent with an existing pair is reusable; it is
          // not an unpaired candidate that would steal another relationship.
          selectedSourceId = equivalents[0].id;
        } else if (equivalents.length > 1 && equivalents.every((candidate) => candidate.occupiedByPair)) {
          const choice = chooseCandidate(equivalents.map((candidate) => ({ ...candidate, occupiedByPair: false })), 'unmarked_duplicate_company_existing_pair', 'BITRIX24');
          if (!choice || choice.action === 'MANUAL_REVIEW') {
            const candidates = choice?.action === 'MANUAL_REVIEW' ? choice.candidates : equivalents.map((candidate) => candidate.id);
            return await holdDependency('DUPLICATE_COMPANY_CANONICAL_AMBIGUOUS', { sourceId: input.sourceId, candidates });
          }
          if (choice.action === 'USE_CANDIDATE') selectedSourceId = choice.targetId;
        }
      }

      const pair = savedPairBeforeRead ?? await this.findPersistedPair(input.entity, selectedSourceId, input.sourceSystem, input.entity === 'CONTACT' ? companyTargetId : undefined);
      if (pair) {
        try {
          if (pair.moyskladType !== 'counterparty' && pair.moyskladType !== 'contactperson') {
            return await holdDependency('CLIENT_PERSISTED_PAIR_TYPE_UNKNOWN', { entity: input.entity, selectedSourceId, pairId: pair.id, moyskladType: pair.moyskladType });
          }
          if (input.entity === 'COMPANY' && pair.moyskladType !== 'counterparty') {
            return await holdDependency('CLIENT_PERSISTED_PAIR_TYPE_MISMATCH', { entity: input.entity, selectedSourceId, pairId: pair.id, moyskladType: pair.moyskladType });
          }
          let moyskladRecord: ClientRecord | null = null;
          if (input.sourceSystem === 'BITRIX24') {
            moyskladRecord = await gateway.readMoysklad(pair.moyskladType, pair.moyskladId, pair.moyskladParentId);
          } else await gateway.readBitrix(input.entity, pair.bitrix24Id);
          if (input.entity === 'CONTACT' && pair.moyskladType === 'counterparty') {
            const individual = input.sourceSystem === 'BITRIX24'
              ? stringValue(moyskladRecord?.companyType)?.toLowerCase() === 'individual'
              : stringValue(sourceRecord.companyType)?.toLowerCase() === 'individual';
            if (!individual) return await holdDependency('CLIENT_CONTACT_TARGET_NOT_INDIVIDUAL', { selectedSourceId, pairId: pair.id, moyskladType: pair.moyskladType, companyType: (input.sourceSystem === 'BITRIX24' ? moyskladRecord?.companyType : sourceRecord.companyType) ?? null });
          }
          if (input.entity === 'CONTACT' && pair.moyskladType === 'contactperson') {
            const sourceCompanyId = input.sourceSystem === 'BITRIX24'
              ? input.primaryCompanySourceId ?? stringValue(sourceRecord.COMPANY_ID)
              : idFromMeta(sourceRecord.company) ?? idFromMeta(sourceRecord.agent) ?? input.primaryCompanySourceId ?? sourceParentId;
            const companyPair = sourceCompanyId ? await this.findPersistedPair('COMPANY', sourceCompanyId, input.sourceSystem) : null;
            resolvedCompanyPair = companyPair;
            const actualParentId = input.sourceSystem === 'BITRIX24'
              ? idFromMeta(moyskladRecord?.company) ?? idFromMeta(moyskladRecord?.agent)
              : idFromMeta(sourceRecord.company) ?? idFromMeta(sourceRecord.agent);
            if (!pair.moyskladParentId || !companyPair || pair.moyskladParentId !== companyPair.moyskladId || (actualParentId && actualParentId !== pair.moyskladParentId)) {
              return await holdDependency('CLIENT_CONTACTPERSON_PARENT_MISMATCH', { selectedSourceId, pairId: pair.id, savedParentId: pair.moyskladParentId, expectedParentId: companyPair?.moyskladId ?? null, actualParentId });
            }
          }
          const reason = selectedSourceId === input.sourceId ? 'PERSISTED_PAIR' : 'DUPLICATE_COMPANY_CANONICALIZED';
          await this.logDependencyResolution(event.id, input, pair, reason, fence);
          return { status: 'RESOLVED', pair, companyPair: input.entity === 'COMPANY' ? pair : resolvedCompanyPair, selectedSourceId, reason };
        } catch (error) {
          if (error instanceof ServiceModeNotOnError) throw error;
          if (isRetryableFailure(error)) return { status: 'RETRY', reason: 'CLIENT_PERSISTED_TARGET_UNAVAILABLE', retryAfter: retryAtForFailure(error, input.attempt ?? event.attempts) };
          return await holdDependency('CLIENT_PERSISTED_TARGET_UNAVAILABLE', { entity: input.entity, selectedSourceId, pairId: pair.id });
        }
      }

      const eventForClient: PersistedEvent = {
        ...event,
        externalEntityId: selectedSourceId,
        externalEntityType: input.entity === 'COMPANY'
          ? input.sourceSystem === 'BITRIX24' ? 'company' : 'counterparty'
          : input.sourceSystem === 'BITRIX24' ? 'contact' : input.primaryCompanySourceId ? 'contactperson' : 'counterparty',
      };
      const resolved = await this.resolveUnpaired(eventForClient, input.entity, input.sourceSystem, pinned.config, primaryCompanySourceId, workerLease, fence, input.optionalRetry);
      if (!resolved) return { status: 'REVIEW', reason: 'CLIENT_DEPENDENCY_REQUIRES_REVIEW' };
      const reason = selectedSourceId === input.sourceId ? 'RUNTIME_LOOKUP_OR_CREATE' : 'DUPLICATE_COMPANY_CANONICALIZED';
      await this.logDependencyResolution(event.id, input, resolved, reason, fence);
      resolvedCompanyPair = input.entity === 'COMPANY'
        ? resolved
        : primaryCompanySourceId ? await this.findPersistedPair('COMPANY', primaryCompanySourceId, input.sourceSystem) : null;
      return { status: 'RESOLVED', pair: resolved, companyPair: resolvedCompanyPair, selectedSourceId, reason };
    } catch (error) {
      if (error instanceof ServiceModeNotOnError) throw error;
      if (error instanceof Error && error.message === 'CLIENT_ENTITY_LOCK_BUSY') {
        await workerLease?.assertOwned();
        return { status: 'RETRY', reason: 'CLIENT_ENTITY_LOCK_BUSY', retryAfter: retryAtForFailure(error, input.attempt ?? event.attempts) };
      }
      const unresolvedCreate = await this.database.pairReviewCase.findFirst({
        where: { entityType: input.entity, sourceSystem: input.sourceSystem, sourceEntityId: input.sourceId, status: 'OPEN', reason: 'CLIENT_CREATE_IN_PROGRESS' },
      }).catch(() => null);
      if (unresolvedCreate) {
        const details = { entity: input.entity, sourceId: input.sourceId, pairReviewId: unresolvedCreate.id };
        return input.optionalDependency
          ? await this.optionalDependencyHold(event, 'CLIENT_CREATE_RESPONSE_UNCERTAIN', details, fence ?? workerLease)
          : await this.dependencyHold(event, 'CLIENT_CREATE_RESPONSE_UNCERTAIN', details, fence ?? workerLease);
      }
      if (error instanceof ProviderFailure && !isRetryableFailure(error)) {
        const details = { provider: error.provider, status: error.status, entity: input.entity, sourceId: input.sourceId };
        return input.optionalDependency
          ? await this.optionalDependencyHold(event, 'CLIENT_PROVIDER_REJECTED', details, fence ?? workerLease)
          : await this.dependencyHold(event, 'CLIENT_PROVIDER_REJECTED', details, fence ?? workerLease);
      }
      await this.database.$transaction(async (tx) => {
        await assertFenceInTransaction(fence ?? workerLease, tx);
        if (!workerLease && !input.optionalRetry) await tx.inboundEvent.updateMany({ where: { id: event.id, status: expectedStatus }, data: { status: 'RETRYABLE_FAILURE', lastErrorCategory: 'CLIENT_DEPENDENCY_RETRY', retryAfter: retryAtForFailure(error, input.attempt ?? event.attempts) } });
        await tx.operationalLog.create({ data: { category: 'CLIENT_DEPENDENCY', message: `Document client dependency will retry: ${safeReason(error)}.`, referenceId: event.id } });
      });
      return { status: 'RETRY', reason: safeReason(error), retryAfter: retryAtForFailure(error, input.attempt ?? event.attempts) };
    } finally {
      await sourceLease?.release().catch(() => undefined);
    }
  }

  private async findPersistedPair(entity: 'COMPANY' | 'CONTACT', sourceId: string, sourceSystem: ClientSystem, companyTargetId?: string | null) {
    return this.database.entityPair.findFirst({ where: {
      entityType: entity, active: true,
      ...(sourceSystem === 'BITRIX24' ? { bitrix24Id: sourceId } : { moyskladId: sourceId }),
      ...(entity === 'CONTACT' && companyTargetId !== undefined ? { moyskladParentId: companyTargetId } : {}),
    } });
  }

  private async dependencyHold(event: PersistedEvent, reason: string, diagnostic: Record<string, unknown>, workerLease?: EventWorkerLeaseContext): Promise<ClientDependencyResolution> {
    await workerLease?.assertOwned();
    await this.database.$transaction(async (tx) => {
      await assertFenceInTransaction(workerLease, tx);
      await tx.manualReviewCase.upsert({ where: { eventId: event.id }, create: {
        eventId: event.id, source: event.source, eventType: event.eventType, externalEntityId: event.externalEntityId,
        externalEntityType: event.externalEntityType, reason, diagnostic: sanitizeReviewDiagnosticForStorage(diagnostic) as Prisma.InputJsonValue, ...manualReviewFields(diagnostic),
      }, update: { reason, diagnostic: sanitizeReviewDiagnosticForStorage(diagnostic) as Prisma.InputJsonValue, ...manualReviewFields(diagnostic) } });
      await tx.operationalLog.create({ data: { category: 'CLIENT_DEPENDENCY', message: `Document client dependency held: ${reason}.`, referenceId: event.id } });
      if (event.status === 'RECEIVED') await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'RECEIVED' }, data: { status: 'MANUAL_REVIEW', lastErrorCategory: reason } });
    });
    return { status: 'REVIEW', reason };
  }

  private async optionalDependencyHold(event: PersistedEvent, reason: string, diagnostic: Record<string, unknown>, workerLease?: EventWorkerLeaseContext): Promise<ClientDependencyResolution> {
    await workerLease?.assertOwned();
    await this.database.$transaction(async (tx) => {
      await assertFenceInTransaction(workerLease, tx);
      await tx.operationalLog.create({ data: {
        category: 'CLIENT_DEPENDENCY',
        message: `Optional document contact dependency held for separate retry: ${reason} (${JSON.stringify(diagnostic).slice(0, 300)}).`,
        referenceId: event.id,
      } });
    });
    return { status: 'REVIEW', reason };
  }

  private async skipDuplicateEvent(event: PersistedEvent, reason: string, workerLease?: EventWorkerLeaseContext) {
    await this.database.$transaction(async (tx) => {
      await assertFenceInTransaction(workerLease, tx);
      await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'PROCESSING' }, data: { status: 'SUCCEEDED', processingStartedAt: null, lastErrorCategory: reason, lastSuccessfulAt: new Date() } });
      await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Duplicate client event excluded from ordinary synchronization: ${reason}.`, referenceId: event.id } });
    });
  }

  private async logDependencyResolution(eventId: string, input: ClientDependencyInput, pair: any, reason: string, workerLease?: EventWorkerLeaseContext) {
    await this.database.$transaction(async (tx) => {
      await assertFenceInTransaction(workerLease, tx);
      await tx.operationalLog.create({ data: {
        category: 'CLIENT_DEPENDENCY',
        message: `Document client dependency resolved (${input.entity}; source ${input.sourceId}; selected ${input.sourceSystem === 'BITRIX24' ? pair.bitrix24Id : pair.moyskladId}; pair ${pair.id}; reason ${reason}).`,
        referenceId: eventId,
      } });
    });
  }

  enqueue(eventId: string): void {
    void this.process(eventId).catch((error) => logger.error(JSON.stringify({ eventId, result: 'PROCESSOR_FAILURE', reason: safeReason(error) })));
  }

  async process(eventId: string): Promise<'IGNORED' | 'REVIEW' | 'BASELINE' | 'UNCHANGED' | 'SYNCED' | 'RETRY'> {
    const run = async () => this.workerLease
      ? await this.workerLease.run(eventId, (lease) => this.processWithLease(eventId, lease)) ?? 'IGNORED'
      : this.processWithLease(eventId);
    return this.controlledAdmission ? this.controlledAdmission.runForEvent(eventId, run) : run();
  }

  private async processWithLease(eventId: string, workerLease?: EventWorkerLeaseContext): Promise<'IGNORED' | 'REVIEW' | 'BASELINE' | 'UNCHANGED' | 'SYNCED' | 'RETRY'> {
    if (this.active.has(eventId)) return 'IGNORED';
    const event = await this.database.inboundEvent.findUnique({ where: { id: eventId } }) as PersistedEvent | null;
    if (!event || !this.supports(event) || !(event.status === 'RECEIVED' || (event.status === 'PROCESSING' && (!event.processingStartedAt || event.processingStartedAt.getTime() < Date.now() - CLIENT_EVENT_LEASE_MS)))) return 'IGNORED';
    let entity = entityForEvent(event)!;
    let fence = workerLease;
    let releaseSourceLease: (() => Promise<void>) | undefined;
    let releasePairLease: (() => Promise<void>) | undefined;
    this.active.add(eventId);
    try {
      const claim = await withServiceModeOn(this.database, async (tx) => {
        await assertFenceInTransaction(workerLease, tx);
        return tx.inboundEvent.updateMany({
          where: { id: event.id, OR: [
            { status: 'RECEIVED' },
            { status: 'PROCESSING', OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: new Date(Date.now() - CLIENT_EVENT_LEASE_MS) } }] },
          ] },
          data: { status: 'PROCESSING', processingStartedAt: new Date(), attempts: { increment: 1 }, lastErrorCategory: null, retryAfter: null },
        });
      });
      if (!claim.enabled || claim.value.count !== 1) return 'IGNORED';
      event.status = 'PROCESSING';
      if (event.externalEntityId) {
        const sourceSystem: ClientSystem = event.source === 'BITRIX24' ? 'BITRIX24' : 'MOYSKLAD';
        const sourceLease = await this.acquireRuntimeLease(sourceSystem, entity, event.externalEntityId, event.id);
        releaseSourceLease = () => sourceLease.release();
        fence = {
          assertOwned: async () => { await workerLease?.assertOwned(); await sourceLease.assertOwned(); },
          assertOwnedIn: async (tx) => {
            if (workerLease?.assertOwnedIn) await workerLease.assertOwnedIn(tx);
            else await workerLease?.assertOwned();
            await sourceLease.assertOwnedIn(tx);
          },
        };
      }
      await fence?.assertOwned();
      if (!event.externalEntityId) return await this.hold(event, 'CLIENT_ID_MISSING', {}, fence);
      if ((await this.syncMode.read()).mode !== 'on') return 'IGNORED';
      if (!this.gateway || !this.candidateGateway) return await this.hold(event, 'CLIENT_RUNTIME_GATEWAY_UNAVAILABLE', { source: event.source, entity }, fence);
      const eventConfig = await this.settings.eventConfig(event.id);
      const sourceSystem: ClientSystem = event.source === 'BITRIX24' ? 'BITRIX24' : 'MOYSKLAD';
      let bitrixSourceRecord: ClientRecord | null = null;
      let moyskladSourceRecord: ClientRecord | null = null;
      if (sourceSystem === 'BITRIX24') {
        const read = () => this.gateway!.readBitrix(entity, event.externalEntityId!);
        bitrixSourceRecord = this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled'
          ? await this.controlledAdmission.withCurrentSourceRead(event.id, sourceSystem, event.externalEntityId, `client:${entity}`, read)
          : await read();
        await this.admitControlledSource(event.id, event, entity, sourceSystem, bitrixSourceRecord);
        if (entity === 'COMPANY' && isMarkedDuplicate(bitrixSourceRecord.UF_CRM_1789126724375)) {
          await this.skipDuplicateEvent(event, 'DUPLICATE_COMPANY_EXCLUDED_FROM_ORDINARY_SYNC', fence);
          return 'UNCHANGED';
        }
        if (entity === 'CONTACT' && isMarkedDuplicate(bitrixSourceRecord.UF_CRM_1789126649744)) {
          const companyId = stringValue(bitrixSourceRecord.COMPANY_ID);
          const companyResolution = companyId ? await this.resolveForDocument({ eventId: event.id, sourceSystem, entity: 'COMPANY', sourceId: companyId }, fence) : null;
          if (!companyResolution || companyResolution.status !== 'RESOLVED') return await this.hold(event, 'DUPLICATE_CONTACT_COMPANY_UNRESOLVED', { sourceId: event.externalEntityId, companyId }, fence);
          const companyPair = companyResolution.pair;
          await this.skipDuplicateEvent(event, 'DUPLICATE_CONTACT_OMITTED_COMPANY_RESOLVED', fence);
          return 'UNCHANGED';
        }
      }
      else {
        const parentId = event.externalEntityType === 'contactperson' ? parentIdFromEvent(event) : null;
        const type = event.externalEntityType === 'contactperson' ? 'contactperson' : 'counterparty';
        const sourceEntityHint = type === 'contactperson' ? 'client:CONTACT' : null;
        const read = () => this.gateway!.readMoysklad(type, event.externalEntityId!, parentId);
        moyskladSourceRecord = this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled'
          ? await this.controlledAdmission.withCurrentSourceRead(event.id, sourceSystem, event.externalEntityId, sourceEntityHint, read)
          : await read();
        if (type === 'counterparty' && stringValue(moyskladSourceRecord.companyType)?.toLowerCase() === 'individual') entity = 'CONTACT';
        await this.admitControlledSource(event.id, event, entity, sourceSystem, moyskladSourceRecord);
      }
      if (entity === 'CONTACT' && sourceSystem === 'BITRIX24') {
        const contextPairs = await this.database.entityPair.findMany({
          where: { entityType: 'CONTACT', active: true, bitrix24Id: event.externalEntityId },
          orderBy: [{ moyskladParentId: 'asc' }, { id: 'asc' }],
        });
        if (contextPairs.length) return await this.processContactPairFanout(event, eventConfig, bitrixSourceRecord!, contextPairs, fence);
      }
      if (entity === 'CONTACT' && sourceSystem === 'MOYSKLAD' && event.externalEntityType === 'contactperson' && !parentIdFromEvent(event)) {
        return await this.hold(event, 'CLIENT_CONTACT_SOURCE_PARENT_MISSING', { sourceId: event.externalEntityId }, fence);
      }
      let contactPrimaryCompanySourceId: string | null = null;
      let contactPrimaryCompanyTargetId: string | null = null;
      if (entity === 'CONTACT' && sourceSystem === 'BITRIX24') {
        contactPrimaryCompanySourceId = stringValue(bitrixSourceRecord?.COMPANY_ID);
        if (contactPrimaryCompanySourceId) {
          let companyPair = await this.findPersistedPair('COMPANY', contactPrimaryCompanySourceId, 'BITRIX24');
          if (!companyPair) {
            const resolved = await this.resolveForDocument({ eventId: event.id, sourceSystem, entity: 'COMPANY', sourceId: contactPrimaryCompanySourceId }, fence);
            if (resolved.status === 'RETRY') return await this.retry(event, resolved.reason, resolved.retryAfter, fence);
            if (resolved.status !== 'RESOLVED') return await this.hold(event, 'CLIENT_CONTACT_PRIMARY_COMPANY_UNRESOLVED', { sourceId: event.externalEntityId, companyId: contactPrimaryCompanySourceId }, fence);
            companyPair = resolved.pair;
          }
          contactPrimaryCompanyTargetId = companyPair.moyskladId;
        }
      }
      const contactPairParentId = entity === 'CONTACT'
        ? sourceSystem === 'BITRIX24'
          ? contactPrimaryCompanyTargetId
          : parentIdFromEvent(event)
        : undefined;
      let pair = await this.database.entityPair.findFirst({
        where: { entityType: entity, active: true, ...(event.source === 'BITRIX24' ? { bitrix24Id: event.externalEntityId } : { moyskladId: event.externalEntityId }),
          ...(entity === 'CONTACT' ? { moyskladParentId: contactPairParentId ?? null } : {}) },
      });
      if (!pair && sourceSystem === 'MOYSKLAD' && event.externalEntityType === 'counterparty') {
        if (stringValue(moyskladSourceRecord?.companyType)?.toLowerCase() === 'individual') entity = 'CONTACT';
      }
      if (!pair) pair = await this.resolveUnpaired(event, entity, sourceSystem, eventConfig.config, contactPrimaryCompanySourceId, fence);
      if (!pair) return 'REVIEW';
      const parentFence = fence;
      const pairLease = await this.acquireRuntimeLease('BITRIX24', entity, `pair:${pair.id}`, event.id);
      releasePairLease = () => pairLease.release();
      fence = {
        assertOwned: async () => { await parentFence?.assertOwned(); await pairLease.assertOwned(); },
        assertOwnedIn: async (tx) => {
          if (parentFence?.assertOwnedIn) await parentFence.assertOwnedIn(tx); else await parentFence?.assertOwned();
          await pairLease.assertOwnedIn(tx);
        },
      };

      const config = eventConfig;
      const bitrixEntity = entity === 'COMPANY' ? 'COMPANY' : 'CONTACT';
      const msType = pair.moyskladType === 'contactperson' ? 'contactperson' : 'counterparty';
      let [bitrix, moysklad] = await Promise.all([
        this.gateway.readBitrix(bitrixEntity, pair.bitrix24Id),
        this.gateway.readMoysklad(msType, pair.moyskladId, pair.moyskladParentId),
      ]);
      if (entity === 'COMPANY') {
        try {
          const [bitrixInn, moyskladInn] = await Promise.all([
            this.candidateGateway.readCompanyInn('BITRIX24', pair.bitrix24Id),
            Promise.resolve(stringValue(moysklad.inn)),
          ]);
          if (bitrixInn && moyskladInn && bitrixInn !== moyskladInn) {
            await this.database.$transaction(async (tx) => {
              await assertFenceInTransaction(fence, tx);
              await tx.operationalLog.create({ data: {
                category: 'CLIENT_SYNC',
                message: `Saved company pair ${pair.id} has an INN mismatch; the persisted pair remains authoritative.`,
                referenceId: event.id,
              } });
            });
          }
        } catch { /* INN diagnostics must never redirect or block a saved pair. */ }
      }
      const mappingEntity = entity === 'COMPANY' ? 'companies' : 'contacts-companies';
      const rules = Array.isArray(config.config.rules) ? config.config.rules : [];
      const applicable = rules.filter((rule: any) => rule?.entity === mappingEntity && typeof rule.sourceField === 'string' && typeof rule.targetField === 'string');
      const groups = Array.isArray(config.config.groups) ? config.config.groups.filter((group: any) => group?.entity === mappingEntity) : [];
      let prior = await this.database.entityPairSyncState.findUnique({ where: { pairId: pair.id } });
      if (prior) {
        const revision = await this.rebaseClientSettings({ pair, event, eventConfig: config, mappingEntity, bitrixEntity, msType, bitrix, moysklad, state: prior, fence });
        if (revision.status === 'RETRY') throw new Error(revision.reason);
        if (revision.status === 'MANUAL_REVIEW') return await this.hold(event, revision.reason, { pairId: pair.id }, fence);
        if (revision.status === 'STALE_PINNED_EVENT') {
          await this.database.$transaction(async (tx) => {
            await assertFenceInTransaction(fence, tx);
            await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'PROCESSING' }, data: { status: 'UNCHANGED', processingStartedAt: null, direction: null, lastSuccessfulAt: new Date(), lastErrorCategory: 'STALE_PINNED_CLIENT_SETTINGS' } });
            await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Older pinned client settings ${config.version} skipped for pair ${pair.id}; version ${revision.currentVersion} is already active or has a prepared revision.`, referenceId: event.id } });
          });
          return 'UNCHANGED';
        }
        prior = revision.state;
        if (revision.rebased) {
          [bitrix, moysklad] = await Promise.all([
            this.gateway.readBitrix(bitrixEntity, pair.bitrix24Id),
            this.gateway.readMoysklad(msType, pair.moyskladId, pair.moyskladParentId),
          ]);
        }
      }
      const current = { bitrix24Values: selectFields(bitrix, applicable, groups, 'BITRIX24'), moyskladValues: selectFields(moysklad, applicable, groups, 'MOYSKLAD') };
      let childResourceState = prior?.childResourceState ?? null;
      let childResourceFields: string[] = [];
      let childResourceChanged = false;
      if (entity === 'COMPANY' && Array.isArray(config.config.childResourceBindings) && config.config.childResourceBindings.length) {
        if (!this.childResources) return await this.hold(event, 'CLIENT_CHILD_RESOURCE_ADAPTER_UNAVAILABLE', { pairId: pair.id }, fence);
        const childSync = await syncPinnedClientChildResources({
          adapter: this.childResources, settings: this.settings, eventId: event.id, direction: event.source === 'BITRIX24' ? 'BITRIX24_TO_MOYSKLAD' : 'MOYSKLAD_TO_BITRIX24',
          bitrix24CompanyId: pair.bitrix24Id, moyskladCounterpartyId: pair.moyskladId,
          prior: childResourceState as ClientChildResourceSnapshot | null,
          fallbackMatch: pair.reason?.includes('exact_name_and_phone') ? 'exact_name_and_phone' : undefined,
          assertLease: fence.assertOwned,
        });
        if (childSync.result.status === 'MANUAL_REVIEW') return await this.hold(event, childSync.result.reason, { pairId: pair.id, bindingId: childSync.result.bindingId ?? null }, fence);
        childResourceState = childSync.result.state as unknown as Prisma.JsonValue;
        childResourceFields = childSync.result.fields;
        childResourceChanged = childSync.result.status === 'SYNCED' || childSync.result.status === 'JOURNALED';
      }

      // First read establishes a comparison point, never a bulk write.
      if (!prior) {
        await this.database.$transaction(async (tx) => {
          await assertFenceInTransaction(fence, tx);
          await tx.entityPairBaseline.upsert({ where: { pairId: pair.id }, create: {
            pairId: pair.id, eventId: event.id, settingsVersion: config.version,
            bitrix24Values: current.bitrix24Values as Prisma.InputJsonValue, moyskladValues: current.moyskladValues as Prisma.InputJsonValue,
          }, update: {} });
          await tx.entityPairSyncState.create({ data: { pairId: pair.id, settingsVersion: config.version, bitrix24Values: current.bitrix24Values as Prisma.InputJsonValue, moyskladValues: current.moyskladValues as Prisma.InputJsonValue, ...(childResourceState ? { childResourceState: childResourceState as Prisma.InputJsonValue } : {}) } });
          await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'PROCESSING' }, data: { status: 'UNCHANGED', processingStartedAt: null, direction: null, lastSuccessfulAt: new Date(), lastErrorCategory: null } });
          await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Initial client baseline captured; no fields written (pair ${pair.id}).`, referenceId: event.id } });
        });
        return 'BASELINE';
      }

      const direction = event.source === 'BITRIX24' ? 'BITRIX24_TO_MOYSKLAD' : 'MOYSKLAD_TO_BITRIX24';
      const protectEmptyFallbackInn = entity === 'COMPANY' && direction === 'BITRIX24_TO_MOYSKLAD'
        && pair.reason?.includes('exact_name_and_phone') === true && !stringValue(moysklad.inn);
      const writes = buildWrites(config.config, mappingEntity, direction, bitrix, moysklad, prior, applicable, this.settings, protectEmptyFallbackInn);
      if (writes.criticalClears.length) {
        const clear = writes.criticalClears[0]!;
        return this.hold(event, 'CRITICAL_FIELD_CLEAR_REVIEW', {
          pairId: pair.id, fieldTitle: clear.fieldTitle, previousValue: clear.previousValue,
          proposedValue: clear.restoreValue, sourceProposedValue: clear.sourceProposedValue,
          proposedValueMeaning: 'RESTORE_PREVIOUS_VALUE', criticalClears: writes.criticalClears,
        });
      }
      if (writes.ambiguous) return this.hold(event, writes.ambiguous, { pairId: pair.id });
      if (Object.keys(writes.moysklad).length) { await fence?.assertOwned(); await this.gateway.updateMoysklad(msType, pair.moyskladId, pair.moyskladParentId, writes.moysklad, event.id); }
      if (Object.keys(writes.bitrix24).length) { await fence?.assertOwned(); await this.gateway.updateBitrix(bitrixEntity, pair.bitrix24Id, writes.bitrix24, event.id); }
      const [afterBitrix, afterMoysklad] = await Promise.all([
        this.gateway.readBitrix(bitrixEntity, pair.bitrix24Id),
        this.gateway.readMoysklad(msType, pair.moyskladId, pair.moyskladParentId),
      ]);
      const confirmed = { bitrix24Values: selectFields(afterBitrix, applicable, groups, 'BITRIX24'), moyskladValues: selectFields(afterMoysklad, applicable, groups, 'MOYSKLAD') };
      if (!matchesWrittenFields(writes.bitrix24, confirmed.bitrix24Values) || !matchesWrittenFields(writes.moysklad, confirmed.moyskladValues)) {
        // A successful write response is not enough to advance the durable
        // baseline. Leave the event retryable; the next attempt starts with
        // fresh reads and will only reissue a write if the target is still stale.
        throw new ProviderFailure(Object.keys(writes.moysklad).length ? 'MOYSKLAD' : 'BITRIX24', null);
      }
      await this.database.$transaction(async (tx) => {
        await assertFenceInTransaction(fence, tx);
        await tx.entityPairSyncState.update({ where: { pairId: pair.id }, data: { settingsVersion: config.version, bitrix24Values: confirmed.bitrix24Values as Prisma.InputJsonValue, moyskladValues: confirmed.moyskladValues as Prisma.InputJsonValue, ...(childResourceState ? { childResourceState: childResourceState as Prisma.InputJsonValue } : {}) } });
        await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'PROCESSING' }, data: { status: 'SUCCEEDED', processingStartedAt: null, direction, lastSuccessfulAt: new Date(), lastErrorCategory: null } });
        const updatedFields = [...Object.keys(writes.moysklad), ...Object.keys(writes.bitrix24), ...childResourceFields];
        await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: updatedFields.length ? `Configured fields synchronized (MoySklad wins conflicts): ${updatedFields.join(', ')} (pair ${pair.id}).` : `No configured field changes to synchronize (pair ${pair.id}).`, referenceId: event.id } });
      });
      return Object.keys(writes.moysklad).length || Object.keys(writes.bitrix24).length || childResourceChanged ? 'SYNCED' : 'UNCHANGED';
    } catch (error) {
      if (error instanceof ServiceModeNotOnError) return 'IGNORED';
      const retryable = isRetryableFailure(error);
      const reason = error instanceof ProviderFailure && !retryable ? 'CLIENT_PROVIDER_REJECTED' : 'CLIENT_SYNC_FAILURE';
      await this.database.$transaction(async (tx) => {
        await assertFenceInTransaction(fence, tx);
        if (!retryable) await tx.manualReviewCase.upsert({
          where: { eventId: event.id },
          create: { eventId: event.id, source: event.source, eventType: event.eventType, externalEntityId: event.externalEntityId, externalEntityType: event.externalEntityType, reason },
          update: { reason },
        });
        const dueAt = retryAtForFailure(error, event.attempts + 1);
        await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'PROCESSING' }, data: { status: retryable ? 'RETRYABLE_FAILURE' : 'MANUAL_REVIEW', processingStartedAt: null, lastErrorCategory: reason, retryAfter: retryable ? dueAt : null } });
        await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Client sync held for retry: ${safeReason(error)}.`, referenceId: event.id } });
      }).catch(() => undefined);
      return 'RETRY';
    } finally {
      await releasePairLease?.().catch(() => undefined);
      await releaseSourceLease?.().catch(() => undefined);
      this.active.delete(eventId);
    }
  }

  private async admitControlledSource(eventId: string, _event: PersistedEvent, entity: 'COMPANY' | 'CONTACT', sourceSystem: ClientSystem, record: ClientRecord): Promise<void> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    if (!this.controlledAdmission) throw new Error('CONTROLLED_LIVE_TEST_ADMISSION_SERVICE_UNAVAILABLE');
    const currentName = controlledClientName(entity, record);
    const createdValue = sourceSystem === 'BITRIX24' ? record.DATE_CREATE : record.created;
    const sourceCreatedAt = createdValue instanceof Date ? createdValue : new Date(String(createdValue ?? ''));
    if (!currentName || !Number.isFinite(sourceCreatedAt.getTime())) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_READBACK_INVALID');
    await this.controlledAdmission.admit(eventId, { entity: `client:${entity}`, sourceSystem, sourceNativeId: String(_event.externalEntityId),
      currentNativeId: String(record.ID ?? record.id ?? ''), currentName, sourceCreatedAt });
    enterControlledLiveEventScope(await this.controlledAdmission.scopeForEvent(eventId));
  }

  private async rebaseClientSettings(input: {
    pair: Prisma.EntityPairGetPayload<Record<string, never>>;
    event: PersistedEvent;
    eventConfig: Awaited<ReturnType<FieldSettingsService['eventConfig']>>;
    mappingEntity: string;
    bitrixEntity: 'COMPANY' | 'CONTACT';
    msType: 'counterparty' | 'contactperson';
    bitrix: ClientRecord;
    moysklad: ClientRecord;
    state: Prisma.EntityPairSyncStateGetPayload<Record<string, never>>;
    fence?: EventWorkerLeaseContext;
  }): Promise<
    | { status: 'READY'; state: Prisma.EntityPairSyncStateGetPayload<Record<string, never>>; rebased: boolean }
    | { status: 'STALE_PINNED_EVENT'; currentVersion: number }
    | { status: 'RETRY'; reason: string }
    | { status: 'MANUAL_REVIEW'; reason: string }
  > {
    const baseline = await this.database.entityPairBaseline.findUnique({ where: { pairId: input.pair.id } });
    if (!baseline) return { status: 'MANUAL_REVIEW', reason: 'CLIENT_SETTINGS_BASELINE_MISSING' };
    if (input.eventConfig.version < baseline.settingsVersion) return { status: 'STALE_PINNED_EVENT', currentVersion: baseline.settingsVersion };
    const prepared = await this.database.entityPairSettingsRevision.findFirst({
      where: { pairId: input.pair.id, toSettingsVersion: { gt: input.eventConfig.version }, status: 'PREPARED' },
      orderBy: { toSettingsVersion: 'desc' }, select: { toSettingsVersion: true },
    });
    if (prepared) return { status: 'STALE_PINNED_EVENT', currentVersion: prepared.toSettingsVersion };
    if (input.eventConfig.version === baseline.settingsVersion) {
      if (input.state.settingsVersion !== baseline.settingsVersion) return { status: 'MANUAL_REVIEW', reason: 'CLIENT_SETTINGS_STATE_VERSION_MISMATCH' };
      return { status: 'READY', state: input.state, rebased: false };
    }
    if (input.state.settingsVersion !== baseline.settingsVersion) return { status: 'MANUAL_REVIEW', reason: 'CLIENT_SETTINGS_STATE_VERSION_MISMATCH' };

    const oldSettings = await this.settings.version(baseline.settingsVersion).catch(() => null);
    if (!oldSettings) return { status: 'MANUAL_REVIEW', reason: 'CLIENT_SETTINGS_PREVIOUS_VERSION_UNAVAILABLE' };
    const oldProjection = semanticClientSettings(oldSettings.config, input.mappingEntity);
    const newProjection = semanticClientSettings(input.eventConfig.config, input.mappingEntity);
    const fingerprint = createHash('sha256').update(stableClientJson(newProjection)).digest('hex');
    const previousBaseline = {
      settingsVersion: baseline.settingsVersion,
      bitrix24Values: baseline.bitrix24Values,
      moyskladValues: baseline.moyskladValues,
      syncState: { bitrix24Values: input.state.bitrix24Values, moyskladValues: input.state.moyskladValues, childResourceState: input.state.childResourceState },
    } as Prisma.InputJsonValue;
    try {
      await this.database.entityPairSettingsRevision.upsert({
        where: { pairId_toSettingsVersion: { pairId: input.pair.id, toSettingsVersion: input.eventConfig.version } },
        create: { pairId: input.pair.id, fromSettingsVersion: baseline.settingsVersion, toSettingsVersion: input.eventConfig.version, status: 'PREPARED', semanticFingerprint: fingerprint, previousBaseline },
        update: { fromSettingsVersion: baseline.settingsVersion, status: 'PREPARED', semanticFingerprint: fingerprint, previousBaseline, currentBaseline: Prisma.DbNull, errorCategory: null },
      });
    } catch { return { status: 'RETRY', reason: 'CLIENT_SETTINGS_REVISION_PREPARE_FAILED' }; }

    const oldRuleKeys = new Set(oldProjection.rules.map(stableClientJson));
    const oldGroupKeys = new Set(oldProjection.groups.map(stableClientJson));
    const changedRules = newProjection.rules.filter((rule) => !oldRuleKeys.has(stableClientJson(rule)));
    const changedGroups = newProjection.groups.filter((group) => !oldGroupKeys.has(stableClientJson(group)));
    const oldChildBindings = new Set(oldProjection.childResourceBindings.map(stableClientJson));
    const changedChildBindings = newProjection.childResourceBindings.filter((binding) => !oldChildBindings.has(stableClientJson(binding)));
    let revisedChildState = input.state.childResourceState;
    if (changedChildBindings.length) {
      const applicable = changedChildBindings.filter((binding) => isRecord(binding) && binding.bitrix24CompanyId === input.pair.bitrix24Id && binding.moyskladCounterpartyId === input.pair.moyskladId);
      if (applicable.length !== 1 || !this.childResources || input.mappingEntity !== 'companies') {
        const bindingIds = changedChildBindings.map((binding) => isRecord(binding) ? String(binding.id ?? 'unknown') : 'unknown').join(',');
        const reason = `CLIENT_SETTINGS_REVISION_CHILD_BINDING_REQUIRES_REVIEW:${bindingIds}`;
        await this.database.entityPairSettingsRevision.updateMany({ where: { pairId: input.pair.id, toSettingsVersion: input.eventConfig.version, status: 'PREPARED' }, data: { status: 'FAILED', errorCategory: reason } }).catch(() => undefined);
        return { status: 'MANUAL_REVIEW', reason };
      }
      const binding = applicable[0] as any;
      const previous = oldProjection.childResourceBindings.find((candidate) => isRecord(candidate) && candidate.id === binding.id) as Record<string, any> | undefined;
      const mappingPairs = (source: any) => [
        ...(Array.isArray(source?.legalFields) ? source.legalFields : []),
        ...(Array.isArray(source?.bankDetail?.fields) ? source.bankDetail.fields : []),
      ].filter((field: any) => typeof field?.bitrix24Field === 'string' && typeof field?.moyskladField === 'string');
      const previousPairs = new Set(mappingPairs(previous).map(stableClientJson));
      const idsChanged = Boolean(previous && (previous.bitrix24CompanyId !== binding.bitrix24CompanyId || previous.bitrix24RequisiteId !== binding.bitrix24RequisiteId || previous.moyskladCounterpartyId !== binding.moyskladCounterpartyId || stableClientJson(previous.bankDetail?.bitrix24Id ?? null) !== stableClientJson(binding.bankDetail?.bitrix24Id ?? null) || stableClientJson(previous.bankDetail?.moyskladAccountId ?? null) !== stableClientJson(binding.bankDetail?.moyskladAccountId ?? null)));
      const revisionFields = mappingPairs(binding).filter((field: any) => idsChanged || !previousPairs.has(stableClientJson(field)));
      if (revisionFields.length) try {
        const result = await this.childResources.syncForPair({
          eventId: input.event.id, direction: 'MOYSKLAD_TO_BITRIX24', bindings: [binding],
          bitrix24CompanyId: input.pair.bitrix24Id, moyskladCounterpartyId: input.pair.moyskladId,
          prior: input.state.childResourceState as ClientChildResourceSnapshot | null, revisionFields, assertLease: input.fence?.assertOwned,
        });
        if (result.status === 'MANUAL_REVIEW') {
          const reason = `CLIENT_SETTINGS_REVISION_CHILD_${result.reason}:${String(binding.id)}`;
          await this.database.entityPairSettingsRevision.updateMany({ where: { pairId: input.pair.id, toSettingsVersion: input.eventConfig.version, status: 'PREPARED' }, data: { status: 'FAILED', errorCategory: reason } }).catch(() => undefined);
          return { status: 'MANUAL_REVIEW', reason };
        }
        revisedChildState = result.state as unknown as Prisma.JsonValue;
      } catch (error) {
        if (error instanceof ServiceModeNotOnError) throw error;
        return { status: 'RETRY', reason: `CLIENT_SETTINGS_REVISION_CHILD_READBACK_FAILED:${safeReason(error)}` };
      }
    }
    const bitrixWrites: Record<string, unknown> = {};
    const sourceFields = new Set<string>();
    const skipped: string[] = [];
    let mappingError: string | null = null;

    for (const rule of changedRules) {
      sourceFields.add(rule.targetField);
      if (!rule.moyskladToBitrix24.enabled) {
        mappingError = 'CLIENT_SETTINGS_REVISION_REVERSE_MAPPING_REQUIRED';
        continue;
      }
      const transformed = this.settings.transformFieldResult(input.eventConfig.config, input.mappingEntity, 'MOYSKLAD_TO_BITRIX24', rule.sourceField, input.moysklad);
      if (transformed?.status === 'mapped') bitrixWrites[rule.sourceField] = transformed.value;
      else if (transformed?.status === 'error' && rule.criticality === 'critical') mappingError = `CLIENT_SETTINGS_REVISION_TRANSFORM_FAILED:${rule.sourceField}`;
      else skipped.push(`${rule.sourceField} → ${rule.targetField}:${transformed?.status === 'skip' ? transformed.reason : 'reverse transform unavailable'}`);
    }
    for (const group of changedGroups) {
      if (group.direction !== 'MOYSKLAD_TO_BITRIX24') {
        mappingError = 'CLIENT_SETTINGS_REVISION_GROUP_REVERSE_MAPPING_REQUIRED';
        continue;
      }
      for (const field of group.sourceFields) sourceFields.add(field);
      const transformed = this.settings.transformFieldResult(input.eventConfig.config, input.mappingEntity, group.direction, group.targetField, input.moysklad);
      if (transformed?.status === 'mapped') bitrixWrites[group.targetField] = transformed.value;
      else if (transformed?.status === 'error' && group.criticality === 'critical') mappingError = `CLIENT_SETTINGS_REVISION_GROUP_TRANSFORM_FAILED:${group.targetField}`;
      else skipped.push(`${group.targetField}:${transformed?.status === 'skip' ? transformed.reason : 'group transform unavailable'}`);
    }
    if (mappingError) {
      await this.database.entityPairSettingsRevision.updateMany({ where: { pairId: input.pair.id, toSettingsVersion: input.eventConfig.version, status: 'PREPARED' }, data: { status: 'FAILED', errorCategory: mappingError } }).catch(() => undefined);
      return { status: 'MANUAL_REVIEW', reason: mappingError };
    }

    let verifiedBitrix = input.bitrix;
    let verifiedMoysklad = input.moysklad;
    if (Object.keys(bitrixWrites).length) {
      try {
        const [beforeBitrix, beforeMoysklad] = await Promise.all([
          this.gateway!.readBitrix(input.bitrixEntity, input.pair.bitrix24Id),
          this.gateway!.readMoysklad(input.msType, input.pair.moyskladId, input.pair.moyskladParentId),
        ]);
        if ([...sourceFields].some((field) => !equal(beforeMoysklad[field], input.moysklad[field])) ||
            Object.keys(bitrixWrites).some((field) => !equal(beforeBitrix[field], input.bitrix[field]))) {
          return { status: 'RETRY', reason: 'CLIENT_SETTINGS_REVISION_SOURCE_CHANGED' };
        }
        await input.fence?.assertOwned();
        await this.gateway!.updateBitrix(input.bitrixEntity, input.pair.bitrix24Id, bitrixWrites, input.event.id);
        [verifiedBitrix, verifiedMoysklad] = await Promise.all([
          this.gateway!.readBitrix(input.bitrixEntity, input.pair.bitrix24Id),
          this.gateway!.readMoysklad(input.msType, input.pair.moyskladId, input.pair.moyskladParentId),
        ]);
      } catch { return { status: 'RETRY', reason: 'CLIENT_SETTINGS_REVISION_READBACK_FAILED' }; }
      if (!matchesWrittenFields(bitrixWrites, verifiedBitrix) ||
          [...sourceFields].some((field) => !equal(verifiedMoysklad[field], input.moysklad[field]))) {
        return { status: 'RETRY', reason: 'CLIENT_SETTINGS_REVISION_READBACK_MISMATCH' };
      }
    }

    const rules = Array.isArray(input.eventConfig.config.rules) ? input.eventConfig.config.rules.filter((rule: any) => rule?.entity === input.mappingEntity && typeof rule.sourceField === 'string' && typeof rule.targetField === 'string') : [];
    const groups = Array.isArray(input.eventConfig.config.groups) ? input.eventConfig.config.groups.filter((group: any) => group?.entity === input.mappingEntity) : [];
    const currentB = selectFields(verifiedBitrix, rules, groups, 'BITRIX24');
    const currentM = selectFields(verifiedMoysklad, rules, groups, 'MOYSKLAD');
    const preserveB = unchangedClientFields(oldProjection, newProjection, 'BITRIX24');
    const preserveM = unchangedClientFields(oldProjection, newProjection, 'MOYSKLAD');
    const bitrix24Values = preservePriorClientFields(currentB, baseline.bitrix24Values, preserveB);
    const moyskladValues = preservePriorClientFields(currentM, baseline.moyskladValues, preserveM);
    const stateBitrix24Values = preservePriorClientFields(currentB, input.state.bitrix24Values, preserveB);
    const stateMoyskladValues = preservePriorClientFields(currentM, input.state.moyskladValues, preserveM);
    try {
      const committed = await this.database.$transaction(async (tx) => {
        await assertFenceInTransaction(input.fence, tx);
        const latest = await tx.entityPairBaseline.findUnique({ where: { pairId: input.pair.id } });
        if (!latest || latest.settingsVersion !== baseline.settingsVersion) throw new Error('CLIENT_SETTINGS_REVISION_BASELINE_CHANGED');
        await tx.entityPairBaseline.update({ where: { pairId: input.pair.id }, data: { settingsVersion: input.eventConfig.version, bitrix24Values: bitrix24Values as Prisma.InputJsonValue, moyskladValues: moyskladValues as Prisma.InputJsonValue } });
        const nextState = await tx.entityPairSyncState.upsert({
          where: { pairId: input.pair.id },
          create: { pairId: input.pair.id, settingsVersion: input.eventConfig.version, bitrix24Values: stateBitrix24Values as Prisma.InputJsonValue, moyskladValues: stateMoyskladValues as Prisma.InputJsonValue, ...(revisedChildState ? { childResourceState: revisedChildState as Prisma.InputJsonValue } : {}) },
          update: { settingsVersion: input.eventConfig.version, bitrix24Values: stateBitrix24Values as Prisma.InputJsonValue, moyskladValues: stateMoyskladValues as Prisma.InputJsonValue, ...(revisedChildState ? { childResourceState: revisedChildState as Prisma.InputJsonValue } : {}) },
        });
        await tx.entityPairSettingsRevision.update({ where: { pairId_toSettingsVersion: { pairId: input.pair.id, toSettingsVersion: input.eventConfig.version } }, data: {
          status: 'COMPLETE', currentBaseline: { settingsVersion: input.eventConfig.version, bitrix24Values, moyskladValues, childResourceState: revisedChildState } as Prisma.InputJsonValue,
          errorCategory: skipped.length ? 'OPTIONAL_MAPPING_SKIPPED' : null,
        } });
        await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Client mapping settings advanced from ${baseline.settingsVersion} to ${input.eventConfig.version}; MySklad-authoritative initial values verified for pair ${input.pair.id}.${skipped.length ? ` Optional mappings skipped: ${skipped.join('; ')}.` : ''}`, referenceId: input.event.id } });
        return nextState;
      });
      return { status: 'READY', state: committed, rebased: true };
    } catch { return { status: 'RETRY', reason: 'CLIENT_SETTINGS_REVISION_PERSIST_FAILED' }; }
  }

  private async processContactPairFanout(
    event: PersistedEvent,
    eventConfig: Awaited<ReturnType<FieldSettingsService['eventConfig']>>,
    bitrixSource: ClientRecord,
    pairs: Array<Prisma.EntityPairGetPayload<Record<string, never>>>,
    parentFence?: EventWorkerLeaseContext,
  ): Promise<'REVIEW' | 'BASELINE' | 'UNCHANGED' | 'SYNCED' | 'RETRY'> {
    if (!this.gateway) return this.hold(event, 'CLIENT_RUNTIME_GATEWAY_UNAVAILABLE', {}, parentFence);
    const failures: Array<{ pairId: string; reason: string; retryable: boolean; retryAfter?: Date }> = [];
    let baselines = 0;
    let syncs = 0;
    let staleSettings = 0;
    for (const pair of pairs) {
      let lease: ClientRuntimeLease | undefined;
      try {
        if ((await this.syncMode.read()).mode !== 'on') throw new Error('CLIENT_SYNC_MODE_NOT_ON');
        // A distinct lease per saved relationship prevents one association from
        // blocking or accidentally standing in for another company's pair.
        lease = await this.acquireRuntimeLease('BITRIX24', 'CONTACT', `pair:${pair.id}`, event.id);
        const fence: EventWorkerLeaseContext = {
          assertOwned: async () => { await parentFence?.assertOwned(); await lease?.assertOwned(); },
          assertOwnedIn: async (tx) => {
            if (parentFence?.assertOwnedIn) await parentFence.assertOwnedIn(tx); else await parentFence?.assertOwned();
            await lease?.assertOwnedIn(tx);
          },
        };
        await fence.assertOwned();
        if (!pair.moyskladParentId) {
          if (pair.moyskladType !== 'counterparty') throw new Error('CLIENT_CONTACTPERSON_PARENT_MISSING');
        } else {
          const companyPair = await this.database.entityPair.findFirst({ where: {
            entityType: 'COMPANY', active: true, moyskladId: pair.moyskladParentId, moyskladType: 'counterparty',
          } });
          if (!companyPair) throw new Error('CLIENT_CONTACT_PAIR_COMPANY_CONTEXT_UNRESOLVED');
        }
        if (pair.moyskladType !== 'counterparty' && pair.moyskladType !== 'contactperson') throw new Error('CLIENT_PERSISTED_PAIR_TYPE_UNKNOWN');
        let ms = await this.gateway.readMoysklad(pair.moyskladType, pair.moyskladId, pair.moyskladParentId);
        if (pair.moyskladType === 'contactperson') {
          const actualParent = idFromMeta(ms.company) ?? idFromMeta(ms.agent);
          if (actualParent && actualParent !== pair.moyskladParentId) throw new Error('CLIENT_CONTACTPERSON_PARENT_MISMATCH');
        } else if (stringValue(ms.companyType)?.toLowerCase() !== 'individual') {
          throw new Error('CLIENT_CONTACT_TARGET_NOT_INDIVIDUAL');
        }
        let bitrix = await this.gateway.readBitrix('CONTACT', pair.bitrix24Id);
        const mappingEntity = 'contacts-companies';
        const rules = Array.isArray(eventConfig.config.rules) ? eventConfig.config.rules : [];
        const applicable = rules.filter((rule: any) => rule?.entity === mappingEntity && typeof rule.sourceField === 'string' && typeof rule.targetField === 'string');
        const groups = Array.isArray(eventConfig.config.groups) ? eventConfig.config.groups.filter((group: any) => group?.entity === mappingEntity) : [];
        let prior = await this.database.entityPairSyncState.findUnique({ where: { pairId: pair.id } });
        if (prior) {
          const revision = await this.rebaseClientSettings({ pair, event, eventConfig, mappingEntity, bitrixEntity: 'CONTACT', msType: pair.moyskladType, bitrix, moysklad: ms, state: prior, fence });
          if (revision.status === 'RETRY') throw new Error(revision.reason);
          if (revision.status === 'MANUAL_REVIEW') {
            const failure = new ProviderFailure('BITRIX24', 400);
            failure.message = revision.reason;
            throw failure;
          }
          if (revision.status === 'STALE_PINNED_EVENT') {
            staleSettings++;
            await this.database.$transaction(async (tx) => {
              await assertFenceInTransaction(fence, tx);
              await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Older pinned contact settings ${eventConfig.version} skipped for pair ${pair.id}; version ${revision.currentVersion} is already active or has a prepared revision.`, referenceId: event.id } });
            });
            continue;
          }
          prior = revision.state;
          if (revision.rebased) {
            [bitrix, ms] = await Promise.all([
              this.gateway.readBitrix('CONTACT', pair.bitrix24Id),
              this.gateway.readMoysklad(pair.moyskladType, pair.moyskladId, pair.moyskladParentId),
            ]);
          }
        }
        const current = { bitrix24Values: selectFields(bitrix, applicable, groups, 'BITRIX24'), moyskladValues: selectFields(ms, applicable, groups, 'MOYSKLAD') };
        if (!prior) {
          await this.database.$transaction(async (tx) => {
            await assertFenceInTransaction(fence, tx);
            await tx.entityPairBaseline.upsert({ where: { pairId: pair.id }, create: {
              pairId: pair.id, eventId: event.id, settingsVersion: eventConfig.version,
              bitrix24Values: current.bitrix24Values as Prisma.InputJsonValue, moyskladValues: current.moyskladValues as Prisma.InputJsonValue,
            }, update: {} });
            await tx.entityPairSyncState.create({ data: { pairId: pair.id, settingsVersion: eventConfig.version, bitrix24Values: current.bitrix24Values as Prisma.InputJsonValue, moyskladValues: current.moyskladValues as Prisma.InputJsonValue } });
          });
          baselines++;
          continue;
        }
        const direction = event.source === 'BITRIX24' ? 'BITRIX24_TO_MOYSKLAD' : 'MOYSKLAD_TO_BITRIX24';
        const writes = buildWrites(eventConfig.config, mappingEntity, direction, bitrix, ms, prior, applicable, this.settings);
        if (writes.ambiguous) throw new Error(writes.ambiguous);
        if (Object.keys(writes.moysklad).length) { await fence.assertOwned(); await this.gateway.updateMoysklad(pair.moyskladType, pair.moyskladId, pair.moyskladParentId, writes.moysklad, event.id); }
        if (Object.keys(writes.bitrix24).length) { await fence.assertOwned(); await this.gateway.updateBitrix('CONTACT', pair.bitrix24Id, writes.bitrix24, event.id); }
        const [afterBitrix, afterMoysklad] = await Promise.all([
          this.gateway.readBitrix('CONTACT', pair.bitrix24Id),
          this.gateway.readMoysklad(pair.moyskladType, pair.moyskladId, pair.moyskladParentId),
        ]);
        const confirmed = { bitrix24Values: selectFields(afterBitrix, applicable, groups, 'BITRIX24'), moyskladValues: selectFields(afterMoysklad, applicable, groups, 'MOYSKLAD') };
        if (!matchesWrittenFields(writes.bitrix24, confirmed.bitrix24Values) || !matchesWrittenFields(writes.moysklad, confirmed.moyskladValues)) throw new ProviderFailure(Object.keys(writes.moysklad).length ? 'MOYSKLAD' : 'BITRIX24', null);
        await this.database.$transaction(async (tx) => {
          await assertFenceInTransaction(fence, tx);
          await tx.entityPairSyncState.update({ where: { pairId: pair.id }, data: { settingsVersion: eventConfig.version, bitrix24Values: confirmed.bitrix24Values as Prisma.InputJsonValue, moyskladValues: confirmed.moyskladValues as Prisma.InputJsonValue } });
          const updated = [...Object.keys(writes.moysklad), ...Object.keys(writes.bitrix24)];
          await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: updated.length ? `Configured contact fields synchronized for company context ${pair.moyskladParentId ?? 'standalone'}: ${updated.join(', ')} (pair ${pair.id}).` : `No configured contact field changes for company context ${pair.moyskladParentId ?? 'standalone'} (pair ${pair.id}).`, referenceId: event.id } });
        });
        if (Object.keys(writes.moysklad).length || Object.keys(writes.bitrix24).length) syncs++;
      } catch (error) {
        if (error instanceof ServiceModeNotOnError) throw error;
        const reason = safeReason(error);
        failures.push({ pairId: pair.id, reason, retryable: isRetryableFailure(error), retryAfter: isRetryableFailure(error) ? retryAtForFailure(error, event.attempts + 1) : undefined });
      } finally {
        await lease?.release().catch(() => undefined);
      }
    }
    if (failures.length) {
      const retryable = failures.some((failure) => failure.retryable);
      if (!retryable) return this.hold(event, 'CLIENT_CONTACT_CONTEXT_SYNC_REVIEW', { failures }, parentFence);
      const retryAfter = failures.filter((failure) => failure.retryable && failure.retryAfter).map((failure) => failure.retryAfter!).sort((a, b) => a.getTime() - b.getTime())[0];
      await this.database.$transaction(async (tx) => {
        await assertFenceInTransaction(parentFence, tx);
        await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'PROCESSING' }, data: { status: 'RETRYABLE_FAILURE', processingStartedAt: null, retryAfter: retryAfter ?? retryAtForFailure(new Error('CLIENT_CONTACT_CONTEXT_SYNC_RETRY'), event.attempts + 1), lastErrorCategory: 'CLIENT_CONTACT_CONTEXT_SYNC_RETRY' } });
        await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Some contact company contexts need retry: ${failures.map((failure) => `${failure.pairId}:${failure.reason}`).join('; ')}.`, referenceId: event.id } });
      });
      return 'RETRY';
    }
    await this.database.$transaction(async (tx) => {
      await assertFenceInTransaction(parentFence, tx);
      await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'PROCESSING' }, data: { status: 'SUCCEEDED', processingStartedAt: null, direction: 'BITRIX24_TO_MOYSKLAD', lastSuccessfulAt: new Date(), lastErrorCategory: null } });
    });
    if (syncs) return 'SYNCED';
    return baselines ? 'BASELINE' : 'UNCHANGED';
  }

  private async resolveUnpaired(event: PersistedEvent, entity: 'COMPANY' | 'CONTACT', sourceSystem: ClientSystem, config: unknown, primaryCompanyOverride: string | null = null, workerLease?: EventWorkerLeaseContext, parentFence?: EventWorkerLeaseContext, optionalRetry = false): Promise<any | null> {
    const ownedLease = workerLease || parentFence ? null : await this.acquireRuntimeLease(sourceSystem, entity, event.externalEntityId!, event.id);
    const fence = parentFence ?? workerLease ?? ownedLease!;
    try {
      await fence.assertOwned();
      const companyPair = entity === 'CONTACT' && primaryCompanyOverride
        ? await this.findPersistedPair('COMPANY', primaryCompanyOverride, sourceSystem)
        : null;
      const companyTargetId = entity !== 'CONTACT' ? undefined
        : sourceSystem === 'BITRIX24' ? companyPair?.moyskladId ?? null
          : primaryCompanyOverride ?? (event.externalEntityType === 'contactperson' ? parentIdFromEvent(event) : null);
      const persisted = await this.findPersistedPair(entity, event.externalEntityId!, sourceSystem, entity === 'CONTACT' ? companyTargetId : undefined);
      if (persisted) return persisted;
      return await this.resolveUnpairedWithLease(event, entity, sourceSystem, config, primaryCompanyOverride, workerLease, fence, optionalRetry);
    } finally {
      await ownedLease?.release().catch(() => undefined);
    }
  }

  private async resolveUnpairedWithLease(event: PersistedEvent, entity: 'COMPANY' | 'CONTACT', sourceSystem: ClientSystem, config: unknown, primaryCompanyOverride: string | null, workerLease: EventWorkerLeaseContext | undefined, fence: EventWorkerLeaseContext, optionalRetry: boolean): Promise<any | null> {
    const sourceId = event.externalEntityId!;
    const sourceHold = await this.database.pairReviewCase.findFirst({ where: { entityType: entity, sourceSystem, sourceEntityId: sourceId, status: 'OPEN' } });
    if (sourceHold) {
      await this.hold(event, sourceHold.reason === 'CLIENT_CREATE_IN_PROGRESS' ? 'CLIENT_CREATE_RESPONSE_UNCERTAIN' : sourceHold.reason,
        { entity, sourceSystem, sourceId, sourceHoldId: sourceHold.id }, fence);
      return null;
    }
    const sourceContactParentId = entity === 'CONTACT'
      ? sourceSystem === 'BITRIX24'
        ? null
        : primaryCompanyOverride ?? (event.externalEntityType === 'contactperson' ? parentIdFromEvent(event) : null)
      : null;
    const gateway = leaseProxy(this.gateway!, fence);
    const candidateGateway = leaseProxy(this.candidateGateway!, fence);
    const record = sourceSystem === 'BITRIX24'
      ? await gateway.readBitrix(entity === 'COMPANY' ? 'COMPANY' : 'CONTACT', sourceId)
      : await gateway.readMoysklad(event.externalEntityType === 'contactperson' ? 'contactperson' : 'counterparty', sourceId, sourceContactParentId);

    let primaryCompanySourceId: string | null = null;
    let primaryCompanyTargetId: string | null = null;
    if (entity === 'CONTACT') {
      primaryCompanySourceId = sourceSystem === 'BITRIX24'
        ? primaryCompanyOverride ?? stringValue(record.COMPANY_ID)
        : primaryCompanyOverride ?? sourceContactParentId ?? idFromMeta(record.agent);
      if (primaryCompanySourceId) {
        const companyResolution = await this.resolveForDocument({ eventId: event.id, sourceSystem, entity: 'COMPANY', sourceId: primaryCompanySourceId, optionalRetry, optionalDependency: optionalRetry }, workerLease);
        if (companyResolution.status !== 'RESOLVED') return null;
        const companyPair = companyResolution.pair;
        primaryCompanyTargetId = sourceSystem === 'BITRIX24' ? companyPair.moyskladId : companyPair.bitrix24Id;
      }
    }

    const nativeName = entity === 'COMPANY'
      ? stringValue(sourceSystem === 'BITRIX24' ? record.TITLE : record.name)
      : sourceSystem === 'BITRIX24' ? personNameFromBitrix(record) : stringValue(record.name);
    const inn = entity === 'COMPANY'
      ? sourceSystem === 'BITRIX24' ? await candidateGateway.readCompanyInn(sourceSystem, sourceId) : stringValue(record.inn)
      : null;
    const source: ClientSource = {
      id: sourceId, entity, sourceSystem, inn, name: nativeName,
      phone: firstValue(record.PHONE ?? record.phone), email: firstValue(record.EMAIL ?? record.email),
      companyId: primaryCompanySourceId,
    };
    let resolution: ClientResolution;
    if (process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
      const targetSystem: ClientSystem = sourceSystem === 'BITRIX24' ? 'MOYSKLAD' : 'BITRIX24';
      if (!this.controlledAdmission) throw new Error('CONTROLLED_LIVE_TEST_ADMISSION_SERVICE_UNAVAILABLE');
      if (primaryCompanyTargetId) throw new Error('CONTROLLED_LIVE_TEST_SHARED_COMPANY_DEPENDENCY_NOT_ALLOWED');
      await this.controlledAdmission.assertCreateReserved(event.id, `client:${entity}`, targetSystem);
      resolution = { action: 'CREATE', targetSystem, reason: entity === 'CONTACT' ? 'NO_CONTACT_KEYS' : 'NO_CANDIDATE',
        targetType: targetSystem === 'MOYSKLAD' ? 'counterparty' : entity === 'CONTACT' ? 'contact' : 'company' };
    } else {
      resolution = await new ClientRuntimeResolver(candidateGateway).resolve(source, primaryCompanyTargetId);
    }
    if (resolution.action === 'MANUAL_REVIEW') {
      await this.hold(event, `CLIENT_${resolution.reason}`, { entity, sourceSystem, sourceId, primaryCompanySourceId, candidates: resolution.candidates }, fence);
      return null;
    }

    let targetId: string | null = resolution.action === 'CREATE' ? null : resolution.targetId;
    let targetType = resolution.targetType;
    const contactPairParentId = entity === 'CONTACT'
      ? sourceSystem === 'BITRIX24' ? (targetType === 'contactperson' ? primaryCompanyTargetId : null) : sourceContactParentId
      : null;
    if (resolution.action === 'CREATE') {
      const mappingEntity = entity === 'COMPANY' ? 'companies' : 'contacts-companies';
      const direction = sourceSystem === 'BITRIX24' ? 'BITRIX24_TO_MOYSKLAD' : 'MOYSKLAD_TO_BITRIX24';
      const configuredFields = configuredCreateFields(config, mappingEntity, direction, record, this.settings);
      const concurrentlyPaired = await this.markCreateInProgress(event, entity, sourceSystem, sourceId, fence, contactPairParentId);
      if (concurrentlyPaired) return concurrentlyPaired;
      targetId = await candidateGateway.createTarget({
        entity, targetSystem: resolution.targetSystem, targetType: resolution.targetType,
        parentId: primaryCompanyTargetId, source: record, configuredFields, eventId: event.id,
      });
      if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
        this.controlledAdmission.allowTargetReadback(resolution.targetSystem, targetId);
        const readback = await candidateGateway.readRecord(resolution.targetSystem, entity, targetId, contactPairParentId);
        const targetCreatedValue = resolution.targetSystem === 'BITRIX24' ? readback.DATE_CREATE : readback.created;
        const targetCreatedAt = targetCreatedValue instanceof Date
          ? targetCreatedValue
          : resolution.targetSystem === 'MOYSKLAD'
            ? parseClientMoyskladTimestamp(targetCreatedValue) ?? new Date(Number.NaN)
            : new Date(String(targetCreatedValue ?? ''));
        await this.controlledAdmission.bindCreatedTarget(event.id, targetId, String(readback.ID ?? readback.id ?? ''), controlledClientName(entity, readback), targetCreatedAt);
      }
      targetType = resolution.targetType;
    }

    if (!targetId) {
      await this.hold(event, 'CLIENT_RUNTIME_TARGET_ID_MISSING', { entity, sourceSystem, sourceId, resolution: resolution.action }, fence);
      return null;
    }
    if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
      await this.controlledAdmission.assertTargetAllowed(event.id, resolution.targetSystem, targetId);
    }
    const bitrix24Id = sourceSystem === 'BITRIX24' ? sourceId : targetId;
    const moyskladId = sourceSystem === 'BITRIX24' ? targetId : sourceId;
    const moyskladType = sourceSystem === 'BITRIX24'
      ? targetType === 'contactperson' ? 'contactperson' : 'counterparty'
      : event.externalEntityType === 'contactperson' ? 'contactperson' : 'counterparty';
    const moyskladParentId = contactPairParentId;

    try {
      await workerLease?.assertOwned();
      const pair = await this.database.$transaction(async (tx) => {
        await assertFenceInTransaction(fence, tx);
        await lockEntityPairState(tx);
        const sourceField = sourceSystem === 'BITRIX24' ? 'bitrix24Id' : 'moyskladId';
        const existing = await tx.entityPair.findFirst({ where: { entityType: entity, active: true, [sourceField]: sourceId,
          ...(entity === 'CONTACT' ? { moyskladParentId } : {}) } });
        if (existing) return existing;
        const conflict = await tx.entityPair.findFirst({
          where: { entityType: entity, active: true, OR: entity === 'CONTACT' ? [{ moyskladId }] : [{ bitrix24Id }, { moyskladId }] },
        });
        if (conflict) throw new Error('CLIENT_RUNTIME_PAIR_CONFLICT');
        const saved = await tx.entityPair.create({ data: {
          entityType: entity, bitrix24Id, moyskladId, moyskladType, moyskladParentId,
          active: true, source: 'RUNTIME', reason: resolution.action === 'USE_CANDIDATE'
            ? `${resolution.reason} Evidence: usage=${resolution.evidence.usageCount ?? 'unavailable'}, filled=${resolution.evidence.filledFields}, created=${resolution.evidence.createdAt}, criteria=${resolution.evidence.criteria.join(',')}.`
            : resolution.action === 'CREATE' ? `CREATED: ${resolution.reason}` : 'PERSISTED_PAIR',
        } });
        await tx.pairReviewCase.updateMany({ where: { entityType: entity, sourceSystem, sourceEntityId: sourceId, status: 'OPEN', reason: 'CLIENT_CREATE_IN_PROGRESS' }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
        await tx.operationalLog.create({ data: {
          category: 'CLIENT_RUNTIME',
          message: `Client pair resolved (${entity}; ${sourceSystem} ${sourceId} → ${moyskladType} ${moyskladId}; ${resolution.action === 'USE_CANDIDATE' ? `${resolution.reason} Evidence: usage=${resolution.evidence.usageCount ?? 'unavailable'}, filled=${resolution.evidence.filledFields}, created=${resolution.evidence.createdAt}, criteria=${resolution.evidence.criteria.join(',')}` : resolution.action === 'CREATE' ? `created: ${resolution.reason}` : resolution.reason}).`,
          referenceId: event.id,
        } });
        return saved;
      });
      return pair;
    } catch (error) {
      if (error instanceof Error && error.message === 'CLIENT_RUNTIME_PAIR_CONFLICT') {
        await this.hold(event, 'CLIENT_RUNTIME_PAIR_CONFLICT', { entity, sourceSystem, sourceId, targetId }, fence);
        return null;
      }
      throw error;
    }
  }

  private async markCreateInProgress(event: PersistedEvent, entity: 'COMPANY' | 'CONTACT', sourceSystem: ClientSystem, sourceId: string, workerLease: EventWorkerLeaseContext, companyTargetId?: string | null) {
    await workerLease?.assertOwned();
    return this.database.$transaction(async (tx) => {
      await assertFenceInTransaction(workerLease, tx);
      await lockEntityPairState(tx);
      const sourceField = sourceSystem === 'BITRIX24' ? 'bitrix24Id' : 'moyskladId';
      const persisted = await tx.entityPair.findFirst({ where: { entityType: entity, active: true, [sourceField]: sourceId,
        ...(entity === 'CONTACT' ? { moyskladParentId: companyTargetId ?? null } : {}) } });
      if (persisted) return persisted;
      const existing = await tx.pairReviewCase.findFirst({ where: { entityType: entity, sourceSystem, sourceEntityId: sourceId, status: 'OPEN' } });
      if (existing) throw new Error('CLIENT_SOURCE_REVIEW_OPEN');
      await tx.pairReviewCase.create({ data: { entityType: entity, sourceSystem, sourceEntityId: sourceId, eventId: event.id, reason: 'CLIENT_CREATE_IN_PROGRESS' } });
      await tx.inboundEvent.updateMany({ where: { id: event.id, status: event.status }, data: { lastErrorCategory: 'CLIENT_CREATE_IN_PROGRESS' } });
    });
  }

  private async acquireRuntimeLease(sourceSystem: ClientSystem, entity: 'COMPANY' | 'CONTACT', sourceId: string, eventId: string): Promise<ClientRuntimeLease> {
    const entityKey = runtimeLockKey(sourceSystem, entity, sourceId);
    const ownerToken = randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 60_000);
    const reclaimed = await this.database.inboundEntityLock.updateMany({ where: { entityKey, leaseExpiresAt: { lte: now } }, data: { ownerToken, eventId, leaseExpiresAt } });
    if (!reclaimed.count) {
      try { await this.database.inboundEntityLock.create({ data: { entityKey, ownerToken, eventId, leaseExpiresAt } }); }
      catch (error) {
        if (isUniqueConstraintError(error)) throw Object.assign(new Error('CLIENT_ENTITY_LOCK_BUSY'), { retryAfterMs: 5_000 });
        throw error;
      }
    }
    let lost = false;
    const renew = async () => {
      const result = await this.database.inboundEntityLock.updateMany({ where: { entityKey, ownerToken }, data: { leaseExpiresAt: new Date(Date.now() + 60_000) } });
      if (result.count !== 1) lost = true;
      return result.count === 1;
    };
    const timer = setInterval(() => { void renew().catch(() => { lost = true; }); }, 15_000);
    timer.unref();
    return {
      assertOwned: async () => {
        if (lost) throw new Error('CLIENT_ENTITY_LEASE_LOST');
        const row = await this.database.inboundEntityLock.findUnique({ where: { entityKey }, select: { ownerToken: true, leaseExpiresAt: true } });
        if (!row || row.ownerToken !== ownerToken || row.leaseExpiresAt <= new Date()) { lost = true; throw new Error('CLIENT_ENTITY_LEASE_LOST'); }
      },
      assertOwnedIn: async (transaction) => {
        if (lost) throw new Error('CLIENT_ENTITY_LEASE_LOST');
        const renewed = await transaction.inboundEntityLock.updateMany({
          where: { entityKey, ownerToken, leaseExpiresAt: { gt: new Date() } },
          data: { leaseExpiresAt: new Date(Date.now() + 60_000) },
        });
        if (renewed.count !== 1) { lost = true; throw new Error('CLIENT_ENTITY_LEASE_LOST'); }
      },
      release: async () => {
        clearInterval(timer);
        await this.database.inboundEntityLock.deleteMany({ where: { entityKey, ownerToken } });
      },
    };
  }

  private async hold(event: PersistedEvent, reason: string, diagnostic: Record<string, unknown>, fence?: EventWorkerLeaseContext): Promise<'REVIEW'> {
    await this.database.$transaction(async (tx) => {
      await assertFenceInTransaction(fence, tx);
      if (event.externalEntityId) {
        const entityType = entityForEvent(event);
        if (entityType) {
          const sourceSystem = event.source === 'BITRIX24' ? 'BITRIX24' : 'MOYSKLAD';
          const open = await tx.pairReviewCase.findFirst({ where: { entityType, sourceSystem, sourceEntityId: event.externalEntityId, status: 'OPEN' } });
          if (open) await tx.pairReviewCase.update({ where: { id: open.id }, data: { eventId: event.id, reason } });
          else await tx.pairReviewCase.create({ data: { entityType, sourceSystem, sourceEntityId: event.externalEntityId, eventId: event.id, reason } });
        }
      }
      await tx.manualReviewCase.upsert({ where: { eventId: event.id }, create: {
        eventId: event.id, source: event.source, eventType: event.eventType, externalEntityId: event.externalEntityId,
        externalEntityType: event.externalEntityType, reason, diagnostic: sanitizeReviewDiagnosticForStorage(diagnostic) as Prisma.InputJsonValue, ...manualReviewFields(diagnostic),
      }, update: { reason, diagnostic: sanitizeReviewDiagnosticForStorage(diagnostic) as Prisma.InputJsonValue, ...manualReviewFields(diagnostic) } });
      await tx.inboundEvent.updateMany({ where: { id: event.id, status: event.status }, data: { status: 'MANUAL_REVIEW', processingStartedAt: null, lastErrorCategory: reason } });
      await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Client event requires review: ${reason}.`, referenceId: event.id } });
    });
    return 'REVIEW';
  }

  private async retry(event: PersistedEvent, reason: string, retryAfter?: Date, fence?: EventWorkerLeaseContext): Promise<'RETRY'> {
    await this.database.$transaction(async (tx) => {
      await assertFenceInTransaction(fence, tx);
      await tx.inboundEvent.updateMany({ where: { id: event.id, status: event.status }, data: {
        status: 'RETRYABLE_FAILURE', processingStartedAt: null, lastErrorCategory: reason,
        retryAfter: retryAfter ?? retryAtForFailure(new Error(reason), event.attempts + 1),
      } });
      await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Client dependency held for retry: ${reason}.`, referenceId: event.id } });
    });
    return 'RETRY';
  }
}

function entityForEvent(event: { source?: string; eventType?: string | null; externalEntityType?: string | null }): 'COMPANY' | 'CONTACT' | null {
  if (event.source === 'BITRIX24') {
    if (event.externalEntityType === 'company' && /^ONCRMCOMPANY(?:ADD|UPDATE)$/.test(event.eventType ?? '')) return 'COMPANY';
    if (event.externalEntityType === 'contact' && /^ONCRMCONTACT(?:ADD|UPDATE)$/.test(event.eventType ?? '')) return 'CONTACT';
  }
  if (event.source === 'MOYSKLAD' && ['CREATE', 'UPDATE'].includes(event.eventType ?? '')) {
    if (event.externalEntityType === 'counterparty') return 'COMPANY';
    if (event.externalEntityType === 'contactperson') return 'CONTACT';
  }
  return null;
}

function selectFields(record: ClientRecord, rules: any[], groups: any[], side: 'BITRIX24' | 'MOYSKLAD'): Record<string, unknown> {
  const keys = new Set<string>();
  for (const rule of rules) keys.add(side === 'BITRIX24' ? rule.sourceField : rule.targetField);
  for (const group of groups) {
    if (group.direction === 'BITRIX24_TO_MOYSKLAD') {
      if (side === 'BITRIX24') {
        for (const field of group.sourceFields ?? []) if (typeof field === 'string') keys.add(field);
      } else keys.add(group.targetField);
    } else if (group.direction === 'MOYSKLAD_TO_BITRIX24') {
      if (side === 'MOYSKLAD') {
        for (const field of group.sourceFields ?? []) if (typeof field === 'string') keys.add(field);
      } else keys.add(group.targetField);
    }
  }
  return Object.fromEntries([...keys].filter((key) => Object.prototype.hasOwnProperty.call(record, key)).map((key) => [key, record[key]]));
}

type ClientSettingsProjection = {
  rules: Array<{
    entity: string; sourceField: string; targetField: string; criticality: string;
    bitrix24ToMoysklad: { enabled: boolean; transform: unknown };
    moyskladToBitrix24: { enabled: boolean; transform: unknown };
  }>;
  groups: Array<{ entity: string; direction: string; sourceFields: string[]; targetField: string; criticality: string; transform: unknown }>;
  childResourceBindings: unknown[];
};

function semanticClientSettings(config: unknown, entity: string): ClientSettingsProjection {
  const source = isRecord(config) ? config : {};
  const rules = (Array.isArray(source.rules) ? source.rules : []).filter((rule): rule is Record<string, any> =>
    isRecord(rule) && rule.entity === entity && typeof rule.sourceField === 'string' && typeof rule.targetField === 'string' &&
    (isRecord(rule.bitrix24ToMoysklad) && rule.bitrix24ToMoysklad.enabled === true || isRecord(rule.moyskladToBitrix24) && rule.moyskladToBitrix24.enabled === true))
    .map((rule) => ({
      entity, sourceField: rule.sourceField, targetField: rule.targetField, criticality: rule.criticality,
      bitrix24ToMoysklad: { enabled: rule.bitrix24ToMoysklad?.enabled === true, transform: rule.bitrix24ToMoysklad?.transform ?? null },
      moyskladToBitrix24: { enabled: rule.moyskladToBitrix24?.enabled === true, transform: rule.moyskladToBitrix24?.transform ?? null },
    })).sort((left, right) => stableClientJson(left).localeCompare(stableClientJson(right)));
  const groups = (Array.isArray(source.groups) ? source.groups : []).filter((group): group is Record<string, any> =>
    isRecord(group) && group.entity === entity && typeof group.targetField === 'string' && Array.isArray(group.sourceFields))
    .map((group) => ({ entity, direction: group.direction, sourceFields: group.sourceFields.filter((field: unknown): field is string => typeof field === 'string'),
      targetField: group.targetField, criticality: group.criticality, transform: group.transform ?? null }))
    .sort((left, right) => stableClientJson(left).localeCompare(stableClientJson(right)));
  const childResourceBindings = entity === 'companies' && Array.isArray(source.childResourceBindings)
    ? source.childResourceBindings.map((binding) => isRecord(binding) ? {
      id: binding.id, entity: binding.entity, bitrix24CompanyId: binding.bitrix24CompanyId,
      bitrix24RequisiteId: binding.bitrix24RequisiteId, moyskladCounterpartyId: binding.moyskladCounterpartyId,
      legalFields: binding.legalFields, bankDetail: binding.bankDetail ?? null,
    } : binding).sort((left, right) => stableClientJson(left).localeCompare(stableClientJson(right)))
    : [];
  return { rules, groups, childResourceBindings };
}

function unchangedClientFields(oldProjection: ClientSettingsProjection, newProjection: ClientSettingsProjection, side: 'BITRIX24' | 'MOYSKLAD'): Set<string> {
  const newRules = new Set(newProjection.rules.map(stableClientJson));
  const newGroups = new Set(newProjection.groups.map(stableClientJson));
  const fields = new Set<string>();
  for (const rule of oldProjection.rules) {
    if (!newRules.has(stableClientJson(rule))) continue;
    fields.add(side === 'BITRIX24' ? rule.sourceField : rule.targetField);
  }
  for (const group of oldProjection.groups) {
    if (!newGroups.has(stableClientJson(group))) continue;
    const sourceSide = group.direction === 'BITRIX24_TO_MOYSKLAD' ? 'BITRIX24' : 'MOYSKLAD';
    if (side === sourceSide) for (const field of group.sourceFields) fields.add(field);
    else fields.add(group.targetField);
  }
  return fields;
}

function preservePriorClientFields(current: Record<string, unknown>, previous: unknown, preservedFields: Set<string>): Record<string, unknown> {
  const values = { ...current };
  if (!isRecord(previous)) return values;
  for (const field of preservedFields) if (Object.prototype.hasOwnProperty.call(previous, field)) values[field] = previous[field];
  return values;
}

function stableClientJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableClientJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableClientJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function buildWrites(config: any, entity: string, direction: 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24', bitrix: ClientRecord, ms: ClientRecord, prior: { bitrix24Values: unknown; moyskladValues: unknown }, rules: any[], settings: FieldSettingsService, protectEmptyFallbackInn = false) {
  const bitrix24: Record<string, unknown> = {};
  const moysklad: Record<string, unknown> = {};
  const criticalClears: Array<{ fieldTitle: string; previousValue: unknown; restoreValue: unknown; sourceProposedValue: unknown }> = [];
  let ambiguous: string | null = null;
  const defaultTarget = direction === 'BITRIX24_TO_MOYSKLAD' ? moysklad : bitrix24;
  const previousB = isRecord(prior.bitrix24Values) ? prior.bitrix24Values : {};
  const previousM = isRecord(prior.moyskladValues) ? prior.moyskladValues : {};
  const sourceNow = direction === 'BITRIX24_TO_MOYSKLAD' ? bitrix : ms;
  const targetNow = direction === 'BITRIX24_TO_MOYSKLAD' ? ms : bitrix;
  const sourcePrior = direction === 'BITRIX24_TO_MOYSKLAD' ? previousB : previousM;
  const targetPrior = direction === 'BITRIX24_TO_MOYSKLAD' ? previousM : previousB;
  for (const rule of rules) {
    const directionKey = direction === 'BITRIX24_TO_MOYSKLAD' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
    if (rule?.[directionKey]?.enabled !== true) continue;
    const srcField = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.sourceField : rule.targetField;
    const destField = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.targetField : rule.sourceField;
    // A name+phone fallback pair does not prove tax identity. Keep an empty
    // MoySklad INN empty even when a later source event changes configured RQ_INN.
    if (protectEmptyFallbackInn && direction === 'BITRIX24_TO_MOYSKLAD' && destField === 'inn') continue;
    const beforeSource = sourcePrior[srcField]; const beforeTarget = targetPrior[destField];
    const sourceChanged = !equal(sourceNow[srcField], beforeSource);
    const targetChanged = !equal(targetNow[destField], beforeTarget);
    if (sourceChanged && targetChanged && !equal(sourceNow[srcField], targetNow[destField])) {
      // The documented conflict policy is deterministic: MoySklad's current
      // value wins even when the event was triggered by the Bitrix24 edit.
      if (direction === 'MOYSKLAD_TO_BITRIX24') {
        const transformed = settings.transformFieldResult(config, entity, direction, destField, sourceNow);
        if (transformed?.status === 'mapped') bitrix24[destField] = transformed.value;
        else if (transformed?.status === 'error' && rule.criticality === 'critical') ambiguous = `CLIENT_FIELD_TRANSFORM_FAILED:${destField}:${transformed.reason}`;
      } else {
        const sourceField = rule.sourceField;
        const transformed = settings.transformFieldResult(config, entity, 'MOYSKLAD_TO_BITRIX24', sourceField, ms);
        if (transformed?.status === 'mapped') bitrix24[sourceField] = transformed.value;
        else if (transformed?.status === 'error' && rule.criticality === 'critical') ambiguous = `CLIENT_FIELD_TRANSFORM_FAILED:${sourceField}:${transformed.reason}`;
      }
      continue;
    }
    if (!sourceChanged || equal(sourceNow[srcField], targetNow[destField])) continue;
    const transformed = settings.transformFieldResult(config, entity, direction, destField, sourceNow);
    if (!transformed || transformed.status === 'skip') continue;
    if (transformed.status === 'error') {
      if (rule.criticality === 'critical') ambiguous = `CLIENT_FIELD_TRANSFORM_FAILED:${destField}:${transformed.reason}`;
      else logger.warn(`Optional field transform skipped (${entity}; ${destField}): ${transformed.reason}`);
      continue;
    }
    if (rule.criticality === 'critical' && isEmptyValue(transformed.value) && !isEmptyValue(targetNow[destField])) {
      criticalClears.push({ fieldTitle: destField, previousValue: targetNow[destField], restoreValue: targetNow[destField], sourceProposedValue: transformed.value });
      continue;
    }
    defaultTarget[destField] = transformed.value;
  }
  for (const group of Array.isArray(config?.groups) ? config.groups : []) {
    if (group?.entity !== entity || group.direction !== direction || !Array.isArray(group.sourceFields) || typeof group.targetField !== 'string') continue;
    const sourceFields = group.sourceFields.filter((field: unknown): field is string => typeof field === 'string');
    const changed = sourceFields.some((field: string) => !equal(sourceNow[field], sourcePrior[field]));
    if (!changed) continue;
    const targetChanged = !equal(targetNow[group.targetField], targetPrior[group.targetField]);
    if (targetChanged && !equal(targetNow[group.targetField], sourceNow[group.targetField])) {
      if (direction === 'BITRIX24_TO_MOYSKLAD') {
        const transformed = settings.transformFieldResult(config, entity, 'MOYSKLAD_TO_BITRIX24', group.sourceFields[0], ms);
        if (transformed?.status === 'error' && group.criticality === 'critical') ambiguous = `CLIENT_FIELD_TRANSFORM_FAILED:${group.targetField}:${transformed.reason}`;
        else if (transformed?.status === 'mapped') bitrix24[group.sourceFields[0]] = transformed.value;
      }
      continue;
    }
    if (targetChanged) continue;
    const transformed = settings.transformFieldResult(config, entity, direction, group.targetField, sourceNow);
    if (transformed?.status === 'error') {
      if (group.criticality === 'critical') ambiguous = `CLIENT_FIELD_TRANSFORM_FAILED:${group.targetField}:${transformed.reason}`;
      else logger.warn(`Optional field group transform skipped (${entity}; ${group.targetField}): ${transformed.reason}`);
    } else if (transformed?.status === 'mapped' && !equal(transformed.value, targetNow[group.targetField])) {
      if (group.criticality === 'critical' && isEmptyValue(transformed.value) && !isEmptyValue(targetNow[group.targetField])) {
        criticalClears.push({ fieldTitle: group.targetField, previousValue: targetNow[group.targetField], restoreValue: targetNow[group.targetField], sourceProposedValue: transformed.value });
      } else defaultTarget[group.targetField] = transformed.value;
    }
  }
  return { bitrix24, moysklad, ambiguous, criticalClears };
}

function equal(a: unknown, b: unknown) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
function isEmptyValue(value: unknown) { return value === null || value === undefined || typeof value === 'string' && value.trim() === ''; }
function matchesWrittenFields(writes: Record<string, unknown>, readback: Record<string, unknown>) {
  return Object.entries(writes).every(([field, value]) => Object.prototype.hasOwnProperty.call(readback, field) && equal(readback[field], value));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function safeReason(error: unknown) { return error instanceof Error ? error.message.slice(0, 120) : 'unknown'; }
function isUniqueConstraintError(error: unknown) { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002'; }
function isMarkedDuplicate(value: unknown) {
  return value === true || value === 1 || value === '1' || value === 'Y' || value === 'y' || value === 'true'
    || typeof value === 'string' && value.trim().toLocaleLowerCase('ru-RU') === 'дубль';
}
async function readSourceRecord(gateway: ClientSyncGateway, sourceSystem: ClientSystem, entity: 'COMPANY' | 'CONTACT', id: string, parentId: string | null) {
  if (sourceSystem === 'BITRIX24') return gateway.readBitrix(entity, id);
  return gateway.readMoysklad(entity === 'CONTACT' && parentId ? 'contactperson' : 'counterparty', id, parentId);
}
function stringValue(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function firstValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const field = value.find((item) => isRecord(item) && typeof item.VALUE === 'string' && item.VALUE.trim());
    return field && isRecord(field) ? String(field.VALUE).trim() : null;
  }
  return null;
}
function personNameFromBitrix(record: ClientRecord): string | null {
  const parts = [record.LAST_NAME, record.NAME, record.SECOND_NAME].filter((part): part is string => typeof part === 'string' && Boolean(part.trim()));
  return parts.length ? parts.join(' ').trim() : null;
}
function controlledClientName(entity: 'COMPANY' | 'CONTACT', record: ClientRecord): string {
  if (entity === 'COMPANY') return String(record.TITLE ?? record.name ?? '').trim();
  return personNameFromBitrix(record) ?? String(record.name ?? '').trim();
}
function idFromMeta(value: unknown): string | null {
  if (typeof value === 'string') return value.split('/').filter(Boolean).at(-1) ?? null;
  if (!isRecord(value)) return null;
  if (typeof value.id === 'string') return value.id;
  const href = isRecord(value.meta) && typeof value.meta.href === 'string' ? value.meta.href : null;
  return href?.split('/').filter(Boolean).at(-1) ?? null;
}
function parentIdFromEvent(event: PersistedEvent): string | null {
  const payload = isRecord(event.payload) ? event.payload : {};
  const events = Array.isArray(payload.events) ? payload.events : [];
  const child = events.find(isRecord) ?? payload;
  const meta = isRecord(child) && isRecord(child.meta) ? child.meta : {};
  const href = typeof meta.href === 'string' ? meta.href : '';
  const parts = href.split('/').filter(Boolean);
  const contactpersons = parts.lastIndexOf('contactpersons');
  return contactpersons >= 1 ? parts[contactpersons - 1] ?? null : null;
}
function configuredCreateFields(config: unknown, entity: string, direction: 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24', source: ClientRecord, settings: FieldSettingsService): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (!isRecord(config)) return output;
  const rules = Array.isArray(config.rules) ? config.rules : [];
  for (const rule of rules) {
    if (!isRecord(rule) || rule.entity !== entity || typeof rule.sourceField !== 'string' || typeof rule.targetField !== 'string') continue;
    const configKey = direction === 'BITRIX24_TO_MOYSKLAD' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
    if (!isRecord(rule[configKey]) || rule[configKey].enabled !== true) continue;
    const targetField = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.targetField : rule.sourceField;
    const transformed = settings.transformFieldResult(config, entity, direction, targetField, source);
    if (transformed?.status === 'mapped') output[targetField] = transformed.value;
    else if (transformed?.status === 'error' && rule.criticality === 'critical') throw new Error(`CLIENT_FIELD_TRANSFORM_FAILED:${targetField}:${transformed.reason}`);
  }
  const groups = Array.isArray(config.groups) ? config.groups : [];
  for (const group of groups) {
    if (!isRecord(group) || group.entity !== entity || group.direction !== direction || typeof group.targetField !== 'string') continue;
    const transformed = settings.transformFieldResult(config, entity, direction, group.targetField, source);
    if (transformed?.status === 'mapped') output[group.targetField] = transformed.value;
    else if (transformed?.status === 'error' && group.criticality === 'critical') throw new Error(`CLIENT_FIELD_TRANSFORM_FAILED:${group.targetField}:${transformed.reason}`);
  }
  return output;
}

type ClientFenceTransaction = Pick<Prisma.TransactionClient, 'eventWorkerLease' | 'inboundEntityLock'>;
type ClientRuntimeLease = { assertOwned(): Promise<void>; assertOwnedIn(transaction: ClientFenceTransaction): Promise<void>; release(): Promise<void> };

async function assertFenceInTransaction(fence: EventWorkerLeaseContext | undefined, transaction: ClientFenceTransaction): Promise<void> {
  if (fence?.assertOwnedIn) await fence.assertOwnedIn(transaction);
  else await fence?.assertOwned();
}

function runtimeLockKey(sourceSystem: ClientSystem, entity: 'COMPANY' | 'CONTACT', sourceId: string): string {
  return `client:${createHash('sha256').update([sourceSystem, entity, sourceId].join('\0')).digest('hex')}`;
}

function leaseProxy<T extends object>(target: T, lease: EventWorkerLeaseContext): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await lease.assertOwned();
        const result = await value.apply(object, args);
        try { await lease.assertOwned(); }
        catch (error) {
          if (property === 'createTarget') throw Object.assign(new Error('CLIENT_CREATE_RESPONSE_UNCERTAIN'), { uncertainWrite: true });
          throw error;
        }
        return result;
      };
    },
  });
}
