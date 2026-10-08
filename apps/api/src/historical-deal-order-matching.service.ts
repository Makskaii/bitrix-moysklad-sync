import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from './database.service';
import { lockEntityPairState } from './pairs/pair-db-lock';
import {
  ActiveDealOrderPair,
  classifyDealBatch,
  classifyUnmatchedOrderBatch,
  DEAL_MATCH_KEY,
  HistoricalMatchEntry,
  MatchCategory,
  titleValue,
} from './historical-deal-order-matching';

const INVENTORY_JOB_ID = 'deal-order-history';
const PREVIEW_BATCH_SIZE = 500;
const APPLY_BATCH_SIZE = 100;
const LEASE_MS = 5 * 60_000;
const RESULT_CATEGORIES: string[] = [
  'MATCH_READY', 'UNMATCHED_BITRIX24', 'UNMATCHED_MOYSKLAD', 'INVALID_BITRIX24_KEY',
  'INVALID_MOYSKLAD_ID', 'DUPLICATE_BITRIX24_KEY', 'ALREADY_PAIRED', 'PAIR_CONFLICT', 'APPLIED',
];

type InventoryJob = {
  status: string; phase: string; bitrixProcessed: number; moyskladProcessed: number;
  bitrixTotal: number | null; moyskladTotal: number | null; checkpointAt: Date | null;
  inventoryRevision: number; updatedAt: Date;
};
type InventoryEntry = HistoricalMatchEntry & {
  id: string; source: 'BITRIX24' | 'MOYSKLAD'; observedAt: Date; updatedAt: Date;
};
type Run = {
  id: string; status: string; phase: string; bitrixCursor: string | null; moyskladCursor: string | null;
  bitrixProcessed: number; moyskladProcessed: number; bitrixTotal: number; moyskladTotal: number;
  inventoryCheckpointAt: Date; inventoryRevision: number; inventoryFingerprint: string;
  applyStatus: string; applyCursor: string | null; appliedCount: number; leaseOwner: string | null;
  leaseUntil: Date | null; error: string | null; applyError: string | null; counts: Prisma.JsonValue;
  createdAt: Date; updatedAt: Date;
};
type Snapshot = {
  job: InventoryJob; bitrixCount: number; moyskladCount: number;
  bitrixMaxUpdate: Date | null; moyskladMaxUpdate: Date | null; fingerprint: string;
};

@Injectable()
export class HistoricalDealOrderMatchingService {
  constructor(private readonly database: DatabaseService) {}

  async readStatus() {
    const latestRun = await this.database.historicalDealOrderMatchingRun.findFirst({ orderBy: { createdAt: 'desc' } }) as Run | null;
    const job = await this.database.historicalInventoryJob.findUnique({ where: { id: INVENTORY_JOB_ID } }) as InventoryJob | null;
    if (!job) return { inventory: { status: 'idle', phase: 'BITRIX24', bitrixProcessed: 0, bitrixTotal: null, moyskladProcessed: 0, moyskladTotal: null, checkpointAt: null, complete: false }, previewFresh: false, run: latestRun ? serializeRun(latestRun) : null };
    const inventoryComplete = inventoryJobComplete(job);
    const previewFresh = latestRun?.status === 'complete' && inventoryJobMatchesRun(job, latestRun);
    let serialized = latestRun ? serializeRun(latestRun) : null;
    if (latestRun) {
      const grouped = await this.database.historicalDealOrderMatchResult.groupBy({ by: ['category'], where: { runId: latestRun.id }, _count: { _all: true } });
      serialized = { ...serialized!, counts: Object.fromEntries(grouped.map((row) => [row.category, row._count._all])) };
    }
    return {
      inventory: {
        status: job.status,
        phase: job.phase,
        bitrixProcessed: job.bitrixProcessed,
        bitrixTotal: job.bitrixTotal,
        moyskladProcessed: job.moyskladProcessed,
        moyskladTotal: job.moyskladTotal,
        checkpointAt: job.checkpointAt,
        complete: inventoryComplete,
      },
      previewFresh,
      run: serialized,
    };
  }

  async startPreview() {
    const snapshot = await this.readInventorySnapshot();
    if (!snapshot.complete) throw new ConflictException('HISTORICAL_INVENTORY_INCOMPLETE');

    const now = new Date();
    const claim = await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw`WITH matching_lock AS MATERIALIZED (SELECT pg_advisory_xact_lock(713103, 50)) SELECT 1::int AS locked FROM matching_lock`;
      let run = await transaction.historicalDealOrderMatchingRun.findFirst({ orderBy: { createdAt: 'desc' } }) as Run | null;
      if (run?.applyStatus === 'running' && run.leaseUntil && run.leaseUntil > now) {
        throw new ConflictException('MATCH_APPLY_ALREADY_RUNNING');
      }
      if (run?.status === 'running' && run.leaseUntil && run.leaseUntil > now) return null;
      const canResume = run && run.inventoryFingerprint === snapshot.fingerprint &&
        (run.status === 'failed' || run.status === 'running' && (!run.leaseUntil || run.leaseUntil <= now));
      if (!canResume) {
        run = await transaction.historicalDealOrderMatchingRun.create({
          data: {
            status: 'running', phase: 'KEYS', bitrixTotal: snapshot.bitrixCount,
            moyskladTotal: snapshot.moyskladCount, inventoryCheckpointAt: snapshot.job.checkpointAt!,
            inventoryRevision: snapshot.job.inventoryRevision, bitrixInventoryMaxUpdate: snapshot.bitrixMaxUpdate,
            moyskladInventoryMaxUpdate: snapshot.moyskladMaxUpdate, inventoryFingerprint: snapshot.fingerprint,
          },
        }) as Run;
      }
      if (!run) throw new ConflictException('MATCH_PREVIEW_UNAVAILABLE');

      const owner = randomUUID();
      const claimed = await transaction.historicalDealOrderMatchingRun.updateMany({
        where: { id: run.id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        data: { status: 'running', error: null, leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS) },
      });
      return claimed.count === 1 ? { runId: run.id, owner } : null;
    });
    if (!claim) return this.readStatus();
    void this.runPreview(claim.runId, claim.owner);
    return this.readStatus();
  }

  async listResults(input: { runId?: string; category?: string; cursor?: string }) {
    const run = input.runId
      ? await this.database.historicalDealOrderMatchingRun.findUnique({ where: { id: input.runId } }) as Run | null
      : await this.database.historicalDealOrderMatchingRun.findFirst({ orderBy: { createdAt: 'desc' } }) as Run | null;
    if (!run) throw new NotFoundException('HISTORICAL_MATCH_PREVIEW_NOT_FOUND');
    if (input.category && !RESULT_CATEGORIES.includes(input.category as MatchCategory)) {
      throw new ConflictException('MATCH_CATEGORY_UNSUPPORTED');
    }
    const rows = await this.database.historicalDealOrderMatchResult.findMany({
      where: { runId: run.id, ...(input.category ? { category: input.category } : {}), ...(input.cursor ? { id: { gt: input.cursor } } : {}) },
      orderBy: { id: 'asc' }, take: 51,
    });
    const page = rows.slice(0, 50);
    return { runId: run.id, results: page, nextCursor: rows.length > 50 ? page.at(-1)?.id ?? null : null };
  }

  async applyPreview(runId: string, confirmed: boolean) {
    if (confirmed !== true) throw new ConflictException('MATCH_APPLY_CONFIRMATION_REQUIRED');
    const run = await this.database.historicalDealOrderMatchingRun.findUnique({ where: { id: runId } }) as Run | null;
    if (!run || run.status !== 'complete') throw new ConflictException('MATCH_PREVIEW_INCOMPLETE');
    if (!await this.isFresh(run)) throw new ConflictException('MATCH_PREVIEW_STALE');
    if (run.applyStatus === 'complete') return this.readStatus();
    if (run.applyStatus === 'stale') throw new ConflictException('MATCH_PREVIEW_STALE');

    const now = new Date();
    const owner = randomUUID();
    const claim = await this.database.historicalDealOrderMatchingRun.updateMany({
      where: { id: runId, status: 'complete', applyStatus: { in: ['not_started', 'failed', 'running'] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: { applyStatus: 'running', applyError: null, leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS) },
    });
    if (claim.count !== 1) {
      const current = await this.database.historicalDealOrderMatchingRun.findUnique({ where: { id: runId } }) as Run | null;
      if (current?.applyStatus === 'running' && current.leaseUntil && current.leaseUntil > now) return this.readStatus();
      throw new ConflictException('MATCH_APPLY_ALREADY_CLAIMED');
    }
    void this.runApply(runId, owner);
    return this.readStatus();
  }

  private async runPreview(runId: string, owner: string) {
    try {
      let run = await this.readRun(runId);
      if (run.phase === 'KEYS') {
        await this.prepareDuplicateKeys(run, owner);
        run = await this.readRun(runId);
      }

      while (run.phase === 'BITRIX24') {
        const deals = await this.database.historicalInventoryEntry.findMany({
          where: { source: 'BITRIX24', ...(run.bitrixCursor ? { externalId: { gt: run.bitrixCursor } } : {}) },
          orderBy: { externalId: 'asc' }, take: PREVIEW_BATCH_SIZE,
        }) as InventoryEntry[];
        if (!deals.length) {
          await this.advancePreview(run, owner, { phase: 'MOYSKLAD', bitrixCursor: null });
          run = await this.readRun(runId);
          continue;
        }
        const validKeys = [...new Set(deals.map((deal) => deal.fields[DEAL_MATCH_KEY]).filter(isUuidValue))];
        const orders = validKeys.length ? await this.database.historicalInventoryEntry.findMany({
          where: { source: 'MOYSKLAD', externalId: { in: validKeys } },
        }) as InventoryEntry[] : [];
        const duplicateRows = validKeys.length ? await this.database.historicalDealOrderDuplicateKey.findMany({
          where: { runId, keyValue: { in: validKeys } }, select: { keyValue: true, recordCount: true },
        }) : [];
        const activePairs = validKeys.length ? await this.database.entityPair.findMany({
          where: { entityType: 'DEAL', active: true, OR: [
            { bitrix24Id: { in: deals.map((deal) => deal.externalId) } },
            { moyskladId: { in: validKeys } },
          ] }, select: { id: true, bitrix24Id: true, moyskladId: true },
        }) as ActiveDealOrderPair[] : [];
        const orderById = new Map(orders.map((order) => [order.externalId, order]));
        const results = classifyDealBatch({
          deals, ordersById: orderById,
          dealKeyCounts: new Map(duplicateRows.map((row) => [row.keyValue, row.recordCount])),
          activePairs,
        });
        const keyTitles = deals[0]?.fieldTitles ?? {};
        const resultInputs = results.map((row) => ({
          ...row,
          linkedLabel: row.linkedEntityId ? orderById.get(row.linkedEntityId)?.label ?? null : null,
          keyFieldTitle: row.keyFieldTitle ?? titleValue(keyTitles[DEAL_MATCH_KEY]),
        }));
        await this.savePreviewBatch(run, owner, resultInputs, 'BITRIX24', deals.at(-1)!.externalId, deals.length);
        run = await this.readRun(runId);
      }

      while (run.phase === 'MOYSKLAD') {
        const orders = await this.database.historicalInventoryEntry.findMany({
          where: { source: 'MOYSKLAD', ...(run.moyskladCursor ? { externalId: { gt: run.moyskladCursor } } : {}) },
          orderBy: { externalId: 'asc' }, take: PREVIEW_BATCH_SIZE,
        }) as InventoryEntry[];
        if (!orders.length) {
          if (!await this.isFresh(run)) throw new Error('MATCH_PREVIEW_STALE');
          const grouped = await this.database.historicalDealOrderMatchResult.groupBy({
            by: ['category'], where: { runId }, _count: { _all: true },
          });
          const counts = Object.fromEntries(grouped.map((row) => [row.category, row._count._all]));
          const completed = await this.database.historicalDealOrderMatchingRun.updateMany({
            where: { id: runId, leaseOwner: owner, leaseUntil: { gt: new Date() } },
            data: { phase: 'COMPLETE', status: 'complete', counts: counts as Prisma.InputJsonObject, leaseOwner: null, leaseUntil: null, error: null },
          });
          if (completed.count !== 1) throw new Error('MATCH_PREVIEW_LEASE_LOST');
          return;
        }
        const ids = orders.map((order) => order.externalId);
        const references = await this.database.historicalDealOrderMatchResult.findMany({
          where: { runId, linkedEntityId: { in: ids } }, select: { linkedEntityId: true },
        });
        const referencedOrderIds = new Set(references.map((row) => row.linkedEntityId).filter((id): id is string => !!id));
        const idTitle = titleValue(orders[0]?.fieldTitles.id);
        const results = classifyUnmatchedOrderBatch({ orders, referencedOrderIds, idTitle });
        await this.savePreviewBatch(run, owner, results, 'MOYSKLAD', orders.at(-1)!.externalId, orders.length);
        run = await this.readRun(runId);
      }
    } catch (error) {
      const reason = error instanceof Error && error.message === 'MATCH_PREVIEW_STALE' ? 'Inventory changed while the preview was running; start a new preview.' : 'Preview failed; the completed checkpoint was retained.';
      await this.database.historicalDealOrderMatchingRun.updateMany({
        where: { id: runId, leaseOwner: owner }, data: { status: 'failed', error: reason, leaseOwner: null, leaseUntil: null },
      }).catch(() => undefined);
    }
  }

  private async prepareDuplicateKeys(run: Run, owner: string) {
    if (!await this.isFresh(run)) throw new Error('MATCH_PREVIEW_STALE');
    await this.database.$transaction(async (transaction) => {
      const now = new Date();
      const claim = await transaction.historicalDealOrderMatchingRun.updateMany({
        where: { id: run.id, leaseOwner: owner, leaseUntil: { gt: now } },
        data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
      });
      if (claim.count !== 1) throw new Error('MATCH_PREVIEW_LEASE_LOST');
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO "HistoricalDealOrderDuplicateKey" ("runId", "keyValue", "recordCount")
        SELECT ${run.id}, e."fields" ->> 'UF_CRM_1719836973', COUNT(*)::int
        FROM "HistoricalInventoryEntry" AS e
        WHERE e."source" = 'BITRIX24'
          AND (e."fields" ->> 'UF_CRM_1719836973') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        GROUP BY e."fields" ->> 'UF_CRM_1719836973'
        HAVING COUNT(*) > 1
      `);
      const advanced = await transaction.historicalDealOrderMatchingRun.updateMany({
        where: { id: run.id, leaseOwner: owner, leaseUntil: { gt: new Date() } }, data: { phase: 'BITRIX24' },
      });
      if (advanced.count !== 1) throw new Error('MATCH_PREVIEW_LEASE_LOST');
    });
  }

  private async savePreviewBatch(
    run: Run,
    owner: string,
    results: Array<{
      sourceSystem: 'BITRIX24' | 'MOYSKLAD'; sourceEntityId: string; linkedEntityId: string | null;
      category: MatchCategory; keyValue: string | null; sourceLabel: string | null; linkedLabel: string | null;
      keyFieldCode: string; keyFieldTitle: string | null;
    }>,
    side: 'BITRIX24' | 'MOYSKLAD',
    cursor: string,
    processed: number,
  ) {
    await this.database.$transaction(async (transaction) => {
      const now = new Date();
      const claim = await transaction.historicalDealOrderMatchingRun.updateMany({
        where: { id: run.id, leaseOwner: owner, leaseUntil: { gt: now } },
        data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
      });
      if (claim.count !== 1) throw new Error('MATCH_PREVIEW_LEASE_LOST');
      if (results.length) await transaction.historicalDealOrderMatchResult.createMany({
        data: results.map((row) => ({ runId: run.id, ...row })), skipDuplicates: true,
      });
      const updated = await transaction.historicalDealOrderMatchingRun.updateMany({
        where: { id: run.id, leaseOwner: owner, leaseUntil: { gt: new Date() } },
        data: side === 'BITRIX24'
          ? { bitrixCursor: cursor, bitrixProcessed: { increment: processed } }
          : { moyskladCursor: cursor, moyskladProcessed: { increment: processed } },
      });
      if (updated.count !== 1) throw new Error('MATCH_PREVIEW_LEASE_LOST');
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  private async advancePreview(run: Run, owner: string, data: { phase: string; bitrixCursor?: null }) {
    const updated = await this.database.historicalDealOrderMatchingRun.updateMany({
      where: { id: run.id, leaseOwner: owner, leaseUntil: { gt: new Date() } }, data,
    });
    if (updated.count !== 1) throw new Error('MATCH_PREVIEW_LEASE_LOST');
  }

  private async runApply(runId: string, owner: string) {
    try {
      while (true) {
        const run = await this.readRun(runId);
        if (!await this.isFresh(run)) throw new Error('MATCH_PREVIEW_STALE');
        const rows = await this.database.historicalDealOrderMatchResult.findMany({
          where: { runId, category: 'MATCH_READY', ...(run.applyCursor ? { id: { gt: run.applyCursor } } : {}) },
          orderBy: { id: 'asc' }, take: APPLY_BATCH_SIZE,
        });
        if (!rows.length) {
          const updated = await this.database.historicalDealOrderMatchingRun.updateMany({
            where: { id: runId, leaseOwner: owner, leaseUntil: { gt: new Date() } },
            data: { applyStatus: 'complete', leaseOwner: null, leaseUntil: null, applyError: null },
          });
          if (updated.count !== 1) throw new Error('MATCH_APPLY_LEASE_LOST');
          return;
        }

        await this.database.$transaction(async (transaction) => {
          const now = new Date();
          const claim = await transaction.historicalDealOrderMatchingRun.updateMany({
            where: { id: runId, leaseOwner: owner, leaseUntil: { gt: now } },
            data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
          });
          if (claim.count !== 1) throw new Error('MATCH_APPLY_LEASE_LOST');
          await lockEntityPairState(transaction);
          const job = await transaction.historicalInventoryJob.findUnique({ where: { id: INVENTORY_JOB_ID } }) as InventoryJob | null;
          if (!job || !inventoryJobMatchesRun(job, run)) throw new Error('MATCH_PREVIEW_STALE');

          const activePairs = await transaction.entityPair.findMany({
            where: { entityType: 'DEAL', active: true, OR: [
              { bitrix24Id: { in: rows.map((row) => row.sourceEntityId) } },
              { moyskladId: { in: rows.map((row) => row.linkedEntityId!) } },
            ] },
            select: { id: true, bitrix24Id: true, moyskladId: true },
          });
          const byBitrixId = new Map(activePairs.map((pair) => [pair.bitrix24Id, pair]));
          const byMoyskladId = new Map(activePairs.map((pair) => [pair.moyskladId, pair]));
          for (const row of rows) {
            const byDeal = byBitrixId.get(row.sourceEntityId);
            const byOrder = byMoyskladId.get(row.linkedEntityId!);
            const identical = byDeal?.id === byOrder?.id && byDeal?.bitrix24Id === row.sourceEntityId && byDeal?.moyskladId === row.linkedEntityId ? byDeal : null;
            if (identical) {
              await transaction.historicalDealOrderMatchResult.update({
                where: { id: row.id }, data: { category: 'ALREADY_PAIRED', applyStatus: 'already_paired', pairId: identical.id },
              });
            } else if (byDeal || byOrder) {
              await transaction.historicalDealOrderMatchResult.update({
                where: { id: row.id }, data: { category: 'PAIR_CONFLICT', applyStatus: 'withheld_conflict' },
              });
            } else {
              const pair = await transaction.entityPair.create({
                data: {
                  entityType: 'DEAL', bitrix24Id: row.sourceEntityId, moyskladId: row.linkedEntityId!,
                  active: true, source: 'HISTORICAL_MATCH', reason: `HISTORICAL_MATCH_RUN:${runId}`,
                },
              });
              byBitrixId.set(pair.bitrix24Id, pair);
              byMoyskladId.set(pair.moyskladId, pair);
              await transaction.historicalDealOrderMatchResult.update({
                where: { id: row.id }, data: { category: 'APPLIED', applyStatus: 'applied', pairId: pair.id },
              });
              await transaction.historicalDealOrderMatchingRun.update({ where: { id: runId }, data: { appliedCount: { increment: 1 } } });
            }
          }
          await transaction.historicalDealOrderMatchingRun.update({
            where: { id: runId }, data: { applyCursor: rows.at(-1)!.id, leaseUntil: new Date(Date.now() + LEASE_MS) },
          });
        }, { maxWait: 10_000, timeout: 30_000 });
      }
    } catch (error) {
      const stale = error instanceof Error && error.message === 'MATCH_PREVIEW_STALE';
      await this.database.historicalDealOrderMatchingRun.updateMany({
        where: { id: runId, leaseOwner: owner },
        data: { applyStatus: stale ? 'stale' : 'failed', applyError: stale ? 'Inventory changed; start a new preview.' : 'Application stopped; the last committed batch is safe to resume.', leaseOwner: null, leaseUntil: null },
      }).catch(() => undefined);
    }
  }

  private async readInventorySnapshot(): Promise<Snapshot & { complete: boolean }> {
    const job = await this.database.historicalInventoryJob.findUnique({ where: { id: INVENTORY_JOB_ID } }) as InventoryJob | null;
    if (!job) throw new ConflictException('HISTORICAL_INVENTORY_NOT_STARTED');
    const rows = await this.database.historicalInventoryEntry.groupBy({
      by: ['source'], where: { source: { in: ['BITRIX24', 'MOYSKLAD'] } }, _count: { _all: true }, _max: { updatedAt: true },
    });
    const bySource = new Map(rows.map((row) => [row.source, row]));
    const bitrixCount = bySource.get('BITRIX24')?._count._all ?? 0;
    const moyskladCount = bySource.get('MOYSKLAD')?._count._all ?? 0;
    const bitrixMaxUpdate = bySource.get('BITRIX24')?._max.updatedAt ?? null;
    const moyskladMaxUpdate = bySource.get('MOYSKLAD')?._max.updatedAt ?? null;
    const complete = job.status === 'complete' && job.phase === 'COMPLETE' && job.checkpointAt !== null &&
      job.bitrixTotal !== null && job.moyskladTotal !== null && job.bitrixProcessed === job.bitrixTotal &&
      job.moyskladProcessed === job.moyskladTotal && bitrixCount === job.bitrixTotal && moyskladCount === job.moyskladTotal;
    const fingerprint = JSON.stringify({
      status: job.status, phase: job.phase, checkpointAt: job.checkpointAt?.toISOString() ?? null,
      revision: job.inventoryRevision, bitrixCount, moyskladCount,
      bitrixMaxUpdate: bitrixMaxUpdate?.toISOString() ?? null, moyskladMaxUpdate: moyskladMaxUpdate?.toISOString() ?? null,
    });
    return { job, bitrixCount, moyskladCount, bitrixMaxUpdate, moyskladMaxUpdate, fingerprint, complete };
  }

  private async isFresh(run: Run) {
    const job = await this.database.historicalInventoryJob.findUnique({ where: { id: INVENTORY_JOB_ID } }) as InventoryJob | null;
    return !!job && inventoryJobMatchesRun(job, run);
  }

  private async readRun(id: string): Promise<Run> {
    const run = await this.database.historicalDealOrderMatchingRun.findUnique({ where: { id } }) as Run | null;
    if (!run) throw new NotFoundException('HISTORICAL_MATCH_PREVIEW_NOT_FOUND');
    return run;
  }
}

function serializeRun(run: Run) {
  return {
    id: run.id, status: run.status, phase: run.phase, bitrixProcessed: run.bitrixProcessed,
    bitrixTotal: run.bitrixTotal, moyskladProcessed: run.moyskladProcessed, moyskladTotal: run.moyskladTotal,
    inventoryCheckpointAt: run.inventoryCheckpointAt, counts: run.counts, applyStatus: run.applyStatus,
    appliedCount: run.appliedCount, error: run.error, applyError: run.applyError,
    leaseUntil: run.leaseUntil, createdAt: run.createdAt, updatedAt: run.updatedAt,
  };
}

function inventoryJobMatchesRun(job: InventoryJob, run: Run): boolean {
  return inventoryJobComplete(job) && job.inventoryRevision === run.inventoryRevision &&
    job.checkpointAt?.getTime() === run.inventoryCheckpointAt.getTime() &&
    job.bitrixProcessed === run.bitrixTotal && job.moyskladProcessed === run.moyskladTotal;
}

function inventoryJobComplete(job: InventoryJob): boolean {
  return job.status === 'complete' && job.phase === 'COMPLETE' && job.checkpointAt !== null &&
    job.bitrixTotal !== null && job.moyskladTotal !== null && job.bitrixProcessed === job.bitrixTotal &&
    job.moyskladProcessed === job.moyskladTotal;
}

function isUuidValue(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
