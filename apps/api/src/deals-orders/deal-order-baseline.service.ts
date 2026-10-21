import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { DryRunDocumentReader } from '../dry-run-document-reader';
import { VersionedFieldSettingsDto } from '../field-settings/field-settings.dto';
import { PairResolutionResult } from '../pairs/pair-resolver';
import { ProviderFailure, isRetryableFailure, retryAtForFailure } from '../provider-failure';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { DealOrderFieldRuntimeService, RevisionMappingResult } from './deal-order-field-runtime.service';
import { withDealOrderPairLock } from './deal-order-pair-lock';

type ConfirmedPair = Extract<PairResolutionResult, { status: 'confirmed' }>['pair'];
export type DealOrderBaselineResult =
  | { status: 'READY'; baselineId: string; created: boolean; settingsVersion: number; capturedAt: string; bitrix24UpdatedAt: string | null; moyskladUpdatedAt: string | null }
  | { status: 'RETRYABLE_FAILURE'; reason: string; retryAfter: Date }
  | { status: 'DATABASE_FAILURE' }
  | { status: 'STALE_PINNED_EVENT'; currentSettingsVersion: number }
  | { status: 'MANUAL_REVIEW'; reason: string };

/**
 * Captures the first bilateral, approved-field state for an already-confirmed
 * deal/order pair. Value snapshots are preserved; a semantically unchanged
 * settings transition records a revision and advances only the version pointer.
 */
@Injectable()
export class DealOrderBaselineService {
  constructor(
    private readonly database: DatabaseService,
    private readonly reader: DryRunDocumentReader,
    @Optional() @Inject(FieldSettingsService) private readonly fieldSettings?: FieldSettingsService,
    @Optional() @Inject(DealOrderFieldRuntimeService) private readonly fieldRuntime?: DealOrderFieldRuntimeService,
  ) {}

  async ensureForConfirmedPair(input: {
    pair: ConfirmedPair;
    eventId: string;
    eventConfig: VersionedFieldSettingsDto;
    attempt?: number;
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
      return { status: 'DATABASE_FAILURE' };
    }
    if (!pair) return { status: 'MANUAL_REVIEW', reason: 'PAIR_NOT_ACTIVE' };

    let existing: Awaited<ReturnType<typeof this.database.entityPairBaseline.findUnique>>;
    try {
      existing = await this.database.entityPairBaseline.findUnique({ where: { pairId: pair.id } });
    } catch {
      return { status: 'DATABASE_FAILURE' };
    }
    if (existing) {
      if (input.eventConfig.version < existing.settingsVersion) {
        return { status: 'STALE_PINNED_EVENT', currentSettingsVersion: existing.settingsVersion };
      }
      if (existing.settingsVersion !== input.eventConfig.version) {
        return this.rebaseSettings(input, pair.id);
      }
      return result(existing, false);
    }

    let bitrix24: Record<string, unknown>;
    let moysklad: Record<string, unknown>;
    try {
      // MySklad is the first-event authority; still read both sides to preserve
      // disagreements without writing either system.
      moysklad = await this.reader.readMoySkladCustomerOrderForBaseline(input.pair.moyskladId);
      bitrix24 = await this.reader.readBitrix24DealForBaseline(input.pair.bitrix24Id);
    } catch (error) {
      if (error instanceof ProviderFailure && isRetryableFailure(error)) {
        return { status: 'RETRYABLE_FAILURE', reason: 'SOURCE_READ_FAILED', retryAfter: retryAtForFailure(error, input.attempt ?? 1) };
      }
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
      if (!saved) return { status: 'DATABASE_FAILURE' };
      if (saved.settingsVersion !== input.eventConfig.version) {
        return { status: 'MANUAL_REVIEW', reason: 'SETTINGS_VERSION_MISMATCH' };
      }
      return result(saved, saved.eventId === input.eventId && saved.capturedAt.getTime() === capturedAt.getTime());
    } catch {
      return { status: 'DATABASE_FAILURE' };
    }
  }

  private async rebaseSettings(
    input: { pair: ConfirmedPair; eventId: string; eventConfig: VersionedFieldSettingsDto; attempt?: number },
    pairId: string,
  ): Promise<DealOrderBaselineResult> {
    if (!this.fieldSettings) return { status: 'MANUAL_REVIEW', reason: 'SETTINGS_VERSION_MISMATCH' };
    const locked = await withDealOrderPairLock(this.database, pairId, input.eventId, async (lease) => {
      const baseline = await this.database.entityPairBaseline.findUnique({ where: { pairId } });
      if (!baseline) return { status: 'MANUAL_REVIEW', reason: 'SETTINGS_VERSION_MISMATCH' } as const;
      if (input.eventConfig.version < baseline.settingsVersion) return { status: 'STALE_PINNED_EVENT', currentSettingsVersion: baseline.settingsVersion } as const;
      const [oldSettings, state] = await Promise.all([
        this.fieldSettings!.version(baseline.settingsVersion),
        this.database.entityPairSyncState.findUnique({ where: { pairId } }),
      ]);
      const oldProjection = semanticDealOrderSettings(oldSettings.config);
      const newProjection = semanticDealOrderSettings(input.eventConfig.config);
      const fingerprint = createHash('sha256').update(stableJson(newProjection)).digest('hex');
      const previousBaseline = {
        settingsVersion: baseline.settingsVersion, bitrix24Values: baseline.bitrix24Values,
        moyskladValues: baseline.moyskladValues, capturedAt: baseline.capturedAt.toISOString(),
        syncState: state ? { bitrix24Values: state.bitrix24Values, moyskladValues: state.moyskladValues, childResourceState: state.childResourceState } : null,
      } as Prisma.InputJsonValue;
      try {
        await this.database.entityPairSettingsRevision.upsert({
          where: { pairId_toSettingsVersion: { pairId, toSettingsVersion: input.eventConfig.version } },
          create: {
            pairId, fromSettingsVersion: baseline.settingsVersion, toSettingsVersion: input.eventConfig.version,
            status: 'PREPARED', semanticFingerprint: fingerprint, previousBaseline,
          },
          update: {},
        });
      } catch { return { status: 'DATABASE_FAILURE' } as const; }
      let revisionValues: RevisionMappingResult | null = null;
      if (stableJson(oldProjection) !== stableJson(newProjection)) {
        if (!this.fieldRuntime) return { status: 'MANUAL_REVIEW', reason: 'SETTINGS_REBASE_RUNTIME_UNAVAILABLE' } as const;
        revisionValues = await this.fieldRuntime.reconcileRevisionMappings({
          pair: input.pair, eventId: input.eventId, oldConfig: oldSettings, newConfig: input.eventConfig,
          assertLease: lease.assertOwner,
        });
        if (revisionValues.status === 'retry') {
          await this.database.entityPairSettingsRevision.updateMany({
            where: { pairId, toSettingsVersion: input.eventConfig.version, status: 'PREPARED' },
            data: { errorCategory: revisionValues.reason },
          }).catch(() => undefined);
          return { status: 'RETRYABLE_FAILURE', reason: revisionValues.reason, retryAfter: retryAtForFailure(new Error(revisionValues.reason), input.attempt ?? 1) } as const;
        }
        if (revisionValues.status === 'manual_review') {
          await this.database.entityPairSettingsRevision.updateMany({
            where: { pairId, toSettingsVersion: input.eventConfig.version, status: 'PREPARED' },
            data: { status: 'FAILED', errorCategory: revisionValues.reason },
          }).catch(() => undefined);
          return { status: 'MANUAL_REVIEW', reason: revisionValues.reason } as const;
        }
      }
      const bitrix24Values = mergeRevisionValues(baseline.bitrix24Values, oldSettings.config, input.eventConfig.config, revisionValues?.status === 'verified' ? revisionValues.bitrix24Values : {});
      const moyskladValues = mergeRevisionValues(baseline.moyskladValues, oldSettings.config, input.eventConfig.config, revisionValues?.status === 'verified' ? revisionValues.moyskladValues : {});
      const stateBitrix24Values = mergeRevisionValues(state?.bitrix24Values ?? baseline.bitrix24Values, oldSettings.config, input.eventConfig.config, revisionValues?.status === 'verified' ? revisionValues.bitrix24Values : {});
      const stateMoyskladValues = mergeRevisionValues(state?.moyskladValues ?? baseline.moyskladValues, oldSettings.config, input.eventConfig.config, revisionValues?.status === 'verified' ? revisionValues.moyskladValues : {});
      try {
        const committed = await lease.commit(async (transaction) => {
          const current = await transaction.entityPairBaseline.findUnique({ where: { pairId } });
          if (!current || current.settingsVersion !== baseline.settingsVersion) throw new Error('SETTINGS_REBASE_BASELINE_CHANGED');
          await transaction.entityPairBaseline.update({ where: { pairId }, data: {
            settingsVersion: input.eventConfig.version,
            bitrix24Values: bitrix24Values as Prisma.InputJsonValue,
            moyskladValues: moyskladValues as Prisma.InputJsonValue,
          } });
          await transaction.entityPairSyncState.upsert({
            where: { pairId },
            create: { pairId, settingsVersion: input.eventConfig.version, bitrix24Values: stateBitrix24Values as Prisma.InputJsonValue, moyskladValues: stateMoyskladValues as Prisma.InputJsonValue },
            update: { settingsVersion: input.eventConfig.version, bitrix24Values: stateBitrix24Values as Prisma.InputJsonValue, moyskladValues: stateMoyskladValues as Prisma.InputJsonValue },
          });
          await transaction.entityPairSettingsRevision.update({
            where: { pairId_toSettingsVersion: { pairId, toSettingsVersion: input.eventConfig.version } },
            data: { status: 'COMPLETE', currentBaseline: { settingsVersion: input.eventConfig.version, bitrix24Values, moyskladValues } as Prisma.InputJsonValue },
          });
          return transaction.entityPairBaseline.findUnique({ where: { pairId } });
        });
        if (!committed.committed || !committed.value) return { status: 'DATABASE_FAILURE' } as const;
        return result(committed.value, false);
      } catch {
        await this.database.entityPairSettingsRevision.updateMany({
          where: { pairId, toSettingsVersion: input.eventConfig.version, status: 'PREPARED' },
          data: { status: 'FAILED', errorCategory: 'REVISION_STATE_PERSIST_FAILED' },
        }).catch(() => undefined);
        return { status: 'DATABASE_FAILURE' } as const;
      }
    });
    return locked ?? { status: 'MANUAL_REVIEW', reason: 'SETTINGS_VERSION_MISMATCH' };
  }
}

function projectApprovedValues(config: VersionedFieldSettingsDto['config'], record: Record<string, unknown>, system: 'bitrix24' | 'moysklad') {
  const values: Record<string, unknown> = {};
  if (system === 'bitrix24') {
    values['client:companyId'] = approvedValue(record.COMPANY_ID);
    values['deal-order-total'] = { amount: approvedValue(record.OPPORTUNITY), currencyCode: approvedValue(record.CURRENCY_ID) };
  } else {
    values['client:agentId'] = approvedValue(agentId(record.agent));
    values['deal-order-total'] = { amount: approvedValue(record.sum), currencyCode: approvedValue(orderCurrencyCode(record)) };
  }
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

function orderCurrencyCode(record: Record<string, unknown>): unknown {
  const currency = isRecord(record.currency) ? record.currency : isRecord(record.rate) && isRecord(record.rate.currency) ? record.rate.currency : null;
  return currency?.isoCode ?? currency?.code ?? null;
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

function agentId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)) return value.id;
  if (!isRecord(value.meta) || typeof value.meta.href !== 'string') return null;
  const match = /\/counterparty\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?(?:\?.*)?$/i.exec(value.meta.href);
  return match?.[1] ?? null;
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

function semanticDealOrderSettings(config: VersionedFieldSettingsDto['config']): Record<string, unknown> {
  const rules = (Array.isArray(config.rules) ? config.rules : []).filter((rule) => rule.entity === 'deals-orders')
    .map((rule) => ({
      entity: rule.entity, sourceField: rule.sourceField, targetField: rule.targetField, criticality: rule.criticality,
      bitrix24ToMoysklad: { enabled: rule.bitrix24ToMoysklad.enabled, transform: rule.bitrix24ToMoysklad.transform },
      moyskladToBitrix24: { enabled: rule.moyskladToBitrix24.enabled, transform: rule.moyskladToBitrix24.transform },
    }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const groups = (Array.isArray(config.groups) ? config.groups : []).filter((group) => group.entity === 'deals-orders')
    .map((group) => ({
      entity: group.entity, direction: group.direction, sourceFields: group.sourceFields,
      targetField: group.targetField, criticality: group.criticality, transform: group.transform,
    }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return { rules, groups };
}

function rekeyRuleValues(value: Prisma.JsonValue, oldConfig: VersionedFieldSettingsDto['config'], newConfig: VersionedFieldSettingsDto['config']): Record<string, unknown> {
  const result: Record<string, unknown> = isRecord(value) ? { ...value } : {};
  const oldRules = Array.isArray(oldConfig.rules) ? oldConfig.rules.filter((rule) => rule.entity === 'deals-orders') : [];
  const newRules = Array.isArray(newConfig.rules) ? newConfig.rules.filter((rule) => rule.entity === 'deals-orders') : [];
  for (const oldRule of oldRules) {
    const semantic = stableJson({
      entity: oldRule.entity, sourceField: oldRule.sourceField, targetField: oldRule.targetField, criticality: oldRule.criticality,
      bitrix24ToMoysklad: { enabled: oldRule.bitrix24ToMoysklad.enabled, transform: oldRule.bitrix24ToMoysklad.transform },
      moyskladToBitrix24: { enabled: oldRule.moyskladToBitrix24.enabled, transform: oldRule.moyskladToBitrix24.transform },
    });
    const newRule = newRules.find((candidate) => stableJson({
      entity: candidate.entity, sourceField: candidate.sourceField, targetField: candidate.targetField, criticality: candidate.criticality,
      bitrix24ToMoysklad: { enabled: candidate.bitrix24ToMoysklad.enabled, transform: candidate.bitrix24ToMoysklad.transform },
      moyskladToBitrix24: { enabled: candidate.moyskladToBitrix24.enabled, transform: candidate.moyskladToBitrix24.transform },
    }) === semantic);
    if (newRule) moveKey(result, `rule:${oldRule.id}`, `rule:${newRule.id}`);
  }
  const oldGroups = Array.isArray(oldConfig.groups) ? oldConfig.groups.filter((group) => group.entity === 'deals-orders') : [];
  const newGroups = Array.isArray(newConfig.groups) ? newConfig.groups.filter((group) => group.entity === 'deals-orders') : [];
  for (const oldGroup of oldGroups) {
    const semantic = stableJson({ entity: oldGroup.entity, direction: oldGroup.direction, sourceFields: oldGroup.sourceFields, targetField: oldGroup.targetField, criticality: oldGroup.criticality, transform: oldGroup.transform });
    const newGroup = newGroups.find((candidate) => stableJson({ entity: candidate.entity, direction: candidate.direction, sourceFields: candidate.sourceFields, targetField: candidate.targetField, criticality: candidate.criticality, transform: candidate.transform }) === semantic);
    if (newGroup) {
      moveKey(result, `group:${oldGroup.id}:source`, `group:${newGroup.id}:source`);
      moveKey(result, `group:${oldGroup.id}:target`, `group:${newGroup.id}:target`);
    }
  }
  return result;
}

function mergeRevisionValues(
  snapshot: Prisma.JsonValue,
  oldConfig: VersionedFieldSettingsDto['config'],
  newConfig: VersionedFieldSettingsDto['config'],
  verifiedChanges: Record<string, unknown>,
): Record<string, unknown> {
  const rekeyed = rekeyRuleValues(snapshot, oldConfig, newConfig);
  const preservedKeys = new Set<string>();
  const oldRules = (oldConfig.rules ?? []).filter((rule) => rule.entity === 'deals-orders');
  const newRules = (newConfig.rules ?? []).filter((rule) => rule.entity === 'deals-orders');
  for (const oldRule of oldRules) {
    const projected = stableJson({
      entity: oldRule.entity, sourceField: oldRule.sourceField, targetField: oldRule.targetField, criticality: oldRule.criticality,
      bitrix24ToMoysklad: { enabled: oldRule.bitrix24ToMoysklad.enabled, transform: oldRule.bitrix24ToMoysklad.transform },
      moyskladToBitrix24: { enabled: oldRule.moyskladToBitrix24.enabled, transform: oldRule.moyskladToBitrix24.transform },
    });
    const next = newRules.find((candidate) => stableJson({
      entity: candidate.entity, sourceField: candidate.sourceField, targetField: candidate.targetField, criticality: candidate.criticality,
      bitrix24ToMoysklad: { enabled: candidate.bitrix24ToMoysklad.enabled, transform: candidate.bitrix24ToMoysklad.transform },
      moyskladToBitrix24: { enabled: candidate.moyskladToBitrix24.enabled, transform: candidate.moyskladToBitrix24.transform },
    }) === projected);
    if (next) preservedKeys.add(`rule:${next.id}`);
  }
  const oldGroups = (oldConfig.groups ?? []).filter((group) => group.entity === 'deals-orders');
  const newGroups = (newConfig.groups ?? []).filter((group) => group.entity === 'deals-orders');
  for (const oldGroup of oldGroups) {
    const projected = stableJson({ entity: oldGroup.entity, direction: oldGroup.direction, sourceFields: oldGroup.sourceFields, targetField: oldGroup.targetField, criticality: oldGroup.criticality, transform: oldGroup.transform });
    const next = newGroups.find((candidate) => stableJson({ entity: candidate.entity, direction: candidate.direction, sourceFields: candidate.sourceFields, targetField: candidate.targetField, criticality: candidate.criticality, transform: candidate.transform }) === projected);
    if (next) { preservedKeys.add(`group:${next.id}:source`); preservedKeys.add(`group:${next.id}:target`); }
  }
  const merged: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(rekeyed)) {
    if (!key.startsWith('rule:') && !key.startsWith('group:') || preservedKeys.has(key)) merged[key] = item;
  }
  return { ...merged, ...verifiedChanges };
}

function moveKey(record: Record<string, unknown>, oldKey: string, newKey: string) {
  if (oldKey === newKey || !(oldKey in record)) return;
  if (!(newKey in record)) record[newKey] = record[oldKey];
  delete record[oldKey];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
