import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DatabaseService } from './database.service';
import { withServiceModeOn } from './service-mode-transaction';

const MAX_CONCURRENT_EVENT_WORKERS = 4;
const EVENT_WORKER_LEASE_MS = 60_000;
const EVENT_WORKER_RENEW_MS = 15_000;

type Lease = { slot: number; ownerToken: string };
export interface EventWorkerLeaseContext {
  assertOwned(): Promise<void>;
  assertOwnedIn?(transaction: Pick<Prisma.TransactionClient, 'eventWorkerLease' | 'inboundEntityLock'>): Promise<void>;
}

/** A PostgreSQL-backed global semaphore shared by all event processors/instances. */
@Injectable()
export class EventWorkerLeaseService {
  constructor(private readonly database: DatabaseService) {}

  async run<T>(eventId: string, work: (lease: EventWorkerLeaseContext) => Promise<T>): Promise<T | null> {
    const lease = await this.acquire(eventId);
    if (!lease) return null;
    let lost = false;
    const renewal = setInterval(() => {
      void this.renew(lease).then((renewed) => { if (!renewed) lost = true; }).catch(() => { lost = true; });
    }, EVENT_WORKER_RENEW_MS);
    renewal.unref();
    try {
      const assertOwned = async () => {
        if (lost || !await this.renew(lease)) {
          lost = true;
          throw new Error('EVENT_WORKER_LEASE_LOST');
        }
      };
      const result = await work({
        assertOwned,
        assertOwnedIn: async (transaction) => {
          if (lost) throw new Error('EVENT_WORKER_LEASE_LOST');
          const renewed = await transaction.eventWorkerLease.updateMany({
            where: { slot: lease.slot, ownerToken: lease.ownerToken, leaseExpiresAt: { gt: new Date() } },
            data: { leaseExpiresAt: new Date(Date.now() + EVENT_WORKER_LEASE_MS) },
          });
          if (renewed.count !== 1) { lost = true; throw new Error('EVENT_WORKER_LEASE_LOST'); }
        },
      });
      await assertOwned();
      return result;
    } finally {
      clearInterval(renewal);
      await this.release(lease).catch(() => undefined);
    }
  }

  private async acquire(eventId: string): Promise<Lease | null> {
    const now = new Date();
    const ownerToken = randomUUID();
    // Serialize new persistent semaphore leases with ON→OFF; never hold this lock
    // across worker execution. Renewal and release of an existing lease stay ungated.
    const result = await withServiceModeOn(this.database, async (transaction) => {
      for (let slot = 0; slot < MAX_CONCURRENT_EVENT_WORKERS; slot++) {
        await transaction.$executeRaw`
          INSERT INTO "EventWorkerLease" ("slot", "ownerToken", "eventId", "leaseExpiresAt", "updatedAt")
          VALUES (${slot}, '', '', ${new Date(0)}, NOW())
          ON CONFLICT ("slot") DO NOTHING
        `;
        const claimed = await transaction.eventWorkerLease.updateMany({
          where: { slot, leaseExpiresAt: { lte: now } },
          data: { ownerToken, eventId, leaseExpiresAt: new Date(now.getTime() + EVENT_WORKER_LEASE_MS) },
        });
        if (claimed.count === 1) return { slot, ownerToken };
      }
      return null;
    });
    return result.enabled ? result.value : null;
  }

  private async renew(lease: Lease): Promise<boolean> {
    const now = new Date();
    const renewed = await this.database.eventWorkerLease.updateMany({
      where: { slot: lease.slot, ownerToken: lease.ownerToken, leaseExpiresAt: { gt: now } },
      data: { leaseExpiresAt: new Date(now.getTime() + EVENT_WORKER_LEASE_MS) },
    });
    return renewed.count === 1;
  }

  private async release(lease: Lease): Promise<void> {
    await this.database.eventWorkerLease.updateMany({
      where: { slot: lease.slot, ownerToken: lease.ownerToken },
      data: { ownerToken: '', eventId: '', leaseExpiresAt: new Date(0) },
    });
  }
}
