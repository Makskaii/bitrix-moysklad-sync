import { Prisma } from '@prisma/client';

/** Serialize resolver decisions with explicit assignments/reassignments. */
export async function lockEntityPairState(transaction: Prisma.TransactionClient): Promise<void> {
  await transaction.$queryRaw`WITH pair_lock AS MATERIALIZED (SELECT pg_advisory_xact_lock(713103, 11)) SELECT 1::int AS locked FROM pair_lock`;
}
