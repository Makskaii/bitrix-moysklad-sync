import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { writeOperationalLog } from './monitoring-log';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(private readonly database: DatabaseService) {}

  onApplicationBootstrap() {
    void this.cleanupExpired().catch(() => undefined);
    this.timer = setInterval(() => { void this.cleanupExpired().catch(() => undefined); }, CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async cleanupExpired(now = new Date()) {
    const retentionDays = process.env.SYNC_MODE === 'dry' ? 7 : configuredRetentionDays();
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    const manualCaseCutoff = new Date(now.getTime() - 180 * DAY_MS);
    const auditCutoff = new Date(now.getTime() - 365 * DAY_MS);
    const openCases = await this.database.manualReviewCase.findMany({ where: { status: 'OPEN' }, select: { eventId: true } });
    const [events, apiAttempts, logs, resolvedCases, auditEntries] = await Promise.all([
      this.database.inboundEvent.deleteMany({ where: { receivedAt: { lt: cutoff }, id: { notIn: openCases.map((item) => item.eventId) } } }),
      this.database.apiAttempt.deleteMany({ where: { occurredAt: { lt: cutoff } } }),
      this.database.operationalLog.deleteMany({ where: { occurredAt: { lt: cutoff } } }),
      this.database.manualReviewCase.deleteMany({ where: { status: 'RESOLVED', resolvedAt: { lt: manualCaseCutoff } } }),
      this.database.adminAuditEntry.deleteMany({ where: { occurredAt: { lt: auditCutoff } } }),
    ]);
    if (events.count + apiAttempts.count + logs.count > 0) {
      await writeOperationalLog(
        this.database,
        'SCHEDULED',
        `Retention cleanup removed ${events.count} events, ${apiAttempts.count} API attempts, and ${logs.count} log entries`,
      );
    }
    return {
      retentionDays, cutoff, manualCaseRetentionDays: 180, auditRetentionDays: 365,
      eventsDeleted: events.count, apiAttemptsDeleted: apiAttempts.count, logsDeleted: logs.count,
      resolvedCasesDeleted: resolvedCases.count, auditEntriesDeleted: auditEntries.count,
    };
  }
}

function configuredRetentionDays(): number {
  const configured = process.env.SYNC_OPERATIONAL_RETENTION_DAYS;
  if (configured === undefined) return 30;
  const days = Number(configured);
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : 30;
}
