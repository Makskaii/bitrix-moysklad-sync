import { randomUUID } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DatabaseService } from './database.service';
import { withServiceModeOn } from './service-mode-transaction';

const MAX_CONCURRENT_EVENT_WORKERS = 4;
const EVENT_WORKER_LEASE_MS = 60_000;
const EVENT_WORKER_RENEW_MS = 15_000;

type Lease = { slot: number; ownerToken: string };
type PendingWorker = { eventId: string; execute: () => Promise<void>; cancel: () => void };
const MAX_PENDING_PER_LANE = 100;
const BUSY_RETRY_MS = 250;
export interface EventWorkerLeaseContext {
  assertOwned(): Promise<void>;
  assertOwnedIn?(transaction: Pick<Prisma.TransactionClient, 'eventWorkerLease' | 'inboundEntityLock'>): Promise<void>;
}

/** A PostgreSQL-backed global semaphore shared by all event processors/instances. */
@Injectable()
export class EventWorkerLeaseService implements OnModuleDestroy {
  private readonly waiting = new Map<string, PendingWorker[]>();
  private readonly scheduled = new Map<string, Promise<unknown>>();
  private readonly lanes: string[] = [];
  private running = 0;
  private stopped = false;
  private retryTimer?: NodeJS.Timeout;
  constructor(private readonly database: DatabaseService) {}

  run<T>(eventId: string, work: (lease: EventWorkerLeaseContext) => Promise<T>, lane = 'events'): Promise<T | null> {
    if (this.stopped) return Promise.resolve(null);
    const existing = this.scheduled.get(eventId);
    if (existing) return existing as Promise<T | null>;
    let queue = this.waiting.get(lane);
    if ((queue?.length ?? 0) >= MAX_PENDING_PER_LANE) return Promise.resolve(null);
    if (!queue) { queue = []; this.waiting.set(lane, queue); this.lanes.push(lane); }
    let settle!: (value: T | null) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<T | null>((resolve, fail) => { settle = resolve; reject = fail; });
    this.scheduled.set(eventId, result);
    queue.push({ eventId, cancel: () => settle(null), execute: AsyncResource.bind(async () => {
      try {
        // The local queue is only fair admission; PostgreSQL remains the global
        // four-slot authority. Do not consume a worker while polling another instance.
        const acquired = await this.acquire(eventId);
        if (this.stopped) {
          if (acquired.enabled && acquired.lease) await this.release(acquired.lease);
          settle(null); return;
        }
        if (!acquired.enabled) { settle(null); this.cancelWaiting(); return; }
        if (!acquired.lease) {
          if (this.stopped) settle(null);
          else {
            let retryQueue = this.waiting.get(lane);
            if (!retryQueue) { retryQueue = []; this.waiting.set(lane, retryQueue); this.lanes.push(lane); }
            retryQueue.push(entry);
            this.scheduleRetry();
          }
          return;
        }
        settle(await this.execute(acquired.lease, work));
      } catch (error) { reject(error); }
    }) });
    const entry = queue[queue.length - 1]!;
    void result.finally(() => this.scheduled.delete(eventId)).catch(() => undefined);
    this.pump();
    return result;
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.cancelWaiting();
  }

  private cancelWaiting() {
    for (const queue of this.waiting.values()) for (const entry of queue) entry.cancel();
    this.waiting.clear(); this.lanes.length = 0;
  }

  private scheduleRetry() {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, BUSY_RETRY_MS);
    this.retryTimer.unref();
  }

  private pump() {
    if (this.stopped || this.retryTimer) return;
    while (this.running < MAX_CONCURRENT_EVENT_WORKERS && this.lanes.length) {
      const lane = this.lanes.shift()!;
      const queue = this.waiting.get(lane)!;
      const entry = queue.shift()!;
      if (queue.length) this.lanes.push(lane);
      else this.waiting.delete(lane);
      this.running++;
      void entry.execute().finally(() => { this.running--; this.pump(); });
    }
  }

  private async execute<T>(lease: Lease, work: (lease: EventWorkerLeaseContext) => Promise<T>): Promise<T> {
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

  private async acquire(eventId: string): Promise<{ enabled: false } | { enabled: true; lease: Lease | null }> {
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
    return result.enabled ? { enabled: true, lease: result.value } : { enabled: false };
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
