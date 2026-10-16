import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { DryRunDocumentReader } from '../dry-run-document-reader';
import { DictionaryReference, VersionedFieldSettingsDto } from '../field-settings/field-settings.dto';
import { PairResolutionResult } from '../pairs/pair-resolver';
import { writeOperationalLog } from '../monitoring-log';
import { DealOrderWriteDirection, DealOrderWriteGateError, SyncModeService } from '../sync-mode.service';
import { withDealOrderPairLock } from './deal-order-pair-lock';
import { isPlannedDeliveryDateMapping, normalizePlannedDeliveryDate, toMoySkladPlannedDeliveryDate, touchesPlannedDeliveryDateEndpoint } from './planned-delivery-date';

type ConfirmedPair = Extract<PairResolutionResult, { status: 'confirmed' }>['pair'];
type RecordValue = Record<string, unknown>;
type Rule = VersionedFieldSettingsDto['config']['rules'][number];
type Direction = 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24';
type Result = { status: 'SYNCED'; heldRules: number } | { status: 'MANUAL_REVIEW'; reason: string } | { status: 'RETRY'; reason: string };

const logger = new Logger('DealOrderFieldRuntimeService');
const EXACT_OPTIONAL_STRING_ATTRIBUTES: Record<string, string> = {
  UF_CRM_1770062820: 'attributes.4a432000-0785-11f1-0a80-1b1000018578',
  UF_CRM_1785419472892: 'attributes.d5172d2c-8c1d-11f1-0a80-1af10010ed42',
  UF_CRM_1769687298: 'attributes.423e297a-7feb-11ef-0a80-0e7e002e09ff',
  UF_CRM_1729757856892: 'attributes.f7a9c2df-47f9-11ef-0a80-0c0c00322096',
};

/**
 * Applies only explicitly configured scalar copy rules on confirmed deal/order
 * pairs. Reference objects and non-copy transforms are intentionally held until
 * their value maps and encodings have an approved, verified implementation.
 */
@Injectable()
export class DealOrderFieldRuntimeService {
  constructor(private readonly database: DatabaseService, private readonly reader: DryRunDocumentReader, private readonly mode: SyncModeService) {}

  async process(input: { pair: ConfirmedPair; eventId: string; eventConfig: VersionedFieldSettingsDto }): Promise<Result> {
    if (input.pair.entityType !== 'DEAL') return { status: 'MANUAL_REVIEW', reason: 'UNSUPPORTED_ENTITY' };
    if (process.env.SYNC_MODE !== 'apply') return { status: 'MANUAL_REVIEW', reason: 'SYNC_MODE_NOT_APPLY' };
    return await withDealOrderPairLock(this.database, input.pair.id, input.eventId, (lease) => this.processLocked(input, lease.assertOwner, (direction, mutation) => this.mode.runDealOrderExternalWrite(direction, lease.assertOwner, { id: input.pair.id, entityType: input.pair.entityType }, mutation))) ??
      { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_BUSY' };
  }

  private async processLocked(input: { pair: ConfirmedPair; eventId: string; eventConfig: VersionedFieldSettingsDto }, assertOwner: () => Promise<boolean>, runMutation: (direction: DealOrderWriteDirection, mutation: () => Promise<unknown>) => Promise<unknown>): Promise<Result> {
    const pair = await this.database.entityPair.findFirst({
      where: { id: input.pair.id, entityType: 'DEAL', active: true, bitrix24Id: input.pair.bitrix24Id, moyskladId: input.pair.moyskladId },
      select: { id: true, bitrix24Id: true, moyskladId: true },
    });
    if (!pair) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_PAIR_NOT_ACTIVE' };
    const groups = input.eventConfig.config.groups.filter((group) => group.entity === 'deals-orders');
    if (groups.length) {
      for (const group of groups) this.logHeld(input.eventId, pair.id, group.id, 'FIELD_GROUP_RUNTIME_NOT_SUPPORTED');
      return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_FIELD_GROUPS_UNSUPPORTED' };
    }
    const rules = input.eventConfig.config.rules.filter((rule) => rule.entity === 'deals-orders' && (rule.bitrix24ToMoysklad.enabled || rule.moyskladToBitrix24.enabled));
    if (!rules.length) return { status: 'SYNCED', heldRules: 0 };

    const baseline = await this.database.entityPairBaseline.findUnique({ where: { pairId: pair.id } });
    if (!baseline) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_BASELINE_MISSING' };
    if (baseline.settingsVersion !== input.eventConfig.version) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_SETTINGS_VERSION_MISMATCH' };
    let state = await this.database.entityPairSyncState.findUnique({ where: { pairId: pair.id } });
    if (state && state.settingsVersion !== input.eventConfig.version) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_SETTINGS_VERSION_MISMATCH' };
    if (!state) {
      try {
        state = await this.database.entityPairSyncState.create({ data: {
          pairId: pair.id, settingsVersion: baseline.settingsVersion,
          bitrix24Values: baseline.bitrix24Values as Prisma.InputJsonValue,
          moyskladValues: baseline.moyskladValues as Prisma.InputJsonValue,
        } });
      } catch {
        state = await this.database.entityPairSyncState.findUnique({ where: { pairId: pair.id } });
      }
      if (!state || state.settingsVersion !== input.eventConfig.version) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_SYNC_STATE_UNAVAILABLE' };
    }

    const directions = await this.database.syncDirectionSetting.findUnique({
      where: { entityKey: 'deals-orders' }, select: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
    });
    let heldRules = 0;
    for (const rule of rules) {
      // COMMENTS/description is deliberately owned by the local header
      // processor, whose readiness gate prevents this pilot mapping from
      // falling through to generic attribute writes.
      if (rule.sourceField === 'COMMENTS' && rule.targetField === 'description') continue;
      if (touchesExactOptionalStringEndpoint(rule.sourceField, rule.targetField) && !isExactOptionalStringMapping(rule.sourceField, rule.targetField)) {
        heldRules++;
        this.logHeld(input.eventId, pair.id, rule.id, 'OPTIONAL_STRING_MAPPING_NOT_APPROVED');
        continue;
      }
      if (touchesPlannedDeliveryDateEndpoint(rule.sourceField, rule.targetField) && !isPlannedDeliveryDateMapping(rule.sourceField, rule.targetField)) {
        heldRules++;
        this.logHeld(input.eventId, pair.id, rule.id, 'PLANNED_DELIVERY_DATE_MAPPING_NOT_APPROVED');
        continue;
      }
      if (isQ26PaidSumField(rule) && !isReadOnlyPaidSumRule(rule)) {
        heldRules++;
        this.logHeld(input.eventId, pair.id, rule.id, 'READ_ONLY_PAID_SUM_MAPPING_INVALID');
        continue;
      }
      let bitrix24: RecordValue;
      let moysklad: RecordValue;
      try {
        [bitrix24, moysklad] = await Promise.all([
          this.reader.readBitrix24DealForBaseline(pair.bitrix24Id),
          this.reader.readMoySkladCustomerOrderForBaseline(pair.moyskladId),
        ]);
      } catch { return { status: 'RETRY', reason: 'DEAL_ORDER_FIELD_READ_FAILED' }; }
      const dictionary = dictionaryForRule(input.eventConfig, rule);
      const b24Current = dictionary
        ? readDictionaryField(bitrix24, moysklad, rule, dictionary, 'BITRIX24')
        : readDealOrderRuleField(bitrix24, rule, 'BITRIX24');
      const msCurrent = dictionary
        ? readDictionaryField(bitrix24, moysklad, rule, dictionary, 'MOYSKLAD')
        : readDealOrderRuleField(moysklad, rule, 'MOYSKLAD');
      if (!b24Current.supported || !msCurrent.supported) {
        heldRules++;
        this.logHeld(input.eventId, pair.id, rule.id, 'FIELD_VALUE_NOT_SCALAR');
        continue;
      }
      if (isExactOptionalStringMapping(rule.sourceField, rule.targetField) &&
          (!isOptionalString(b24Current.value) || !isOptionalString(msCurrent.value))) {
        heldRules++;
        this.logHeld(input.eventId, pair.id, rule.id, 'OPTIONAL_STRING_VALUE_NOT_STRING');
        continue;
      }
      const b24Snapshot = jsonRecord(state.bitrix24Values);
      const msSnapshot = jsonRecord(state.moyskladValues);
      const key = `rule:${rule.id}`;
      if (!(key in b24Snapshot) || !(key in msSnapshot)) {
        heldRules++;
        this.logHeld(input.eventId, pair.id, rule.id, 'FIELD_NOT_IN_PINNED_BASELINE');
        continue;
      }
      const previousB24 = b24Snapshot[key];
      const previousMs = msSnapshot[key];
      const b24Changed = !sameJson(b24Current.value, previousB24);
      const msChanged = !sameJson(msCurrent.value, previousMs);
      const paidSumAuthority = isReadOnlyPaidSumRule(rule);
      if (paidSumAuthority && (!isFiniteNumber(msCurrent.value) || !(b24Current.value === null || isFiniteNumber(b24Current.value)))) {
        heldRules++;
        this.logHeld(input.eventId, pair.id, rule.id, 'READ_ONLY_PAID_SUM_VALUE_INVALID');
        continue;
      }
      let direction: Direction | 'ECHO' = paidSumAuthority
        ? (b24Changed || msChanged ? 'MOYSKLAD_TO_BITRIX24' : 'ECHO')
        : b24Changed && msChanged
        ? 'MOYSKLAD_TO_BITRIX24'
        : b24Changed ? 'BITRIX24_TO_MOYSKLAD' : msChanged ? 'MOYSKLAD_TO_BITRIX24' : 'ECHO';
      // Fixed deal/order conflict policy: MySklad wins regardless of clocks.
      if (!paidSumAuthority && b24Changed && msChanged) direction = 'MOYSKLAD_TO_BITRIX24';
      if (direction === 'ECHO') continue;
      const mapping = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.bitrix24ToMoysklad : rule.moyskladToBitrix24;
      if (paidSumAuthority && direction !== 'MOYSKLAD_TO_BITRIX24') {
        heldRules++;
        this.logHeld(input.eventId, pair.id, rule.id, 'READ_ONLY_PAID_SUM_DIRECTION_INVALID');
        continue;
      }
      if (mapping.transform.kind !== 'copy') {
        heldRules++;
        this.logHeld(input.eventId, pair.id, rule.id, 'TRANSFORM_NOT_SUPPORTED');
        continue;
      }
      const allowed = direction === 'BITRIX24_TO_MOYSKLAD' ? directions?.bitrix24ToMoysklad ?? true : directions?.moyskladToBitrix24 ?? true;
      if (!mapping.enabled || !allowed) {
        heldRules++;
        this.logHeld(input.eventId, pair.id, rule.id, 'DIRECTION_DISABLED');
        continue;
      }
      const desired = direction === 'BITRIX24_TO_MOYSKLAD' ? b24Current.value : msCurrent.value;
      const targetCurrent = direction === 'BITRIX24_TO_MOYSKLAD' ? msCurrent.value : b24Current.value;
      if (!sameJson(desired, targetCurrent)) {
        try {
          const [latestB24, latestMs] = await Promise.all([
            this.reader.readBitrix24DealForBaseline(pair.bitrix24Id),
            this.reader.readMoySkladCustomerOrderForBaseline(pair.moyskladId),
          ]);
          const latestB24Field = dictionary
            ? readDictionaryField(latestB24, latestMs, rule, dictionary, 'BITRIX24')
            : readDealOrderRuleField(latestB24, rule, 'BITRIX24');
          const latestMsField = dictionary
            ? readDictionaryField(latestB24, latestMs, rule, dictionary, 'MOYSKLAD')
            : readDealOrderRuleField(latestMs, rule, 'MOYSKLAD');
          if (!latestB24Field.supported || !latestMsField.supported || !sameJson(latestB24Field.value, b24Current.value) || !sameJson(latestMsField.value, msCurrent.value)) {
            return { status: 'RETRY', reason: 'DEAL_ORDER_FIELD_CHANGED_BEFORE_WRITE' };
          }
          if (!await assertOwner()) return { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_LOCK_LOST' };
          if (dictionary) {
            const mapped = resolveDictionaryValue(dictionary, 'BITRIX24', desired);
            if (mapped.status !== 'MAPPED' && mapped.status !== 'EMPTY') return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_REFERENCE_VALUE_UNMAPPED' };
            if (direction === 'BITRIX24_TO_MOYSKLAD') await runMutation('bitrix24ToMoysklad', () => writeMoySkladDictionaryAttribute(pair.moyskladId, dictionary, mapped.status === 'EMPTY' ? null : mapped.moyskladId));
            else await runMutation('moyskladToBitrix24', () => writeBitrix24Field(pair.bitrix24Id, rule.sourceField, mapped.status === 'EMPTY' ? null : mapped.bitrix24Id));
          } else if (direction === 'BITRIX24_TO_MOYSKLAD') {
            const writeValue = isPlannedDeliveryDateMapping(rule.sourceField, rule.targetField)
              ? toMoySkladPlannedDeliveryDate(desired as string | null)
              : desired;
            await runMutation('bitrix24ToMoysklad', () => writeMoySkladAttribute(pair.moyskladId, rule.targetField, writeValue, rule.sourceField));
          }
          else await runMutation('moyskladToBitrix24', () => writeBitrix24Field(pair.bitrix24Id, rule.sourceField, desired));
        } catch (error) {
          if (error instanceof DealOrderWriteGateError) return { status: 'RETRY', reason: error.message };
          return { status: 'RETRY', reason: 'DEAL_ORDER_FIELD_WRITE_FAILED' };
        }
        if (paidSumAuthority && b24Changed) {
          await writeOperationalLog(this.database, 'EVENT', `Q26.44 corrected manual Bitrix24 paid sum; previousBitrix24Value=${String(b24Current.value)}; reason=MY_SKLAD_READ_ONLY_SOURCE_AUTHORITATIVE`, input.eventId);
        }
      }
      let verifiedB24: RecordValue;
      let verifiedMs: RecordValue;
      try {
        [verifiedB24, verifiedMs] = await Promise.all([
          this.reader.readBitrix24DealForBaseline(pair.bitrix24Id),
          this.reader.readMoySkladCustomerOrderForBaseline(pair.moyskladId),
        ]);
      } catch { return { status: 'RETRY', reason: 'DEAL_ORDER_FIELD_READBACK_FAILED' }; }
      const readBackB24 = dictionary
        ? readDictionaryField(verifiedB24, verifiedMs, rule, dictionary, 'BITRIX24')
        : readDealOrderRuleField(verifiedB24, rule, 'BITRIX24');
      const readBackMs = dictionary
        ? readDictionaryField(verifiedB24, verifiedMs, rule, dictionary, 'MOYSKLAD')
        : readDealOrderRuleField(verifiedMs, rule, 'MOYSKLAD');
      if (!readBackB24.supported || !readBackMs.supported || !sameJson(readBackB24.value, desired) || !sameJson(readBackMs.value, desired)) {
        return { status: 'RETRY', reason: 'DEAL_ORDER_FIELD_READBACK_MISMATCH' };
      }
      if (!await assertOwner()) return { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_LOCK_LOST' };
      b24Snapshot[key] = readBackB24.value;
      msSnapshot[key] = readBackMs.value;
      try {
        await this.database.entityPairSyncState.upsert({
          where: { pairId: pair.id },
          create: { pairId: pair.id, settingsVersion: input.eventConfig.version, bitrix24Values: b24Snapshot as Prisma.InputJsonValue, moyskladValues: msSnapshot as Prisma.InputJsonValue },
          update: { settingsVersion: input.eventConfig.version, bitrix24Values: b24Snapshot as Prisma.InputJsonValue, moyskladValues: msSnapshot as Prisma.InputJsonValue },
        });
        state.bitrix24Values = b24Snapshot as Prisma.JsonValue;
        state.moyskladValues = msSnapshot as Prisma.JsonValue;
      } catch { return { status: 'RETRY', reason: 'DEAL_ORDER_FIELD_STATE_STORE_FAILED' }; }
    }
        const stageResult = await this.processConfiguredStage(input, pair, state, directions, assertOwner, runMutation);
    if (stageResult?.status === 'RETRY' || stageResult?.status === 'MANUAL_REVIEW') return stageResult;
    if (heldRules > 0) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_FIELD_RULES_HELD' };
    return { status: 'SYNCED', heldRules };
  }

  private async processConfiguredStage(
    input: { pair: ConfirmedPair; eventId: string; eventConfig: VersionedFieldSettingsDto },
    pair: { id: string; bitrix24Id: string; moyskladId: string },
    state: NonNullable<Awaited<ReturnType<DatabaseService['entityPairSyncState']['findUnique']>>>,
    directions: { bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean } | null,
    assertOwner: () => Promise<boolean>,
    runMutation: (direction: DealOrderWriteDirection, mutation: () => Promise<unknown>) => Promise<unknown>,
  ): Promise<Result | null> {
    const stages = input.eventConfig.config.dealOrderRuntime?.stages;
    if (!Array.isArray(stages) || stages.length === 0) return null;
    const b24State = jsonRecord(state.bitrix24Values);
    const msState = jsonRecord(state.moyskladValues);
    if (!('native:stage' in b24State) || !('native:stage' in msState) ||
        typeof b24State['native:stage'] !== 'string' || typeof msState['native:stage'] !== 'string') {
      return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_STAGE_BASELINE_UNAVAILABLE' };
    }
    let b24: RecordValue;
    let moysklad: RecordValue;
    try {
      [b24, moysklad] = await Promise.all([
        this.reader.readBitrix24DealForBaseline(pair.bitrix24Id),
        this.reader.readMoySkladCustomerOrderForBaseline(pair.moyskladId),
      ]);
    } catch { return { status: 'RETRY', reason: 'DEAL_ORDER_STAGE_READ_FAILED' }; }
    const b24Current = readConfiguredStage(b24, stages, 'BITRIX24');
    const msCurrent = readConfiguredStage(moysklad, stages, 'MOYSKLAD');
    if (!b24Current || !msCurrent) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_STAGE_UNMAPPED' };
    const b24Changed = b24Current !== b24State['native:stage'];
    const msChanged = msCurrent !== msState['native:stage'];
    if (!b24Changed && !msChanged) return null;

    let direction: Direction;
    if (b24Changed && msChanged) direction = 'MOYSKLAD_TO_BITRIX24';
    else direction = b24Changed ? 'BITRIX24_TO_MOYSKLAD' : 'MOYSKLAD_TO_BITRIX24';
    const enabled = direction === 'BITRIX24_TO_MOYSKLAD'
      ? directions?.bitrix24ToMoysklad ?? true
      : directions?.moyskladToBitrix24 ?? true;
    if (!enabled) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_STAGE_DIRECTION_DISABLED' };

    const sourceId = direction === 'BITRIX24_TO_MOYSKLAD' ? b24Current : msCurrent;
    const mapping = stages.filter((stage) => direction === 'BITRIX24_TO_MOYSKLAD'
      ? stage.bitrix24StageId === sourceId
      : stage.moyskladId === sourceId);
    if (mapping.length !== 1 || !isUuid(mapping[0].moyskladId) || !mapping[0].bitrix24StageId) {
      return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_STAGE_UNMAPPED' };
    }
    const expectedB24 = mapping[0].bitrix24StageId;
    const expectedMs = mapping[0].moyskladId;
    try {
      const [latestB24, latestMs] = await Promise.all([
        this.reader.readBitrix24DealForBaseline(pair.bitrix24Id),
        this.reader.readMoySkladCustomerOrderForBaseline(pair.moyskladId),
      ]);
      if (readConfiguredStage(latestB24, stages, 'BITRIX24') !== b24Current ||
          readConfiguredStage(latestMs, stages, 'MOYSKLAD') !== msCurrent) {
        return { status: 'RETRY', reason: 'DEAL_ORDER_STAGE_CHANGED_BEFORE_WRITE' };
      }
      if (!await assertOwner()) return { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_LOCK_LOST' };
      if (direction === 'BITRIX24_TO_MOYSKLAD') await runMutation('bitrix24ToMoysklad', () => writeMoySkladStage(pair.moyskladId, expectedMs));
      else await runMutation('moyskladToBitrix24', () => writeBitrix24Field(pair.bitrix24Id, 'STAGE_ID', expectedB24));
    } catch (error) { return { status: 'RETRY', reason: error instanceof DealOrderWriteGateError ? error.message : 'DEAL_ORDER_STAGE_WRITE_FAILED' }; }

    let verifiedB24: RecordValue;
    let verifiedMs: RecordValue;
    try {
      [verifiedB24, verifiedMs] = await Promise.all([
        this.reader.readBitrix24DealForBaseline(pair.bitrix24Id),
        this.reader.readMoySkladCustomerOrderForBaseline(pair.moyskladId),
      ]);
    } catch { return { status: 'RETRY', reason: 'DEAL_ORDER_STAGE_READBACK_FAILED' }; }
    if (readConfiguredStage(verifiedB24, stages, 'BITRIX24') !== expectedB24 ||
        readConfiguredStage(verifiedMs, stages, 'MOYSKLAD') !== expectedMs) {
      return { status: 'RETRY', reason: 'DEAL_ORDER_STAGE_READBACK_MISMATCH' };
    }
    if (!await assertOwner()) return { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_LOCK_LOST' };
    b24State['native:stage'] = expectedB24;
    msState['native:stage'] = expectedMs;
    try {
      await this.database.entityPairSyncState.update({
        where: { pairId: pair.id },
        data: { bitrix24Values: b24State as Prisma.InputJsonValue, moyskladValues: msState as Prisma.InputJsonValue },
      });
      state.bitrix24Values = b24State as Prisma.JsonValue;
      state.moyskladValues = msState as Prisma.JsonValue;
      return null;
    } catch { return { status: 'RETRY', reason: 'DEAL_ORDER_STAGE_STATE_STORE_FAILED' }; }
  }

  private logHeld(eventId: string, pairId: string, ruleId: string, reason: string) {
    logger.warn(JSON.stringify({ eventId, pairId, ruleId, reason }));
  }
}

export function resolveDealOrderConflict(bitrix24Modified: unknown, moyskladUpdated: unknown): 'BITRIX24' | 'MOYSKLAD' | null {
  void bitrix24Modified;
  void moyskladUpdated;
  return 'MOYSKLAD';
}
function isOptionalString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
function touchesExactOptionalStringEndpoint(sourceField: string, targetField: string): boolean {
  return sourceField in EXACT_OPTIONAL_STRING_ATTRIBUTES || Object.values(EXACT_OPTIONAL_STRING_ATTRIBUTES).some((field) => field.toLowerCase() === targetField.toLowerCase());
}
function isExactOptionalStringMapping(sourceField: string, targetField: string): boolean {
  return EXACT_OPTIONAL_STRING_ATTRIBUTES[sourceField]?.toLowerCase() === targetField.toLowerCase();
}

function isReadOnlyPaidSumRule(rule: Rule): boolean {
  return rule.sourceField === 'UF_CRM_1782196830070' && rule.targetField === 'payedSum' &&
    !rule.bitrix24ToMoysklad.enabled && rule.moyskladToBitrix24.enabled &&
    rule.moyskladToBitrix24.transform.kind === 'copy';
}
function isQ26PaidSumField(rule: Rule): boolean {
  return rule.sourceField === 'UF_CRM_1782196830070' || rule.targetField === 'payedSum';
}
function isFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }

function readScalarField(record: RecordValue, field: string, system: 'bitrix24' | 'moysklad'):
  { supported: true; value: string | number | boolean | null } | { supported: false } {
  let value: unknown;
  const attribute = system === 'moysklad' ? field.match(/^attributes\.([0-9a-f-]{36})$/i) : null;
  if (attribute) {
    const attributes = Array.isArray(record.attributes) ? record.attributes : [];
    const item = attributes.find((candidate) => isRecord(candidate) && (candidate.id === attribute[1] || attributeId(candidate) === attribute[1]));
    value = isRecord(item) ? item.value ?? null : null;
  } else if (system === 'moysklad' && field.startsWith('attributes.')) return { supported: false };
  else value = record[field];
  if (value === undefined || value === '') return { supported: true, value: null };
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return { supported: true, value };
  return { supported: false };
}

function readDealOrderRuleField(record: RecordValue, rule: Rule, side: 'BITRIX24' | 'MOYSKLAD'):
  { supported: true; value: string | number | boolean | null } | { supported: false } {
  const field = side === 'BITRIX24' ? rule.sourceField : rule.targetField;
  const scalar = readScalarField(record, field, side === 'BITRIX24' ? 'bitrix24' : 'moysklad');
  if (!scalar.supported || !isPlannedDeliveryDateMapping(rule.sourceField, rule.targetField)) return scalar;
  const normalized = normalizePlannedDeliveryDate(scalar.value, side);
  return normalized.supported ? normalized : { supported: false };
}

async function writeMoySkladAttribute(orderId: string, targetField: string, value: string | number | boolean | null, sourceField: string) {
  const attributeId = targetField.match(/^attributes\.([0-9a-f-]{36})$/i)?.[1];
  const base = externalBase(process.env.MOYSKLAD_API_BASE_URL);
  const token = process.env.MOYSKLAD_API_TOKEN;
  const isShipmentAddress = targetField === 'shipmentAddress' && sourceField === 'UF_CRM_6926D80233F92' && (value === null || typeof value === 'string');
  if ((!attributeId && !isShipmentAddress) || !token) throw new Error('unsupported target');
  const url = new URL(`entity/customerorder/${encodeURIComponent(orderId)}`, base);
  const payload = isShipmentAddress ? { shipmentAddress: value } : { attributes: [{ meta: { href: new URL(`entity/customerorder/metadata/attributes/${attributeId}`, base).href, type: 'attributemetadata', mediaType: 'application/json' }, value }] };
  const response = await fetch(url, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('MySklad field update failed');
}

async function writeMoySkladStage(orderId: string, stateId: string) {
  const base = externalBase(process.env.MOYSKLAD_API_BASE_URL);
  const token = process.env.MOYSKLAD_API_TOKEN;
  if (!token || !isUuid(stateId)) throw new Error('unsupported customerorder state');
  const url = new URL(`entity/customerorder/${encodeURIComponent(orderId)}`, base);
  const href = new URL(`entity/customerorder/metadata/states/${encodeURIComponent(stateId)}`, base).href;
  const response = await fetch(url, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ state: { meta: { href, type: 'state', mediaType: 'application/json' } } }),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('MySklad stage update failed');
}

async function writeBitrix24Field(dealId: string, targetField: string, value: string | number | boolean | null) {
  if (!/^[A-Z][A-Z0-9_]{0,119}$/i.test(targetField)) throw new Error('unsupported target');
  const base = externalBase(process.env.BITRIX24_REST_BASE_URL);
  const url = new URL('crm.deal.update.json', base);
  const fields = value === null ? '' : String(value);
  const body = new URLSearchParams({ id: dealId, [`fields[${targetField}]`]: fields });
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Bitrix24 field update failed');
  const result: unknown = await response.json().catch(() => null);
  if (!isRecord(result) || result.error || result.result !== true) throw new Error('Bitrix24 field update failed');
}

function isReferenceMapping(config: VersionedFieldSettingsDto, rule: Rule): boolean {
  const targetAttribute = rule.targetField.match(/^attributes\.([0-9a-f-]{36})$/i)?.[1];
  return !!targetAttribute && config.config.references.dictionaries.some((dictionary) => dictionary.bitrix24Field === rule.sourceField && dictionary.moyskladAttributeId === targetAttribute);
}
function dictionaryForRule(config: VersionedFieldSettingsDto, rule: Rule): DictionaryReference | null {
  const targetAttribute = rule.targetField.match(/^attributes\.([0-9a-f-]{36})$/i)?.[1];
  const dictionary = config.config.references.dictionaries.find((candidate) => candidate.bitrix24Field === rule.sourceField && candidate.moyskladAttributeId === targetAttribute);
  if (!dictionary) return null;
  const contract = dictionary.key === 'service'
    ? ['UF_CRM_1766085949', '42', '0ad997c8-8e75-11e3-1ec9-002590a28eca', 'f0177126-8e74-11e3-b761-002590a28eca']
    : dictionary.key === 'payment-method'
      ? ['UF_CRM_1766072752', '44', 'f214f966-dc1a-11f0-0a80-0ef700278459', '0ecffb86-d8a3-11eb-0a80-0dbc000256e5']
      : null;
  if (!contract || dictionary.bitrix24Field !== contract[0] || dictionary.bitrix24ListId !== contract[1] ||
      dictionary.moyskladAttributeId !== contract[2] || dictionary.moyskladDirectoryId !== contract[3]) return null;
  return dictionary;
}

export function resolveDictionaryValue(
  dictionary: DictionaryReference,
  source: 'BITRIX24' | 'MOYSKLAD',
  value: unknown,
): { status: 'EMPTY' } | { status: 'UNMAPPED' } | { status: 'MAPPED'; bitrix24Id: number; moyskladId: string } {
  if (value === null || value === undefined || value === '') return { status: 'EMPTY' };
  const matches = dictionary.pairs.filter((pair) => source === 'BITRIX24'
    ? String(pair.bitrix24Id) === String(value)
    : pair.moyskladId === value);
  if (matches.length !== 1) return { status: 'UNMAPPED' };
  return { status: 'MAPPED', bitrix24Id: matches[0].bitrix24Id, moyskladId: matches[0].moyskladId };
}

function readDictionaryField(
  bitrix24: RecordValue,
  moysklad: RecordValue,
  rule: Rule,
  dictionary: DictionaryReference,
  side: 'BITRIX24' | 'MOYSKLAD',
): { supported: true; value: number | null } | { supported: false } {
  const raw = side === 'BITRIX24'
    ? bitrix24[rule.sourceField]
    : readDictionaryAttribute(moysklad, dictionary.moyskladAttributeId, dictionary.moyskladDirectoryId);
  if (side === 'MOYSKLAD' && raw === undefined) return { supported: false };
  if (raw === undefined || raw === null || raw === '') return { supported: true, value: null };
  const value = side === 'BITRIX24' ? readSingleIblockId(raw) : raw;
  const mapped = resolveDictionaryValue(dictionary, side, value);
  return mapped.status === 'MAPPED' ? { supported: true, value: mapped.bitrix24Id } : { supported: false };
}

function readSingleIblockId(value: unknown): number | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : '';
  return /^\d{1,10}$/.test(text) ? Number(text) : null;
}

function readDictionaryAttribute(record: RecordValue, attributeId: string, directoryId: string): string | null | undefined {
  const attributes = Array.isArray(record.attributes) ? record.attributes : [];
  const item = attributes.find((candidate) => isRecord(candidate) && (candidate.id === attributeId || attributeIdFromValue(candidate) === attributeId));
  if (!isRecord(item) || item.value === null || item.value === undefined) return null;
  if (!isRecord(item.value) || !isRecord(item.value.meta) || typeof item.value.meta.href !== 'string') return undefined;
  const base = externalBase(process.env.MOYSKLAD_API_BASE_URL);
  try {
    const href = new URL(item.value.meta.href);
    const apiPath = base.pathname.replace(/\/$/, '');
    const escapedApiPath = apiPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const path = `${escapedApiPath}/entity/customentity/${directoryId}/([0-9a-f-]{36})`;
    const match = href.pathname.match(new RegExp(`^${path}$`, 'i'));
    if (href.origin !== base.origin || !match || item.value.meta.type !== 'customentity') return undefined;
    return match[1];
  } catch { return undefined; }
}

function attributeIdFromValue(value: RecordValue): string | null {
  const href = isRecord(value.meta) && typeof value.meta.href === 'string' ? value.meta.href : '';
  return href.match(/\/metadata\/attributes\/([0-9a-f-]{36})(?:\?.*)?$/i)?.[1] ?? null;
}

async function writeMoySkladDictionaryAttribute(orderId: string, dictionary: DictionaryReference, valueId: string | null) {
  const base = externalBase(process.env.MOYSKLAD_API_BASE_URL);
  const token = process.env.MOYSKLAD_API_TOKEN;
  if (!token) throw new Error('external token missing');
  const value = valueId === null ? null : { meta: {
    href: new URL(`entity/customentity/${encodeURIComponent(dictionary.moyskladDirectoryId)}/${encodeURIComponent(valueId)}`, base).href,
    type: 'customentity', mediaType: 'application/json',
  } };
  const url = new URL(`entity/customerorder/${encodeURIComponent(orderId)}`, base);
  const response = await fetch(url, {
    method: 'PUT', headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ attributes: [{ meta: { href: new URL(`entity/customerorder/metadata/attributes/${dictionary.moyskladAttributeId}`, base).href, type: 'attributemetadata', mediaType: 'application/json' }, value }] }),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('MySklad dictionary update failed');
}
function attributeId(value: RecordValue): string | null {
  const href = isRecord(value.meta) && typeof value.meta.href === 'string' ? value.meta.href : '';
  return href.match(/\/metadata\/attributes\/([0-9a-f-]{36})(?:\?.*)?$/i)?.[1] ?? null;
}
function externalBase(value: string | undefined): URL {
  if (!value) throw new Error('external base not configured');
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid external base');
  if (!url.href.endsWith('/')) url.pathname += '/';
  return url;
}
function readConfiguredStage(
  record: RecordValue,
  stages: Array<{ bitrix24StageId: string; moyskladId: string; creationEnabled: boolean }>,
  side: 'BITRIX24' | 'MOYSKLAD',
): string | null {
  if (side === 'BITRIX24') {
    const id = typeof record.STAGE_ID === 'string' ? record.STAGE_ID : null;
    return id && stages.filter((stage) => stage.bitrix24StageId === id).length === 1 ? id : null;
  }
  const state = isRecord(record.state) ? record.state : null;
  const meta = state && isRecord(state.meta) ? state.meta : null;
  const href = meta && typeof meta.href === 'string' ? meta.href : null;
  if (!href || meta?.type !== 'state') return null;
  try {
    const target = new URL(href);
    const base = externalBase(process.env.MOYSKLAD_API_BASE_URL);
    const prefix = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
    const suffix = target.pathname.startsWith(`${prefix}/`) ? target.pathname.slice(prefix.length) : '';
    const match = suffix.match(/^\/entity\/customerorder\/metadata\/states\/([0-9a-f-]{36})$/i);
    const id = target.origin === base.origin ? match?.[1] ?? null : null;
    return id && stages.filter((stage) => stage.moyskladId === id).length === 1 ? id : null;
  } catch { return null; }
}
function jsonRecord(value: Prisma.JsonValue): RecordValue {
  return isRecord(value) ? { ...value } : {};
}
function sameJson(left: unknown, right: unknown): boolean {
  if ((left === null || left === '') && (right === null || right === '')) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}
function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

