import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { bindControlledLiveTarget, ControlledLiveEventScope, createControlledLiveTestPolicy, enterControlledLiveEventScope, withControlledLiveEventScope } from './controlled-live-test-policy';
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
    const scopedEntity = source.entity.startsWith('client:') ? source.entity : `client:${source.entity}`;
    if (!source.currentNativeId || source.currentNativeId !== source.sourceNativeId) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_ID_MISMATCH');
    const priorAdmissions = await this.database.controlledTestAdmission.findMany({ where: { runId: this.manifest.runId, entity: scopedEntity } });
    const match = this.manifest.records.map((candidate: any) => {
      if (candidate.entity !== scopedEntity || candidate.syntheticOnly !== true || candidate.name !== source.currentName ||
          !source.currentName.includes('тест') || !source.currentName.includes(this.manifest.runId) ||
          source.sourceCreatedAt.getTime() < new Date(candidate.createdAfterUtc).getTime() || source.sourceCreatedAt.getTime() > Date.now()) return null;
      if (candidate.sourceSystem === source.sourceSystem &&
          (candidate.sourceNativeId === null || candidate.sourceNativeId === source.sourceNativeId)) return { record: candidate, reversed: false, prior: null };
      if (candidate.targetSystem === source.sourceSystem) {
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

  async bindCreatedTarget(eventId: string, targetNativeId: string, verifiedTargetNativeId: string, verifiedTargetName: string, targetCreatedAt: Date): Promise<void> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    const admission = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
    const record = admission && this.manifest.records.find((candidate: any) => candidate.entity === admission.entity && candidate.name === admission.sourceName && (
      candidate.sourceSystem === admission.sourceSystem && (candidate.sourceNativeId === null || candidate.sourceNativeId === admission.sourceNativeId) && candidate.targetSystem === admission.targetSystem ||
      candidate.targetSystem === admission.sourceSystem && candidate.targetNativeId === admission.sourceNativeId && candidate.sourceSystem === admission.targetSystem));
    if (!admission || !record || !targetNativeId || verifiedTargetNativeId !== targetNativeId || verifiedTargetName !== admission.sourceName ||
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
      candidate.name === admission.sourceName && (
        candidate.sourceSystem === admission.sourceSystem && (candidate.sourceNativeId === null || candidate.sourceNativeId === admission.sourceNativeId) ||
        candidate.targetSystem === admission.sourceSystem && candidate.targetNativeId === admission.sourceNativeId));
    if (!admission || !record || admission.targetSystem !== targetSystem || admission.targetNativeId !== targetNativeId ||
        (record.targetNativeId !== null && record.targetNativeId !== targetNativeId)) {
      throw new Error('CONTROLLED_LIVE_TEST_TARGET_NOT_MANIFESTED');
    }
  }

  async runForEvent<T>(eventId: string, action: () => Promise<T>): Promise<T> {
    if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return action();
    const admission = await this.database.controlledTestAdmission.findUnique({ where: { eventId } });
    if (!admission) return action();
    return withControlledLiveEventScope(this.scope(eventId, admission), action);
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
