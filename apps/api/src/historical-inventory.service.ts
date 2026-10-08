import { ConflictException, Injectable, Optional, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from './database.service';

export const HISTORICAL_INVENTORY_FETCHER = Symbol('HISTORICAL_INVENTORY_FETCHER');
const JOB_ID = 'deal-order-history';
const BITRIX_PAGE_SIZE = 50;
const DEFAULT_MOYSKLAD_PAGE_SIZE = 500;
const DEFAULT_INTERVAL_MS = 1_000;
const MIN_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const LEASE_MS = MAX_INTERVAL_MS + REQUEST_TIMEOUT_MS + 10_000;
const BITRIX_FIELDS = ['ID', 'TITLE', 'UF_CRM_1719836973', 'UF_CRM_1729757435964', 'ORIGINATOR_ID', 'ORIGIN_ID', 'ORIGIN_VERSION', 'DATE_CREATE', 'DATE_MODIFY'] as const;
const MOYSKLAD_FIELDS = ['id', 'name', 'externalCode', 'created', 'updated'] as const;
const UNVERIFIED_FIELDS = new Set(['UF_CRM_1719836973', 'ORIGINATOR_ID', 'ORIGIN_ID', 'ORIGIN_VERSION', 'externalCode']);
const DISPLAY_ONLY_FIELDS = new Set(['UF_CRM_1729757435964']);

type Source = 'BITRIX24' | 'MOYSKLAD';
type Job = {
  id: string; runId: string | null; status: string; phase: string; bitrixStart: number; moyskladOffset: number;
  bitrixProcessed: number; moyskladProcessed: number; bitrixTotal: number | null; moyskladTotal: number | null;
  moyskladPageSize: number; requestIntervalMs: number; attempts: number; error: string | null; retryAfter: Date | null;
  pauseRequested: boolean; leaseOwner: string | null; leaseUntil: Date | null; checkpointAt: Date | null; updatedAt: Date;
};
type FieldTitles = Record<string, string | null>;
type InventoryRow = { id: string; source: Source; externalId: string; label: string | null; fields: Record<string, unknown>; fieldTitles: FieldTitles; observedAt: Date; updatedAt: Date };
type Fetcher = typeof fetch;

@Injectable()
export class HistoricalInventoryService {
  private activeOwner: string | null = null;
  private lastRequestAt = 0;
  private retryTimer?: NodeJS.Timeout;
  private cachedStatsAt = 0;
  private cachedStats: Array<{ source: Source; code: string; empty: number; unique: number; multiple: number }> = [];

  constructor(
    private readonly database: DatabaseService,
    @Optional() @Inject(HISTORICAL_INVENTORY_FETCHER) private readonly fetcher: Fetcher = fetch,
  ) {}

  async readStatus() {
    const job = await this.ensureJob();
    if (job.status !== 'running' && this.cachedStatsAt !== job.updatedAt.getTime()) {
      const stats = await this.database.$queryRawUnsafe<Array<{ source: Source; code: string; empty: bigint | number; uniqueCount: bigint | number; multiple: bigint | number }>>(`
      WITH candidates AS (
        SELECT e."source", k.code, NULLIF(BTRIM(e."fields" ->> k.code), '') AS value
        FROM "HistoricalInventoryEntry" e
        JOIN (VALUES
          ('BITRIX24','UF_CRM_1719836973'), ('BITRIX24','UF_CRM_1729757435964'),
          ('BITRIX24','ORIGINATOR_ID'), ('BITRIX24','ORIGIN_ID'), ('BITRIX24','ORIGIN_VERSION'),
          ('MOYSKLAD','externalCode')
        ) AS k(source, code) ON k.source = e."source"
      ), groups AS (
        SELECT "source", code, value, COUNT(*) AS row_count
        FROM candidates WHERE value IS NOT NULL GROUP BY "source", code, value
      )
      SELECT c."source", c.code,
        COUNT(*) FILTER (WHERE c.value IS NULL) AS empty,
        COUNT(*) FILTER (WHERE c.value IS NOT NULL AND g.row_count = 1) AS "uniqueCount",
        COUNT(*) FILTER (WHERE g.row_count > 1) AS multiple
      FROM candidates c LEFT JOIN groups g ON g."source" = c."source" AND g.code = c.code AND g.value = c.value
      GROUP BY c."source", c.code ORDER BY c."source", c.code
      `).catch(() => []);
      this.cachedStats = stats.map((row) => ({ source: row.source, code: row.code, empty: Number(row.empty), unique: Number(row.uniqueCount), multiple: Number(row.multiple) }));
      this.cachedStatsAt = job.updatedAt.getTime();
    }
    return {
      ...job,
      bitrixPageSize: BITRIX_PAGE_SIZE,
      stats: this.cachedStats,
    };
  }

  async start(input: { accessToken?: unknown; moyskladPageSize?: unknown; requestIntervalMs?: unknown }) {
    const accessToken = typeof input?.accessToken === 'string' ? input.accessToken.trim() : '';
    if (!accessToken || accessToken.length > 4096) throw new ServiceUnavailableException('An active Bitrix24 administrator session is required to start the inventory.');
    const pageSize = parseInteger(input.moyskladPageSize, DEFAULT_MOYSKLAD_PAGE_SIZE, 1, 1000, 'moyskladPageSize');
    const intervalMs = parseInteger(input.requestIntervalMs, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS, 'requestIntervalMs');
    if (!process.env.BITRIX24_REST_BASE_URL || !process.env.MOYSKLAD_API_BASE_URL || !process.env.MOYSKLAD_API_TOKEN) {
      throw new ServiceUnavailableException('Both read-only upstream APIs must be configured before starting the inventory.');
    }

    const job = await this.ensureJob();
    if (job.status === 'complete') return this.readStatus();
    const now = new Date();
    if (job.retryAfter && job.retryAfter > now) throw new ConflictException('The inventory retry backoff is still active.');
    const owner = randomUUID();
    const claim = await this.database.historicalInventoryJob.updateMany({
      where: { id: JOB_ID, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: { runId: owner, status: 'running', pauseRequested: false, error: null, retryAfter: null, leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS), moyskladPageSize: pageSize, requestIntervalMs: intervalMs },
    });
    if (claim.count !== 1) return this.readStatus();

    this.activeOwner = owner;
    this.lastRequestAt = 0;
    void this.run(owner, accessToken);
    return this.readStatus();
  }

  async pause() {
    const job = await this.database.historicalInventoryJob.findUnique({ where: { id: JOB_ID } }) as Job | null;
    if (!job || job.status !== 'running') throw new ConflictException('The historical inventory is not running.');
    await this.database.historicalInventoryJob.update({ where: { id: JOB_ID }, data: { pauseRequested: true } });
    return this.readStatus();
  }

  async listEntries(source: Source, cursor?: string) {
    if (source !== 'BITRIX24' && source !== 'MOYSKLAD') throw new ConflictException('source must be BITRIX24 or MOYSKLAD');
    const rows = await this.database.historicalInventoryEntry.findMany({
      where: { source, ...(cursor ? { externalId: { lt: cursor } } : {}) },
      orderBy: { externalId: 'desc' }, take: 50,
    }) as InventoryRow[];
    const codes = source === 'BITRIX24' ? BITRIX_FIELDS : MOYSKLAD_FIELDS;
    return {
      entries: rows.map((row) => ({
        source: row.source, externalId: row.externalId, label: row.label,
        fields: codes.map((code) => ({ code, title: row.fieldTitles[code] ?? 'недоступно в метаданных', value: row.fields[code] ?? null,
          verification: UNVERIFIED_FIELDS.has(code) ? 'UNVERIFIED' : DISPLAY_ONLY_FIELDS.has(code) ? 'DISPLAY ONLY' : null })),
        observedAt: row.observedAt,
      })),
      nextCursor: rows.length === 50 ? rows[rows.length - 1]?.externalId ?? null : null,
    };
  }

  private async run(owner: string, accessToken: string) {
    try {
      let job = await this.database.historicalInventoryJob.findUnique({ where: { id: JOB_ID } }) as Job;
      const bitrixTitles = await this.readBitrixTitles(accessToken).catch(() => ({} as FieldTitles));
      const moyskladTitles = await this.readMoyskladTitles().catch(() => ({} as FieldTitles));

      while (job.phase === 'BITRIX24') {
        if (await this.pauseRequested(owner)) return;
        const page = await this.retryPage(() => this.readBitrixPage(accessToken, job.bitrixStart));
        const entries = page.rows.map((row) => shapeEntry('BITRIX24', row, BITRIX_FIELDS, bitrixTitles));
        if (!entries.length && page.next !== null) throw new Error('Bitrix24 returned an empty page with a next cursor.');
        await this.savePage(entries, owner);
        job = await this.updateCheckpoint(owner, {
          bitrixStart: page.next ?? 0,
          bitrixProcessed: { increment: entries.length },
          bitrixTotal: page.total,
          attempts: 0,
          phase: page.next === null ? 'MOYSKLAD' : 'BITRIX24',
          checkpointAt: new Date(), leaseUntil: new Date(Date.now() + LEASE_MS),
        });
      }

      while (job.phase === 'MOYSKLAD') {
        if (await this.pauseRequested(owner)) return;
        const page = await this.retryPage(() => this.readMoyskladPage(job.moyskladOffset, job.moyskladPageSize));
        const entries = page.rows.map((row) => shapeEntry('MOYSKLAD', row, MOYSKLAD_FIELDS, moyskladTitles));
        const nextOffset = job.moyskladOffset + entries.length;
        const hasNext = nextOffset < page.total;
        if (!entries.length && hasNext) throw new Error('MoySklad returned an empty page before the collection ended.');
        await this.savePage(entries, owner);
        job = await this.updateCheckpoint(owner, {
          moyskladOffset: hasNext ? nextOffset : 0,
          moyskladProcessed: { increment: entries.length },
          moyskladTotal: page.total,
          attempts: 0,
          phase: hasNext ? 'MOYSKLAD' : 'COMPLETE',
          status: hasNext ? 'running' : 'complete',
          checkpointAt: new Date(),
          ...(hasNext ? {} : { leaseOwner: null, leaseUntil: null }),
        });
      }
    } catch (error) {
      const current = await this.database.historicalInventoryJob.findUnique({ where: { id: JOB_ID } }) as Job;
      const nextAttempt = current.attempts + 1;
      const retryAfterMs = Math.max(retryAfterFromError(error), Math.min(1_000 * 2 ** (nextAttempt - 1), 60_000));
      await this.database.historicalInventoryJob.updateMany({
        where: { id: JOB_ID, leaseOwner: owner, leaseUntil: { gt: new Date() } },
        data: { status: 'failed', error: 'Provider retrieval failed; the incomplete page checkpoint was retained.', retryAfter: new Date(Date.now() + retryAfterMs), attempts: { increment: 1 }, leaseOwner: null, leaseUntil: null },
      }).catch(() => undefined);
      if (nextAttempt < 5) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          void this.start({ accessToken, moyskladPageSize: current.moyskladPageSize, requestIntervalMs: current.requestIntervalMs }).catch(() => undefined);
        }, retryAfterMs + 25);
        this.retryTimer.unref();
      }
    } finally {
      if (this.activeOwner === owner) this.activeOwner = null;
    }
  }

  private async pauseRequested(owner: string) {
    const job = await this.database.historicalInventoryJob.findUnique({ where: { id: JOB_ID } }) as Job | null;
    if (job?.leaseOwner !== owner) return true;
    if (!job.pauseRequested) return false;
    await this.database.historicalInventoryJob.updateMany({ where: { id: JOB_ID, leaseOwner: owner, leaseUntil: { gt: new Date() } }, data: { status: 'paused', pauseRequested: false, leaseOwner: null, leaseUntil: null, checkpointAt: new Date() } });
    return true;
  }

  private async ensureJob(): Promise<Job> {
    try {
      return await this.database.historicalInventoryJob.upsert({
        where: { id: JOB_ID }, create: { id: JOB_ID }, update: {},
      }) as Job;
    } catch (error) {
      // Concurrent first launches can race creating the singleton. The unique
      // constraint is the serialization point; the losing request reads it.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.database.historicalInventoryJob.findUnique({ where: { id: JOB_ID } }) as Job | null;
        if (existing) return existing;
      }
      throw error;
    }
  }

  private async savePage(entries: Array<{ source: Source; externalId: string; label: string | null; fields: Record<string, unknown>; fieldTitles: FieldTitles }>, owner: string) {
    for (let start = 0; start < entries.length; start += 10) {
      const batch = entries.slice(start, start + 10);
      await this.database.$transaction(async (transaction) => {
        const now = new Date();
        const fenced = await transaction.historicalInventoryJob.updateMany({
          where: { id: JOB_ID, leaseOwner: owner, leaseUntil: { gt: now } },
          data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
        });
        if (fenced.count !== 1) throw new Error('Historical inventory lease was lost before saving a page.');
        for (const entry of batch) {
          await transaction.historicalInventoryEntry.upsert({
            where: { source_externalId: { source: entry.source, externalId: entry.externalId } },
            create: { ...entry, fields: entry.fields as Prisma.InputJsonObject, fieldTitles: entry.fieldTitles as Prisma.InputJsonObject },
            update: { label: entry.label, fields: entry.fields as Prisma.InputJsonObject, fieldTitles: entry.fieldTitles as Prisma.InputJsonObject, observedAt: new Date() },
          });
        }
      }, { maxWait: 10_000, timeout: 30_000 });
    }
  }

  private async readBitrixTitles(accessToken: string): Promise<FieldTitles> {
    const payload = await this.bitrixCall('crm.deal.fields', accessToken, []);
    if (!isRecord(payload) || !isRecord(payload.result)) return {};
    return Object.fromEntries(BITRIX_FIELDS.map((code) => [code, titleFromField(payload.result[code])]));
  }

  private async readBitrixPage(accessToken: string, start: number) {
    const payload = await this.bitrixCall('crm.deal.list', accessToken, [['start', String(start)], ...BITRIX_FIELDS.map((code): [string, string] => ['select[]', code])]);
    if (!isRecord(payload) || payload.error || !Array.isArray(payload.result) || typeof payload.total !== 'number') throw new Error('Invalid Bitrix24 inventory page.');
    const rows = payload.result.filter(isRecord);
    if (rows.length !== payload.result.length || rows.some((row) => !nonEmptyString(row.ID))) throw new Error('Invalid Bitrix24 inventory record.');
    const next = payload.next === undefined ? null : Number(payload.next);
    if (next !== null && (!Number.isInteger(next) || next <= start)) throw new Error('Invalid Bitrix24 inventory cursor.');
    return { rows, next, total: payload.total };
  }

  private async bitrixCall(method: string, accessToken: string, fields: Array<[string, string]>) {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new Error('Bitrix24 inventory API unavailable.');
    const form = new URLSearchParams({ auth: accessToken });
    for (const [key, value] of fields) form.append(key, value);
    const response = await this.request(new URL(`${method}.json`, withSlash(base)), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
      redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw retryableError(response);
    return response.json() as Promise<unknown>;
  }

  private async readMoyskladTitles(): Promise<FieldTitles> {
    const payload = await this.moyskladCall('entity/customerorder/metadata');
    return Object.fromEntries(MOYSKLAD_FIELDS.map((code) => [code, titleFromMetadata(payload, code)]));
  }

  private async readMoyskladPage(offset: number, limit: number) {
    const url = new URL('entity/customerorder', withSlash(process.env.MOYSKLAD_API_BASE_URL!));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const payload = await this.moyskladCall(url.toString());
    if (!isRecord(payload) || !Array.isArray(payload.rows) || !isRecord(payload.meta) || typeof payload.meta.size !== 'number') throw new Error('Invalid MoySklad inventory page.');
    const rows = payload.rows.filter(isRecord);
    if (rows.length !== payload.rows.length || rows.some((row) => !nonEmptyString(row.id))) throw new Error('Invalid MoySklad inventory record.');
    return { rows, total: payload.meta.size };
  }

  private async moyskladCall(path: string) {
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new Error('MoySklad inventory API unavailable.');
    const target = path.startsWith('https://') ? path : new URL(path, withSlash(base)).toString();
    const response = await this.request(target, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw retryableError(response);
    return response.json() as Promise<unknown>;
  }

  private async request(input: string | URL, init: RequestInit) {
    const job = await this.database.historicalInventoryJob.findUnique({ where: { id: JOB_ID } }) as Job;
    if (this.activeOwner) await this.renewLease(this.activeOwner);
    return this.retryRequest(input, init, job.requestIntervalMs);
  }

  private async renewLease(owner: string) {
    const now = new Date();
    const renewed = await this.database.historicalInventoryJob.updateMany({ where: { id: JOB_ID, leaseOwner: owner, leaseUntil: { gt: now } }, data: { leaseUntil: new Date(now.getTime() + LEASE_MS) } });
    if (renewed.count !== 1) throw new Error('Historical inventory lease was lost.');
  }

  private async updateCheckpoint(owner: string, data: Prisma.HistoricalInventoryJobUpdateManyMutationInput): Promise<Job> {
    const updated = await this.database.historicalInventoryJob.updateMany({ where: { id: JOB_ID, leaseOwner: owner, leaseUntil: { gt: new Date() } }, data });
    if (updated.count !== 1) throw new Error('Historical inventory lease was lost before checkpoint commit.');
    return await this.database.historicalInventoryJob.findUnique({ where: { id: JOB_ID } }) as Job;
  }

  private async retryRequest(input: string | URL, init: RequestInit, requestIntervalMs: number): Promise<Response> {
    for (let attempt = 0; attempt < 4; attempt++) {
      // Apply the configured throttle to every HTTP attempt, including retries.
      const wait = Math.max(0, requestIntervalMs - (Date.now() - this.lastRequestAt));
      if (wait) await delay(wait);
      this.lastRequestAt = Date.now();
      const response = await this.fetcher(input, init).catch(() => null);
      if (response && (response.ok || (response.status < 500 && response.status !== 429))) return response;
      if (attempt === 3) throw response ? retryableError(response) : new Error('Temporary upstream transport failure.');
      const retryAfter = response?.headers.get('retry-after');
      const vendorDelay = retryAfter ? parseRetryAfter(retryAfter) : 0;
      await delay(Math.max(vendorDelay, 250 * 2 ** attempt));
    }
    throw new Error('Temporary upstream failure.');
  }

  private async retryPage<T>(read: () => Promise<T>): Promise<T> {
    return read();
  }
}

function shapeEntry(source: Source, row: Record<string, unknown>, codes: readonly string[], titles: FieldTitles) {
  const id = source === 'BITRIX24' ? row.ID : row.id;
  const externalId = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
  const fields = Object.fromEntries(codes.map((code) => [code, scalarValue(row[code])]));
  const labelCode = source === 'BITRIX24' ? 'TITLE' : 'name';
  const labelValue = fields[labelCode];
  return { source, externalId, label: typeof labelValue === 'string' ? labelValue : null, fields, fieldTitles: titles };
}

function scalarValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

function titleFromField(value: unknown): string | null {
  return isRecord(value) && typeof value.title === 'string' && value.title.trim() ? value.title.trim() : null;
}

function titleFromMetadata(payload: unknown, code: string): string | null {
  if (!isRecord(payload)) return null;
  const direct = titleFromField(payload[code]);
  if (direct) return direct;
  const fields = Array.isArray(payload.fields) ? payload.fields : Array.isArray(payload.attributes) ? payload.attributes : [];
  const field = fields.find((candidate) => isRecord(candidate) && (candidate.code === code || candidate.name === code || candidate.id === code));
  return isRecord(field) && typeof field.title === 'string' && field.title.trim() ? field.title.trim() : null;
}

function parseInteger(value: unknown, fallback: number, minimum: number, maximum: number, name: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new ConflictException(`${name} must be between ${minimum} and ${maximum}.`);
  return parsed;
}

function retryableError(response: Response) {
  const error = new Error(`upstream status ${response.status}`);
  const retryAfter = response.headers.get('retry-after');
  Object.assign(error, { retryAfter });
  return error;
}

function retryAfterFromError(error: unknown) {
  const retryAfter = isRecord(error) && typeof error.retryAfter === 'string' ? parseRetryAfter(error.retryAfter) : 0;
  return Math.max(retryAfter, 1_000);
}

function parseRetryAfter(value: string) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 0 : Math.max(0, Math.min(date - Date.now(), 60_000));
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nonEmptyString(value: unknown): value is string { return (typeof value === 'string' || typeof value === 'number') && String(value).trim().length > 0; }
function withSlash(value: string) { return value.endsWith('/') ? value : `${value}/`; }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
