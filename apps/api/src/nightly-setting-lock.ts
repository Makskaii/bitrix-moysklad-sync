import { Prisma } from '@prisma/client';
import { DatabaseService } from './database.service';

/** Acquire the row before evaluating lease clocks. NOW() is fixed at transaction
 * start and can already be stale after waiting behind bounded provider reads. */
export function withNightlySettingLock<T>(database: DatabaseService, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return database.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('lock_timeout', '15000ms', true)`;
    await tx.$queryRaw`SELECT set_config('statement_timeout', '15000ms', true)`;
    await tx.$queryRaw`SELECT "id" FROM "SyncSetting" WHERE "id" = 'global' FOR NO KEY UPDATE`;
    return operation(tx);
  }, { maxWait: 5_000, timeout: 20_000 });
}
