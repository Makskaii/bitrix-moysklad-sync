import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database.service';
import { lockEntityPairState } from '../pairs/pair-db-lock';
import { writeOperationalLog } from '../monitoring-log';
import { VersionedFieldSettingsDto } from '../field-settings/field-settings.dto';
import { SyncModeService } from '../sync-mode.service';
import { assertApplyExternalWrite } from '../external-write-guard';
import { ControlledLiveTestAdmissionService } from '../controlled-live-test-admission.service';
import { bitrixProductDescription, ProductDescriptionEncodingError } from './bitrix-product-description';

type Row = Record<string, any>;
type ProductCreateInput = {
  productId: string;
  product: Row;
  moyskladType?: 'product' | 'service';
  eventId: string;
  eventConfig: VersionedFieldSettingsDto;
  bitrix24MeasureId?: number;
  prices?: Array<{ catalogGroupId: number; value: number; currency: string }>;
  writeGate?: 'PRODUCT_CATALOG' | 'DEAL_ORDER';
  assertPairLease?: () => Promise<boolean>;
  writePair?: { id: string; entityType: string };
};

export class ProductCatalogManualReviewError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

export type ProductImportEcho = { status: 'NONE' } | { status: 'WAIT'; moyskladProductId: string; originEventId: string } |
  { status: 'PAIR'; pairId: string; moyskladProductId: string; originEventId: string };

/** Durable MS→B24 product creation shared by catalog events and deal prerequisites. */
@Injectable()
export class ProductCatalogCreateService {
  constructor(private readonly database: DatabaseService, private readonly mode: SyncModeService, @Optional() private readonly controlledAdmission?: ControlledLiveTestAdmissionService) {}

  /** Read-only provenance check. Never creates a pair or completes the importing
   * operation; only its original leased worker can do that after prices/readback.
   */
  async inspectCreateEcho(input: { targetId: string; kind: 'product' | 'service'; card: Row; receivedAt: Date },
    exactTargets: (catalogId: string, xmlId: string, kind: 'product' | 'service') => Promise<string[]>): Promise<ProductImportEcho> {
    const marker = typeof input.card.xmlId === 'string' ? /^MOYSKLAD_(PRODUCT|SERVICE)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(input.card.xmlId) : null;
    const operations = await this.database.dealOrderReverseProductOperation.findMany({ where: { OR: [
      { bitrix24ProductId: input.targetId }, ...(marker ? [{ moyskladProductId: marker[2] }] : []),
    ] }, take: 2 });
    if (!operations.length && !marker) return { status: 'NONE' };
    if (operations.length !== 1) throw new ProductCatalogManualReviewError(operations.length ? 'PRODUCT_IMPORT_ECHO_AMBIGUOUS' : 'PRODUCT_IMPORT_ECHO_IDENTITY_UNPROVEN');
    const operation = operations[0]!;
    const frozen: Row = isRecord(operation.payload) ? operation.payload as Row : {};
    const expected = isRecord(frozen.fields) ? frozen.fields : {};
    const xmlId = `MOYSKLAD_${input.kind.toUpperCase()}_${operation.moyskladProductId}`;
    const uuid = isRecord(input.card.property108) ? input.card.property108.value : input.card.property108;
    if (!marker || marker[1].toLowerCase() !== input.kind || marker[2] !== operation.moyskladProductId ||
      frozen.kind !== input.kind || frozen.xmlId !== xmlId || expected.xmlId !== xmlId || frozen.catalogId !== operation.bitrix24CatalogId ||
      String(expected.iblockId) !== operation.bitrix24CatalogId || String(input.card.iblockId) !== operation.bitrix24CatalogId ||
      input.card.xmlId !== xmlId || uuid !== operation.moyskladProductId || (isRecord(expected.property108) ? expected.property108.value : null) !== uuid ||
      String(input.card.id) !== input.targetId || Number(input.card.type) !== (input.kind === 'service' ? 7 : 1) ||
      operation.bitrix24ProductId !== null && operation.bitrix24ProductId !== input.targetId ||
      !operation.attemptedAt || operation.attemptedAt > input.receivedAt || operation.createdAt > input.receivedAt) {
      throw new ProductCatalogManualReviewError('PRODUCT_IMPORT_ECHO_IDENTITY_MISMATCH');
    }
    const origin = await this.database.inboundEvent.findUnique({ where: { id: operation.eventId },
      select: { id: true, source: true, eventType: true, externalEntityType: true, externalEntityId: true, status: true } });
    // Document-origin operations are outside this catalog-echo contract.
    if (origin?.source === 'MOYSKLAD' && origin.externalEntityType === 'customerorder') return { status: 'NONE' };
    if (!origin || origin.source !== 'MOYSKLAD' || origin.eventType !== 'CREATE' || origin.externalEntityType !== input.kind || origin.externalEntityId !== operation.moyskladProductId) {
      throw new ProductCatalogManualReviewError('PRODUCT_IMPORT_ECHO_ORIGIN_UNPROVEN');
    }
    const targets = await exactTargets(operation.bitrix24CatalogId, xmlId, input.kind);
    if (targets.length !== 1 || targets[0] !== input.targetId) throw new ProductCatalogManualReviewError('PRODUCT_IMPORT_ECHO_AMBIGUOUS');
    // Provider reads can overlap the original worker's pair commit. Re-read the
    // operation, origin and pair in ONE snapshot, never mix pre/post commit rows.
    const stable = await this.database.$transaction(async transaction => {
      const current = await transaction.dealOrderReverseProductOperation.findUnique({ where: { moyskladProductId: operation.moyskladProductId } });
      const currentOrigin = await transaction.inboundEvent.findUnique({ where: { id: operation.eventId }, select: { status: true } });
      const pairs = await transaction.entityPair.findMany({ where: { entityType: 'PRODUCT', OR: [
        { bitrix24Id: input.targetId }, { moyskladId: operation.moyskladProductId },
      ] }, take: 2 });
      return { current, currentOrigin, pairs };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const { current, currentOrigin, pairs } = stable;
    if (!current || current.syncId !== operation.syncId || JSON.stringify(current.payload) !== JSON.stringify(operation.payload) ||
        current.bitrix24ProductId !== null && current.bitrix24ProductId !== input.targetId) throw new ProductCatalogManualReviewError('PRODUCT_IMPORT_ECHO_IDENTITY_MISMATCH');
    if (pairs.length > 1 || pairs.some(pair => !pair.active || pair.bitrix24Id !== input.targetId || pair.moyskladId !== operation.moyskladProductId || pair.moyskladType !== input.kind)) {
      throw new ProductCatalogManualReviewError('PRODUCT_IMPORT_ECHO_PAIR_CONFLICT');
    }
    if (current.status === 'SUCCEEDED') {
      if (current.bitrix24ProductId !== input.targetId || pairs.length !== 1) throw new ProductCatalogManualReviewError('PRODUCT_IMPORT_ECHO_PAIR_NOT_ACTIVE');
      return { status: 'PAIR', pairId: pairs[0]!.id, moyskladProductId: operation.moyskladProductId, originEventId: origin.id };
    }
    if (current.status !== 'PENDING' || !currentOrigin || !['RECEIVED', 'PROCESSING', 'RETRYABLE_FAILURE', 'DEFERRED_PAUSE'].includes(currentOrigin.status)) {
      throw new ProductCatalogManualReviewError('PRODUCT_IMPORT_ECHO_CREATE_NOT_PENDING');
    }
    if (!readbackMatches(input.card, expected, input.kind)) throw new ProductCatalogManualReviewError('PRODUCT_IMPORT_ECHO_CREATE_MISMATCH');
    return { status: 'WAIT', moyskladProductId: operation.moyskladProductId, originEventId: origin.id };
  }

  async createOrRecover(input: ProductCreateInput): Promise<string> {
    const kind = input.moyskladType ?? 'product';
    const runtime = input.eventConfig.config.dealOrderRuntime;
    const productSettings = input.eventConfig.config.productCatalogRuntime;
    const catalogId = productSettings?.bitrix24CatalogId ?? runtime?.bitrix24ProductCatalogId;
    const allowedFields = productSettings?.moyskladFields ?? runtime?.moyskladProductFields;
    if (!catalogId || !/^\d+$/.test(catalogId) || !allowedFields?.includes('name')) {
      throw new ProductCatalogManualReviewError('PRODUCT_CREATE_CATALOG_OR_NAME_NOT_CONFIGURED');
    }
    if (!isRecord(input.product.meta) || input.product.meta.type !== kind || input.product.id !== input.productId || typeof input.product.name !== 'string' || !input.product.name.trim()) {
      throw new ProductCatalogManualReviewError('PRODUCT_CREATE_SOURCE_INVALID');
    }
    const xmlId = `MOYSKLAD_${kind.toUpperCase()}_${input.productId}`;
    const fields: Row = { iblockId: Number(catalogId), active: 'Y', xmlId, property108: { value: input.productId }, name: input.product.name.trim() };
    if (input.bitrix24MeasureId !== undefined) fields.measure = input.bitrix24MeasureId;
    const defaultSectionId = productSettings?.bitrix24DefaultSectionId ?? runtime?.bitrix24DefaultProductSectionId;
    if (defaultSectionId) {
      if (!/^\d+$/.test(defaultSectionId)) throw new ProductCatalogManualReviewError('PRODUCT_CREATE_SECTION_INVALID');
      fields.iblockSectionId = Number(defaultSectionId);
    }
    if (allowedFields.includes('code') && typeof input.product.code === 'string' && input.product.code.trim()) fields.code = input.product.code.trim();
    if (allowedFields.includes('description') && typeof input.product.description === 'string' && input.product.description.trim()) fields.detailText = input.product.description;
    for (const rule of configuredCatalogCreateRules(input.eventConfig.config.rules, input.product)) {
      if (['name', 'iblockId', 'active', 'xmlId', 'property108', 'measure', 'detailPicture', 'previewPicture', 'iblockSection', 'iblockSectionId'].includes(rule.bitrix24Field)) continue;
      fields[rule.bitrix24Field] = rule.value;
    }
    if (typeof fields.detailText === 'string') {
      try { fields.detailText = bitrixProductDescription(fields.detailText); }
      catch (error) {
        if (error instanceof ProductDescriptionEncodingError) throw new ProductCatalogManualReviewError(error.reason);
        throw error;
      }
      // An emoji-only optional description is absent; identity/prices/pair
      // creation still complete. Freeze only the approved provider projection.
      if (fields.detailText === '') delete fields.detailText;
      else fields.detailTextType = 'text';
    }
    await assertCatalogCreateFieldsWritable(catalogId, kind, fields);
    const prices = input.prices ?? [];
    if (!Array.isArray(prices) || prices.some((price) => !Number.isInteger(price.catalogGroupId) || price.catalogGroupId < 1 || !Number.isFinite(price.value) || price.value < 0 || !/^[A-Z]{3}$/.test(price.currency))) {
      throw new ProductCatalogManualReviewError('PRODUCT_CREATE_PRICE_MAPPING_INVALID');
    }
    const payload = { fields, xmlId, catalogId, prices, kind };

    let operation = await this.database.dealOrderReverseProductOperation.findUnique({ where: { moyskladProductId: input.productId } });
    if (!operation) {
      try {
        operation = await this.database.dealOrderReverseProductOperation.create({
          data: { moyskladProductId: input.productId, syncId: randomUUID(), eventId: input.eventId, settingsVersion: input.eventConfig.version, bitrix24CatalogId: catalogId, payload: payload as Prisma.InputJsonValue },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        operation = await this.database.dealOrderReverseProductOperation.findUniqueOrThrow({ where: { moyskladProductId: input.productId } });
      }
    }
    if (operation.bitrix24CatalogId !== catalogId) throw new ProductCatalogManualReviewError('PRODUCT_CREATE_CATALOG_CHANGED');
    const frozen: Row | null = isRecord(operation.payload) ? operation.payload as unknown as Row : null;
    if (!frozen || !isRecord(frozen.fields) || frozen.xmlId !== xmlId) throw new ProductCatalogManualReviewError('PRODUCT_CREATE_JOURNAL_INVALID');
    if (operation.status === 'SUCCEEDED' && operation.bitrix24ProductId) {
      await this.persistPair(input.productId, operation.bitrix24ProductId, operation.leaseToken ?? '', input.eventId, kind);
      return operation.bitrix24ProductId;
    }
    if (operation.status !== 'PENDING') throw new ProductCatalogManualReviewError('PRODUCT_CREATE_OPERATION_NOT_PENDING');
    const leaseToken = randomUUID();
    const now = new Date();
    const claimed = await this.database.dealOrderReverseProductOperation.updateMany({
      where: { moyskladProductId: input.productId, status: 'PENDING', OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      data: { leaseToken, attemptedAt: operation.attemptedAt ?? now, leaseUntil: new Date(now.getTime() + 60_000) },
    });
    if (claimed.count !== 1) throw new Error('PRODUCT_CREATE_OPERATION_BUSY');
    try {
      const products = await findProducts(catalogId, xmlId, kind, Object.keys(frozen.fields));
      if (products.length > 1) throw new ProductCatalogManualReviewError('PRODUCT_CREATE_DUPLICATE_EXTERNAL_ID');
      let b24Id = operation.bitrix24ProductId ?? (products.length === 1 ? numericId(products[0].id) : null);
      if (products.length === 1 && !readbackMatches(products[0], frozen.fields, kind)) throw new ProductCatalogManualReviewError('PRODUCT_CREATE_RECOVERY_MISMATCH');
      if (!b24Id) {
        const response = await this.write(input, () => this.assertLease(input.productId, leaseToken), () => bitrixCall(kind === 'service' ? 'catalog.product.service.add' : 'catalog.product.add', { fields: frozen.fields }));
        const responseKey = kind === 'service' ? 'service' : 'element';
        const created = isRecord(response) && isRecord(response[responseKey]) ? response[responseKey] : null;
        b24Id = created ? numericId(created.id) : null;
        if (!b24Id || !readbackMatches(created!, frozen.fields, kind)) throw new Error('PRODUCT_CREATE_RESPONSE_INVALID');
        const saved = await this.database.dealOrderReverseProductOperation.updateMany({ where: { moyskladProductId: input.productId, leaseToken }, data: { bitrix24ProductId: b24Id } });
        if (saved.count !== 1) throw new Error('PRODUCT_CREATE_LEASE_LOST');
      } else if (!operation.bitrix24ProductId) {
        const saved = await this.database.dealOrderReverseProductOperation.updateMany({ where: { moyskladProductId: input.productId, leaseToken }, data: { bitrix24ProductId: b24Id } });
        if (saved.count !== 1) throw new Error('PRODUCT_CREATE_LEASE_LOST');
      }
      const frozenPrices = Array.isArray(frozen.prices) ? frozen.prices.filter(isRecord) : [];
      if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') this.controlledAdmission.allowTargetReadback('BITRIX24', b24Id);
      const targetReadback = await findProducts(catalogId, xmlId, kind, Object.keys(frozen.fields));
      if (targetReadback.length !== 1 || String(targetReadback[0]!.id) !== b24Id || !readbackMatches(targetReadback[0]!, frozen.fields, kind)) throw new ProductCatalogManualReviewError('PRODUCT_CREATE_READBACK_MISMATCH');
      if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
        const targetCreatedAt = typeof targetReadback[0]!.dateCreate === 'string' ? new Date(targetReadback[0]!.dateCreate) : null;
        if (!targetCreatedAt || !Number.isFinite(targetCreatedAt.getTime())) throw new ProductCatalogManualReviewError('CONTROLLED_LIVE_TEST_TARGET_CREATED_AT_UNAVAILABLE');
        await this.controlledAdmission.bindCreatedTarget(input.eventId, b24Id, b24Id, String(targetReadback[0]!.name ?? ''), targetCreatedAt);
      }
      for (const price of frozenPrices) await this.createOrRecoverPrice(b24Id, price, input.productId, leaseToken, input);
      const verified = await findProducts(catalogId, xmlId, kind, Object.keys(frozen.fields));
      if (verified.length !== 1 || String(verified[0].id) !== b24Id || !readbackMatches(verified[0], frozen.fields, kind)) throw new ProductCatalogManualReviewError('PRODUCT_CREATE_READBACK_MISMATCH');
      await this.persistPair(input.productId, b24Id, leaseToken, input.eventId, kind);
      return b24Id;
    } catch (error) {
      await this.database.dealOrderReverseProductOperation.updateMany({ where: { moyskladProductId: input.productId, leaseToken }, data: { leaseToken: null, leaseUntil: null, lastErrorCategory: 'PRODUCT_CREATE_RETRYABLE' } }).catch(() => undefined);
      throw error;
    }
  }

  private async write<T>(input: ProductCreateInput, assertLease: () => Promise<void>, mutation: () => Promise<T>): Promise<T> {
    const assertOwned = async () => { await assertLease(); return !input.assertPairLease || input.assertPairLease(); };
    return input.writeGate === 'PRODUCT_CATALOG'
      ? this.mode.runProductCatalogExternalWrite(assertOwned, mutation)
      : this.mode.runDealOrderExternalWrite('moyskladToBitrix24', assertOwned, input.writePair, mutation);
  }

  private async createOrRecoverPrice(productId: string, price: Row, moyskladId: string, leaseToken: string, input: ProductCreateInput) {
    const catalogGroupId = Number(price.catalogGroupId);
    const value = Number(price.value);
    const currency = typeof price.currency === 'string' ? price.currency : '';
    if (!Number.isInteger(catalogGroupId) || catalogGroupId < 1 || !Number.isFinite(value) || value < 0 || !/^[A-Z]{3}$/.test(currency)) {
      throw new ProductCatalogManualReviewError('PRODUCT_CREATE_PRICE_MAPPING_INVALID');
    }
    let rows = await findPrices(productId, catalogGroupId);
    if (rows.length > 1) throw new ProductCatalogManualReviewError('PRODUCT_CREATE_PRICE_AMBIGUOUS');
    if (rows.length === 1) {
      if (!samePrice(rows[0], productId, catalogGroupId, value, currency)) throw new ProductCatalogManualReviewError('PRODUCT_CREATE_PRICE_RECOVERY_MISMATCH');
      return;
    }
    await this.write(input, () => this.assertLease(moyskladId, leaseToken), () => bitrixCall('catalog.price.add', { fields: { productId: Number(productId), catalogGroupId, price: value, currency } }));
    rows = await findPrices(productId, catalogGroupId);
    if (rows.length !== 1 || !samePrice(rows[0], productId, catalogGroupId, value, currency)) {
      throw new Error('PRODUCT_CREATE_PRICE_READBACK_MISMATCH');
    }
  }

  private async persistPair(moyskladId: string, bitrix24Id: string, leaseToken: string, eventId: string, kind: 'product' | 'service') {
    await this.database.$transaction(async (transaction) => {
      await lockEntityPairState(transaction);
      const [bySource, byTarget] = await Promise.all([
        transaction.entityPair.findMany({ where: { entityType: 'PRODUCT', bitrix24Id, active: true } }),
        transaction.entityPair.findMany({ where: { entityType: 'PRODUCT', moyskladId, active: true } }),
      ]);
      if (bySource.some((pair) => pair.moyskladId !== moyskladId) || byTarget.some((pair) => pair.bitrix24Id !== bitrix24Id) || bySource.length > 1 || byTarget.length > 1) {
        throw new ProductCatalogManualReviewError('PRODUCT_CREATE_PAIR_CONFLICT');
      }
      if (!bySource.length && !byTarget.length) await transaction.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id, moyskladId, moyskladType: kind, source: 'AUTO' } });
      const updated = await transaction.dealOrderReverseProductOperation.updateMany({
        where: { moyskladProductId: moyskladId, status: 'PENDING', ...(leaseToken ? { leaseToken } : {}) },
        data: { status: 'SUCCEEDED', bitrix24ProductId: bitrix24Id, leaseToken: null, leaseUntil: null, lastErrorCategory: null },
      });
      if (updated.count !== 1) {
        const succeeded = await transaction.dealOrderReverseProductOperation.findUnique({ where: { moyskladProductId: moyskladId }, select: { status: true, bitrix24ProductId: true } });
        if (leaseToken || succeeded?.status !== 'SUCCEEDED' || succeeded.bitrix24ProductId !== bitrix24Id) throw new Error('PRODUCT_CREATE_PAIR_PERSISTENCE_FAILED');
      }
    });
    await writeOperationalLog(this.database, 'EVENT', `Created and paired Bitrix24 product ${bitrix24Id} from MySklad product ${moyskladId}`, eventId);
  }

  private async assertLease(moyskladId: string, leaseToken: string) {
    const current = await this.database.dealOrderReverseProductOperation.findUnique({ where: { moyskladProductId: moyskladId }, select: { leaseToken: true, leaseUntil: true } });
    if (!current || current.leaseToken !== leaseToken || !current.leaseUntil || current.leaseUntil.getTime() <= Date.now()) throw new Error('PRODUCT_CREATE_LEASE_LOST');
  }
}

async function findPrices(productId: string, catalogGroupId: number): Promise<Row[]> {
  const rows: Row[] = [];
  for (let start = 0; start < 10_000;) {
    const result = await bitrixCall('catalog.price.list', { select: ['id', 'productId', 'catalogGroupId', 'price', 'currency'], filter: { productId: Number(productId), catalogGroupId }, order: { id: 'ASC' }, start });
    const root = isRecord(result) ? result : null;
    const page = root && Array.isArray(root.prices) ? root.prices.filter(isRecord) : null;
    if (!root || !page) throw new Error('PRODUCT_CREATE_PRICE_READ_INVALID');
    rows.push(...page);
    const next = root.next;
    if (typeof next !== 'number') return rows;
    start = next;
  }
  throw new ProductCatalogManualReviewError('PRODUCT_CREATE_PRICE_SEARCH_TOO_LARGE');
}
function samePrice(actual: Row, productId: string, catalogGroupId: number, value: number, currency: string): boolean {
  return String(actual.productId) === productId && String(actual.catalogGroupId) === String(catalogGroupId) && Number(actual.price) === value && actual.currency === currency;
}

async function findProducts(catalogId: string, xmlId: string, kind: 'product' | 'service' = 'product', configuredFields: string[] = []): Promise<Row[]> {
  const rows: Row[] = [];
  let start = 0;
  let total: number | null = null;
  for (let page = 0; page < 200; page += 1) {
    const value = await bitrixCall(kind === 'service' ? 'catalog.product.service.list' : 'catalog.product.list', { select: [...new Set(['id', 'iblockId', 'iblockSectionId', 'name', 'code', 'detailText', 'measure', 'xmlId', 'type', 'dateCreate', ...configuredFields])], filter: { iblockId: Number(catalogId), xmlId }, order: { id: 'ASC' }, start });
    const root = isRecord(value) ? value : null;
    const pageRows = root && Array.isArray(root[kind === 'service' ? 'services' : 'products']) ? (root[kind === 'service' ? 'services' : 'products'] as unknown[]).filter(isRecord) : null;
    if (!root || !pageRows || typeof root.total !== 'number') throw new Error('PRODUCT_CREATE_RECOVERY_SEARCH_INVALID');
    if (total === null) total = root.total;
    else if (root.total !== total) throw new ProductCatalogManualReviewError('PRODUCT_CREATE_RECOVERY_CHANGED');
    rows.push(...pageRows);
    if (rows.length >= total) return rows;
    if (!pageRows.length) throw new ProductCatalogManualReviewError('PRODUCT_CREATE_RECOVERY_INCOMPLETE');
    start += pageRows.length;
  }
  throw new ProductCatalogManualReviewError('PRODUCT_CREATE_RECOVERY_TOO_LARGE');
}
async function bitrixCall(method: string, params: Row): Promise<unknown> {
  if (/\.(?:add|update|delete)$/i.test(method)) {
    const operation = /\.add$/i.test(method) ? 'PRODUCT_CREATE' : 'PRODUCT_UPDATE';
    assertApplyExternalWrite('BITRIX24', operation);
  }
  const base = process.env.BITRIX24_REST_BASE_URL;
  if (!base) throw new Error('BITRIX24_PRODUCT_API_NOT_CONFIGURED');
  const url = new URL(method, base.endsWith('/') ? base : `${base}/`);
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(params), redirect: 'error', signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`BITRIX24_PRODUCT_API_${response.status}`);
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || payload.error || !('result' in payload)) throw new Error('BITRIX24_PRODUCT_API_REJECTED');
  const result = payload.result;
  if (isRecord(result) && typeof payload.total === 'number' && result.total === undefined) return { ...result, total: payload.total };
  return result;
}
function readbackMatches(actual: Row, expected: Row, kind: 'product' | 'service'): boolean {
  if (!numericId(actual.id) || String(actual.iblockId) !== String(expected.iblockId)) return false;
  if (Number(actual.type) !== (kind === 'service' ? 7 : 1)) return false;
  return Object.entries(expected).every(([key, value]) => key === 'iblockId' ? String(actual[key]) === String(value)
    : key === 'property108' ? (isRecord(actual[key]) ? actual[key].value : actual[key]) === value.value
    : actual[key] === value);
}
function configuredCatalogCreateRules(value: unknown, product: Row): Array<{ bitrix24Field: string; value: string | number | boolean }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || candidate.entity !== 'catalog' || typeof candidate.sourceField !== 'string' || typeof candidate.targetField !== 'string') return [];
    const mapping = isRecord(candidate.moyskladToBitrix24) ? candidate.moyskladToBitrix24 : null;
    const transform = mapping && isRecord(mapping.transform) ? mapping.transform : null;
    if (mapping?.enabled !== true || transform?.kind !== 'copy') return [];
    const value = product[candidate.targetField];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return [];
    if (candidate.sourceField === 'name' || candidate.sourceField === 'xmlId') return [];
    return [{ bitrix24Field: candidate.sourceField, value }];
  });
}

async function assertCatalogCreateFieldsWritable(catalogId: string, kind: 'product' | 'service', fields: Row) {
  const method = kind === 'service' ? 'catalog.product.service.getFieldsByFilter' : 'catalog.product.getFieldsByFilter';
  const result = await bitrixCall(method, { filter: { iblockId: Number(catalogId) } });
  const root = isRecord(result) ? result : {};
  const definitions = isRecord(root[kind]) ? root[kind] as Row : {};
  const neverWrite = new Set(['id', 'type', 'iblockSection', 'iblockSectionId', 'detailPicture', 'previewPicture', 'quantity', 'quantityReserved', 'quantityTrace', 'available', 'createdBy', 'modifiedBy', 'dateCreate', 'timestampX', 'dateActiveFrom', 'dateActiveTo', 'priceType', 'purchasingPrice', 'purchasingCurrency']);
  for (const key of Object.keys(fields)) {
    if (['iblockId', 'active', 'xmlId'].includes(key)) continue;
    const definition = definitions[key];
    const fieldValue = fields[key];
    if (key === 'property108') {
      if (!isRecord(definition) || definition.isReadOnly !== false || definition.isMultiple !== false || definition.type !== 'productproperty' || definition.propertyType !== 'S' ||
          !isRecord(fieldValue) || typeof fieldValue.value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fieldValue.value)) {
        throw new ProductCatalogManualReviewError('PRODUCT_CREATE_UUID_FIELD_NOT_CONFIRMED_WRITABLE');
      }
      continue;
    }
    if (neverWrite.has(key) || !isRecord(definition) || definition.isReadOnly !== false || !['string', 'char', 'integer', 'double', 'datetime'].includes(String(definition.type)) || !compatibleCreateScalar(String(definition.type), fieldValue)) {
      throw new ProductCatalogManualReviewError('PRODUCT_CREATE_FIELD_NOT_CONFIRMED_WRITABLE');
    }
  }
}

function compatibleCreateScalar(fieldType: string, value: unknown) {
  if (fieldType === 'string' || fieldType === 'datetime') return typeof value === 'string';
  if (fieldType === 'char') return typeof value === 'string' || typeof value === 'boolean';
  if (fieldType === 'integer' || fieldType === 'double') return typeof value === 'number' && Number.isFinite(value);
  return false;
}
function numericId(value: unknown): string | null { return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^\d{1,20}$/.test(value)) ? String(value) : null; }
function isUniqueViolation(error: unknown): boolean { return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
