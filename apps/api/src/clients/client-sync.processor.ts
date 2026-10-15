import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { SyncModeService } from '../sync-mode.service';
import { ClientRecord, ClientSyncGateway } from './client-sync.gateway';
import { chooseCandidate, ClientRuntimeResolver, ClientSource, ClientSystem } from './client-runtime-resolver';
import { CLIENT_CANDIDATE_GATEWAY, WritableClientCandidateGateway } from './client-candidate.gateway';
import { lockEntityPairState } from '../pairs/pair-db-lock';
import { ClientDependencyInput, ClientDependencyResolution, ClientDependencyResolver } from './client-dependency-resolver';

const logger = new Logger('ClientSyncProcessor');
export const CLIENT_SYNC_GATEWAY = Symbol('CLIENT_SYNC_GATEWAY');

type PersistedEvent = {
  id: string; source: string; eventType: string | null; externalEntityType: string | null;
  externalEntityId: string | null; status: string; lastErrorCategory: string | null; payload?: unknown;
};

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
  ) {}

  supports(event: { source?: string; eventType?: string | null; externalEntityType?: string | null }): boolean {
    return Boolean(entityForEvent(event));
  }

  async resolveForDocument(input: ClientDependencyInput): Promise<ClientDependencyResolution> {
    const event = await this.database.inboundEvent.findUnique({ where: { id: input.eventId } }) as PersistedEvent | null;
    if (!event || event.status !== 'RECEIVED') return { status: 'REVIEW', reason: 'CLIENT_OWNER_EVENT_NOT_RECEIVED' };
    if ((await this.syncMode.read()).mode !== 'on') return { status: 'RETRY', reason: 'CLIENT_SYNC_MODE_NOT_ON' };
    if (!this.gateway || !this.candidateGateway) return { status: 'RETRY', reason: 'CLIENT_RUNTIME_GATEWAY_UNAVAILABLE' };

    try {
      const pinned = await this.settings.eventConfig(input.eventId);
      let selectedSourceId = input.sourceId;
      const savedPairBeforeRead = input.entity === 'CONTACT'
        ? await this.findPersistedPair(input.entity, selectedSourceId, input.sourceSystem)
        : null;
      const sourceParentId = input.sourceSystem === 'MOYSKLAD' && input.entity === 'CONTACT'
        ? input.primaryCompanySourceId ?? savedPairBeforeRead?.moyskladParentId ?? null
        : input.primaryCompanySourceId ?? null;
      if (input.sourceSystem === 'MOYSKLAD' && input.entity === 'CONTACT' && !sourceParentId) {
        return this.dependencyHold(event, 'CLIENT_CONTACT_SOURCE_PARENT_MISSING', { sourceId: selectedSourceId });
      }
      const sourceRecord = await readSourceRecord(this.gateway, input.sourceSystem, input.entity, selectedSourceId, sourceParentId);
      if (input.entity === 'CONTACT') {
        const nativeParentId = input.sourceSystem === 'BITRIX24'
          ? stringValue(sourceRecord.COMPANY_ID)
          : idFromMeta(sourceRecord.company) ?? idFromMeta(sourceRecord.agent);
        if (input.primaryCompanySourceId && nativeParentId && input.primaryCompanySourceId !== nativeParentId) {
          return this.dependencyHold(event, 'CLIENT_CONTACT_PRIMARY_COMPANY_CONFLICT', { sourceId: selectedSourceId, explicitParentId: input.primaryCompanySourceId, nativeParentId });
        }
      }

      if (input.sourceSystem === 'BITRIX24' && input.entity === 'CONTACT' && isMarkedDuplicate(sourceRecord.UF_CRM_1789126649744)) {
        const companyId = stringValue(sourceRecord.COMPANY_ID) ?? input.primaryCompanySourceId ?? null;
        if (!companyId) return this.dependencyHold(event, 'DUPLICATE_CONTACT_WITHOUT_VALID_COMPANY', { sourceId: input.sourceId });
        const companyResolution = await this.resolveForDocument({ ...input, entity: 'COMPANY', sourceId: companyId, primaryCompanySourceId: null });
        if (companyResolution.status !== 'RESOLVED') return { status: 'REVIEW', reason: 'DUPLICATE_CONTACT_COMPANY_UNRESOLVED' };
        const companyPair = companyResolution.pair;
        try { await this.gateway.readMoysklad('counterparty', companyPair.moyskladId, null); }
        catch { return this.dependencyHold(event, 'DUPLICATE_CONTACT_COMPANY_TARGET_UNAVAILABLE', { companyId, pairId: companyPair.id }); }
        await this.logDependencyResolution(event.id, input, companyPair, 'DUPLICATE_CONTACT_OMITTED');
        return { status: 'OMITTED', reason: 'DUPLICATE_CONTACT', companyPair };
      }

      if (input.sourceSystem === 'BITRIX24' && input.entity === 'COMPANY' && isMarkedDuplicate(sourceRecord.UF_CRM_1789126724375)) {
        const inn = await this.candidateGateway.readCompanyInn('BITRIX24', input.sourceId);
        const equivalents = await this.candidateGateway.unmarkedBitrixCompanyEquivalents({
          id: input.sourceId, name: stringValue(sourceRecord.TITLE), phone: firstValue(sourceRecord.PHONE), inn,
        });
        const eligibleEquivalents = equivalents.filter((candidate) => !candidate.occupiedByPair);
        if (eligibleEquivalents.length) {
          const choice = chooseCandidate(eligibleEquivalents, inn ? 'unmarked_duplicate_company_exact_inn' : 'unmarked_duplicate_company_exact_name_and_phone', 'BITRIX24');
          if (!choice || choice.action === 'MANUAL_REVIEW') {
            const candidates = choice?.action === 'MANUAL_REVIEW' ? choice.candidates : eligibleEquivalents.map((candidate) => candidate.id);
            return this.dependencyHold(event, 'DUPLICATE_COMPANY_CANONICAL_AMBIGUOUS', { sourceId: input.sourceId, candidates });
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
            return this.dependencyHold(event, 'DUPLICATE_COMPANY_CANONICAL_AMBIGUOUS', { sourceId: input.sourceId, candidates });
          }
          if (choice.action === 'USE_CANDIDATE') selectedSourceId = choice.targetId;
        }
      }

      const pair = savedPairBeforeRead ?? await this.findPersistedPair(input.entity, selectedSourceId, input.sourceSystem);
      if (pair) {
        try {
          if (pair.moyskladType !== 'counterparty' && pair.moyskladType !== 'contactperson') {
            return this.dependencyHold(event, 'CLIENT_PERSISTED_PAIR_TYPE_UNKNOWN', { entity: input.entity, selectedSourceId, pairId: pair.id, moyskladType: pair.moyskladType });
          }
          if (input.entity === 'COMPANY' && pair.moyskladType !== 'counterparty') {
            return this.dependencyHold(event, 'CLIENT_PERSISTED_PAIR_TYPE_MISMATCH', { entity: input.entity, selectedSourceId, pairId: pair.id, moyskladType: pair.moyskladType });
          }
          let moyskladRecord: ClientRecord | null = null;
          if (input.sourceSystem === 'BITRIX24') {
            moyskladRecord = await this.gateway.readMoysklad(pair.moyskladType, pair.moyskladId, pair.moyskladParentId);
          } else await this.gateway.readBitrix(input.entity, pair.bitrix24Id);
          if (input.entity === 'CONTACT' && pair.moyskladType === 'counterparty') {
            const individual = input.sourceSystem === 'BITRIX24'
              ? stringValue(moyskladRecord?.companyType)?.toLowerCase() === 'individual'
              : stringValue(sourceRecord.companyType)?.toLowerCase() === 'individual';
            if (!individual) return this.dependencyHold(event, 'CLIENT_CONTACT_TARGET_NOT_INDIVIDUAL', { selectedSourceId, pairId: pair.id, moyskladType: pair.moyskladType, companyType: (input.sourceSystem === 'BITRIX24' ? moyskladRecord?.companyType : sourceRecord.companyType) ?? null });
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
              return this.dependencyHold(event, 'CLIENT_CONTACTPERSON_PARENT_MISMATCH', { selectedSourceId, pairId: pair.id, savedParentId: pair.moyskladParentId, expectedParentId: companyPair?.moyskladId ?? null, actualParentId });
            }
          }
          const reason = selectedSourceId === input.sourceId ? 'PERSISTED_PAIR' : 'DUPLICATE_COMPANY_CANONICALIZED';
          await this.logDependencyResolution(event.id, input, pair, reason);
          return { status: 'RESOLVED', pair, selectedSourceId, reason };
        } catch {
          return this.dependencyHold(event, 'CLIENT_PERSISTED_TARGET_UNAVAILABLE', { entity: input.entity, selectedSourceId, pairId: pair.id });
        }
      }

      const eventForClient: PersistedEvent = {
        ...event,
        externalEntityId: selectedSourceId,
        externalEntityType: input.entity === 'COMPANY'
          ? input.sourceSystem === 'BITRIX24' ? 'company' : 'counterparty'
          : input.sourceSystem === 'BITRIX24' ? 'contact' : input.primaryCompanySourceId ? 'contactperson' : 'counterparty',
      };
      const resolved = await this.resolveUnpaired(eventForClient, input.entity, input.sourceSystem, pinned.config, input.primaryCompanySourceId ?? null);
      if (!resolved) return { status: 'REVIEW', reason: 'CLIENT_DEPENDENCY_REQUIRES_REVIEW' };
      const reason = selectedSourceId === input.sourceId ? 'RUNTIME_LOOKUP_OR_CREATE' : 'DUPLICATE_COMPANY_CANONICALIZED';
      await this.logDependencyResolution(event.id, input, resolved, reason);
      return { status: 'RESOLVED', pair: resolved, selectedSourceId, reason };
    } catch (error) {
      await this.database.$transaction(async (tx) => {
        await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'RECEIVED' }, data: { status: 'RETRYABLE_FAILURE', lastErrorCategory: 'CLIENT_DEPENDENCY_RETRY', retryAfter: new Date(Date.now() + 30_000) } });
        await tx.operationalLog.create({ data: { category: 'CLIENT_DEPENDENCY', message: `Document client dependency will retry: ${safeReason(error)}.`, referenceId: event.id } });
      });
      return { status: 'RETRY', reason: safeReason(error) };
    }
  }

  private async findPersistedPair(entity: 'COMPANY' | 'CONTACT', sourceId: string, sourceSystem: ClientSystem) {
    return this.database.entityPair.findFirst({ where: {
      entityType: entity, active: true,
      ...(sourceSystem === 'BITRIX24' ? { bitrix24Id: sourceId } : { moyskladId: sourceId }),
    } });
  }

  private async dependencyHold(event: PersistedEvent, reason: string, diagnostic: Record<string, unknown>): Promise<ClientDependencyResolution> {
    await this.database.manualReviewCase.upsert({ where: { eventId: event.id }, create: {
      eventId: event.id, source: event.source, eventType: event.eventType, externalEntityId: event.externalEntityId,
      externalEntityType: event.externalEntityType, reason, diagnostic: diagnostic as Prisma.InputJsonValue,
    }, update: { reason, diagnostic: diagnostic as Prisma.InputJsonValue } });
    await this.database.operationalLog.create({ data: { category: 'CLIENT_DEPENDENCY', message: `Document client dependency held: ${reason}.`, referenceId: event.id } });
    await this.database.inboundEvent.updateMany({ where: { id: event.id, status: 'RECEIVED' }, data: { status: 'MANUAL_REVIEW', lastErrorCategory: reason } });
    return { status: 'REVIEW', reason };
  }

  private async skipDuplicateEvent(event: PersistedEvent, reason: string) {
    await this.database.$transaction(async (tx) => {
      await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'RECEIVED' }, data: { status: 'SUCCEEDED', lastErrorCategory: reason, lastSuccessfulAt: new Date() } });
      await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Duplicate client event excluded from ordinary synchronization: ${reason}.`, referenceId: event.id } });
    });
  }

  private async logDependencyResolution(eventId: string, input: ClientDependencyInput, pair: any, reason: string) {
    await this.database.operationalLog.create({ data: {
      category: 'CLIENT_DEPENDENCY',
      message: `Document client dependency resolved (${input.entity}; source ${input.sourceId}; selected ${input.sourceSystem === 'BITRIX24' ? pair.bitrix24Id : pair.moyskladId}; pair ${pair.id}; reason ${reason}).`,
      referenceId: eventId,
    } });
  }

  enqueue(eventId: string): void {
    void this.process(eventId).catch((error) => logger.error(JSON.stringify({ eventId, result: 'PROCESSOR_FAILURE', reason: safeReason(error) })));
  }

  async process(eventId: string): Promise<'IGNORED' | 'REVIEW' | 'BASELINE' | 'UNCHANGED' | 'SYNCED' | 'RETRY'> {
    if (this.active.has(eventId)) return 'IGNORED';
    const event = await this.database.inboundEvent.findUnique({ where: { id: eventId } }) as PersistedEvent | null;
    if (!event || !this.supports(event) || event.status !== 'RECEIVED') return 'IGNORED';
    let entity = entityForEvent(event)!;
    if (!event.externalEntityId) return this.hold(event, 'CLIENT_ID_MISSING', {});
    this.active.add(eventId);
    try {
      if ((await this.syncMode.read()).mode !== 'on') return 'IGNORED';
      if (!this.gateway || !this.candidateGateway) return this.hold(event, 'CLIENT_RUNTIME_GATEWAY_UNAVAILABLE', { source: event.source, entity });
      const eventConfig = await this.settings.eventConfig(event.id);
      const sourceSystem: ClientSystem = event.source === 'BITRIX24' ? 'BITRIX24' : 'MOYSKLAD';
      if (sourceSystem === 'BITRIX24') {
        const sourceRecord = await this.gateway.readBitrix(entity, event.externalEntityId);
        if (entity === 'COMPANY' && isMarkedDuplicate(sourceRecord.UF_CRM_1789126724375)) {
          await this.skipDuplicateEvent(event, 'DUPLICATE_COMPANY_EXCLUDED_FROM_ORDINARY_SYNC');
          return 'UNCHANGED';
        }
        if (entity === 'CONTACT' && isMarkedDuplicate(sourceRecord.UF_CRM_1789126649744)) {
          const companyId = stringValue(sourceRecord.COMPANY_ID);
          const companyResolution = companyId ? await this.resolveForDocument({ eventId: event.id, sourceSystem, entity: 'COMPANY', sourceId: companyId }) : null;
          if (!companyResolution || companyResolution.status !== 'RESOLVED') return this.hold(event, 'DUPLICATE_CONTACT_COMPANY_UNRESOLVED', { sourceId: event.externalEntityId, companyId });
          const companyPair = companyResolution.pair;
          await this.skipDuplicateEvent(event, 'DUPLICATE_CONTACT_OMITTED_COMPANY_RESOLVED');
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
      if (!pair) pair = await this.resolveUnpaired(event, entity, sourceSystem, eventConfig.config);
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
            await this.database.operationalLog.create({ data: {
              category: 'CLIENT_SYNC',
              message: `Saved company pair ${pair.id} has an INN mismatch; the persisted pair remains authoritative.`,
              referenceId: event.id,
            } });
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
          await tx.entityPairBaseline.upsert({ where: { pairId: pair.id }, create: {
            pairId: pair.id, eventId: event.id, settingsVersion: config.version,
            bitrix24Values: current.bitrix24Values as Prisma.InputJsonValue, moyskladValues: current.moyskladValues as Prisma.InputJsonValue,
          }, update: {} });
          await tx.entityPairSyncState.create({ data: { pairId: pair.id, settingsVersion: config.version, bitrix24Values: current.bitrix24Values as Prisma.InputJsonValue, moyskladValues: current.moyskladValues as Prisma.InputJsonValue } });
          await tx.inboundEvent.update({ where: { id: event.id }, data: { status: 'UNCHANGED', direction: null, lastSuccessfulAt: new Date(), lastErrorCategory: null } });
          await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Initial client baseline captured; no fields written (pair ${pair.id}).`, referenceId: event.id } });
        });
        return 'BASELINE';
      }

      const direction = event.source === 'BITRIX24' ? 'BITRIX24_TO_MOYSKLAD' : 'MOYSKLAD_TO_BITRIX24';
      const writes = buildWrites(config.config, mappingEntity, direction, bitrix, moysklad, prior, applicable, this.settings);
      if (writes.ambiguous) return this.hold(event, writes.ambiguous, { pairId: pair.id });
      if (Object.keys(writes.moysklad).length) await this.gateway.updateMoysklad(msType, pair.moyskladId, pair.moyskladParentId, writes.moysklad);
      if (Object.keys(writes.bitrix24).length) await this.gateway.updateBitrix(bitrixEntity, pair.bitrix24Id, writes.bitrix24);
      const [afterBitrix, afterMoysklad] = await Promise.all([
        this.gateway.readBitrix(bitrixEntity, pair.bitrix24Id),
        this.gateway.readMoysklad(msType, pair.moyskladId, pair.moyskladParentId),
      ]);
      const confirmed = { bitrix24Values: selectFields(afterBitrix, applicable, groups, 'BITRIX24'), moyskladValues: selectFields(afterMoysklad, applicable, groups, 'MOYSKLAD') };
      await this.database.$transaction(async (tx) => {
        await tx.entityPairSyncState.update({ where: { pairId: pair.id }, data: { settingsVersion: config.version, bitrix24Values: confirmed.bitrix24Values as Prisma.InputJsonValue, moyskladValues: confirmed.moyskladValues as Prisma.InputJsonValue } });
        await tx.inboundEvent.update({ where: { id: event.id }, data: { status: 'SUCCEEDED', direction, lastSuccessfulAt: new Date(), lastErrorCategory: null } });
        const updatedFields = [...Object.keys(writes.moysklad), ...Object.keys(writes.bitrix24)];
        await tx.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: updatedFields.length ? `Configured fields synchronized (MoySklad wins conflicts): ${updatedFields.join(', ')} (pair ${pair.id}).` : `No configured field changes to synchronize (pair ${pair.id}).`, referenceId: event.id } });
      });
      return Object.keys(writes.moysklad).length || Object.keys(writes.bitrix24).length ? 'SYNCED' : 'UNCHANGED';
    } catch (error) {
      await this.database.inboundEvent.updateMany({ where: { id: event.id, status: 'RECEIVED' }, data: { status: 'RETRYABLE_FAILURE', lastErrorCategory: 'CLIENT_SYNC_FAILURE', retryAfter: new Date(Date.now() + 30_000) } }).catch(() => undefined);
      await this.database.operationalLog.create({ data: { category: 'CLIENT_SYNC', message: `Client sync held for retry: ${safeReason(error)}.`, referenceId: event.id } }).catch(() => undefined);
      return 'RETRY';
    } finally { this.active.delete(eventId); }
  }

  private async resolveUnpaired(event: PersistedEvent, entity: 'COMPANY' | 'CONTACT', sourceSystem: ClientSystem, config: unknown, primaryCompanyOverride: string | null = null): Promise<any | null> {
    const sourceId = event.externalEntityId!;
    const sourceContactParentId = entity === 'CONTACT'
      ? sourceSystem === 'BITRIX24'
        ? null
        : primaryCompanyOverride ?? (event.externalEntityType === 'contactperson' ? parentIdFromEvent(event) : null)
      : null;
    const record = sourceSystem === 'BITRIX24'
      ? await this.gateway!.readBitrix(entity === 'COMPANY' ? 'COMPANY' : 'CONTACT', sourceId)
      : await this.gateway!.readMoysklad(event.externalEntityType === 'contactperson' ? 'contactperson' : 'counterparty', sourceId, sourceContactParentId);

    let primaryCompanySourceId: string | null = null;
    let primaryCompanyTargetId: string | null = null;
    if (entity === 'CONTACT') {
      primaryCompanySourceId = sourceSystem === 'BITRIX24'
        ? stringValue(record.COMPANY_ID)
        : primaryCompanyOverride ?? sourceContactParentId ?? idFromMeta(record.agent);
      if (primaryCompanySourceId) {
        const companyResolution = await this.resolveForDocument({ eventId: event.id, sourceSystem, entity: 'COMPANY', sourceId: primaryCompanySourceId });
        if (companyResolution.status !== 'RESOLVED') return null;
        const companyPair = companyResolution.pair;
        primaryCompanyTargetId = sourceSystem === 'BITRIX24' ? companyPair.moyskladId : companyPair.bitrix24Id;
      }
    }

    const nativeName = entity === 'COMPANY'
      ? stringValue(sourceSystem === 'BITRIX24' ? record.TITLE : record.name)
      : sourceSystem === 'BITRIX24' ? personNameFromBitrix(record) : stringValue(record.name);
    const inn = entity === 'COMPANY'
      ? sourceSystem === 'BITRIX24' ? await this.candidateGateway!.readCompanyInn(sourceSystem, sourceId) : stringValue(record.inn)
      : null;
    const source: ClientSource = {
      id: sourceId, entity, sourceSystem, inn, name: nativeName,
      phone: firstValue(record.PHONE ?? record.phone), email: firstValue(record.EMAIL ?? record.email),
      companyId: primaryCompanySourceId,
    };
    const resolution = await new ClientRuntimeResolver(this.candidateGateway!).resolve(source, primaryCompanyTargetId);
    if (resolution.action === 'MANUAL_REVIEW') {
      await this.hold(event, `CLIENT_${resolution.reason}`, { entity, sourceSystem, sourceId, primaryCompanySourceId, candidates: resolution.candidates });
      return null;
    }

    let targetId: string | null = resolution.action === 'CREATE' ? null : resolution.targetId;
    let targetType = resolution.targetType;
    if (resolution.action === 'CREATE') {
      const mappingEntity = entity === 'COMPANY' ? 'companies' : 'contacts-companies';
      const direction = sourceSystem === 'BITRIX24' ? 'BITRIX24_TO_MOYSKLAD' : 'MOYSKLAD_TO_BITRIX24';
      const configuredFields = configuredCreateFields(config, mappingEntity, direction, record, this.settings);
      targetId = await this.candidateGateway!.createTarget({
        entity, targetSystem: resolution.targetSystem, targetType: resolution.targetType,
        parentId: primaryCompanyTargetId, source: record, configuredFields,
      });
      targetType = resolution.targetType;
    }

    if (!targetId) {
      await this.hold(event, 'CLIENT_RUNTIME_TARGET_ID_MISSING', { entity, sourceSystem, sourceId, resolution: resolution.action });
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
      const pair = await this.database.$transaction(async (tx) => {
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
        await this.hold(event, 'CLIENT_RUNTIME_PAIR_CONFLICT', { entity, sourceSystem, sourceId, targetId });
        return null;
      }
      throw error;
    }
  }

  private async hold(event: PersistedEvent, reason: string, diagnostic: Record<string, unknown>): Promise<'REVIEW'> {
    await this.database.$transaction(async (tx) => {
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
      await tx.inboundEvent.updateMany({ where: { id: event.id, status: 'RECEIVED' }, data: { status: 'MANUAL_REVIEW', lastErrorCategory: reason } });
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
