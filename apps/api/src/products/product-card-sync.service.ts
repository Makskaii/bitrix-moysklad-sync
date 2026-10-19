import { isRetryableFailure, retryAtForFailure } from '../provider-failure';

export type ProductCardPair = {
  id: string;
  entityType: string;
  bitrix24Id: string;
  moyskladId: string;
  moyskladType?: string | null;
  active: boolean;
  source: string;
  reason: string | null;
  createdAt: Date;
};

export type ProductCardPrice = { priceId: string; typeId: string; value: number; currency: string; currencyRef?: Record<string, unknown> };
export type ProductCardSnapshot = {
  name: string | null;
  code?: string | null;
  detailText: string | null;
  unitId: string | null;
  prices: ProductCardPrice[];
  /** Primitive values only; complex references, files and collections stay on dedicated paths. */
  fields?: Record<string, string | number | boolean | null>;
  updatedAt: string | null;
};

export type ProductCardApi = {
  readBitrix24(id: string, kind?: 'product' | 'service'): Promise<ProductCardSnapshot>;
  readMoysklad(id: string, kind?: 'product' | 'service'): Promise<ProductCardSnapshot>;
  updateBitrix24(id: string, fields: Record<string, unknown>, kind?: 'product' | 'service'): Promise<void>;
  updateBitrix24Price(priceId: string, value: number, currency: string): Promise<void>;
  updateMoysklad(id: string, fields: Record<string, unknown>, kind?: 'product' | 'service'): Promise<void>;
};

export type ProductCardSyncState = { bitrix24Values: Record<string, unknown>; moyskladValues: Record<string, unknown> };
export type ProductCardStateStore = {
  read(pairId: string): Promise<ProductCardSyncState | null>;
  write(pairId: string, settingsVersion: number, state: ProductCardSyncState): Promise<void>;
};
export type ProductCardSettings = { rules: unknown[]; references: { units: unknown[]; priceTypes: unknown[] } };
export type ProductCardSyncResult =
  | { status: 'BASELINED' | 'UNCHANGED' | 'SYNCED'; changedFields: string[] }
  | { status: 'SKIPPED_DISABLED' | 'SKIPPED_DIRECTION_DISABLED' | 'DEFERRED_PAUSE'; reason: string; changedFields: [] }
  | { status: 'MANUAL_REVIEW'; reason: string; changedFields: string[] }
  | { status: 'RETRYABLE_FAILURE'; reason: string; changedFields: string[]; retryAfter?: Date };

type Side = 'BITRIX24' | 'MOYSKLAD';
type FieldRule = { source: string; target: string; bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean };
type Direction = {
  target: Side;
  value: unknown;
  field: string;
  bitrix24Key?: string;
  moyskladKey?: string;
  bitrix24Field?: string;
  moyskladField?: string;
};

export class ProductCardManualReviewError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

export class ProductCardLeaseError extends Error {
  constructor(readonly reason: 'PRODUCT_PAIR_LOCK_LOST' | 'PRODUCT_PAIR_LOCK_UNAVAILABLE') {
    super(reason);
  }
}

/** Reconciles one already-persisted PRODUCT pair. No candidate search or card creation occurs here. */
export class ProductCardSyncService {
  constructor(private readonly api: ProductCardApi, private readonly state: ProductCardStateStore) {}

  async sync(input: {
    pair: ProductCardPair;
    source: Side;
    settingsVersion: number;
    settings: ProductCardSettings;
    attempt?: number;
  }): Promise<ProductCardSyncResult> {
    const { pair, settings, settingsVersion } = input;
    if (input.source === 'BITRIX24') return { status: 'SKIPPED_DIRECTION_DISABLED', reason: 'PRODUCT_DIRECTION_DISABLED', changedFields: [] };
    if (pair.entityType !== 'PRODUCT' || pair.active !== true) return review('PRODUCT_PAIR_NOT_ACTIVE');
    if (!Number.isInteger(settingsVersion) || settingsVersion < 1) return review('FIELD_SETTINGS_VERSION_INVALID');
    const rules = productRules(settings);
    if (!rules.name) return review('PRODUCT_NAME_MAPPING_MISSING');

    let bitrix24: ProductCardSnapshot;
    let moysklad: ProductCardSnapshot;
    let previous: ProductCardSyncState | null;
    try {
      [bitrix24, moysklad, previous] = await Promise.all([
        this.api.readBitrix24(pair.bitrix24Id, pair.moyskladType === 'service' ? 'service' : 'product'),
        this.api.readMoysklad(pair.moyskladId, pair.moyskladType === 'service' ? 'service' : 'product'),
        this.state.read(pair.id),
      ]);
    } catch (error) {
      if (error instanceof ProductCardLeaseError || isRuntimeGateError(error)) throw error;
      return error instanceof ProductCardManualReviewError ? review(error.reason) : isRetryableFailure(error)
        ? retry('PRODUCT_CARD_READ_FAILED', [], retryAtForFailure(error, input.attempt ?? 1)) : review('PRODUCT_PROVIDER_REJECTED');
    }
    if (!nonEmpty(bitrix24.name) || !nonEmpty(moysklad.name)) return review('PRODUCT_NAME_VALUE_MISSING');

    const current = snapshotValues(bitrix24, moysklad, settings);
    if (!previous) {
      try {
        await this.state.write(pair.id, settingsVersion, current);
        return { status: 'BASELINED', changedFields: [] };
      } catch (error) {
        if (error instanceof ProductCardLeaseError || isRuntimeGateError(error)) throw error;
        return retry('PRODUCT_CARD_STATE_WRITE_FAILED');
      }
    }

    const next = cloneState(previous);
    const changedFields: string[] = [];
    const criticalReasons: string[] = [];
    const optionalReasons: string[] = [];
    let directions: Direction[];
    let priceDirections: Direction[] = [];
    try {
      const name = chooseField('name', bitrix24.name, moysklad.name,
        previous.bitrix24Values.name, previous.moyskladValues.name, rules.name, true);
      const description = rules.description ? chooseField('description', bitrix24.detailText, moysklad.detailText,
        previous.bitrix24Values.description, previous.moyskladValues.description, rules.description, false) : null;
      const code = rules.code ? chooseField('code', bitrix24.code, moysklad.code,
        previous.bitrix24Values.code, previous.moyskladValues.code, rules.code, false) : null;
      const unit = chooseUnit(bitrix24.unitId, moysklad.unitId,
        previous.bitrix24Values.unitId, previous.moyskladValues.unitId, settings.references.units);
      const generic = rules.fields.flatMap((rule) => {
        if (!rule.moyskladToBitrix24 || isDedicatedFieldRule(rule)) return [];
        const mapped = chooseMappedScalar(
          rule,
          bitrix24.fields?.[rule.source],
          moysklad.fields?.[rule.target],
          record(previous.bitrix24Values.fields) ? previous.bitrix24Values.fields[rule.source] : undefined,
          record(previous.moyskladValues.fields) ? previous.moyskladValues.fields[rule.target] : undefined,
        );
        return mapped ? [mapped] : [];
      });
      directions = [name, description, code, unit, ...generic].filter((value): value is Direction => value !== null);
    } catch (error) {
      return review(error instanceof ProductCardManualReviewError ? error.reason : 'PRODUCT_CARD_FIELD_UNAVAILABLE');
    }
    try {
      priceDirections = choosePrices(bitrix24.prices, moysklad.prices,
        previous.bitrix24Values.prices, previous.moyskladValues.prices, settings.references.priceTypes);
    } catch (error) {
      optionalReasons.push(error instanceof ProductCardManualReviewError ? error.reason : 'PRODUCT_PRICE_FIELD_UNAVAILABLE');
    }
    directions.push(...priceDirections);

    for (const direction of directions) {
      let verified = false;
      try {
        await this.apply(direction, pair, bitrix24, moysklad, rules, settings);
        const actual = await this.readTarget(direction.target, pair, direction.field, direction);
        if (!sameDirectionValue(direction.field, actual, direction.value)) throw new Error('PRODUCT_CARD_READBACK_MISMATCH');
        verified = true;
      } catch (error) {
        if (error instanceof ProductCardLeaseError || isRuntimeGateError(error)) throw error;
        if (error instanceof ProductCardManualReviewError) {
          const optional = direction.field === 'description' || direction.field.startsWith('price:');
          (optional ? optionalReasons : criticalReasons).push(error.reason);
          if (!optional) break;
          continue;
        }
        if (!isRetryableFailure(error)) return review('PRODUCT_PROVIDER_REJECTED', changedFields);

        // A transport error does not prove that the vendor rejected an absolute update.
        // Read the target again before committing state; never blindly replay a write.
        try {
          const actual = await this.readTarget(direction.target, pair, direction.field, direction);
          verified = sameDirectionValue(direction.field, actual, direction.value);
        } catch (readError) {
          if (readError instanceof ProductCardLeaseError) throw readError;
        }
        if (!verified) {
          return retry('PRODUCT_CARD_WRITE_OUTCOME_PENDING', changedFields, retryAtForFailure(error, input.attempt ?? 1));
        }
      }

      if (verified) {
        try {
          setState(next, direction, 'BITRIX24', direction.bitrix24Key,
            direction.target === 'BITRIX24' ? normalizeDirectionState(direction.field, direction.value) : readField(bitrix24, direction.field, direction));
          setState(next, direction, 'MOYSKLAD', direction.moyskladKey,
            direction.target === 'MOYSKLAD' ? direction.value : readField(moysklad, direction.field, direction));
          await this.state.write(pair.id, settingsVersion, next);
          changedFields.push(direction.field);
        } catch (error) {
          if (error instanceof ProductCardLeaseError || isRuntimeGateError(error)) throw error;
          return retry('PRODUCT_CARD_STATE_WRITE_FAILED', changedFields);
        }
      }
    }

    if (criticalReasons.length) return review(criticalReasons[0], changedFields);
    if (optionalReasons.length) return review(optionalReasons[0], changedFields);
    if (!directions.length) return { status: 'UNCHANGED', changedFields: [] };
    return { status: changedFields.length ? 'SYNCED' : 'UNCHANGED', changedFields };
  }

  private async apply(
    direction: Direction,
    pair: ProductCardPair,
    bitrix24: ProductCardSnapshot,
    moysklad: ProductCardSnapshot,
    rules: ProductRules,
    settings: ProductCardSettings,
  ) {
    if (direction.field === 'name') {
      const kind = pair.moyskladType === 'service' ? 'service' : 'product';
      if (direction.target === 'MOYSKLAD') await this.api.updateMoysklad(pair.moyskladId, { name: direction.value }, kind);
      else await this.api.updateBitrix24(pair.bitrix24Id, { [rules.name!.source]: direction.value }, kind);
      return;
    }
    if (direction.field === 'description') {
      if (!rules.description) throw new ProductCardManualReviewError('PRODUCT_DESCRIPTION_MAPPING_MISSING');
      const kind = pair.moyskladType === 'service' ? 'service' : 'product';
      if (direction.target === 'MOYSKLAD') await this.api.updateMoysklad(pair.moyskladId, { description: direction.value }, kind);
      else await this.api.updateBitrix24(pair.bitrix24Id, { [rules.description.source]: direction.value }, kind);
      return;
    }
    if (direction.field === 'code') {
      if (!rules.code) throw new ProductCardManualReviewError('PRODUCT_CODE_MAPPING_MISSING');
      if (direction.target !== 'BITRIX24') throw new ProductCardManualReviewError('PRODUCT_CODE_DIRECTION_UNSUPPORTED');
      await this.api.updateBitrix24(pair.bitrix24Id, { code: direction.value }, pair.moyskladType === 'service' ? 'service' : 'product');
      return;
    }
    if (direction.field.startsWith('field:')) {
      if (direction.target !== 'BITRIX24' || !direction.bitrix24Field) {
        throw new ProductCardManualReviewError('PRODUCT_FIELD_DIRECTION_UNSUPPORTED');
      }
      if (!isWritableScalarField(direction.bitrix24Field) || !isScalarValue(direction.value)) {
        throw new ProductCardManualReviewError('PRODUCT_FIELD_UNSUPPORTED');
      }
      await this.api.updateBitrix24(pair.bitrix24Id, { [direction.bitrix24Field]: direction.value }, pair.moyskladType === 'service' ? 'service' : 'product');
      return;
    }
    if (direction.field === 'unit') {
      const unit = findUnit(settings.references.units, bitrix24.unitId, moysklad.unitId, direction.value, direction.target);
      if (!unit) throw new ProductCardManualReviewError('PRODUCT_UNIT_MAPPING_MISSING_OR_AMBIGUOUS');
      if (direction.target === 'MOYSKLAD') {
        await this.api.updateMoysklad(pair.moyskladId, { uom: { meta: {
          href: `https://api.moysklad.ru/api/remap/1.2/entity/uom/${unit.moyskladId}`,
          type: 'uom', mediaType: 'application/json',
        } } }, pair.moyskladType === 'service' ? 'service' : 'product');
      } else {
        await this.api.updateBitrix24(pair.bitrix24Id, { measure: unit.bitrix24Id }, pair.moyskladType === 'service' ? 'service' : 'product');
      }
      return;
    }
    if (direction.field.startsWith('price:')) {
      const b24Price = bitrix24.prices.find((price) => price.typeId === direction.bitrix24Key);
      const msPrice = moysklad.prices.find((price) => price.typeId === direction.moyskladKey);
      if (!b24Price || !msPrice) throw new ProductCardManualReviewError('PRODUCT_PRICE_TARGET_MISSING');
      if (!sameCurrency(b24Price.currency, msPrice.currency) || !msPrice.currencyRef) {
        throw new ProductCardManualReviewError('PRODUCT_PRICE_CURRENCY_UNVERIFIED_OR_MISMATCHED');
      }
      if (direction.target === 'BITRIX24') {
        await this.api.updateBitrix24Price(b24Price.priceId, Number(direction.value), b24Price.currency);
      } else {
        await this.api.updateMoysklad(pair.moyskladId, {
          // Remap exposes salePrices as an embedded collection. Re-read before
          // writing and include every current entry, preserving unpaired types.
          salePrices: moysklad.prices.map((price) => ({
            value: price.typeId === direction.moyskladKey ? direction.value : price.value,
            ...(price.currencyRef ? { currency: price.currencyRef } : {}),
            priceType: { meta: {
              href: `https://api.moysklad.ru/api/remap/1.2/context/companysettings/pricetype/${price.typeId}`,
              type: 'pricetype', mediaType: 'application/json',
            } },
          })),
        }, pair.moyskladType === 'service' ? 'service' : 'product');
        // A second configured price can be applied in this same pass. Keep
        // the local salePrices snapshot current so that its partial payload
        // cannot roll the first verified price back to the pre-pass value.
        const updated = moysklad.prices.find((price) => price.typeId === direction.moyskladKey);
        if (updated) updated.value = Number(direction.value);
      }
    }
  }

  private async readTarget(side: Side, pair: ProductCardPair, field: string, direction: Direction): Promise<unknown> {
    const snapshot = side === 'BITRIX24'
      ? await this.api.readBitrix24(pair.bitrix24Id, pair.moyskladType === 'service' ? 'service' : 'product')
      : await this.api.readMoysklad(pair.moyskladId, pair.moyskladType === 'service' ? 'service' : 'product');
    if (field === 'name') return snapshot.name;
    if (field === 'description') return snapshot.detailText;
    if (field === 'code') return snapshot.code;
    if (field === 'unit') return snapshot.unitId;
    if (field.startsWith('field:') && direction.bitrix24Field) return snapshot.fields?.[direction.bitrix24Field];
    const typeId = side === 'BITRIX24' ? direction.bitrix24Key : direction.moyskladKey;
    return snapshot.prices.find((price) => price.typeId === typeId)?.value;
  }
}

function isRuntimeGateError(error: unknown): error is Error & { productCardRuntimeGate: true } {
  return error instanceof Error && 'productCardRuntimeGate' in error;
}

type ProductRules = { name?: FieldRule; description?: FieldRule; code?: FieldRule; fields: FieldRule[] };

function productRules(settings: ProductCardSettings): ProductRules {
  const result: ProductRules = { fields: [] };
  for (const candidate of settings.rules) {
    if (!record(candidate) || candidate.entity !== 'catalog' || typeof candidate.sourceField !== 'string' || typeof candidate.targetField !== 'string') continue;
    if (candidate.sourceField === 'xmlId') continue; // reserved as ProductCatalogCreateService's recovery identity
    const forward = record(candidate.bitrix24ToMoysklad) ? candidate.bitrix24ToMoysklad : null;
    const reverse = record(candidate.moyskladToBitrix24) ? candidate.moyskladToBitrix24 : null;
    if ((forward?.enabled === true && record(forward.transform) && forward.transform.kind !== 'copy') ||
      (reverse?.enabled === true && record(reverse.transform) && reverse.transform.kind !== 'copy')) continue;
    const rule: FieldRule = {
      source: candidate.sourceField,
      target: candidate.targetField,
      bitrix24ToMoysklad: false,
      moyskladToBitrix24: reverse?.enabled === true,
    };
    if (candidate.sourceField === 'name' && candidate.targetField === 'name') result.name = rule;
    else if (candidate.sourceField === 'detailText' && candidate.targetField === 'description') result.description = rule;
    else if (candidate.sourceField === 'code' && candidate.targetField === 'code') result.code = rule;
    else result.fields.push(rule);
  }
  return result;
}

function isDedicatedFieldRule(rule: FieldRule) {
  return (rule.source === 'name' && rule.target === 'name') ||
    (rule.source === 'detailText' && rule.target === 'description') ||
    (rule.source === 'code' && rule.target === 'code') ||
    (rule.source === 'measure' && rule.target === 'uom');
}

function chooseMappedScalar(rule: FieldRule, b24: unknown, ms: unknown, oldB24: unknown, oldMs: unknown): Direction | null {
  if (b24 === undefined || ms === undefined || oldB24 === undefined || oldMs === undefined) return null;
  if (b24 === null || ms === null) return null;
  if (!isScalarValue(b24) || !isScalarValue(ms) || !sameScalarType(b24, ms)) return null;
  if (!isScalarValue(oldB24) || !isScalarValue(oldMs) || !sameScalarType(oldB24, oldMs)) return null;
  if (same(b24, ms) || same(b24, oldB24) && same(ms, oldMs)) return null;
  return {
    field: `field:${rule.source}:${rule.target}`,
    target: 'BITRIX24',
    value: ms,
    bitrix24Field: rule.source,
    moyskladField: rule.target,
  };
}

function sameScalarType(left: unknown, right: unknown) {
  if (left === null || right === null) return true;
  return typeof left === typeof right;
}

function isScalarValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean';
}

function isWritableScalarField(field: string) {
  const protectedFields = new Set([
    'id', 'meta', 'type', 'iblockId', 'iblockSection', 'iblockSectionId',
    'detailPicture', 'previewPicture', 'quantity', 'quantityReserved', 'quantityTrace',
    'available', 'active', 'xmlId', 'createdBy', 'modifiedBy', 'dateCreate', 'timestampX',
    'dateActiveFrom', 'dateActiveTo', 'priceType', 'purchasingPrice', 'purchasingCurrency',
  ]);
  return /^[A-Za-z][A-Za-z0-9]*$/.test(field) && !protectedFields.has(field);
}

function chooseField(field: string, b24: unknown, ms: unknown, oldB24: unknown, oldMs: unknown, rule: FieldRule, required: boolean): Direction | null {
  if (b24 === undefined || ms === undefined || oldB24 === undefined || oldMs === undefined) {
    if (required) throw new ProductCardManualReviewError(`PRODUCT_${field.toUpperCase()}_VALUE_UNAVAILABLE`);
    return null;
  }
  if (same(b24, ms)) return null;
  if (same(b24, oldB24) && same(ms, oldMs)) return null;
  return rule.moyskladToBitrix24 ? { field, target: 'BITRIX24', value: ms } : null;
}

function chooseUnit(b24: unknown, ms: unknown, oldB24: unknown, oldMs: unknown, mappings: unknown[]): Direction | null {
  // Unit is optional in both catalogs. Preserve a genuinely absent value instead of
  // treating it like a malformed provider ID; present but invalid IDs still fail closed.
  if (isAbsentUnit(b24) && isAbsentUnit(ms) && isAbsentUnit(oldB24) && isAbsentUnit(oldMs)) return null;
  if (b24 === undefined || ms === undefined || oldB24 === undefined || oldMs === undefined) {
    throw new ProductCardManualReviewError('PRODUCT_UNIT_VALUE_UNAVAILABLE');
  }
  if (!isValidBitrixUnitId(b24) || !isValidBitrixUnitId(oldB24) || typeof ms !== 'string' || !ms || typeof oldMs !== 'string' || !oldMs) {
    throw new ProductCardManualReviewError('PRODUCT_UNIT_VALUE_INVALID');
  }
  if (sameIdentifier(b24, oldB24) && same(ms, oldMs)) return null;
  const target: Side = 'BITRIX24';
  const row = mappings.filter((item) => record(item) && String(item.moyskladId) === ms && item.status === 'configured' && Number.isInteger(item.bitrix24Id) && Number(item.bitrix24Id) > 0);
  if (row.length !== 1 || !record(row[0])) throw new ProductCardManualReviewError('PRODUCT_UNIT_MAPPING_MISSING_OR_AMBIGUOUS');
  return { field: 'unit', target, value: row[0].bitrix24Id };
}

function isAbsentUnit(value: unknown): boolean {
  return value === null || value === undefined;
}

function sameDirectionValue(field: string, actual: unknown, expected: unknown): boolean {
  return field === 'unit' ? sameIdentifier(actual, expected) : same(actual, expected);
}

function normalizeDirectionState(field: string, value: unknown): unknown {
  return field === 'unit' ? normalizeUnitIdentifier(value) : value;
}

function isValidBitrixUnitId(value: unknown): boolean {
  return normalizeUnitIdentifier(value) !== null;
}

function normalizeUnitIdentifier(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value === 'string' && /^\d{1,20}$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0) return String(Number(value));
  return null;
}

function sameIdentifier(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeUnitIdentifier(left);
  const normalizedRight = normalizeUnitIdentifier(right);
  return normalizedLeft !== null && normalizedRight !== null ? normalizedLeft === normalizedRight : typeof left === 'string' && typeof right === 'string' && left === right;
}

function choosePrices(b24: ProductCardPrice[], ms: ProductCardPrice[], oldB24: unknown, oldMs: unknown, mappings: unknown[]): Direction[] {
  if (!Array.isArray(oldB24) || !Array.isArray(oldMs)) return [];
  const result: Direction[] = [];
  for (const mapping of mappings) {
    if (!record(mapping) || mapping.status !== 'configured' || !Number.isInteger(mapping.bitrix24Id) || typeof mapping.moyskladId !== 'string') continue;
    const b24Key = String(mapping.bitrix24Id);
    const msKey = mapping.moyskladId;
    const b24Price = b24.find((price) => price.typeId === b24Key);
    const msPrice = ms.find((price) => price.typeId === msKey);
    const previousB24 = (oldB24 as Record<string, unknown>[]).find((row) => row?.typeId === b24Key)?.value;
    const previousMs = (oldMs as Record<string, unknown>[]).find((row) => row?.typeId === msKey)?.value;
    if (!b24Price || !msPrice || previousB24 === undefined || previousMs === undefined) {
      throw new ProductCardManualReviewError('PRODUCT_PRICE_TARGET_MISSING');
    }
    if (!sameCurrency(b24Price.currency, msPrice.currency) || !msPrice.currencyRef) {
      throw new ProductCardManualReviewError('PRODUCT_PRICE_CURRENCY_UNVERIFIED_OR_MISMATCHED');
    }
    if (same(b24Price.value, msPrice.value)) continue;
    if (!same(b24Price.value, previousB24) || !same(msPrice.value, previousMs)) {
      result.push({ field: `price:${msKey}`, target: 'BITRIX24', value: msPrice.value, bitrix24Key: b24Key, moyskladKey: msKey });
    }
  }
  return result;
}

function findUnit(mappings: unknown[], b24: unknown, ms: unknown, value: unknown, target: Side) {
  const rows = mappings.filter((item) => record(item) && item.status === 'configured' &&
    String(item.bitrix24Id) === String(target === 'MOYSKLAD' ? b24 : value) &&
    String(item.moyskladId) === String(target === 'BITRIX24' ? ms : value));
  if (rows.length !== 1 || !record(rows[0])) return null;
  return { bitrix24Id: Number(rows[0].bitrix24Id), moyskladId: String(rows[0].moyskladId) };
}

function snapshotValues(b24: ProductCardSnapshot, ms: ProductCardSnapshot, settings: ProductCardSettings): ProductCardSyncState {
  const prices = settings.references.priceTypes.filter((item) => record(item) && item.status === 'configured' && typeof item.moyskladId === 'string');
  const rules = productRules(settings);
  return {
    bitrix24Values: {
      name: b24.name, description: b24.detailText, code: b24.code, unitId: b24.unitId,
      fields: Object.fromEntries(rules.fields.flatMap((rule) => isScalarValue(b24.fields?.[rule.source]) ? [[rule.source, b24.fields![rule.source]]] : [])),
      prices: prices.map((item) => {
        const typeId = String((item as Record<string, unknown>).bitrix24Id);
        return { typeId, value: b24.prices.find((price) => price.typeId === typeId)?.value };
      }),
    },
    moyskladValues: {
      name: ms.name, description: ms.detailText, code: ms.code, unitId: ms.unitId,
      fields: Object.fromEntries(rules.fields.flatMap((rule) => isScalarValue(ms.fields?.[rule.target]) ? [[rule.target, ms.fields![rule.target]]] : [])),
      prices: prices.map((item) => {
        const typeId = String((item as Record<string, unknown>).moyskladId);
        return { typeId, value: ms.prices.find((price) => price.typeId === typeId)?.value };
      }),
    },
  };
}

function setState(state: ProductCardSyncState, direction: Direction, side: Side, typeId: string | undefined, value: unknown) {
  const field = direction.field;
  const values = side === 'BITRIX24' ? state.bitrix24Values : state.moyskladValues;
  if (field.startsWith('price:')) {
    if (!typeId) return;
    const prices = Array.isArray(values.prices) ? values.prices as Record<string, unknown>[] : [];
    const row = prices.find((candidate) => candidate.typeId === typeId);
    if (row) row.value = value;
  } else if (field.startsWith('field:')) {
    if (!isScalarValue(value)) return;
    const key = side === 'BITRIX24' ? direction.bitrix24Field : direction.moyskladField;
    if (!key) return;
    const fields = record(values.fields) ? values.fields : {};
    fields[key] = value;
    values.fields = fields;
  } else {
    values[field === 'description' ? 'description' : field === 'unit' ? 'unitId' : field === 'code' ? 'code' : 'name'] = value;
  }
}

function readField(snapshot: ProductCardSnapshot, field: string, direction?: Direction): unknown {
  if (field === 'name') return snapshot.name;
  if (field === 'description') return snapshot.detailText;
  if (field === 'code') return snapshot.code;
  if (field === 'unit') return snapshot.unitId;
  if (field.startsWith('field:')) return direction?.moyskladField ? snapshot.fields?.[direction.moyskladField] : undefined;
  return undefined;
}
function cloneState(state: ProductCardSyncState): ProductCardSyncState { return structuredClone(state); }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function sameCurrency(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toUpperCase();
  const normalizedRight = right.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalizedLeft) && normalizedLeft === normalizedRight;
}
function record(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function review(reason: string, changedFields: string[] = []): ProductCardSyncResult { return { status: 'MANUAL_REVIEW', reason, changedFields }; }
function retry(reason: string, changedFields: string[] = [], retryAfter?: Date): ProductCardSyncResult {
  return { status: 'RETRYABLE_FAILURE', reason, changedFields, ...(retryAfter ? { retryAfter } : {}) };
}
