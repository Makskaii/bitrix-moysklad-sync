import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { DryRunDocumentReader } from '../dry-run-document-reader';
import { VersionedFieldSettingsDto } from '../field-settings/field-settings.dto';
import { PairResolutionResult } from '../pairs/pair-resolver';

type ConfirmedPair = Extract<PairResolutionResult, { status: 'confirmed' }>['pair'];
export type DealOrderBaselineResult =
  | { status: 'READY'; baselineId: string; created: boolean; settingsVersion: number; capturedAt: string; bitrix24UpdatedAt: string | null; moyskladUpdatedAt: string | null }
  | { status: 'MANUAL_REVIEW'; reason: 'SOURCE_READ_FAILED' | 'BASELINE_STORE_FAILED' | 'UNSUPPORTED_ENTITY' | 'PAIR_NOT_ACTIVE' };

/**
 * Captures the first bilateral, approved-field state for an already-confirmed
 * deal/order pair. The row is immutable: later events must compare against it
 * and persist successful runtime state separately, never replace this baseline.
 */
@Injectable()
export class DealOrderBaselineService {
  constructor(private readonly database: DatabaseService, private readonly reader: DryRunDocumentReader) {}

  async ensureForConfirmedPair(input: {
    pair: ConfirmedPair;
    eventId: string;
    eventConfig: VersionedFieldSettingsDto;
  }): Promise<DealOrderBaselineResult> {
    if (input.pair.entityType !== 'DEAL') return { status: 'MANUAL_REVIEW', reason: 'UNSUPPORTED_ENTITY' };
    if (process.env.SYNC_MODE !== 'apply' && process.env.SYNC_MODE !== 'dry') {
      return { status: 'MANUAL_REVIEW', reason: 'SOURCE_READ_FAILED' };
    }

    let pair: { id: string } | null;
    try {
      pair = await this.database.entityPair.findFirst({
        where: {
          id: input.pair.id, entityType: 'DEAL', active: true,
          bitrix24Id: input.pair.bitrix24Id, moyskladId: input.pair.moyskladId,
        },
        select: { id: true },
      });
    } catch {
      return { status: 'MANUAL_REVIEW', reason: 'BASELINE_STORE_FAILED' };
    }
    if (!pair) return { status: 'MANUAL_REVIEW', reason: 'PAIR_NOT_ACTIVE' };

    let existing: Awaited<ReturnType<typeof this.database.entityPairBaseline.findUnique>>;
    try {
      existing = await this.database.entityPairBaseline.findUnique({ where: { pairId: pair.id } });
    } catch {
      return { status: 'MANUAL_REVIEW', reason: 'BASELINE_STORE_FAILED' };
    }
    if (existing) return result(existing, false);

    let bitrix24: Record<string, unknown>;
    let moysklad: Record<string, unknown>;
    try {
      // MySklad is the first-event authority; still read both sides to preserve
      // disagreements without writing either system.
      moysklad = await this.reader.readMoySkladCustomerOrderForBaseline(input.pair.moyskladId);
      bitrix24 = await this.reader.readBitrix24DealForBaseline(input.pair.bitrix24Id);
    } catch {
      return { status: 'MANUAL_REVIEW', reason: 'SOURCE_READ_FAILED' };
    }
    const bitrix24Values = projectApprovedValues(input.eventConfig.config, bitrix24, 'bitrix24');
    const moyskladValues = projectApprovedValues(input.eventConfig.config, moysklad, 'moysklad');
    const capturedAt = new Date();

    try {
      await this.database.entityPairBaseline.createMany({
        data: [{
          pairId: pair.id,
          eventId: input.eventId,
          settingsVersion: input.eventConfig.version,
          bitrix24Values: bitrix24Values as Prisma.InputJsonValue,
          moyskladValues: moyskladValues as Prisma.InputJsonValue,
          bitrix24UpdatedAt: readTimestamp(bitrix24.DATE_MODIFY ?? bitrix24.DATE_CREATE),
          moyskladUpdatedAt: readTimestamp(moysklad.updated ?? moysklad.updatedAt ?? moysklad.moment),
          capturedAt,
        }],
        skipDuplicates: true,
      });
      const saved = await this.database.entityPairBaseline.findUnique({ where: { pairId: pair.id } });
      if (!saved) return { status: 'MANUAL_REVIEW', reason: 'BASELINE_STORE_FAILED' };
      return result(saved, saved.eventId === input.eventId && saved.capturedAt.getTime() === capturedAt.getTime());
    } catch {
      return { status: 'MANUAL_REVIEW', reason: 'BASELINE_STORE_FAILED' };
    }
  }
}

function projectApprovedValues(config: VersionedFieldSettingsDto['config'], record: Record<string, unknown>, system: 'bitrix24' | 'moysklad') {
  const values: Record<string, unknown> = {};
  const rules = Array.isArray(config.rules) ? config.rules : [];
  for (const rule of rules) {
    if (rule.entity !== 'deals-orders' || (!rule.bitrix24ToMoysklad.enabled && !rule.moyskladToBitrix24.enabled)) continue;
    const field = system === 'bitrix24' ? rule.sourceField : rule.targetField;
    values[`rule:${rule.id}`] = approvedValue(record[field]);
  }
  const groups = Array.isArray(config.groups) ? config.groups : [];
  for (const group of groups) {
    if (group.entity !== 'deals-orders') continue;
    const sourceSide = group.direction === 'BITRIX24_TO_MOYSKLAD' ? 'bitrix24' : 'moysklad';
    const targetSide = sourceSide === 'bitrix24' ? 'moysklad' : 'bitrix24';
    if (system === sourceSide) values[`group:${group.id}:source`] = Object.fromEntries(group.sourceFields.map((field) => [field, approvedValue(record[field])]));
    else if (system === targetSide) values[`group:${group.id}:target`] = approvedValue(record[group.targetField]);
  }
  return values;
}

function approvedValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 100).map(approvedValue);
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of ['id', 'ID', 'value', 'VALUE', 'href', 'type']) if (key in row) result[key] = approvedValue(row[key]);
    if (isRecord(row.meta)) {
      const meta: Record<string, unknown> = {};
      for (const key of ['href', 'type']) if (key in row.meta) meta[key] = approvedValue(row.meta[key]);
      if (Object.keys(meta).length) result.meta = meta;
    }
    return result;
  }
  return null;
}

function readTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function result(row: {
  pairId: string; settingsVersion: number; capturedAt: Date; bitrix24UpdatedAt: Date | null; moyskladUpdatedAt: Date | null;
}, created: boolean): DealOrderBaselineResult {
  return {
    status: 'READY', baselineId: row.pairId, created, settingsVersion: row.settingsVersion,
    capturedAt: row.capturedAt.toISOString(), bitrix24UpdatedAt: row.bitrix24UpdatedAt?.toISOString() ?? null,
    moyskladUpdatedAt: row.moyskladUpdatedAt?.toISOString() ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
