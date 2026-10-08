export type ProductCardPair = {
  id: string;
  entityType: string;
  bitrix24Id: string;
  moyskladId: string;
  active: boolean;
  source: string;
  reason: string | null;
  createdAt: Date;
};

export type ProductCardPrice = { priceId: string; typeId: string; value: number; currency: string; currencyRef?: Record<string, unknown> };
export type ProductCardSnapshot = {
  name: string | null;
  detailText: string | null;
  unitId: string | null;
  prices: ProductCardPrice[];
  updatedAt: string | null;
};

export type ProductCardApi = {
  readBitrix24(id: string): Promise<ProductCardSnapshot>;
  readMoysklad(id: string): Promise<ProductCardSnapshot>;
  updateBitrix24(id: string, fields: Record<string, unknown>): Promise<void>;
  updateBitrix24Price(priceId: string, value: number, currency: string): Promise<void>;
  updateMoysklad(id: string, fields: Record<string, unknown>): Promise<void>;
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
  | { status: 'RETRYABLE_FAILURE'; reason: string; changedFields: string[] };

type Side = 'BITRIX24' | 'MOYSKLAD';
type FieldRule = { source: string; target: string; bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean };
type Direction = {
  target: Side;
  value: unknown;
  field: string;
  bitrix24Key?: string;
  moyskladKey?: string;
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
  }): Promise<ProductCardSyncResult> {
    const { pair, settings, settingsVersion } = input;
    if (pair.entityType !== 'PRODUCT' || pair.active !== true) return review('PRODUCT_PAIR_NOT_ACTIVE');
    if (!Number.isInteger(settingsVersion) || settingsVersion < 1) return review('FIELD_SETTINGS_VERSION_INVALID');
    const rules = productRules(settings);
    if (!rules.name) return review('PRODUCT_NAME_MAPPING_MISSING');

    let bitrix24: ProductCardSnapshot;
    let moysklad: ProductCardSnapshot;
    let previous: ProductCardSyncState | null;
    try {
      [bitrix24, moysklad, previous] = await Promise.all([
        this.api.readBitrix24(pair.bitrix24Id),
        this.api.readMoysklad(pair.moyskladId),
        this.state.read(pair.id),
      ]);
    } catch (error) {
      if (error instanceof ProductCardLeaseError) throw error;
      return error instanceof ProductCardManualReviewError ? review(error.reason) : retry('PRODUCT_CARD_READ_FAILED');
    }
    if (!nonEmpty(bitrix24.name) || !nonEmpty(moysklad.name)) return review('PRODUCT_NAME_VALUE_MISSING');

    const current = snapshotValues(bitrix24, moysklad, settings);
    if (!previous) {
      try {
        await this.state.write(pair.id, settingsVersion, current);
        return { status: 'BASELINED', changedFields: [] };
      } catch (error) {
        if (error instanceof ProductCardLeaseError) throw error;
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
      const unit = chooseUnit(bitrix24.unitId, moysklad.unitId,
        previous.bitrix24Values.unitId, previous.moyskladValues.unitId, settings.references.units);
      directions = [name, description, unit].filter((value): value is Direction => value !== null);
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
      try {
        await this.apply(direction, pair, bitrix24, moysklad, rules, settings);
        const actual = await this.readTarget(direction.target, pair, direction.field, direction);
        if (!same(actual, direction.value)) throw new Error('PRODUCT_CARD_READBACK_MISMATCH');
        setState(next, direction.field, 'BITRIX24', direction.bitrix24Key,
          direction.target === 'BITRIX24' ? direction.value : readField(bitrix24, direction.field));
        setState(next, direction.field, 'MOYSKLAD', direction.moyskladKey,
          direction.target === 'MOYSKLAD' ? direction.value : readField(moysklad, direction.field));
        await this.state.write(pair.id, settingsVersion, next);
        changedFields.push(direction.field);
      } catch (error) {
        if (error instanceof ProductCardLeaseError) throw error;
        const reason = error instanceof ProductCardManualReviewError ? error.reason : 'PRODUCT_CARD_WRITE_OR_READBACK_FAILED';
        const optional = direction.field === 'description' || direction.field.startsWith('price:');
        (optional ? optionalReasons : criticalReasons).push(reason);
        if (!optional) break;
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
    rules: { name?: FieldRule; description?: FieldRule },
    settings: ProductCardSettings,
  ) {
    if (direction.field === 'name') {
      if (direction.target === 'MOYSKLAD') await this.api.updateMoysklad(pair.moyskladId, { name: direction.value });
      else await this.api.updateBitrix24(pair.bitrix24Id, { [rules.name!.source]: direction.value });
      return;
    }
    if (direction.field === 'description') {
      if (!rules.description) throw new ProductCardManualReviewError('PRODUCT_DESCRIPTION_MAPPING_MISSING');
      if (direction.target === 'MOYSKLAD') await this.api.updateMoysklad(pair.moyskladId, { description: direction.value });
      else await this.api.updateBitrix24(pair.bitrix24Id, { [rules.description.source]: direction.value });
      return;
    }
    if (direction.field === 'unit') {
      const unit = findUnit(settings.references.units, bitrix24.unitId, moysklad.unitId, direction.value, direction.target);
      if (!unit) throw new ProductCardManualReviewError('PRODUCT_UNIT_MAPPING_MISSING_OR_AMBIGUOUS');
      if (direction.target === 'MOYSKLAD') {
        await this.api.updateMoysklad(pair.moyskladId, { uom: { meta: {
          href: `https://api.moysklad.ru/api/remap/1.2/entity/uom/${unit.moyskladId}`,
          type: 'uom', mediaType: 'application/json',
        } } });
      } else {
        await this.api.updateBitrix24(pair.bitrix24Id, { measure: unit.bitrix24Id });
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
        });
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
      ? await this.api.readBitrix24(pair.bitrix24Id)
      : await this.api.readMoysklad(pair.moyskladId);
    if (field === 'name') return snapshot.name;
    if (field === 'description') return snapshot.detailText;
    if (field === 'unit') return snapshot.unitId;
    const typeId = side === 'BITRIX24' ? direction.bitrix24Key : direction.moyskladKey;
    return snapshot.prices.find((price) => price.typeId === typeId)?.value;
  }
}

function productRules(settings: ProductCardSettings): { name?: FieldRule; description?: FieldRule } {
  const result: { name?: FieldRule; description?: FieldRule } = {};
  for (const candidate of settings.rules) {
    if (!record(candidate) || candidate.entity !== 'catalog' || typeof candidate.sourceField !== 'string' || typeof candidate.targetField !== 'string') continue;
    const forward = record(candidate.bitrix24ToMoysklad) ? candidate.bitrix24ToMoysklad : null;
    const reverse = record(candidate.moyskladToBitrix24) ? candidate.moyskladToBitrix24 : null;
    if ((forward && record(forward.transform) && forward.transform.kind !== 'copy') ||
      (reverse && record(reverse.transform) && reverse.transform.kind !== 'copy')) continue;
    const rule: FieldRule = {
      source: candidate.sourceField,
      target: candidate.targetField,
      bitrix24ToMoysklad: forward?.enabled === true,
      moyskladToBitrix24: reverse?.enabled === true,
    };
    if (candidate.sourceField === 'name' && candidate.targetField === 'name') result.name = rule;
    if (candidate.sourceField === 'detailText' && candidate.targetField === 'description') result.description = rule;
  }
  return result;
}

function chooseField(field: string, b24: unknown, ms: unknown, oldB24: unknown, oldMs: unknown, rule: FieldRule, required: boolean): Direction | null {
  if (b24 === undefined || ms === undefined || oldB24 === undefined || oldMs === undefined) {
    if (required) throw new ProductCardManualReviewError(`PRODUCT_${field.toUpperCase()}_VALUE_UNAVAILABLE`);
    return null;
  }
  if (same(b24, ms)) return null;
  const b24Changed = !same(b24, oldB24);
  const msChanged = !same(ms, oldMs);
  if (!b24Changed && !msChanged) return null;
  if (msChanged) return rule.moyskladToBitrix24 ? { field, target: 'BITRIX24', value: ms } : null;
  return rule.bitrix24ToMoysklad ? { field, target: 'MOYSKLAD', value: b24 } : null;
}

function chooseUnit(b24: unknown, ms: unknown, oldB24: unknown, oldMs: unknown, mappings: unknown[]): Direction | null {
  if (same(b24, ms)) return null;
  if (b24 === undefined || ms === undefined || oldB24 === undefined || oldMs === undefined) {
    throw new ProductCardManualReviewError('PRODUCT_UNIT_VALUE_UNAVAILABLE');
  }
  const b24Changed = !same(b24, oldB24);
  const msChanged = !same(ms, oldMs);
  if (!b24Changed && !msChanged) return null;
  const target: Side = msChanged ? 'BITRIX24' : 'MOYSKLAD';
  const row = target === 'MOYSKLAD'
    ? mappings.filter((item) => record(item) && String(item.bitrix24Id) === String(b24) && item.status === 'configured' && typeof item.moyskladId === 'string')
    : mappings.filter((item) => record(item) && String(item.moyskladId) === String(ms) && item.status === 'configured' && Number.isInteger(item.bitrix24Id));
  if (row.length !== 1 || !record(row[0])) throw new ProductCardManualReviewError('PRODUCT_UNIT_MAPPING_MISSING_OR_AMBIGUOUS');
  return { field: 'unit', target, value: target === 'MOYSKLAD' ? row[0].moyskladId : row[0].bitrix24Id };
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
    const b24Changed = !same(b24Price.value, previousB24);
    const msChanged = !same(msPrice.value, previousMs);
    if (msChanged) result.push({ field: `price:${msKey}`, target: 'BITRIX24', value: msPrice.value, bitrix24Key: b24Key, moyskladKey: msKey });
    else if (b24Changed) result.push({ field: `price:${msKey}`, target: 'MOYSKLAD', value: b24Price.value, bitrix24Key: b24Key, moyskladKey: msKey });
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
  return {
    bitrix24Values: {
      name: b24.name, description: b24.detailText, unitId: b24.unitId,
      prices: prices.map((item) => {
        const typeId = String((item as Record<string, unknown>).bitrix24Id);
        return { typeId, value: b24.prices.find((price) => price.typeId === typeId)?.value };
      }),
    },
    moyskladValues: {
      name: ms.name, description: ms.detailText, unitId: ms.unitId,
      prices: prices.map((item) => {
        const typeId = String((item as Record<string, unknown>).moyskladId);
        return { typeId, value: ms.prices.find((price) => price.typeId === typeId)?.value };
      }),
    },
  };
}

function setState(state: ProductCardSyncState, field: string, side: Side, typeId: string | undefined, value: unknown) {
  const values = side === 'BITRIX24' ? state.bitrix24Values : state.moyskladValues;
  if (field.startsWith('price:')) {
    if (!typeId) return;
    const prices = Array.isArray(values.prices) ? values.prices as Record<string, unknown>[] : [];
    const row = prices.find((candidate) => candidate.typeId === typeId);
    if (row) row.value = value;
  } else {
    values[field === 'description' ? 'description' : field === 'unit' ? 'unitId' : 'name'] = value;
  }
}

function readField(snapshot: ProductCardSnapshot, field: string): unknown {
  if (field === 'name') return snapshot.name;
  if (field === 'description') return snapshot.detailText;
  if (field === 'unit') return snapshot.unitId;
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
function retry(reason: string): ProductCardSyncResult { return { status: 'RETRYABLE_FAILURE', reason, changedFields: [] }; }
