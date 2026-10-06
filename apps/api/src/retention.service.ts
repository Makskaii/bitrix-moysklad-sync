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
    const retentionDays = process.env.SYNC_MODE === 'dry' ? 7 : 30;
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    const [events, apiAttempts, logs] = await Promise.all([
      this.database.inboundEvent.deleteMany({ where: { receivedAt: { lt: cutoff } } }),
      this.database.apiAttempt.deleteMany({ where: { occurredAt: { lt: cutoff } } }),
      this.database.operationalLog.deleteMany({
        where: {
          occurredAt: { lt: cutoff },
          ...(retentionDays === 7 ? {} : { category: { in: ['EVENT', 'SCHEDULED'] } }),
        },
      }),
    ]);
    if (events.count + apiAttempts.count + logs.count > 0) {
      await writeOperationalLog(
        this.database,
        'SCHEDULED',
        `Retention cleanup removed ${events.count} events, ${apiAttempts.count} API attempts, and ${logs.count} log entries`,
      );
    }
    return { retentionDays, cutoff, eventsDeleted: events.count, apiAttemptsDeleted: apiAttempts.count, logsDeleted: logs.count };
  }
}
