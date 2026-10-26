import { Prisma } from '@prisma/client';

export class ForwardOrderPairPendingError extends Error {
  constructor() { super('FORWARD_ORDER_PAIR_PENDING'); }
}
export class ForwardOrderOwnershipConflictError extends Error {
  constructor() { super('FORWARD_ORDER_OWNERSHIP_CONFLICT'); }
}

/** Only our attempted durable forward journal proves ownership. Provider
 * descriptions, origin markers and unattempted local reservations do not.
 * Native syncId closes the provider-response-before-target-ID-save window. */
export async function forwardOrderOwnership(
  database: Pick<Prisma.TransactionClient, 'dealOrderCreateOperation'>,
  orderId: string,
  nativeSyncId?: unknown,
): Promise<'NONE' | 'PENDING' | 'CONFLICT'> {
  const syncId = typeof nativeSyncId === 'string' && uuid(nativeSyncId) ? nativeSyncId : null;
  const operations = await database.dealOrderCreateOperation.findMany({
    where: { OR: [{ moyskladOrderId: orderId }, ...(syncId ? [{ syncId }] : [])] }, take: 2,
    select: { bitrix24DealId: true, syncId: true, moyskladOrderId: true, attemptedAt: true, status: true },
  });
  // A provider marker matching only an unattempted reservation is not proof
  // that we created this native order. An actual saved target is authoritative.
  const evidence = operations.filter(operation => operation.moyskladOrderId === orderId || operation.attemptedAt !== null);
  if (!evidence.length) return 'NONE';
  if (evidence.length !== 1) return 'CONFLICT';
  const owner = evidence[0];
  if (!/^\d{1,20}$/.test(owner.bitrix24DealId) || !uuid(owner.syncId) || !owner.attemptedAt ||
      owner.moyskladOrderId !== null && owner.moyskladOrderId !== orderId ||
      !['PENDING', 'SUCCEEDED', 'PARTIAL'].includes(owner.status) || owner.status !== 'PENDING' && owner.moyskladOrderId === null) return 'CONFLICT';
  // Pair commit can finish between a caller's pair read and this journal read.
  // Re-resolve the pair on the next tick, never turn that benign interleaving
  // into a false review or permit a reverse ADD to continue.
  return 'PENDING';
}

export async function assertNoForwardOrderOwner(
  database: Pick<Prisma.TransactionClient, 'dealOrderCreateOperation'>, orderId: string, nativeSyncId?: unknown,
): Promise<void> {
  const ownership = await forwardOrderOwnership(database, orderId, nativeSyncId);
  if (ownership === 'PENDING') throw new ForwardOrderPairPendingError();
  if (ownership === 'CONFLICT') throw new ForwardOrderOwnershipConflictError();
}
function uuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
