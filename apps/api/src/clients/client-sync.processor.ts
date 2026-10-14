import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { SyncModeService } from '../sync-mode.service';
import { ClientRecord, ClientSyncGateway } from './client-sync.gateway';
import { chooseCandidate, ClientRuntimeResolver, ClientSource, ClientSystem } from './client-runtime-resolver';
import { CLIENT_CANDIDATE_GATEWAY, WritableClientCandidateGateway } from './client-candidate.gateway';
import { lockEntityPairState } from '../pairs/pair-db-lock';
import { ClientDependencyInput, ClientDependencyResolution, ClientDependencyResolver } from './client-dependency-resolver';
import { EventWorkerLeaseContext, EventWorkerLeaseService } from '../event-worker-lease.service';

const logger = new Logger('ClientSyncProcessor');
export const CLIENT_SYNC_GATEWAY = Symbol('CLIENT_SYNC_GATEWAY');

type PersistedEvent = {
  id: string; source: string; eventType: string | null; externalEntityType: string | null;
  externalEntityId: string | null; status: string; lastErrorCategory: string | null; processingStartedAt?: Date | null; payload?: unknown;
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
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: FieldSettingsService,
    private readonly syncMode: SyncModeService,
    @Optional() @Inject(CLIENT_SYNC_GATEWAY) private readonly gateway?: ClientSyncGateway,
    @Optional() @Inject(CLIENT_CANDIDATE_GATEWAY) private readonly candidateGateway?: WritableClientCandidateGateway,
    @Optional() private readonly workerLease?: EventWorkerLeaseService,
  ) {}

  supports(event: { source?: string; eventType?: string | null; externalEntityType?: string | null }): boolean {
    return Boolean(entityForEvent(event));
  }

  async recoverPending(): Promise<void> {
    const now = new Date();
    const pending = await this.database.inboundEvent.findMany({
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
    for (const event of pending) {
      if (event.status === 'RETRYABLE_FAILURE') {
        const reset = await this.database.inboundEvent.updateMany({
          where: { id: event.id, status: 'RETRYABLE_FAILURE', OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
          data: { status: 'RECEIVED', retryAfter: null, lastErrorCategory: null },
        });
        if (reset.count !== 1) continue;
      }
      this.enqueue(event.id);
    }
  }

  async resolveForDocument(input: ClientDependencyInput, workerLease?: EventWorkerLeaseContext): Promise<ClientDependencyResolution> {
    const event = await this.database.inboundEvent.findUnique({ where: { id: input.eventId } }) as PersistedEvent | null;
    const expectedStatus = workerLease ? 'PROCESSING' : 'RECEIVED';
    if (!event || event.status !== expectedStatus) return { status: 'REVIEW', reason: 'CLIENT_OWNER_EVENT_NOT_CLAIMED' };
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
      gateway = leaseProxy(this.gateway, fence);
      candidateGateway = leaseProxy(this.candidateGateway, fence);
      await assertOwned();
      const pinned = await this.settings.eventConfig(input.eventId);
      const unresolvedCreate = await this.database.pairReviewCase.findFirst({
        where: { entityType: input.entity, sourceSystem: input.sourceSystem, sourceEntityId: input.sourceId, status: 'OPEN', reason: 'CLIENT_CREATE_IN_PROGRESS' },
      });
      if (unresolvedCreate) {
        return await this.dependencyHold(event, 'CLIENT_CREATE_RESPONSE_UNCERTAIN', { entity: input.entity, sourceId: input.sourceId, pairReviewId: unresolvedCreate.id }, fence ?? workerLease);
      }
      let selectedSourceId = input.sourceId;
      const savedPairBeforeRead = input.entity === 'CONTACT'
        ? await this.findPersistedPair(input.entity, selectedSourceId, input.sourceSystem)
        : null;
      const sourceParentId = input.sourceSystem === 'MOYSKLAD' && input.entity === 'CONTACT'
        ? input.primaryCompanySourceId ?? savedPairBeforeRead?.moyskladParentId ?? null
        : input.primaryCompanySourceId ?? null;
      if (input.sourceSystem === 'MOYSKLAD' && input.entity === 'CONTACT' && !sourceParentId) {
        return await this.dependencyHold(event, 'CLIENT_CONTACT_SOURCE_PARENT_MISSING', { sourceId: selectedSourceId }, fence);
      }
      const sourceRecord = await readSourceRecord(gateway, input.sourceSystem, input.entity, selectedSourceId, sourceParentId);
      if (input.entity === 'CONTACT') {
        const nativeParentId = input.sourceSystem === 'BITRIX24'
          ? stringValue(sourceRecord.COMPANY_ID)
          : idFromMeta(sourceRecord.company) ?? idFromMeta(sourceRecord.agent);
        if (input.primaryCompanySourceId && nativeParentId && input.primaryCompanySourceId !== nativeParentId) {
          return await this.dependencyHold(event, 'CLIENT_CONTACT_PRIMARY_COMPANY_CONFLICT', { sourceId: selectedSourceId, explicitParentId: input.primaryCompanySourceId, nativeParentId }, fence);
        }
      }

      if (input.sourceSystem === 'BITRIX24' && input.entity === 'CONTACT' && isMarkedDuplicate(sourceRecord.UF_CRM_1789126649744)) {
        const companyId = stringValue(sourceRecord.COMPANY_ID) ?? input.primaryCompanySourceId ?? null;
        if (!companyId) return await this.dependencyHold(event, 'DUPLICATE_CONTACT_WITHOUT_VALID_COMPANY', { sourceId: input.sourceId }, fence);
        const companyResolution = await this.resolveForDocument({ ...input, entity: 'COMPANY', sourceId: companyId, primaryCompanySourceId: null }, workerLease);
        if (companyResolution.status !== 'RESOLVED') return { status: 'REVIEW', reason: 'DUPLICATE_CONTACT_COMPANY_UNRESOLVED' };
        const companyPair = companyResolution.pair;
        try { await gateway.readMoysklad('counterparty', companyPair.moyskladId, null); }
        catch { return await this.dependencyHold(event, 'DUPLICATE_CONTACT_COMPANY_TARGET_UNAVAILABLE', { companyId, pairId: companyPair.id }, fence); }
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
            return await this.dependencyHold(event, 'DUPLICATE_COMPANY_CANONICAL_AMBIGUOUS', { sourceId: input.sourceId, candidates }, fence);
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
            return await this.dependencyHold(event, 'DUPLICATE_COMPANY_CANONICAL_AMBIGUOUS', { sourceId: input.sourceId, candidates }, fence);
          }
          if (choice.action === 'USE_CANDIDATE') selectedSourceId = choice.targetId;
        }
      }

      const pair = savedPairBeforeRead ?? await this.findPersistedPair(input.entity, selectedSourceId, input.sourceSystem);
      if (pair) {
        try {
          if (pair.moyskladType !== 'counterparty' && pair.moyskladType !== 'contactperson') {
            return await this.dependencyHold(event, 'CLIENT_PERSISTED_PAIR_TYPE_UNKNOWN', { entity: input.entity, selectedSourceId, pairId: pair.id, moyskladType: pair.moyskladType }, fence);
          }
          if (input.entity === 'COMPANY' && pair.moyskladType !== 'counterparty') {
            return await this.dependencyHold(event, 'CLIENT_PERSISTED_PAIR_TYPE_MISMATCH', { entity: input.entity, selectedSourceId, pairId: pair.id, moyskladType: pair.moyskladType }, fence);
          }
          let moyskladRecord: ClientRecord | null = null;
          if (input.sourceSystem === 'BITRIX24') {
            moyskladRecord = await gateway.readMoysklad(pair.moyskladType, pair.moyskladId, pair.moyskladParentId);
          } else await gateway.readBitrix(input.entity, pair.bitrix24Id);
          if (input.entity === 'CONTACT' && pair.moyskladType === 'counterparty') {
            const individual = input.sourceSystem === 'BITRIX24'
              ? stringValue(moyskladRecord?.companyType)?.toLowerCase() === 'individual'
              : stringValue(sourceRecord.companyType)?.toLowerCase() === 'individual';
            if (!individual) return await this.dependencyHold(event, 'CLIENT_CONTACT_TARGET_NOT_INDIVIDUAL', { selectedSourceId, pairId: pair.id, moyskladType: pair.moyskladType, companyType: (input.sourceSystem === 'BITRIX24' ? moyskladRecord?.companyType : sourceRecord.companyType) ?? null }, fence);
          }
          if (input.entity === 'CONTACT' && pair.moyskladType === 'contactperson') {
            const sourceCompanyId = input.sourceSystem === 'BITRIX24'
              ? stringValue(sourceRecord.COMPANY_ID) ?? input.primaryCompanySourceId
              : idFromMeta(sourceRecord.company) ?? idFromMeta(sourceRecord.agent) ?? input.primaryCompanySourceId ?? sourceParentId;
            const companyPair = sourceCompanyId ? await this.findPersistedPair('COMPANY', sourceCompanyId, input.sourceSystem) : null;
            const actualParentId = input.sourceSystem === 'BITRIX24'
              ? idFromMeta(moyskladRecord?.company) ?? idFromMeta(moyskladRecord?.agent)
              : idFromMeta(sourceRecord.company) ?? idFromMeta(sourceRecord.agent);
            if (!pair.moyskladParentId || !companyPair || pair.moyskladParentId !== companyPair.moyskladId || (actualParentId && actualParentId !== pair.moyskladParentId)) {
              return await this.dependencyHold(event, 'CLIENT_CONTACTPERSON_PARENT_MISMATCH', { selectedSourceId, pairId: pair.id, savedParentId: pair.moyskladParentId, expectedParentId: companyPair?.moyskladId ?? null, actualParentId }, fence);
            }
          }
          const reason = selectedSourceId === input.sourceId ? 'PERSISTED_PAIR' : 'DUPLICATE_COMPANY_CANONICALIZED';
          await this.logDependencyResolution(event.id, input, pair, reason, fence);
          return { status: 'RESOLVED', pair, selectedSourceId, reason };
        } catch {
          return await this.dependencyHold(event, 'CLIENT_PERSISTED_TARGET_UNAVAILABLE', { entity: input.entity, selectedSourceId, pairId: pair.id }, fence);
        }
      }

      const eventForClient: PersistedEvent = {
        ...event,
        externalEntityId: selectedSourceId,
        externalEntityType: input.entity === 'COMPANY'
          ? input.sourceSystem === 'BITRIX24' ? 'company' : 'counterparty'
          : input.sourceSystem === 'BITRIX24' ? 'contact' : input.primaryCompanySourceId ? 'contactperson' : 'counterparty',
      };
      const resolved = await this.resolveUnpaired(eventForClient, input.entity, input.sourceSystem, pinned.config, input.primaryCompanySourceId ?? null, workerLease, fence);
      if (!resolved) return { status: 'REVIEW', reason: 'CLIENT_DEPENDENCY_REQUIRES_REVIEW' };
      const reason = selectedSourceId === input.sourceId ? 'RUNTIME_LOOKUP_OR_CREATE' : 'DUPLICATE_COMPANY_CANONICALIZED';
      await this.logDependencyResolution(event.id, input, resolved, reason, fence);
      return { status: 'RESOLVED', pair: resolved, selectedSourceId, reason };
    } catch (error) {
      if (error instanceof Error && error.message === 'CLIENT_ENTITY_LOCK_BUSY') {
        await workerLease?.assertOwned();
        return { status: 'RETRY', reason: 'CLIENT_ENTITY_LOCK_BUSY' };
      }
      const unresolvedCreate = await this.database.pairReviewCase.findFirst({
        where: { entityType: input.entity, sourceSystem: input.sourceSystem, sourceEntityId: input.sourceId, status: 'OPEN', reason: 'CLIENT_CREATE_IN_PROGRESS' },
      }).catch(() => null);
      if (unresolvedCreate) {
        return await this.dependencyHold(event, 'CLIENT_CREATE_RESPONSE_UNCERTAIN', { entity: input.entity, sourceId: input.sourceId, pairReviewId: unresolvedCreate.id }, fence);
      }
      await this.database.$transaction(async (tx) => {
        await assertFenceInTransaction(fence ?? workerLease, tx);
        if (!workerLease) await tx.inboundEvent.updateMany({ where: { id: event.id, status: expectedStatus }, data: { status: 'RETRYABLE_FAILURE', lastErrorCategory: 'CLIENT_DEPENDENCY_RETRY', retryAfter: new Date(Date.now() + 30_000) } });
        await tx.operationalLog.create({ data: { category: 'CLIENT_DEPENDENCY', message: `Document client dependency will retry: ${safeReason(error)}.`, referenceId: event.id } });
      });
      return { status: 'RETRY', reason: safeReason(error) };
    } finally {
      await sourceLease?.release().catch(() => undefined);
    }
  }

  private async findPersistedPair(entity: 'COMPANY' | 'CONTACT', sourceId: string, sourceSystem: ClientSystem) {
    return this.database.entityPair.findFirst({ where: {
      entityType: entity, active: true,
      ...(sourceSystem === 'BITRIX24' ? { bitrix24Id: sourceId } : { moyskladId: sourceId }),
    } });
  }

  private async dependencyHold(event: PersistedEvent, reason: string, diagnostic: Record<string, unknown>, workerLease?: EventWorkerLeaseContext): Promise<ClientDependencyResolution> {
    await workerLease?.assertOwned();
    await this.database.$transaction(async (tx) => {
      await assertFenceInTransaction(workerLease, tx);
      await tx.manualReviewCase.upsert({ where: { eventId: event.id }, create: {
        eventId: event.id, source: event.source, eventType: event.eventType, externalEntityId: event.externalEntityId,
        externalEntityType: event.externalEntityType, reason, diagnostic: diagnostic as Prisma.InputJsonValue,
      }, update: { reason, diagnostic: diagnostic as Prisma.InputJsonValue } });
      await tx.operationalLog.create({ data: { category: 'CLIENT_DEPENDENCY', message: `Document client dependency held: ${reason}.`, referenceId: event.id } });
      if (event.status === 'RECEIVED') await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'RECEIVED' }, data: { status: 'MANUAL_REVIEW', lastErrorCategory: reason } });
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
    if (this.workerLease) return await this.workerLease.run(eventId, (lease) => this.processWithLease(eventId, lease)) ?? 'IGNORED';
    return this.processWithLease(eventId);
  }

  private async processWithLease(eventId: string, workerLease?: EventWorkerLeaseContext): Promise<'IGNORED' | 'REVIEW' | 'BASELINE' | 'UNCHANGED' | 'SYNCED' | 'RETRY'> {
    if (this.active.has(eventId)) return 'IGNORED';
    const event = await this.database.inboundEvent.findUnique({ where: { id: eventId } }) as PersistedEvent | null;
    if (!event || !this.supports(event) || !(event.status === 'RECEIVED' || (event.status === 'PROCESSING' && (!event.processingStartedAt || event.processingStartedAt.getTime() < Date.now() - CLIENT_EVENT_LEASE_MS)))) return 'IGNORED';
    let entity = entityForEvent(event)!;
    let fence = workerLease;
    let releaseSourceLease: (() => Promise<void>) | undefined;
    this.active.add(eventId);
    try {
      const claimed = await this.database.$transaction(async (tx) => {
        await assertFenceInTransaction(workerLease, tx);
        return tx.inboundEvent.updateMany({
          where: { id: event.id, OR: [
            { status: 'RECEIVED' },
            { status: 'PROCESSING', OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: new Date(Date.now() - CLIENT_EVENT_LEASE_MS) } }] },
          ] },
          data: { status: 'PROCESSING', processingStartedAt: new Date(), attempts: { increment: 1 }, lastErrorCategory: null, retryAfter: null },
        });
      });
      if (claimed.count !== 1) return 'IGNORED';
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
      if (sourceSystem === 'BITRIX24') {
        const sourceRecord = await this.gateway.readBitrix(entity, event.externalEntityId);
        if (entity === 'COMPANY' && isMarkedDuplicate(sourceRecord.UF_CRM_1789126724375)) {
          await this.skipDuplicateEvent(event, 'DUPLICATE_COMPANY_EXCLUDED_FROM_ORDINARY_SYNC', fence);
          return 'UNCHANGED';
        }
        if (entity === 'CONTACT' && isMarkedDuplicate(sourceRecord.UF_CRM_1789126649744)) {
          const companyId = stringValue(sourceRecord.COMPANY_ID);
          const companyResolution = companyId ? await this.resolveForDocument({ eventId: event.id, sourceSystem, entity: 'COMPANY', sourceId: companyId }, fence) : null;
          if (!companyResolution || companyResolution.status !== 'RESOLVED') return await this.hold(event, 'DUPLICATE_CONTACT_COMPANY_UNRESOLVED', { sourceId: event.externalEntityId, companyId }, fence);
          const companyPair = companyResolution.pair;
          await this.skipDuplicateEvent(event, 'DUPLICATE_CONTACT_OMITTED_COMPANY_RESOLVED', fence);
          return 'UNCHANGED';
        }
      }
      let pair = await this.database.entityPair.findFirst({
        where: { entityType: entity, active: true, ...(event.source === 'BITRIX24' ? { bitrix24Id: event.externalEntityId } : { moyskladId: event.externalEntityId }) },
      });
      if (!pair && sourceSystem === 'MOYSKLAD' && event.externalEntityType === 'counterparty') {
        const record = await this.gateway.readMoysklad('counterparty', event.externalEntityId, null);
        if (stringValue(record.companyType)?.toLowerCase() === 'individual') entity = 'CONTACT';
      }
      if (!pair) pair = await this.resolveUnpaired(event, entity, sourceSystem, eventConfig.config, null, fence);
      if (!pair) return 'REVIEW';

      const config = eventConfig;
      const bitrixEntity = entity === 'COMPANY' ? 'COMPANY' : 'CONTACT';
      const msType = pair.moyskladType === 'contactperson' ? 'contactperson' : 'counterparty';
      const [bitrix, moysklad] = await Promise.all([
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
      const prior = await this.database.entityPairSyncState.findUnique({ where: { pairId: pair.id } });
      const current = { bitrix24Values: selectFields(bitrix, applicable, groups, 'BITRIX24'), moyskladValues: selectFields(moysklad, applicable, groups, 'MOYSKLAD') };

      // First read establishes a comparison point, never a bulk write.
      if (!prior) {
        await this.database.$transaction(async (tx) => {
          await assertFenceInTransaction(fence, tx);
          await tx.entityPairBaseline.upsert({ where: { pairId: pair.id }, create: {
            pairId: pair.id, eventId: event.id, settingsVersion: config.version,
            bitrix24Values: current.bitrix24Values as Prisma.InputJsonValue, moyskladValues: current.moyskladValues as Prisma.InputJsonValue,
          }, update: {} });
          await tx.entityPairSyncState.create({ data: { pairId: pair.id, settingsVersion: config.version, bitrix24Values: current.bitrix24Values as Prisma.InputJsonValue, moyskladValues: current.moyskladValues as Prisma.InputJsonValue } });
          await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'PROCESSING' }, data: { status: 'UNCHANGED', processingStartedAt: null, direction: null, lastSuccessfulAt: new Date(), lastErrorCategory: null } });
          await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Initial client baseline captured; no fields written (pair ${pair.id}).`, referenceId: event.id } });
        });
        return 'BASELINE';
      }

      const direction = event.source === 'BITRIX24' ? 'BITRIX24_TO_MOYSKLAD' : 'MOYSKLAD_TO_BITRIX24';
      const writes = buildWrites(config.config, mappingEntity, direction, bitrix, moysklad, prior, applicable, this.settings);
      if (writes.ambiguous) return this.hold(event, writes.ambiguous, { pairId: pair.id });
      if (Object.keys(writes.moysklad).length) { await fence?.assertOwned(); await this.gateway.updateMoysklad(msType, pair.moyskladId, pair.moyskladParentId, writes.moysklad, event.id); }
      if (Object.keys(writes.bitrix24).length) { await fence?.assertOwned(); await this.gateway.updateBitrix(bitrixEntity, pair.bitrix24Id, writes.bitrix24, event.id); }
      const [afterBitrix, afterMoysklad] = await Promise.all([
        this.gateway.readBitrix(bitrixEntity, pair.bitrix24Id),
        this.gateway.readMoysklad(msType, pair.moyskladId, pair.moyskladParentId),
      ]);
      const confirmed = { bitrix24Values: selectFields(afterBitrix, applicable, groups, 'BITRIX24'), moyskladValues: selectFields(afterMoysklad, applicable, groups, 'MOYSKLAD') };
      await this.database.$transaction(async (tx) => {
        await assertFenceInTransaction(fence, tx);
        await tx.entityPairSyncState.update({ where: { pairId: pair.id }, data: { settingsVersion: config.version, bitrix24Values: confirmed.bitrix24Values as Prisma.InputJsonValue, moyskladValues: confirmed.moyskladValues as Prisma.InputJsonValue } });
        await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'PROCESSING' }, data: { status: 'SUCCEEDED', processingStartedAt: null, direction, lastSuccessfulAt: new Date(), lastErrorCategory: null } });
        const updatedFields = [...Object.keys(writes.moysklad), ...Object.keys(writes.bitrix24)];
        await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: updatedFields.length ? `Configured fields synchronized (MoySklad wins conflicts): ${updatedFields.join(', ')} (pair ${pair.id}).` : `No configured field changes to synchronize (pair ${pair.id}).`, referenceId: event.id } });
      });
      return Object.keys(writes.moysklad).length || Object.keys(writes.bitrix24).length ? 'SYNCED' : 'UNCHANGED';
    } catch (error) {
      await this.database.$transaction(async (tx) => {
        await assertFenceInTransaction(fence, tx);
        await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'PROCESSING' }, data: { status: 'RETRYABLE_FAILURE', processingStartedAt: null, lastErrorCategory: 'CLIENT_SYNC_FAILURE', retryAfter: new Date(Date.now() + 30_000) } });
        await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Client sync held for retry: ${safeReason(error)}.`, referenceId: event.id } });
      }).catch(() => undefined);
      return 'RETRY';
    } finally {
      await releaseSourceLease?.().catch(() => undefined);
      this.active.delete(eventId);
    }
  }

  private async resolveUnpaired(event: PersistedEvent, entity: 'COMPANY' | 'CONTACT', sourceSystem: ClientSystem, config: unknown, primaryCompanyOverride: string | null = null, workerLease?: EventWorkerLeaseContext, parentFence?: EventWorkerLeaseContext): Promise<any | null> {
    const ownedLease = workerLease ? null : await this.acquireRuntimeLease(sourceSystem, entity, event.externalEntityId!, event.id);
    const fence = parentFence ?? workerLease ?? ownedLease!;
    try {
      await fence.assertOwned();
      const persisted = await this.findPersistedPair(entity, event.externalEntityId!, sourceSystem);
      if (persisted) return persisted;
      return await this.resolveUnpairedWithLease(event, entity, sourceSystem, config, primaryCompanyOverride, workerLease, fence);
    } finally {
      await ownedLease?.release().catch(() => undefined);
    }
  }

  private async resolveUnpairedWithLease(event: PersistedEvent, entity: 'COMPANY' | 'CONTACT', sourceSystem: ClientSystem, config: unknown, primaryCompanyOverride: string | null, workerLease: EventWorkerLeaseContext | undefined, fence: EventWorkerLeaseContext): Promise<any | null> {
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
        ? stringValue(record.COMPANY_ID)
        : primaryCompanyOverride ?? sourceContactParentId ?? idFromMeta(record.agent);
      if (primaryCompanySourceId) {
        const companyResolution = await this.resolveForDocument({ eventId: event.id, sourceSystem, entity: 'COMPANY', sourceId: primaryCompanySourceId }, workerLease);
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
    const resolution = await new ClientRuntimeResolver(candidateGateway).resolve(source, primaryCompanyTargetId);
    if (resolution.action === 'MANUAL_REVIEW') {
      await this.hold(event, `CLIENT_${resolution.reason}`, { entity, sourceSystem, sourceId, primaryCompanySourceId, candidates: resolution.candidates }, fence);
      return null;
    }

    let targetId: string | null = resolution.action === 'CREATE' ? null : resolution.targetId;
    let targetType = resolution.targetType;
    if (resolution.action === 'CREATE') {
      const mappingEntity = entity === 'COMPANY' ? 'companies' : 'contacts-companies';
      const direction = sourceSystem === 'BITRIX24' ? 'BITRIX24_TO_MOYSKLAD' : 'MOYSKLAD_TO_BITRIX24';
      const configuredFields = configuredCreateFields(config, mappingEntity, direction, record, this.settings);
      const concurrentlyPaired = await this.markCreateInProgress(event, entity, sourceSystem, sourceId, fence);
      if (concurrentlyPaired) return concurrentlyPaired;
      targetId = await candidateGateway.createTarget({
        entity, targetSystem: resolution.targetSystem, targetType: resolution.targetType,
        parentId: primaryCompanyTargetId, source: record, configuredFields, eventId: event.id,
      });
      targetType = resolution.targetType;
    }

    if (!targetId) {
      await this.hold(event, 'CLIENT_RUNTIME_TARGET_ID_MISSING', { entity, sourceSystem, sourceId, resolution: resolution.action }, fence);
      return null;
    }
    const bitrix24Id = sourceSystem === 'BITRIX24' ? sourceId : targetId;
    const moyskladId = sourceSystem === 'BITRIX24' ? targetId : sourceId;
    const moyskladType = sourceSystem === 'BITRIX24'
      ? targetType === 'contactperson' ? 'contactperson' : 'counterparty'
      : event.externalEntityType === 'contactperson' ? 'contactperson' : 'counterparty';
    const moyskladParentId = entity === 'CONTACT'
      ? sourceSystem === 'BITRIX24' ? (targetType === 'contactperson' ? primaryCompanyTargetId : null) : sourceContactParentId
      : null;

    try {
      await workerLease?.assertOwned();
      const pair = await this.database.$transaction(async (tx) => {
        await assertFenceInTransaction(fence, tx);
        await lockEntityPairState(tx);
        const sourceField = sourceSystem === 'BITRIX24' ? 'bitrix24Id' : 'moyskladId';
        const existing = await tx.entityPair.findFirst({ where: { entityType: entity, active: true, [sourceField]: sourceId } });
        if (existing) return existing;
        const conflict = await tx.entityPair.findFirst({
          where: { entityType: entity, active: true, OR: [{ bitrix24Id }, { moyskladId }] },
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

  private async markCreateInProgress(event: PersistedEvent, entity: 'COMPANY' | 'CONTACT', sourceSystem: ClientSystem, sourceId: string, workerLease: EventWorkerLeaseContext) {
    await workerLease?.assertOwned();
    return this.database.$transaction(async (tx) => {
      await assertFenceInTransaction(workerLease, tx);
      await lockEntityPairState(tx);
      const sourceField = sourceSystem === 'BITRIX24' ? 'bitrix24Id' : 'moyskladId';
      const persisted = await tx.entityPair.findFirst({ where: { entityType: entity, active: true, [sourceField]: sourceId } });
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
        externalEntityType: event.externalEntityType, reason, diagnostic: diagnostic as Prisma.InputJsonValue,
      }, update: { reason, diagnostic: diagnostic as Prisma.InputJsonValue } });
      await tx.inboundEvent.updateMany({ where: { id: event.id, status: event.status }, data: { status: 'MANUAL_REVIEW', processingStartedAt: null, lastErrorCategory: reason } });
      await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Client event requires review: ${reason}.`, referenceId: event.id } });
    });
    return 'REVIEW';
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

function buildWrites(config: any, entity: string, direction: 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24', bitrix: ClientRecord, ms: ClientRecord, prior: { bitrix24Values: unknown; moyskladValues: unknown }, rules: any[], settings: FieldSettingsService) {
  const bitrix24: Record<string, unknown> = {};
  const moysklad: Record<string, unknown> = {};
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
    const beforeSource = sourcePrior[srcField]; const beforeTarget = targetPrior[destField];
    const sourceChanged = !equal(sourceNow[srcField], beforeSource);
    const targetChanged = !equal(targetNow[destField], beforeTarget);
    if (sourceChanged && targetChanged && !equal(sourceNow[srcField], targetNow[destField])) {
      // The documented conflict policy is deterministic: MoySklad's current
      // value wins even when the event was triggered by the Bitrix24 edit.
      if (direction === 'MOYSKLAD_TO_BITRIX24') {
        const transformed = settings.transformField(config, entity, direction, destField, sourceNow);
        if (transformed && !transformed.error) bitrix24[destField] = transformed.value;
      } else {
        const sourceField = rule.sourceField;
        const transformed = settings.transformField(config, entity, 'MOYSKLAD_TO_BITRIX24', sourceField, ms);
        if (transformed && !transformed.error) bitrix24[sourceField] = transformed.value;
      }
      continue;
    }
    if (!sourceChanged || equal(sourceNow[srcField], targetNow[destField])) continue;
    const transformed = settings.transformField(config, entity, direction, destField, sourceNow);
    if (!transformed || transformed.error) continue;
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
        const transformed = settings.transformField(config, entity, 'MOYSKLAD_TO_BITRIX24', group.sourceFields[0], ms);
        if (transformed && !transformed.error) bitrix24[group.sourceFields[0]] = transformed.value;
      }
      continue;
    }
    if (targetChanged) continue;
    const transformed = settings.transformField(config, entity, direction, group.targetField, sourceNow);
    if (transformed && !transformed.error && !equal(transformed.value, targetNow[group.targetField])) defaultTarget[group.targetField] = transformed.value;
  }
  return { bitrix24, moysklad, ambiguous: null as string | null };
}

function equal(a: unknown, b: unknown) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function safeReason(error: unknown) { return error instanceof Error ? error.message.slice(0, 120) : 'unknown'; }
function isUniqueConstraintError(error: unknown) { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002'; }
function isMarkedDuplicate(value: unknown) { return value === true || value === 1 || value === '1' || value === 'Y' || value === 'y' || value === 'true'; }
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
    const transformed = settings.transformField(config, entity, direction, targetField, source);
    if (transformed && !transformed.error) output[targetField] = transformed.value;
  }
  const groups = Array.isArray(config.groups) ? config.groups : [];
  for (const group of groups) {
    if (!isRecord(group) || group.entity !== entity || group.direction !== direction || typeof group.targetField !== 'string') continue;
    const transformed = settings.transformField(config, entity, direction, group.targetField, source);
    if (transformed && !transformed.error) output[group.targetField] = transformed.value;
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
