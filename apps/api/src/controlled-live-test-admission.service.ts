import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { bindControlledLiveTarget, ControlledLiveEventScope, ControlledLiveIngressAction, createControlledLiveTestPolicy, enterControlledLiveEventScope, registerControlledTargetReadback, withControlledLiveEventScope } from './controlled-live-test-policy';
import { setControlledLiveTestWriteCheck } from './external-write-guard';
import { ControlledLiveProviderNamespace, getVerifiedControlledLiveProviderNamespace } from './controlled-live-test-namespace';

export interface VerifiedControlledSource {
  entity: string;
  sourceSystem: 'BITRIX24' | 'MOYSKLAD';
  sourceNativeId: string;
  currentNativeId: string;
  currentName: string;
  sourceCreatedAt: Date;
}

interface ControlledLiveManifestIngressRecord {
  entity: string;
  syntheticOnly: true;
  direction: 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24' | 'BOTH';
  sourceSystem: 'BITRIX24' | 'MOYSKLAD';
  sourceNativeId: string;
  targetSystem: 'BITRIX24' | 'MOYSKLAD';
  targetNativeId: string | null;
  allowedActions?: ControlledLiveIngressAction[];
}

/** Durable admission is written only after a caller has freshly read and verified the provider source. */
@Injectable()
export class ControlledLiveTestAdmissionService {
  private readonly manifest: any;
  private readonly providerNamespace: ControlledLiveProviderNamespace | null = null;

  constructor(private readonly database: DatabaseService) {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    const path = process.env.CONTROLLED_LIVE_TEST_MANIFEST;
    if (!path) throw new Error('CONTROLLED_LIVE_TEST_MANIFEST_REQUIRED');
    this.manifest = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
    this.providerNamespace = getVerifiedControlledLiveProviderNamespace(this.manifest.providerNamespace);
    setControlledLiveTestWriteCheck(createControlledLiveTestPolicy(this.manifest, process.env.DATABASE_URL));
  }

  async admit(eventId: string, source: VerifiedControlledSource): Promise<void> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    const scopedEntity = controlledManifestEntity(source.entity);
    if (!source.currentNativeId || source.currentNativeId !== source.sourceNativeId) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_ID_MISMATCH');
    const priorBindings = await this.database.controlledTestSourceBinding.findMany({ where: { runId: this.manifest.runId, entity: scopedEntity } });
    const matches = this.manifest.records.map((candidate: any) => {
      if (candidate.entity !== scopedEntity || candidate.syntheticOnly !== true || candidate.name !== source.currentName ||
          !source.currentName.includes('тест') || !source.currentName.includes(this.manifest.runId) ||
          source.sourceCreatedAt.getTime() < new Date(candidate.createdAfterUtc).getTime() || source.sourceCreatedAt.getTime() > Date.now()) return null;
      if (candidate.sourceSystem === source.sourceSystem &&
          candidate.sourceNativeId === source.sourceNativeId) return { record: candidate, reversed: false };
      if (candidate.direction === 'BOTH' && candidate.targetSystem === source.sourceSystem) {
        const prior = priorBindings.find((row: any) => bindingMatchesManifestPair(row, candidate));
        if (prior && candidate.targetNativeId === source.sourceNativeId) return { record: candidate, reversed: true };
      }
      return null;
    }).filter((item: any) => item !== null);
    if (matches.length !== 1) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_NOT_ADMITTED');
    const { record, reversed } = matches[0];
    const pair = canonicalProviderIds(record);
    const expectedSourceSide = source.sourceSystem === 'BITRIX24' ? 'bitrix24NativeId' : 'moyskladNativeId';
    const existingForSource = priorBindings.find((binding: any) => binding[expectedSourceSide] === source.sourceNativeId);
    let binding = existingForSource;
    if (binding) {
      if (!bindingMatchesExpected(binding, this.manifest.runId, record, pair, this.providerNamespace!, source, reversed)) {
        throw new Error('CONTROLLED_LIVE_TEST_ADMISSION_CONFLICT');
      }
    } else {
      if (reversed) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_NOT_ADMITTED');
      try {
        binding = await this.database.controlledTestSourceBinding.create({ data: {
          runId: this.manifest.runId, entity: scopedEntity,
          bitrix24NativeId: pair.bitrix24NativeId, moyskladNativeId: pair.moyskladNativeId,
          bitrix24PortalOrigin: this.providerNamespace!.bitrix24PortalOrigin, bitrix24UserId: this.providerNamespace!.bitrix24UserId,
          moyskladAccountId: this.providerNamespace!.moyskladAccountId,
          sourceName: source.currentName, sourceCreatedAt: source.sourceCreatedAt,
        } });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const raced = await this.database.controlledTestSourceBinding.findMany({ where: {
          runId: this.manifest.runId, entity: scopedEntity,
          OR: [
            ...(pair.bitrix24NativeId ? [{ bitrix24NativeId: pair.bitrix24NativeId }] : []),
            ...(pair.moyskladNativeId ? [{ moyskladNativeId: pair.moyskladNativeId }] : []),
          ],
        } });
        const sameSource = raced.find((candidate: any) => candidate[expectedSourceSide] === source.sourceNativeId);
        if (!sameSource || !bindingMatchesExpected(sameSource, this.manifest.runId, record, pair, this.providerNamespace!, source, reversed)) {
          throw new Error('CONTROLLED_LIVE_TEST_ADMISSION_CONFLICT');
        }
        binding = sameSource;
      }
    }
    const eventTargetSystem = reversed ? record.sourceSystem : record.targetSystem;
    const targetNativeId = eventTargetSystem === 'BITRIX24' ? binding.bitrix24NativeId : binding.moyskladNativeId;
    await this.database.controlledTestAdmission.upsert({
      where: { eventId },
      create: { eventId, runId: this.manifest.runId, entity: scopedEntity, sourceSystem: source.sourceSystem,
        sourceNativeId: source.sourceNativeId, targetSystem: eventTargetSystem,
        targetNativeId,
        bitrix24PortalOrigin: this.providerNamespace!.bitrix24PortalOrigin, bitrix24UserId: this.providerNamespace!.bitrix24UserId,
        moyskladAccountId: this.providerNamespace!.moyskladAccountId,
        sourceName: source.currentName, sourceCreatedAt: source.sourceCreatedAt, bindingId: binding.id },
      update: {},
    });
    const existing = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
    if (!existing || existing.runId !== this.manifest.runId || existing.entity !== scopedEntity ||
        existing.sourceSystem !== source.sourceSystem || existing.sourceNativeId !== source.sourceNativeId ||
        existing.targetSystem !== eventTargetSystem ||
        existing.targetNativeId !== targetNativeId || existing.bindingId !== binding.id ||
        existing.bitrix24PortalOrigin !== this.providerNamespace!.bitrix24PortalOrigin ||
        existing.bitrix24UserId !== this.providerNamespace!.bitrix24UserId ||
        existing.moyskladAccountId !== this.providerNamespace!.moyskladAccountId ||
        existing.sourceName !== source.currentName || existing.sourceCreatedAt.getTime() !== source.sourceCreatedAt.getTime()) {
      throw new Error('CONTROLLED_LIVE_TEST_ADMISSION_CONFLICT');
    }
    this.enterScope(existing);
  }

  /**
   * Checks an authenticated webhook envelope against the exact run manifest
   * before it is persisted or dispatched. The later provider read, admission,
   * marker, boundary, and transport checks remain authoritative as well.
   */
  allowsIncomingEvent(input: {
    sourceSystem: 'BITRIX24' | 'MOYSKLAD';
    eventType: string | null;
    externalEntityType: string | null;
    sourceNativeId: string | null;
  }): boolean {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return true;
    const action = controlledIngressAction(input.sourceSystem, input.eventType);
    const entities = controlledIngressEntities(input.sourceSystem, input.externalEntityType);
    const records = (this.manifest as { records?: ControlledLiveManifestIngressRecord[] } | undefined)?.records;
    if (!action || !entities || !input.sourceNativeId || !Array.isArray(records)) return false;

    const matchingRecords = records.filter((record) => {
      if (!entities.includes(record.entity) || record.syntheticOnly !== true ||
          !Array.isArray(record.allowedActions) || record.allowedActions.length === 0 ||
          record.allowedActions.some((candidate) => candidate !== 'CREATE' && candidate !== 'UPDATE') ||
          new Set(record.allowedActions).size !== record.allowedActions.length || !record.allowedActions.includes(action) ||
          typeof record.sourceNativeId !== 'string' || !record.sourceNativeId ||
          record.targetSystem === record.sourceSystem) return false;

      const sourceSide = record.sourceSystem === input.sourceSystem && record.sourceNativeId === input.sourceNativeId &&
        (record.direction === 'BITRIX24_TO_MOYSKLAD' && record.sourceSystem === 'BITRIX24' && record.targetSystem === 'MOYSKLAD' ||
         record.direction === 'MOYSKLAD_TO_BITRIX24' && record.sourceSystem === 'MOYSKLAD' && record.targetSystem === 'BITRIX24' ||
         record.direction === 'BOTH' && typeof record.targetNativeId === 'string' && record.targetNativeId.length > 0 && record.sourceSystem !== record.targetSystem);
      if (sourceSide) return true;

      return record.direction === 'BOTH' && typeof record.targetNativeId === 'string' && record.targetNativeId.length > 0 &&
        record.targetSystem === input.sourceSystem && record.targetNativeId === input.sourceNativeId &&
        record.sourceSystem !== record.targetSystem;
    });
    return matchingRecords.length === 1;
  }

  async bindCreatedTarget(eventId: string, targetNativeId: string, verifiedTargetNativeId: string, verifiedTargetName: string, targetCreatedAt: Date, verifiedTargetRunMarker?: string): Promise<void> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    const admission = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
    if (admission) this.assertAdmissionNamespace(admission);
    const record = admission && this.manifest.records.find((candidate: any) => candidate.entity === admission.entity && candidate.name === admission.sourceName && manifestMatchesAdmission(candidate, admission));
    const targetIdentityVerified = admission?.entity === 'deal-order' ? verifiedTargetName === admission.sourceName || verifiedTargetRunMarker === admission.runId : verifiedTargetName === admission?.sourceName;
    if (!admission || !record || !targetNativeId || verifiedTargetNativeId !== targetNativeId || !targetIdentityVerified ||
        !Number.isFinite(targetCreatedAt.getTime()) || targetCreatedAt.getTime() < new Date(record.createdAfterUtc).getTime() || targetCreatedAt.getTime() > Date.now()) {
      throw new Error('CONTROLLED_LIVE_TEST_TARGET_READBACK_INVALID');
    }
    const binding = await this.database.controlledTestSourceBinding.findUnique({ where: { id: admission.bindingId } });
    if (!binding) throw new Error('CONTROLLED_LIVE_TEST_TARGET_BINDING_MISSING');
    const targetField = admission.targetSystem === 'BITRIX24' ? 'bitrix24NativeId' : 'moyskladNativeId';
    const targetBefore = binding[targetField];
    if (targetBefore !== null && targetBefore !== targetNativeId) throw new Error('CONTROLLED_LIVE_TEST_TARGET_BIND_CONFLICT');
    if (binding.createReservedByEventId !== eventId) throw new Error('CONTROLLED_LIVE_TEST_CREATE_RESERVATION_REQUIRED');
    try {
      if (targetBefore === null) {
        const changed = await this.database.controlledTestSourceBinding.updateMany({
          where: { id: binding.id, [targetField]: null, createReservedByEventId: eventId } as any,
          data: { [targetField]: targetNativeId },
        });
        if (changed.count !== 1) {
          const current = await this.database.controlledTestSourceBinding.findUnique({ where: { id: binding.id } });
          if (!current || current[targetField] !== targetNativeId || current.createReservedByEventId !== eventId) {
            throw new Error('CONTROLLED_LIVE_TEST_TARGET_BIND_CONFLICT');
          }
        }
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new Error('CONTROLLED_LIVE_TEST_TARGET_ALREADY_BOUND');
      throw error;
    }
    if (admission.targetNativeId === null) {
      await this.database.controlledTestAdmission.updateMany({ where: { eventId, targetNativeId: null }, data: { targetNativeId } });
    } else if (admission.targetNativeId !== targetNativeId) {
      throw new Error('CONTROLLED_LIVE_TEST_TARGET_BIND_CONFLICT');
    }
    bindControlledLiveTarget(targetNativeId);
  }

  async assertTargetAllowed(eventId: string, targetSystem: 'BITRIX24' | 'MOYSKLAD', targetNativeId: string): Promise<void> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    const admission = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
    if (admission) this.assertAdmissionNamespace(admission);
    const record = admission && this.manifest.records.find((candidate: any) => candidate.entity === admission.entity &&
      candidate.name === admission.sourceName && manifestMatchesAdmission(candidate, admission));
    if (!admission || !record || admission.targetSystem !== targetSystem || admission.targetNativeId !== targetNativeId ||
        (record.targetNativeId !== null && record.targetNativeId !== targetNativeId)) {
      throw new Error('CONTROLLED_LIVE_TEST_TARGET_NOT_MANIFESTED');
    }
  }

  async assertCreateReserved(eventId: string, entity: string, targetSystem: 'BITRIX24' | 'MOYSKLAD'): Promise<void> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    const admission = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
    if (admission) this.assertAdmissionNamespace(admission);
    const record = admission && this.manifest.records.find((candidate: any) => candidate.entity === entity && candidate.name === admission.sourceName &&
      candidate.sourceSystem === admission.sourceSystem && candidate.sourceNativeId === admission.sourceNativeId &&
      candidate.targetSystem === targetSystem && candidate.targetNativeId === null);
    if (!admission || !record || admission.targetNativeId !== null || admission.targetSystem !== targetSystem || admission.entity !== entity) {
      throw new Error('CONTROLLED_LIVE_TEST_CREATE_NOT_RESERVED');
    }
    const binding = await this.database.controlledTestSourceBinding.findUnique({ where: { id: admission.bindingId } });
    const targetField = targetSystem === 'BITRIX24' ? 'bitrix24NativeId' : 'moyskladNativeId';
    if (!binding || binding[targetField] !== null) throw new Error('CONTROLLED_LIVE_TEST_CREATE_NOT_RESERVED');
    const claimed = await this.database.controlledTestSourceBinding.updateMany({
      where: { id: binding.id, [targetField]: null, OR: [
        { createReservedByEventId: null }, { createReservedByEventId: eventId },
      ] } as any,
      data: { createReservedByEventId: eventId },
    });
    if (claimed.count !== 1) {
      const current = await this.database.controlledTestSourceBinding.findUnique({ where: { id: binding.id } });
      if (!current || current[targetField] !== null || current.createReservedByEventId !== eventId) {
        throw new Error('CONTROLLED_LIVE_TEST_CREATE_NOT_RESERVED');
      }
    }
  }

  async allowsSourceSideWrite(eventId: string): Promise<boolean> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return true;
    const admission = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
    if (admission) this.assertAdmissionNamespace(admission);
    if (!admission || admission.runId !== this.manifest.runId) return false;
    const record = this.manifest.records.find((candidate: any) => candidate.entity === admission.entity && candidate.name === admission.sourceName && manifestMatchesAdmission(candidate, admission));
    return record?.direction === 'BOTH';
  }

  async runForEvent<T>(eventId: string, action: () => Promise<T>): Promise<T> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return action();
    const admission = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
    if (!admission) return action();
    return withControlledLiveEventScope(this.scope(eventId, admission), action);
  }

  /** Reconstructs an event scope from a previously admitted and readback-bound
   * pair. Used for delete webhooks where the source record is expected to be
   * absent, so a fresh source-name read is impossible by definition. */
  async withExistingManifestPairScope<T>(input: {
    eventId: string; entity: string; sourceSystem: 'BITRIX24' | 'MOYSKLAD'; sourceNativeId: string;
    targetSystem: 'BITRIX24' | 'MOYSKLAD'; targetNativeId: string;
  }, action: () => Promise<T>): Promise<T> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return action();
    const entity = controlledManifestEntity(input.entity);
    if (!input.eventId || !input.sourceNativeId || !input.targetNativeId || input.sourceSystem === input.targetSystem) {
      throw new Error('CONTROLLED_LIVE_TEST_LIFECYCLE_PAIR_INVALID');
    }
    const admissions = await this.database.controlledTestAdmission.findMany({ where: { runId: this.manifest.runId, entity } });
    admissions.forEach((admission: any) => this.assertAdmissionNamespace(admission));
    for (const record of this.manifest.records) {
      if (record.entity !== entity || record.syntheticOnly !== true || !admissions.some((row: any) => row.sourceName === record.name)) continue;
      const forward = record.sourceSystem === input.sourceSystem && record.targetSystem === input.targetSystem &&
        record.sourceNativeId === input.sourceNativeId &&
        (record.targetNativeId === null || record.targetNativeId === input.targetNativeId);
      const reverse = record.direction === 'BOTH' && record.targetSystem === input.sourceSystem && record.sourceSystem === input.targetSystem &&
        (record.targetNativeId === null || record.targetNativeId === input.sourceNativeId) &&
        record.sourceNativeId === input.targetNativeId;
      if (!forward && !reverse) continue;
      const prior = admissions.find((row: any) => row.sourceName === record.name && row.runId === this.manifest.runId && row.entity === entity &&
        Number.isFinite(row.sourceCreatedAt?.getTime?.()) && row.sourceCreatedAt.getTime() >= new Date(record.createdAfterUtc).getTime() &&
        (forward ? row.sourceSystem === record.sourceSystem && row.sourceNativeId === input.sourceNativeId && row.targetSystem === record.targetSystem && row.targetNativeId === input.targetNativeId
          : row.sourceSystem === record.sourceSystem && row.sourceNativeId === input.targetNativeId && row.targetSystem === record.targetSystem && row.targetNativeId === input.sourceNativeId));
      if (!prior) continue;
      return withControlledLiveEventScope({
        eventId: input.eventId, runId: this.manifest.runId, entity, sourceSystem: input.sourceSystem,
        sourceNativeId: input.sourceNativeId, targetSystem: input.targetSystem, targetNativeId: input.targetNativeId,
        admittedSourceName: record.name, admittedSourceCreatedAt: prior.sourceCreatedAt.toISOString(),
      }, action);
    }
    throw new Error('CONTROLLED_LIVE_TEST_LIFECYCLE_PAIR_NOT_ADMITTED');
  }

  async withCurrentSourceRead<T>(eventId: string, sourceSystem: 'BITRIX24' | 'MOYSKLAD', sourceNativeId: string, entityHint: string | null, action: () => Promise<T>): Promise<T> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return action();
    const candidates = this.manifest.records.filter((record: any) => {
      if (entityHint && record.entity !== entityHint) return false;
      return record.syntheticOnly === true && (
        record.direction !== 'MOYSKLAD_TO_BITRIX24' && record.sourceSystem === sourceSystem && record.sourceNativeId === sourceNativeId ||
        record.direction === 'BOTH' && record.targetSystem === sourceSystem && (record.targetNativeId === null || record.targetNativeId === sourceNativeId));
    });
    if (candidates.length !== 1) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_READ_NOT_UNIQUELY_MANIFESTED');
    const record = candidates[0];
    const reversed = record.sourceSystem !== sourceSystem;
    const scope: ControlledLiveEventScope = {
      eventId, runId: this.manifest.runId, entity: record.entity, sourceSystem, sourceNativeId,
      targetSystem: (reversed ? record.sourceSystem : record.targetSystem) as ControlledLiveEventScope['targetSystem'],
      targetNativeId: null, admittedSourceName: '', admittedSourceCreatedAt: record.createdAfterUtc, phase: 'SOURCE_READ',
    };
    return withControlledLiveEventScope(scope, action);
  }

  /** Read the exact MySklad side of a manifested product/service pair when a
   * Bitrix24 event is only a reassertion signal. It grants no write authority. */
  async withProductRestoreSourceRead<T>(input: { eventId: string; sourceNativeId: string; targetNativeId: string; entity: 'catalog-product' | 'catalog-service' }, action: () => Promise<T>): Promise<T> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return action();
    const record = this.manifest.records.find((candidate: any) => candidate.entity === input.entity &&
      candidate.direction === 'MOYSKLAD_TO_BITRIX24' && candidate.sourceSystem === 'MOYSKLAD' &&
      candidate.sourceNativeId === input.sourceNativeId && candidate.targetSystem === 'BITRIX24' && candidate.targetNativeId === input.targetNativeId &&
      candidate.syntheticOnly === true);
    if (!record) throw new Error('CONTROLLED_LIVE_TEST_PRODUCT_RESTORE_PAIR_NOT_MANIFESTED');
    const scope: ControlledLiveEventScope = {
      eventId: input.eventId, runId: this.manifest.runId, entity: input.entity,
      sourceSystem: 'MOYSKLAD', sourceNativeId: input.sourceNativeId,
      targetSystem: 'BITRIX24', targetNativeId: input.targetNativeId,
      admittedSourceName: record.name, admittedSourceCreatedAt: record.createdAfterUtc, phase: 'SOURCE_READ',
    };
    return withControlledLiveEventScope(scope, action);
  }

  private enterScope(admission: any): void {
    enterControlledLiveEventScope(this.scope(admission.eventId, admission));
  }

  async activate(eventId: string): Promise<void> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    const admission = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
    if (!admission) throw new Error('CONTROLLED_LIVE_TEST_ADMISSION_REQUIRED');
    this.enterScope(admission);
  }

  async scopeForEvent(eventId: string): Promise<ControlledLiveEventScope> {
    const admission = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
    if (!admission) throw new Error('CONTROLLED_LIVE_TEST_ADMISSION_REQUIRED');
    return this.scope(eventId, admission);
  }

  allowTargetReadback(provider: 'BITRIX24' | 'MOYSKLAD', nativeId: string): void {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    registerControlledTargetReadback(provider, nativeId);
  }

  private scope(eventId: string, admission: any): ControlledLiveEventScope {
    this.assertAdmissionNamespace(admission);
    const scope: ControlledLiveEventScope = {
      eventId, runId: admission.runId, entity: admission.entity,
      sourceSystem: admission.sourceSystem as ControlledLiveEventScope['sourceSystem'], sourceNativeId: admission.sourceNativeId,
      targetSystem: admission.targetSystem as ControlledLiveEventScope['targetSystem'], targetNativeId: admission.targetNativeId,
      admittedSourceName: admission.sourceName, admittedSourceCreatedAt: admission.sourceCreatedAt.toISOString(),
    };
    return scope;
  }

  private assertAdmissionNamespace(admission: any): void {
    if (!this.providerNamespace || admission.bitrix24PortalOrigin !== this.providerNamespace.bitrix24PortalOrigin ||
        admission.bitrix24UserId !== this.providerNamespace.bitrix24UserId || admission.moyskladAccountId !== this.providerNamespace.moyskladAccountId) {
      throw new Error('CONTROLLED_LIVE_TEST_ADMISSION_PROVIDER_NAMESPACE_MISMATCH');
    }
  }
}

function controlledIngressAction(sourceSystem: 'BITRIX24' | 'MOYSKLAD', eventType: string | null): ControlledLiveIngressAction | null {
  if (!eventType) return null;
  if (sourceSystem === 'MOYSKLAD') return eventType === 'CREATE' || eventType === 'UPDATE' ? eventType : null;
  if (/^(?:ONCRM(?:DEAL|CONTACT|COMPANY|DYNAMICITEM|PRODUCT)ADD|CATALOG\.PRODUCT\.ON\.ADD)$/.test(eventType)) return 'CREATE';
  if (/^(?:ONCRM(?:DEAL|CONTACT|COMPANY|DYNAMICITEM|PRODUCT)UPDATE|CATALOG\.PRODUCT\.ON\.UPDATE)$/.test(eventType)) return 'UPDATE';
  return null;
}

function controlledIngressEntities(sourceSystem: 'BITRIX24' | 'MOYSKLAD', externalEntityType: string | null): string[] | null {
  if (sourceSystem === 'BITRIX24') {
    switch (externalEntityType) {
      case 'company': return ['client:COMPANY'];
      case 'contact': return ['client:CONTACT'];
      case 'deal': return ['deal-order'];
      case 'invoice': return ['invoice'];
      case 'product': return ['catalog-product'];
      default: return null;
    }
  }
  switch (externalEntityType) {
    case 'counterparty': return ['client:COMPANY', 'client:CONTACT'];
    case 'customerorder': return ['deal-order'];
    case 'invoiceout': return ['invoice'];
    case 'product': return ['catalog-product'];
    case 'service': return ['catalog-service'];
    default: return null;
  }
}

function controlledManifestEntity(value: string): string {
  if (['client:COMPANY', 'client:CONTACT', 'deal-order', 'invoice', 'catalog-product', 'catalog-service'].includes(value)) return value;
  if (value === 'COMPANY' || value === 'CONTACT') return `client:${value}`;
  throw new Error('CONTROLLED_LIVE_TEST_ENTITY_UNSUPPORTED');
}

function manifestMatchesAdmission(record: any, admission: any): boolean {
  const forward = record.sourceSystem === admission.sourceSystem && record.sourceNativeId === admission.sourceNativeId &&
    record.targetSystem === admission.targetSystem && (record.targetNativeId === null || record.targetNativeId === admission.targetNativeId);
  const reverse = record.direction === 'BOTH' && record.targetSystem === admission.sourceSystem && (record.targetNativeId === null || record.targetNativeId === admission.sourceNativeId) &&
    record.sourceSystem === admission.targetSystem && record.sourceNativeId === admission.targetNativeId;
  return forward || reverse;
}

function canonicalProviderIds(record: any): { bitrix24NativeId: string | null; moyskladNativeId: string | null } {
  return {
    bitrix24NativeId: record.sourceSystem === 'BITRIX24' ? record.sourceNativeId : record.targetNativeId,
    moyskladNativeId: record.sourceSystem === 'MOYSKLAD' ? record.sourceNativeId : record.targetNativeId,
  };
}

function bindingMatchesManifestPair(binding: any, record: any): boolean {
  const pair = canonicalProviderIds(record);
  return binding.entity === record.entity && binding.bitrix24NativeId === pair.bitrix24NativeId &&
    binding.moyskladNativeId === pair.moyskladNativeId && binding.sourceName === record.name;
}

function bindingMatchesExpected(binding: any, runId: string, record: any,
  pair: { bitrix24NativeId: string | null; moyskladNativeId: string | null },
  namespace: ControlledLiveProviderNamespace, source: VerifiedControlledSource, reversed: boolean): boolean {
  const sourceField = source.sourceSystem === 'BITRIX24' ? 'bitrix24NativeId' : 'moyskladNativeId';
  const targetSystem = reversed ? record.sourceSystem : record.targetSystem;
  const targetField = targetSystem === 'BITRIX24' ? 'bitrix24NativeId' : 'moyskladNativeId';
  const targetExpected = reversed ? record.sourceNativeId : record.targetNativeId;
  return binding.runId === runId && binding.entity === record.entity &&
    binding[sourceField] === source.sourceNativeId &&
    (pair.bitrix24NativeId === null || binding.bitrix24NativeId === pair.bitrix24NativeId) &&
    (pair.moyskladNativeId === null || binding.moyskladNativeId === pair.moyskladNativeId) &&
    (targetExpected === null || binding[targetField] === targetExpected) &&
    binding.bitrix24PortalOrigin === namespace.bitrix24PortalOrigin &&
    binding.bitrix24UserId === namespace.bitrix24UserId && binding.moyskladAccountId === namespace.moyskladAccountId &&
    binding.sourceName === source.currentName && binding.sourceCreatedAt.getTime() === source.sourceCreatedAt.getTime();
}

function isUniqueConstraintError(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
}
