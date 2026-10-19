import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { bindControlledLiveTarget, ControlledLiveEventScope, createControlledLiveTestPolicy, enterControlledLiveEventScope, registerControlledTargetReadback, withControlledLiveEventScope } from './controlled-live-test-policy';
import { setControlledLiveTestWriteCheck } from './external-write-guard';

export interface VerifiedControlledSource {
  entity: string;
  sourceSystem: 'BITRIX24' | 'MOYSKLAD';
  sourceNativeId: string;
  currentNativeId: string;
  currentName: string;
  sourceCreatedAt: Date;
}

/** Durable admission is written only after a caller has freshly read and verified the provider source. */
@Injectable()
export class ControlledLiveTestAdmissionService {
  private readonly manifest: any;

  constructor(private readonly database: DatabaseService) {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    const path = process.env.CONTROLLED_LIVE_TEST_MANIFEST;
    if (!path) throw new Error('CONTROLLED_LIVE_TEST_MANIFEST_REQUIRED');
    this.manifest = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
    setControlledLiveTestWriteCheck(createControlledLiveTestPolicy(this.manifest, process.env.DATABASE_URL));
  }

  async admit(eventId: string, source: VerifiedControlledSource): Promise<void> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    const scopedEntity = controlledManifestEntity(source.entity);
    if (!source.currentNativeId || source.currentNativeId !== source.sourceNativeId) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_ID_MISMATCH');
    const priorAdmissions = await this.database.controlledTestAdmission.findMany({ where: { runId: this.manifest.runId, entity: scopedEntity } });
    const match = this.manifest.records.map((candidate: any) => {
      if (candidate.entity !== scopedEntity || candidate.syntheticOnly !== true || candidate.name !== source.currentName ||
          !source.currentName.includes('тест') || !source.currentName.includes(this.manifest.runId) ||
          source.sourceCreatedAt.getTime() < new Date(candidate.createdAfterUtc).getTime() || source.sourceCreatedAt.getTime() > Date.now()) return null;
      if (candidate.sourceSystem === source.sourceSystem &&
          (candidate.sourceNativeId === null || candidate.sourceNativeId === source.sourceNativeId)) return { record: candidate, reversed: false, prior: null };
      if (candidate.direction === 'BOTH' && candidate.targetSystem === source.sourceSystem) {
        const prior = priorAdmissions.find((row: any) => row.sourceSystem === candidate.sourceSystem &&
          (candidate.sourceNativeId === null || row.sourceNativeId === candidate.sourceNativeId) &&
          row.targetSystem === source.sourceSystem && row.targetNativeId === source.sourceNativeId);
        if (prior) return { record: candidate, reversed: true, prior };
      }
      return null;
    }).find((item: any) => item !== null);
    if (!match) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_NOT_ADMITTED');
    const { record, reversed, prior } = match;
    await this.database.controlledTestAdmission.upsert({
      where: { eventId },
      create: { eventId, runId: this.manifest.runId, entity: scopedEntity, sourceSystem: source.sourceSystem,
        sourceNativeId: source.sourceNativeId, targetSystem: reversed ? record.sourceSystem : record.targetSystem,
        targetNativeId: reversed ? prior.sourceNativeId : record.targetNativeId,
        sourceName: source.currentName, sourceCreatedAt: source.sourceCreatedAt },
      update: {},
    });
    const existing = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
    if (!existing || existing.runId !== this.manifest.runId || existing.entity !== scopedEntity ||
        existing.sourceSystem !== source.sourceSystem || existing.sourceNativeId !== source.sourceNativeId ||
        existing.targetSystem !== (reversed ? record.sourceSystem : record.targetSystem) ||
        existing.targetNativeId !== (reversed ? prior.sourceNativeId : record.targetNativeId) ||
        existing.sourceName !== source.currentName || existing.sourceCreatedAt.getTime() !== source.sourceCreatedAt.getTime()) {
      throw new Error('CONTROLLED_LIVE_TEST_ADMISSION_CONFLICT');
    }
    this.enterScope(existing);
  }

  async bindCreatedTarget(eventId: string, targetNativeId: string, verifiedTargetNativeId: string, verifiedTargetName: string, targetCreatedAt: Date, verifiedTargetRunMarker?: string): Promise<void> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    const admission = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
    const record = admission && this.manifest.records.find((candidate: any) => candidate.entity === admission.entity && candidate.name === admission.sourceName && manifestMatchesAdmission(candidate, admission));
    const targetIdentityVerified = admission?.entity === 'deal-order' ? verifiedTargetName === admission.sourceName || verifiedTargetRunMarker === admission.runId : verifiedTargetName === admission?.sourceName;
    if (!admission || !record || !targetNativeId || verifiedTargetNativeId !== targetNativeId || !targetIdentityVerified ||
        !Number.isFinite(targetCreatedAt.getTime()) || targetCreatedAt.getTime() < new Date(record.createdAfterUtc).getTime() || targetCreatedAt.getTime() > Date.now()) {
      throw new Error('CONTROLLED_LIVE_TEST_TARGET_READBACK_INVALID');
    }
    const existing = await this.database.controlledTestAdmission.findFirst({ where: {
      runId: admission.runId, targetSystem: admission.targetSystem, targetNativeId, NOT: { eventId },
    } });
    if (existing) throw new Error('CONTROLLED_LIVE_TEST_TARGET_ALREADY_BOUND');
    const changed = await this.database.controlledTestAdmission.updateMany({
      where: { eventId, targetNativeId: null }, data: { targetNativeId },
    });
    if (changed.count !== 1 && admission.targetNativeId !== targetNativeId) throw new Error('CONTROLLED_LIVE_TEST_TARGET_BIND_CONFLICT');
    bindControlledLiveTarget(targetNativeId);
  }

  async assertTargetAllowed(eventId: string, targetSystem: 'BITRIX24' | 'MOYSKLAD', targetNativeId: string): Promise<void> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    const admission = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
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
    const record = admission && this.manifest.records.find((candidate: any) => candidate.entity === entity && candidate.name === admission.sourceName &&
      candidate.sourceSystem === admission.sourceSystem && (candidate.sourceNativeId === null || candidate.sourceNativeId === admission.sourceNativeId) &&
      candidate.targetSystem === targetSystem && candidate.targetNativeId === null);
    if (!admission || !record || admission.targetNativeId !== null || admission.targetSystem !== targetSystem || admission.entity !== entity) {
      throw new Error('CONTROLLED_LIVE_TEST_CREATE_NOT_RESERVED');
    }
  }

  async allowsSourceSideWrite(eventId: string): Promise<boolean> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return true;
    const admission = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
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
    for (const record of this.manifest.records) {
      if (record.entity !== entity || record.syntheticOnly !== true || !admissions.some((row: any) => row.sourceName === record.name)) continue;
      const forward = record.sourceSystem === input.sourceSystem && record.targetSystem === input.targetSystem &&
        (record.sourceNativeId === null || record.sourceNativeId === input.sourceNativeId) &&
        (record.targetNativeId === null || record.targetNativeId === input.targetNativeId);
      const reverse = record.direction === 'BOTH' && record.targetSystem === input.sourceSystem && record.sourceSystem === input.targetSystem &&
        (record.targetNativeId === null || record.targetNativeId === input.sourceNativeId) &&
        (record.sourceNativeId === null || record.sourceNativeId === input.targetNativeId);
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
        record.direction !== 'MOYSKLAD_TO_BITRIX24' && record.sourceSystem === sourceSystem && (record.sourceNativeId === null || record.sourceNativeId === sourceNativeId) ||
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
    const scope: ControlledLiveEventScope = {
      eventId, runId: admission.runId, entity: admission.entity,
      sourceSystem: admission.sourceSystem as ControlledLiveEventScope['sourceSystem'], sourceNativeId: admission.sourceNativeId,
      targetSystem: admission.targetSystem as ControlledLiveEventScope['targetSystem'], targetNativeId: admission.targetNativeId,
      admittedSourceName: admission.sourceName, admittedSourceCreatedAt: admission.sourceCreatedAt.toISOString(),
    };
    return scope;
  }
}

function controlledManifestEntity(value: string): string {
  if (['client:COMPANY', 'client:CONTACT', 'deal-order', 'invoice', 'catalog-product', 'catalog-service'].includes(value)) return value;
  if (value === 'COMPANY' || value === 'CONTACT') return `client:${value}`;
  throw new Error('CONTROLLED_LIVE_TEST_ENTITY_UNSUPPORTED');
}

function manifestMatchesAdmission(record: any, admission: any): boolean {
  const forward = record.sourceSystem === admission.sourceSystem && (record.sourceNativeId === null || record.sourceNativeId === admission.sourceNativeId) &&
    record.targetSystem === admission.targetSystem && (record.targetNativeId === null || record.targetNativeId === admission.targetNativeId);
  const reverse = record.direction === 'BOTH' && record.targetSystem === admission.sourceSystem && (record.targetNativeId === null || record.targetNativeId === admission.sourceNativeId) &&
    record.sourceSystem === admission.targetSystem && (record.sourceNativeId === null || record.sourceNativeId === admission.targetNativeId);
  return forward || reverse;
}
