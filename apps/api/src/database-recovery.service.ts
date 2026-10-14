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
    if (state && isReadyState(state) && state.previousLaunchBoundary && await this.hasMatchingAudit(state.previousLaunchBoundary)) {
      setDatabaseRecoveryReady(true);
      return;
    }
    await this.database.syncSetting.updateMany({ where: { id: 'global' }, data: { serviceMode: 'off' } });
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
    if (!isReadyState(state)) return { ...unavailable, status: state.status ?? unavailable.status, audit };
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
    const ready = Boolean(state && isReadyState(state) && state.previousLaunchBoundary && await this.hasMatchingAudit(state.previousLaunchBoundary));
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

  private async hasMatchingAudit(boundary: Date): Promise<boolean> {
    const audit = await this.database.databaseRecoveryAudit.findFirst({
      where: {
        action: 'DATABASE_LOSS_RECOVERY_CONFIRMED', actorType: 'VERIFIED_BITRIX24_ADMIN',
        boundaryAt: boundary, pairsRestored: true, lostEventsAcknowledged: true,
      },
      select: { actorId: true },
    });
    return typeof audit?.actorId === 'string' && /^BITRIX24_USER:\d{1,20}$/.test(audit.actorId);
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
  return state?.status === 'READY' && state.previousLaunchBoundary instanceof Date &&
    Number.isFinite(state.previousLaunchBoundary.getTime()) && state.pairsRestored === true &&
    state.lostEventsAcknowledged === true && state.acknowledgedAt instanceof Date &&
    typeof state.acknowledgement === 'string' && state.acknowledgement.trim().length >= 20;
}
