import { Prisma } from '@prisma/client';
import { DatabaseService } from './database.service';

/** Run work while holding the authoritative global mode row against ON→OFF. */
export async function withServiceModeOn<T>(
  database: DatabaseService,
  work: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<{ enabled: false } | { enabled: true; value: T }> {
  // Provider adapters use bounded 10s HTTP requests; keep the mode lock only
  // slightly longer than one operation, never an unbounded worker lifetime.
  return database.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<Array<{ serviceMode: string }>>`
      SELECT "serviceMode" FROM "SyncSetting" WHERE "id" = 'global' FOR SHARE
    `;
    if (rows[0]?.serviceMode !== 'on') return { enabled: false };
    return { enabled: true, value: await work(transaction) };
  }, { maxWait: 5_000, timeout: 15_000 });
}

export class ServiceModeNotOnError extends Error {
  constructor() { super('SERVICE_MODE_NOT_ON'); }
}

/** Gate each provider method at the transport boundary and hold the mode lock until it settles. */
export function serviceModeBoundProvider<T extends object>(database: DatabaseService, provider: T): T {
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => withServiceModeOn(database, async () => Reflect.apply(value, target, args)).then((result) => {
        if (!result.enabled) throw new ServiceModeNotOnError();
        return result.value;
      });
    },
  });
}
