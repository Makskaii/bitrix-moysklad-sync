import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';

const currentUserMethod = 'https://aerosystems.bitrix24.ru/rest/user.current.json';
const secretKey = /(authorization|token|secret|password|webhook|credential|auth)/i;

export type AdminChange = {
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
};

export type RequestWithHeaders = { header(name: string): string | undefined };
export type AuditWriter = { adminAuditEntry: { create(args: { data: Record<string, unknown> }): Promise<unknown> } };

@Injectable()
export class AdminAuditService {
  constructor(private readonly database: DatabaseService) {}

  async resolveActorId(request: RequestWithHeaders): Promise<string> {
    if (process.env.ADMIN_PREVIEW === '1') return 'LOCAL_PREVIEW';
    const token = request.header('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!token || token.length > 4096) throw new ServiceUnavailableException('Could not identify the administrator for the audit record');
    const actorId = await readBitrixUserId(token);
    if (!actorId) throw new ServiceUnavailableException('Bitrix24 did not return the administrator ID');
    return actorId;
  }

  record(transaction: AuditWriter, change: AdminChange) {
    return createAdminAuditEntry(transaction, change);
  }

  async list({ limit = 50, cursor, actorId, action, targetType }: { limit?: number; cursor?: string; actorId?: string; action?: string; targetType?: string }) {
    const entries = await this.database.adminAuditEntry.findMany({
      where: {
        ...(actorId ? { actorId } : {}),
        ...(action ? { action } : {}),
        ...(targetType ? { targetType } : {}),
      },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return { entries, nextCursor: entries.length === limit ? entries.at(-1)?.id ?? null : null };
  }
}

/** Call within the same transaction as the change. There is intentionally no update/delete API. */
export function createAdminAuditEntry(writer: AuditWriter, change: AdminChange) {
  return writer.adminAuditEntry.create({
    data: {
      actorId: bounded(change.actorId, 100),
      action: bounded(change.action, 160),
      targetType: bounded(change.targetType, 100),
      targetId: change.targetId ? bounded(change.targetId, 200) : null,
      reason: change.reason ? bounded(change.reason, 1_000) : null,
      before: toSafeJson(change.before),
      after: toSafeJson(change.after),
    },
  });
}

export async function readBitrixUserId(accessToken: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetcher(currentUserMethod, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth: accessToken }), signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json() as { result?: { ID?: unknown; id?: unknown } };
    const value = body?.result?.ID ?? body?.result?.id;
    return (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) && /^\d{1,20}$/.test(String(value))
      ? `BITRIX24_USER:${String(value)}`
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function bounded(value: string, max: number): string { return value.trim().slice(0, max); }

function toSafeJson(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return sanitize(value, 0, '') as Prisma.InputJsonValue;
}

function sanitize(value: unknown, depth: number, key: string): unknown {
  if (secretKey.test(key)) return '[redacted]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 4_000);
  if (depth >= 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1, ''));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100)
      .map(([childKey, child]) => [childKey.slice(0, 160), sanitize(child, depth + 1, childKey)]));
  }
  return String(value).slice(0, 4_000);
}
