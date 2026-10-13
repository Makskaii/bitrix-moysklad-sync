import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';

const currentUserMethod = 'https://aerosystems.bitrix24.ru/rest/user.current.json';
const timeoutMs = 5_000;
const secretKey = /(authorization|token|secret|password|webhook|credential|auth)/i;

export type AdminChange = {
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
};

export type RequestWithHeaders = { header(name: string): string | undefined };

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

  async recordAdminChange(change: AdminChange) {
    return createAdminAuditEntry(this.database, change);
  }
}

export type AuditWriter = { adminAuditEntry: { create(args: { data: Record<string, unknown> }): Promise<unknown> } };

/** Use this inside the same Prisma transaction as the mutation being audited. */
export function createAdminAuditEntry(writer: AuditWriter, change: AdminChange) {
  return writer.adminAuditEntry.create({
    data: {
      actorId: bounded(change.actorId, 100),
      action: bounded(change.action, 160),
      targetType: bounded(change.entityType, 100),
      targetId: change.entityId ? bounded(change.entityId, 200) : null,
      reason: change.reason ? bounded(change.reason, 1_000) : null,
      before: toSafeJson(change.before),
      after: toSafeJson(change.after),
    },
  });
}

export async function readBitrixUserId(accessToken: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(currentUserMethod, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth: accessToken }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json() as { result?: { ID?: unknown } };
    const value = body?.result?.ID;
    return (typeof value === 'string' || typeof value === 'number') && /^\d{1,20}$/.test(String(value)) ? String(value) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function bounded(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function toSafeJson(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return sanitize(value, 0, '') as Prisma.InputJsonValue;
}

export function safeAuditJson(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  return toSafeJson(value);
}

function sanitize(value: unknown, depth: number, key: string): unknown {
  if (secretKey.test(key)) return '[redacted]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 4_000);
  if (depth >= 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1, ''));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 100);
    return Object.fromEntries(entries.map(([childKey, child]) => [childKey.slice(0, 160), sanitize(child, depth + 1, childKey)]));
  }
  return String(value).slice(0, 4_000);
}
