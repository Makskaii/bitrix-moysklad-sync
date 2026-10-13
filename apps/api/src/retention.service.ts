import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { writeOperationalLog } from './monitoring-log';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const RESOLVED_REVIEW_RETENTION_DAYS = 180;
const ADMIN_AUDIT_RETENTION_DAYS = 365;

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
    const retentionDays = process.env.SYNC_MODE === 'dry' ? 7 : 30;
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    const resolvedReviewCutoff = new Date(now.getTime() - RESOLVED_REVIEW_RETENTION_DAYS * DAY_MS);
    const adminAuditCutoff = new Date(now.getTime() - ADMIN_AUDIT_RETENTION_DAYS * DAY_MS);
    const [events, apiAttempts, logs, resolvedManualReviews, resolvedPairReviews, adminAuditEntries] = await Promise.all([
      this.database.inboundEvent.deleteMany({ where: { receivedAt: { lt: cutoff } } }),
      this.database.apiAttempt.deleteMany({ where: { occurredAt: { lt: cutoff } } }),
      this.database.operationalLog.deleteMany({ where: { occurredAt: { lt: cutoff } } }),
      this.database.manualReviewCase.deleteMany({
        where: { status: 'RESOLVED', resolvedAt: { lt: resolvedReviewCutoff } },
      }),
      this.database.pairReviewCase.deleteMany({
        where: { status: 'RESOLVED', resolvedAt: { lt: resolvedReviewCutoff } },
      }),
      this.database.adminAuditEntry.deleteMany({ where: { occurredAt: { lt: adminAuditCutoff } } }),
    ]);
    if (events.count + apiAttempts.count + logs.count + resolvedManualReviews.count + resolvedPairReviews.count + adminAuditEntries.count > 0) {
      await writeOperationalLog(
        this.database,
        'SCHEDULED',
        `Retention cleanup removed ${events.count} events, ${apiAttempts.count} API attempts, ${logs.count} log entries, ${resolvedManualReviews.count + resolvedPairReviews.count} resolved reviews, and ${adminAuditEntries.count} admin audit entries`,
      );
    }
    return {
      retentionDays,
      cutoff,
      resolvedReviewRetentionDays: RESOLVED_REVIEW_RETENTION_DAYS,
      adminAuditRetentionDays: ADMIN_AUDIT_RETENTION_DAYS,
      eventsDeleted: events.count,
      apiAttemptsDeleted: apiAttempts.count,
      logsDeleted: logs.count,
      resolvedReviewsDeleted: resolvedManualReviews.count + resolvedPairReviews.count,
      adminAuditEntriesDeleted: adminAuditEntries.count,
    };
  }
}
