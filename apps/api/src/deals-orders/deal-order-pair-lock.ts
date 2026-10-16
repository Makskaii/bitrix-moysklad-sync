import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';

const LEASE_MS = 60_000;
const RENEW_MS = 15_000;

export type DealOrderPairLease = {
  assertOwner: () => Promise<boolean>;
  /** Fence a local state change against lease takeover in the same DB transaction. */
  commit: <T>(work: (transaction: Prisma.TransactionClient) => Promise<T>) => Promise<{ committed: true; value: T } | { committed: false }>;
};

/** Cross-process lease shared by the header and row runtimes for one confirmed document pair. */
export async function withDealOrderPairLock<T>(
  database: DatabaseService,
  pairId: string,
  eventId: string,
  action: (lease: DealOrderPairLease) => Promise<T>,
): Promise<T | null> {
  const entityKey = `DEAL_ORDER_PAIR:${pairId}`;
  const ownerToken = randomUUID();
  const now = new Date();
  const reclaimed = await database.inboundEntityLock.updateMany({
    where: { entityKey, leaseExpiresAt: { lte: now } },
    data: { ownerToken, eventId, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
  });
  let acquired = reclaimed.count === 1;
  if (!acquired) {
    try {
      await database.inboundEntityLock.create({ data: { entityKey, ownerToken, eventId, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) } });
      acquired = true;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
    }
  }
  if (!acquired) return null;

  let renewing = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void database.inboundEntityLock.updateMany({
      where: { entityKey, ownerToken },
      data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
    }).then(() => { renewing = false; }, () => { renewing = false; });
  }, RENEW_MS);
  timer.unref();
  const assertOwner = async () => {
    const current = await database.inboundEntityLock.findUnique({ where: { entityKey }, select: { ownerToken: true, leaseExpiresAt: true } });
    return current?.ownerToken === ownerToken && current.leaseExpiresAt > new Date();
  };
  const lease: DealOrderPairLease = {
    assertOwner,
    commit: async <V>(work: (transaction: Prisma.TransactionClient) => Promise<V>) => database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ ownerToken: string; leaseExpiresAt: Date }>>`
        SELECT "ownerToken", "leaseExpiresAt"
        FROM "InboundEntityLock"
        WHERE "entityKey" = ${entityKey}
        FOR UPDATE
      `;
      const owner = rows[0];
      if (!owner || owner.ownerToken !== ownerToken || owner.leaseExpiresAt <= new Date()) return { committed: false as const };
      return { committed: true as const, value: await work(transaction) };
    }, { maxWait: 5_000, timeout: 30_000 }),
  };
  try {
    if (!await assertOwner()) return null;
    return await action(lease);
  } finally {
    clearInterval(timer);
    await database.inboundEntityLock.deleteMany({ where: { entityKey, ownerToken } }).catch(() => undefined);
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
}

