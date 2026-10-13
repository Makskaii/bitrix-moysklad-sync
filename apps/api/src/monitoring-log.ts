import { DatabaseService } from './database.service';
import { RotatingFileLogger } from './rotating-file.logger';

export type OperationalLogCategory = 'EVENT' | 'SCHEDULED' | 'ERROR' | 'ADMIN' | 'MANUAL' | 'SYSTEM' | 'API';

const fileByCategory: Record<OperationalLogCategory, string> = {
  EVENT: 'events.log',
  SCHEDULED: 'cron-system.log',
  SYSTEM: 'cron-system.log',
  ERROR: 'errors.log',
  ADMIN: 'admin.log',
  MANUAL: 'manual-review.log',
  API: 'api.log',
};
const fileLoggers = new Map<string, RotatingFileLogger>();

export async function writeOperationalLog(
  database: DatabaseService,
  category: OperationalLogCategory,
  message: string,
  referenceId?: string | null,
) {
  try {
    await database.operationalLog.create({ data: { category, message, referenceId: referenceId ?? null } });
  } catch {
    // An auxiliary log write must not undo an accepted event or a completed operation.
  }
  try {
    const fileName = fileByCategory[category];
    let logger = fileLoggers.get(fileName);
    if (!logger) {
      logger = new RotatingFileLogger(undefined, undefined, fileName);
      fileLoggers.set(fileName, logger);
    }
    logger.log(referenceId ? `${message} · ${referenceId}` : message, category);
  } catch {
    // File logging is best effort; it must never roll back an accepted operation.
  }
}
