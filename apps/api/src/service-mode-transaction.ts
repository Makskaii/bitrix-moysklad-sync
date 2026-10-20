import { Prisma } from '@prisma/client';
import { DatabaseService } from './database.service';

/** Run work while holding the authoritative global mode row against ON→OFF. */
export async function withServiceModeOn<T>(
  database: DatabaseService,
  work: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<{ enabled: false } | { enabled: true; value: T }> {
  return database.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<Array<{ serviceMode: string }>>`
      SELECT "serviceMode" FROM "SyncSetting" WHERE "id" = 'global' FOR SHARE
    `;
    if (rows[0]?.serviceMode !== 'on') return { enabled: false };
    return { enabled: true, value: await work(transaction) };
  });
}
