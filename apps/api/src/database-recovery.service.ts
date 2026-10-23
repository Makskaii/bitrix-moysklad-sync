import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from './database.service';
import { setDatabaseRecoveryReady } from './external-write-guard';

const unavailable = { status: 'RECOVERY_REQUIRED' as const, previousLaunchBoundary: null, pairsRestored: false, lostEventsAcknowledged: false };

export type DatabaseRecoveryConfirmation = {
  previousLaunchBoundary?: unknown;
  pairsRestored?: unknown;
  lostEventsAcknowledged?: unknown;
  acknowledgement?: unknown;
};

@Injectable()
export class DatabaseRecoveryService {
  constructor(private readonly database: DatabaseService) {}

  /** Runs before listen. Missing or invalid evidence closes the process write gate. */
  async initialize(): Promise<void> {
    setDatabaseRecoveryReady(false);
    const state = await this.database.databaseRecoveryState.findUnique({ where: { id: 'global' } });
    if (state && isReadyState(state) && state.previousLaunchBoundary && await this.hasMatchingAudit(state.previousLaunchBoundary, state.status)) {
      setDatabaseRecoveryReady(true);
      return;
    }
    await this.database.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "SyncSetting" WHERE "id"='global' FOR UPDATE`;
      await tx.syncSetting.updateMany({ where: { id: 'global' }, data: { serviceMode: 'off' } });
    });
  }

  async readStatus() {
    const state = await this.database.databaseRecoveryState.findUnique({
      where: { id: 'global' },
      select: { status: true, previousLaunchBoundary: true, pairsRestored: true, lostEventsAcknowledged: true, acknowledgedAt: true, acknowledgement: true },
    });
    const audit = await this.database.databaseRecoveryAudit.findMany({
      where: { recoveryStateId: 'global' }, orderBy: { occurredAt: 'desc' }, take: 20,
      select: { action: true, actorId: true, oldBoundaryAt: true, boundaryAt: true, occurredAt: true, acknowledgement: true },
    });
    if (!state) return { ...unavailable, audit };
    if (!isReadyState(state) || !state.previousLaunchBoundary || !await this.hasMatchingAudit(state.previousLaunchBoundary, state.status)) return { ...unavailable, audit };
    return {
      status: state.status,
      previousLaunchBoundary: state.previousLaunchBoundary,
      pairsRestored: state.pairsRestored,
      lostEventsAcknowledged: state.lostEventsAcknowledged,
      acknowledgedAt: state.acknowledgedAt,
      acknowledgement: state.acknowledgement,
      audit,
    };
  }

  async assertReady(): Promise<boolean> {
    const state = await this.database.databaseRecoveryState.findUnique({ where: { id: 'global' } });
    const ready = Boolean(state && isReadyState(state) && state.previousLaunchBoundary && await this.hasMatchingAudit(state.previousLaunchBoundary, state.status));
    setDatabaseRecoveryReady(ready);
    return ready;
  }

  async launchBoundary(): Promise<Date | null> {
    if (!await this.assertReady()) return null;
    const state = await this.database.databaseRecoveryState.findUnique({
      where: { id: 'global' }, select: { previousLaunchBoundary: true },
    });
    return state?.previousLaunchBoundary ?? null;
  }

  private async hasMatchingAudit(boundary: Date, status: string): Promise<boolean> {
    const fresh = status === 'READY_FRESH';
    const audit = await this.database.databaseRecoveryAudit.findFirst({
      where: {
        action: fresh ? 'FIRST_LAUNCH_CONFIRMED' : 'DATABASE_LOSS_RECOVERY_CONFIRMED', actorType: 'VERIFIED_BITRIX24_ADMIN',
        boundaryAt: boundary, pairsRestored: !fresh, lostEventsAcknowledged: !fresh,
      },
      select: { actorId: true },
    });
    return typeof audit?.actorId === 'string' && /^BITRIX24_USER:\d{1,20}$/.test(audit.actorId);
  }

  /** A new, empty database is not a recovered database. Never fabricates restoration evidence. */
  async confirmFirstLaunch(input: { confirmed?: unknown; acknowledgement?: unknown }, actorId: string) {
    const acknowledgement = typeof input.acknowledgement === 'string' ? input.acknowledgement.trim() : '';
    if (input.confirmed !== true || acknowledgement.length < 20 || acknowledgement.length > 1000) {
      throw new BadRequestException('Explicit first-launch confirmation and explanation (20 to 1000 characters) are required');
    }
    if (!/^BITRIX24_USER:\d{1,20}$/.test(actorId)) throw new BadRequestException('A verified Bitrix24 administrator identity is required');
    await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('database-recovery-global'))::text AS locked`;
      const existing = await transaction.databaseRecoveryState.findUnique({ where: { id: 'global' } });
      if (existing?.previousLaunchBoundary || existing?.acknowledgedAt || isReadyState(existing)) {
        throw new ConflictException('A launch boundary already exists and cannot be replaced');
      }
      // Exclude settings and operational logs only: any exchange/history evidence forbids first launch.
      const occupied = await transaction.$queryRaw<Array<{ occupied: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM "InboundEvent" UNION ALL SELECT 1 FROM "EntityPair"
          UNION ALL SELECT 1 FROM "ContactPair" UNION ALL SELECT 1 FROM "ContactSnapshot"
          UNION ALL SELECT 1 FROM "DatabaseRecoveryAudit" UNION ALL SELECT 1 FROM "ControlledTestAdmission"
          UNION ALL SELECT 1 FROM "ControlledTestSourceBinding" UNION ALL SELECT 1 FROM "ManualReviewCase"
          UNION ALL SELECT 1 FROM "ApiAttempt" UNION ALL SELECT 1 FROM "DryRunWriteProposal"
          UNION ALL SELECT 1 FROM "ClientInventoryJob" UNION ALL SELECT 1 FROM "ClientInventoryObject"
          UNION ALL SELECT 1 FROM "HistoricalInventoryJob" UNION ALL SELECT 1 FROM "HistoricalDealOrderMatchingRun"
          UNION ALL SELECT 1 FROM "DealOrderCreateOperation" UNION ALL SELECT 1 FROM "DependencyCreateOperation"
          UNION ALL SELECT 1 FROM "DealOrderReverseCreateOperation" UNION ALL SELECT 1 FROM "PairReviewCase"
          UNION ALL SELECT 1 FROM "ProductDuplicateAlias" UNION ALL SELECT 1 FROM "ClientDependencyRetry"
          UNION ALL SELECT 1 FROM "EntityPairBaseline" UNION ALL SELECT 1 FROM "EntityPairSyncState"
          UNION ALL SELECT 1 FROM "EntityPairSettingsRevision" UNION ALL SELECT 1 FROM "InboundEventSettings"
          UNION ALL SELECT 1 FROM "InboundEntityLock" UNION ALL SELECT 1 FROM "EventWorkerLease"
          UNION ALL SELECT 1 FROM "DealOrderReverseProductOperation" UNION ALL SELECT 1 FROM "DealOrderReversePositionOperation"
          UNION ALL SELECT 1 FROM "DealOrderPositionPair" UNION ALL SELECT 1 FROM "DealOrderPositionAddOperation"
          UNION ALL SELECT 1 FROM "HistoricalInventoryEntry" UNION ALL SELECT 1 FROM "HistoricalDealOrderDuplicateKey"
          UNION ALL SELECT 1 FROM "HistoricalDealOrderMatchResult"
          UNION ALL SELECT 1 FROM "SyncModeTransition" WHERE "toMode" = 'on' OR "fromMode" = 'on'
        ) AS occupied`;
      if (occupied[0]?.occupied !== false) throw new ConflictException('First launch requires an empty exchange database; existing history must not be reset');
      await transaction.$queryRaw`SELECT "id" FROM "SyncSetting" WHERE "id" = 'global' FOR UPDATE`;
      const mode = await transaction.syncSetting.findUnique({ where: { id: 'global' } });
      if (mode && mode.serviceMode !== 'off') throw new ConflictException('First launch requires service mode Off');
      if (mode?.lastActiveAt) throw new ConflictException('First launch cannot reset prior activation history');
      const boundary = new Date();
      const data = { status: 'READY_FRESH', previousLaunchBoundary: boundary, pairsRestored: false,
        lostEventsAcknowledged: false, acknowledgedAt: boundary, acknowledgement };
      await transaction.databaseRecoveryState.upsert({ where: { id: 'global' }, create: { id: 'global', ...data }, update: data });
      await transaction.databaseRecoveryAudit.create({ data: {
        id: randomUUID(), action: 'FIRST_LAUNCH_CONFIRMED', actorType: 'VERIFIED_BITRIX24_ADMIN', actorId,
        oldBoundaryAt: null, boundaryAt: boundary, pairsRestored: false, lostEventsAcknowledged: false,
        acknowledgement, recoveryStateId: 'global',
      } });
      await transaction.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'off' }, update: { serviceMode: 'off' } });
    });
    setDatabaseRecoveryReady(true);
    return this.readStatus();
  }

  async confirmRecovery(input: DatabaseRecoveryConfirmation, actorId: string) {
    const boundaryText = typeof input.previousLaunchBoundary === 'string' ? input.previousLaunchBoundary : '';
    const boundary = isIsoTimestampWithTimezone(boundaryText) ? new Date(boundaryText) : null;
    const acknowledgement = typeof input.acknowledgement === 'string' ? input.acknowledgement.trim() : '';
    if (!boundary || !Number.isFinite(boundary.getTime())) throw new BadRequestException('previousLaunchBoundary must be a valid ISO timestamp from the independent operations record');
    if (input.pairsRestored !== true) throw new BadRequestException('Explicit confirmation that entity pairs were restored is required');
    if (input.lostEventsAcknowledged !== true) throw new BadRequestException('Explicit acknowledgement of unrecoverable events is required');
    if (acknowledgement.length < 20 || acknowledgement.length > 1000) throw new BadRequestException('acknowledgement must explain the accepted data-loss risk (20 to 1000 characters)');
    if (!/^BITRIX24_USER:\d{1,20}$/.test(actorId)) throw new BadRequestException('A verified Bitrix24 administrator identity is required');

    await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ locked: string }>>`SELECT pg_advisory_xact_lock(hashtext('database-recovery-global'))::text AS locked`;
      await transaction.$queryRaw`SELECT "id" FROM "SyncSetting" WHERE "id"='global' FOR UPDATE`;
      const existing = await transaction.databaseRecoveryState.findUnique({ where: { id: 'global' } });
      if (isReadyState(existing)) throw new ConflictException('Database recovery was already acknowledged; its launch boundary cannot be replaced through this action');
      await transaction.databaseRecoveryState.upsert({
        where: { id: 'global' },
        create: {
          id: 'global', status: 'READY', previousLaunchBoundary: boundary,
          pairsRestored: true, lostEventsAcknowledged: true, acknowledgedAt: new Date(), acknowledgement,
        },
        update: {
          status: 'READY', previousLaunchBoundary: boundary,
          pairsRestored: true, lostEventsAcknowledged: true, acknowledgedAt: new Date(), acknowledgement,
        },
      });
      await transaction.databaseRecoveryAudit.create({
        data: {
          id: randomUUID(), action: 'DATABASE_LOSS_RECOVERY_CONFIRMED', actorType: 'VERIFIED_BITRIX24_ADMIN', actorId,
          oldBoundaryAt: existing?.previousLaunchBoundary ?? null,
          boundaryAt: boundary, pairsRestored: true, lostEventsAcknowledged: true, acknowledgement,
          recoveryStateId: 'global',
        },
      });
      await transaction.syncSetting.updateMany({ where: { id: 'global' }, data: { serviceMode: 'off' } });
    });

    setDatabaseRecoveryReady(true);
    return this.readStatus();
  }
}

function isIsoTimestampWithTimezone(value: string): boolean {
  // Require an explicit time and timezone; Date.parse alone also accepts ambiguous
  // inputs such as date-only values and locale-like strings.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const datePart = value.slice(0, 10);
  const dateOnly = new Date(`${datePart}T00:00:00.000Z`);
  if (!Number.isFinite(dateOnly.getTime()) || dateOnly.toISOString().slice(0, 10) !== datePart) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime());
}

function isReadyState(state: {
  status?: string;
  previousLaunchBoundary?: Date | null;
  pairsRestored?: boolean;
  lostEventsAcknowledged?: boolean;
  acknowledgedAt?: Date | null;
  acknowledgement?: string | null;
} | null | undefined): boolean {
  return (state?.status === 'READY' || state?.status === 'READY_FRESH') && state.previousLaunchBoundary instanceof Date &&
    Number.isFinite(state.previousLaunchBoundary.getTime()) && state.pairsRestored === (state.status === 'READY') &&
    state.lostEventsAcknowledged === (state.status === 'READY') && state.acknowledgedAt instanceof Date &&
    typeof state.acknowledgement === 'string' && state.acknowledgement.trim().length >= 20;
}
