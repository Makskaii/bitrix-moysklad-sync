import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database.service';
import { CLIENT_DEPENDENCY_RESOLVER, ClientDependencyResolver } from '../clients/client-dependency-resolver';
import { VersionedFieldSettingsDto } from '../field-settings/field-settings.dto';
import { lockEntityPairState } from '../pairs/pair-db-lock';
import { SyncModeService } from '../sync-mode.service';
import { writeOperationalLog } from '../monitoring-log';
import { resolveDictionaryValue } from './deal-order-field-runtime.service';

type Row = Record<string, unknown>;
type PreparedRow = { msPositionId: string; snapshot: Row; fields: { ownerId: number; ownerType: 'D'; productId: number; price: number; quantity: number; discountTypeId: 2; discountRate: 0; discountSum: 0; taxRate: null; taxIncluded: 'N'; measureCode: number; sort: number } };
type Prepared = { orderId: string; eventId: string; settingsVersion: number; sourceSnapshot: Row; fields: Row; rows: PreparedRow[]; companyPairId: string | null; companyId: string | null };

export type ReverseCreateResult = { status: 'CREATED' | 'ALREADY_PAIRED'; bitrix24DealId: string };
export class DealOrderReverseManualReviewError extends Error {}

/** Durable new-MySklad-order to new-Bitrix24-deal exchange. Every provider
 * result is journaled before the next non-idempotent write; uncertain row
 * adds are resolved by stable sort slot plus exact readback or held. */
@Injectable()
export class DealOrderReverseCreateService {
  constructor(
    private readonly database: DatabaseService,
    private readonly mode: SyncModeService,
    @Optional() @Inject(CLIENT_DEPENDENCY_RESOLVER) private readonly clients?: ClientDependencyResolver,
  ) {}

  async createAndPair(input: { moyskladOrderId: string; eventId: string; eventConfig: VersionedFieldSettingsDto }): Promise<ReverseCreateResult> {
    if (!isUuid(input.moyskladOrderId)) throw new Error('Customer-order identity is invalid');
    if (process.env.SYNC_MODE !== 'apply' || (await this.mode.read()).mode !== 'on' || !await this.mode.isDirectionEnabled('deals-orders', 'moyskladToBitrix24')) {
      throw new Error('Reverse deal creation is disabled');
    }
    const existingPair = await this.database.entityPair.findFirst({ where: { entityType: 'DEAL', moyskladId: input.moyskladOrderId, active: true }, select: { bitrix24Id: true } });
    if (existingPair) return { status: 'ALREADY_PAIRED', bitrix24DealId: existingPair.bitrix24Id };
    if (!this.clients) throw new Error('Client dependency resolver is unavailable');

    let operation = await this.database.dealOrderReverseCreateOperation.findUnique({ where: { moyskladOrderId: input.moyskladOrderId }, include: { positions: { orderBy: { moyskladPositionId: 'asc' } } } });
    if (operation?.status === 'SUCCEEDED' && operation.bitrix24DealId) return { status: 'CREATED', bitrix24DealId: operation.bitrix24DealId };
    if (!operation || operation.status === 'WAITING') {
      const prepared = await this.prepare(input);
      const payload = serializePrepared(prepared);
      operation = operation
        ? await this.database.dealOrderReverseCreateOperation.update({ where: { moyskladOrderId: input.moyskladOrderId }, data: { payload: payload as Prisma.InputJsonValue, settingsVersion: input.eventConfig.version, status: 'PENDING', lastErrorCategory: null }, include: { positions: true } })
        : await this.database.dealOrderReverseCreateOperation.create({ data: { moyskladOrderId: input.moyskladOrderId, eventId: input.eventId, syncId: randomUUID(), payload: payload as Prisma.InputJsonValue, settingsVersion: input.eventConfig.version, status: 'PENDING' }, include: { positions: true } });
      for (const row of prepared.rows) {
        await this.database.dealOrderReversePositionOperation.upsert({
          where: { moyskladOrderId_moyskladPositionId: { moyskladOrderId: input.moyskladOrderId, moyskladPositionId: row.msPositionId } },
          create: { moyskladOrderId: input.moyskladOrderId, moyskladPositionId: row.msPositionId, payload: row as unknown as Prisma.InputJsonValue },
          update: {},
        });
      }
      operation = await this.database.dealOrderReverseCreateOperation.findUniqueOrThrow({ where: { moyskladOrderId: input.moyskladOrderId }, include: { positions: { orderBy: { moyskladPositionId: 'asc' } } } });
    }
    if (operation.status !== 'PENDING') throw new Error(`Reverse deal creation is ${operation.status}`);
    const prepared = deserializePrepared(operation.payload);
    const leaseToken = randomUUID();
    const now = new Date();
    const claim = await this.database.dealOrderReverseCreateOperation.updateMany({
      where: { moyskladOrderId: input.moyskladOrderId, status: 'PENDING', OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      data: { leaseToken, attemptedAt: operation.attemptedAt ?? now, leaseUntil: new Date(now.getTime() + 60_000) },
    });
    if (claim.count !== 1) throw new Error('Reverse deal create is already in progress');
    try {
      const dealId = operation.bitrix24DealId ?? await this.createOrRecoverDeal(prepared, leaseToken);
      await this.verifyDeal(dealId, prepared);
      await this.createRows(prepared, leaseToken);
      return await this.persistPair(prepared, dealId, leaseToken);
    } catch (error) {
      await this.database.dealOrderReverseCreateOperation.updateMany({ where: { moyskladOrderId: input.moyskladOrderId, leaseToken }, data: { leaseToken: null, leaseUntil: null, lastErrorCategory: 'REVERSE_CREATE_RETRYABLE' } }).catch(() => undefined);
      throw error;
    }
  }

  private async prepare(input: { moyskladOrderId: string; eventId: string; eventConfig: VersionedFieldSettingsDto }): Promise<Prepared> {
    const config = input.eventConfig.config.dealOrderRuntime;
    if (!config || !config.nativeOrderNumberingVerified) throw new DealOrderReverseManualReviewError('Deal-order runtime settings or native numbering confirmation are missing');
    const order = await msGet(`entity/customerorder/${input.moyskladOrderId}?expand=agent,state,rate.currency`);
    if (!isRecord(order) || order.id !== input.moyskladOrderId || !isRecord(order.agent) || !isRecord(order.agent.meta) || !isUuid(order.agent.id) || !isRecord(order.state) || !isUuid(order.state.id) || !isRecord(order.rate) || !isRecord(order.rate.currency) || !isUuid(order.rate.currency.id) || typeof order.name !== 'string' || !order.name.trim()) {
      throw new DealOrderReverseManualReviewError('Customer-order header is incomplete');
    }
    const stage = config.stages.find((item) => item.moyskladId === order.state?.id);
    const currency = config.currencies.find((item) => item.moyskladId === order.rate.currency.id);
    if (!stage || !currency) throw new DealOrderReverseManualReviewError('Customer-order stage or currency has no confirmed Bitrix24 mapping');

    let companyPairId: string | null = null;
    let companyId: string | null = null;
    const configuredServiceId = input.eventConfig.config.serviceCounterpartyId;
    if (order.agent.id !== configuredServiceId) {
      const client = await this.clients?.resolveForDocument({ eventId: input.eventId, sourceSystem: 'MOYSKLAD', entity: 'COMPANY', sourceId: order.agent.id });
      if (!client || client.status === 'REVIEW') throw new DealOrderReverseManualReviewError('Customer-order counterparty pair is not confirmed');
      if (client.status !== 'RESOLVED') throw new Error('Customer-order counterparty pair resolution is retryable');
      companyPairId = client.pair.id;
      companyId = client.pair.bitrix24Id;
    }

    const positions = await msGetAllPositions(input.moyskladOrderId);
    const sourceIds = positions.map((position) => readId(position.id)).filter((id): id is string => !!id);
    if (sourceIds.length !== positions.length || new Set(sourceIds).size !== sourceIds.length) throw new DealOrderReverseManualReviewError('Customer-order position identity is incomplete or ambiguous');
    const assortmentIds = positions.map((position) => isRecord(position.assortment) ? readId(position.assortment.id) : null).filter((id): id is string => !!id);
    const pairs = assortmentIds.length ? await this.database.entityPair.findMany({ where: { entityType: 'PRODUCT', active: true, moyskladId: { in: [...new Set(assortmentIds)] } }, select: { bitrix24Id: true, moyskladId: true } }) : [];
    const rows: PreparedRow[] = [];
    const seenPair = new Set<string>();
    for (const position of positions) {
      const id = readId(position.id)!;
      const assortment = isRecord(position.assortment) ? position.assortment : {};
      const assortmentId = readId(assortment.id);
      const matches = pairs.filter((pair) => pair.moyskladId === assortmentId);
      const uomId = isRecord(assortment.uom) ? readId(assortment.uom.id) : null;
      const unit = input.eventConfig.config.references.units.filter((candidate) => candidate.status === 'configured' && candidate.moyskladId === uomId);
      const price = typeof position.price === 'number' && Number.isFinite(position.price) && position.price >= 0 ? position.price / 100 : null;
      const quantity = typeof position.quantity === 'number' && Number.isFinite(position.quantity) && position.quantity > 0 ? position.quantity : null;
      const hasUnsupportedDiscount = typeof position.discount === 'number' && position.discount !== 0;
      const hasUnsupportedTax = position.vatEnabled === true || (typeof position.vat === 'number' && position.vat !== 0);
      const rowKey = `${input.moyskladOrderId}:${id}`;
      if (matches.length !== 1 || !/^\d{1,20}$/.test(matches[0]?.bitrix24Id ?? '') || unit.length !== 1 || price === null || quantity === null || hasUnsupportedDiscount || hasUnsupportedTax) {
        const reason = matches.length !== 1 ? 'PRODUCT_PAIR_MISSING_OR_AMBIGUOUS' : unit.length !== 1 ? 'UNIT_UNMAPPED' : price === null ? 'DOCUMENT_PRICE_MISSING' : quantity === null ? 'QUANTITY_INVALID' : hasUnsupportedDiscount ? 'DISCOUNT_MAPPING_UNSUPPORTED' : 'VAT_MAPPING_UNSUPPORTED';
        await writeOperationalLog(this.database, 'EVENT', `MySklad customer-order position ${id} skipped; reason=${reason}`, input.eventId);
        continue;
      }
      if (seenPair.has(rowKey)) throw new Error('Customer-order position was duplicated');
      seenPair.add(rowKey);
      const measureCode = unit[0].bitrix24Id;
      rows.push({
        msPositionId: id,
        snapshot: position,
        fields: { ownerId: 0, ownerType: 'D', productId: Number(matches[0].bitrix24Id), price, quantity, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: null, taxIncluded: 'N', measureCode, sort: rows.length + 1 },
      });
    }
    const dealFields: Row = {
      title: `Заказ покупателя ${order.name}`,
      categoryId: categoryFromStage(stage.bitrix24StageId),
      stageId: stage.bitrix24StageId,
      currencyId: currency.bitrix24Code,
      isManualOpportunity: 'Y',
      opportunity: typeof order.sum === 'number' && Number.isFinite(order.sum) ? order.sum / 100 : 0,
      originatorId: 'MOYSKLAD',
      originId: input.moyskladOrderId,
      UF_CRM_1729757435964: order.name,
      ...(companyId ? { companyId: Number(companyId) } : {}),
      ...(typeof order.description === 'string' ? { comments: order.description } : {}),
    };
    const fields = mapConfiguredFields(input.eventConfig, order, dealFields);
    return { orderId: input.moyskladOrderId, eventId: input.eventId, settingsVersion: input.eventConfig.version, sourceSnapshot: order, fields, rows, companyPairId, companyId };
  }

  private async createOrRecoverDeal(prepared: Prepared, leaseToken: string): Promise<string> {
    const items = await b24FindOriginDeals(prepared.orderId);
    if (items.length > 1) throw new DealOrderReverseManualReviewError('Multiple Bitrix24 deals already reference this MySklad customer order');
    let dealId = items.length === 1 ? readNumericId(items[0].id) : null;
    if (items.length === 1 && (items[0].originId !== prepared.orderId || items[0].originatorId !== 'MOYSKLAD')) throw new DealOrderReverseManualReviewError('Bitrix24 deal recovery identity is ambiguous');
    if (!dealId) {
      await this.assertOperationLease(prepared.orderId, leaseToken);
      const created = await b24('crm.item.add', { entityTypeId: 2, fields: prepared.fields, useOriginalUfNames: true });
      const item = isRecord(created) && isRecord(created.item) ? created.item : null;
      dealId = item ? readNumericId(item.id) : null;
      if (!dealId) throw new Error('Bitrix24 deal create response did not include a numeric ID');
    }
    const saved = await this.database.dealOrderReverseCreateOperation.updateMany({ where: { moyskladOrderId: prepared.orderId, leaseToken }, data: { bitrix24DealId: dealId } });
    if (saved.count !== 1) throw new Error('Reverse deal operation lease was lost after provider success');
    return dealId;
  }

  private async verifyDeal(dealId: string, prepared: Prepared) {
    const result = await b24('crm.item.get', { entityTypeId: 2, id: Number(dealId), useOriginalUfNames: true });
    const item = isRecord(result) && isRecord(result.item) ? result.item : null;
    if (!item || String(item.id) !== dealId || item.title !== prepared.fields.title || item.originatorId !== 'MOYSKLAD' || item.originId !== prepared.orderId || String(item.UF_CRM_1729757435964 ?? '') !== String(prepared.sourceSnapshot.name)) {
      throw new DealOrderReverseManualReviewError('Bitrix24 deal readback did not match the durable MySklad order operation');
    }
  }

  private async createRows(prepared: Prepared, leaseToken: string) {
    const dealId = (await this.database.dealOrderReverseCreateOperation.findUniqueOrThrow({ where: { moyskladOrderId: prepared.orderId }, select: { bitrix24DealId: true } })).bitrix24DealId;
    if (!dealId) throw new Error('Reverse deal ID is not persisted');
    const rows = await b24AllRows(dealId);
    for (const preparedRow of prepared.rows) {
      const operation = await this.database.dealOrderReversePositionOperation.findUnique({ where: { moyskladOrderId_moyskladPositionId: { moyskladOrderId: prepared.orderId, moyskladPositionId: preparedRow.msPositionId } } });
      if (!operation) throw new Error('Reverse position operation is missing');
      if (operation.bitrix24ProductRowId) {
        const current = rows.find((row) => String(row.id) === operation.bitrix24ProductRowId);
        if (!current || !sameRow(current, preparedRow.fields, dealId)) throw new DealOrderReverseManualReviewError('Persisted Bitrix24 product row readback mismatch');
        continue;
      }
      const bySort = rows.filter((row) => Number(row.sort) === preparedRow.fields.sort);
      if (bySort.length > 1) throw new DealOrderReverseManualReviewError('Ambiguous Bitrix24 product row recovery slot');
      let rowId: string;
      if (bySort.length === 1) {
        if (!sameRow(bySort[0], preparedRow.fields, dealId)) throw new DealOrderReverseManualReviewError('Bitrix24 product row recovery slot has different values');
        rowId = String(bySort[0].id);
      } else {
        await this.assertOperationLease(prepared.orderId, leaseToken);
        const created = await b24('crm.item.productrow.add', { fields: { ...preparedRow.fields, ownerId: Number(dealId) } });
        const row = isRecord(created) && isRecord(created.productRow) ? created.productRow : null;
        const id = row && readNumericId(row.id);
        if (!id) throw new Error('Bitrix24 product row create response did not include an ID');
        rowId = id;
      }
      const saved = await this.database.dealOrderReversePositionOperation.updateMany({ where: { id: operation.id, status: 'PENDING' }, data: { status: 'SUCCEEDED', bitrix24ProductRowId: rowId, lastErrorCategory: null } });
      if (saved.count !== 1) throw new Error('Bitrix24 product row operation changed during persistence');
      rows.push({ ...preparedRow.fields, id: Number(rowId), ownerId: Number(dealId), ownerType: 'D' });
    }
  }

  private async assertOperationLease(orderId: string, leaseToken: string) {
    const owner = await this.database.dealOrderReverseCreateOperation.findFirst({ where: { moyskladOrderId: orderId, status: 'PENDING', leaseToken, leaseUntil: { gt: new Date() } }, select: { moyskladOrderId: true } });
    if (!owner) throw new Error('Reverse deal create lease was lost');
  }

  private async persistPair(prepared: Prepared, dealId: string, leaseToken: string): Promise<ReverseCreateResult> {
    return this.database.$transaction(async (transaction) => {
      await lockEntityPairState(transaction);
      const operation = await transaction.dealOrderReverseCreateOperation.findFirst({ where: { moyskladOrderId: prepared.orderId, bitrix24DealId: dealId, status: 'PENDING', leaseToken }, include: { positions: true } });
      if (!operation) throw new Error('Reverse deal create lease was lost before pairing');
      const bySource = await transaction.entityPair.findFirst({ where: { entityType: 'DEAL', moyskladId: prepared.orderId, active: true } });
      const byTarget = await transaction.entityPair.findFirst({ where: { entityType: 'DEAL', bitrix24Id: dealId, active: true } });
      if ((bySource && bySource.bitrix24Id !== dealId) || (byTarget && byTarget.moyskladId !== prepared.orderId)) throw new DealOrderReverseManualReviewError('Reverse deal pair conflicts with an existing mapping');
      const pair = bySource ?? await transaction.entityPair.create({ data: { entityType: 'DEAL', bitrix24Id: dealId, moyskladId: prepared.orderId, source: 'AUTOMATIC', reason: `Created from MySklad event ${prepared.eventId}` } });
      if (prepared.companyPairId) {
        const clientPair = await transaction.entityPair.findFirst({ where: { id: prepared.companyPairId, entityType: 'COMPANY', active: true, moyskladId: { not: '' } } });
        if (!clientPair || clientPair.bitrix24Id !== prepared.companyId) throw new Error('Reverse deal client pair changed before persistence');
      }
      const existingLinks = await transaction.dealOrderPositionPair.findMany({ where: { pairId: pair.id }, select: { moyskladPositionId: true } });
      for (const positionOperation of operation.positions) {
        if (!positionOperation.bitrix24ProductRowId) throw new Error('Bitrix24 product row has not been persisted');
        const existing = existingLinks.find((link) => link.moyskladPositionId === positionOperation.moyskladPositionId);
        const payload = isRecord(positionOperation.payload) ? positionOperation.payload as unknown as Row : null;
        if (!payload || !isRecord(payload.snapshot)) throw new Error('Reverse position snapshot is malformed');
        if (!existing) {
          await transaction.dealOrderPositionPair.create({ data: {
            pairId: pair.id,
            bitrix24ProductRowId: positionOperation.bitrix24ProductRowId,
            moyskladPositionId: positionOperation.moyskladPositionId,
            bitrix24Values: { id: positionOperation.bitrix24ProductRowId, ...(payload.fields as Row) } as Prisma.InputJsonValue,
            moyskladValues: payload.snapshot as Prisma.InputJsonValue,
          } });
        } else if (existing.moyskladPositionId !== positionOperation.moyskladPositionId) throw new Error('Reverse row link conflicts');
      }
      await transaction.dealOrderReverseCreateOperation.update({ where: { moyskladOrderId: prepared.orderId }, data: { status: 'SUCCEEDED', leaseToken: null, leaseUntil: null, lastErrorCategory: null } });
      await transaction.pairReviewCase.updateMany({ where: { entityType: 'DEAL', sourceSystem: 'MOYSKLAD', sourceEntityId: prepared.orderId, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
      return { status: 'CREATED', bitrix24DealId: dealId };
    }, { timeout: 30_000 });
  }
}

function serializePrepared(value: Prepared): Row { return JSON.parse(JSON.stringify(value)) as Row; }
function deserializePrepared(value: Prisma.JsonValue): Prepared {
  const parsed = isRecord(value) ? value as unknown as Row : null;
  if (!parsed || !isRecord(parsed.fields) || !Array.isArray(parsed.rows) || !isRecord(parsed.sourceSnapshot)) throw new Error('Stored reverse deal payload is malformed');
  return value as unknown as Prepared;
}
function mapConfiguredFields(config: VersionedFieldSettingsDto, source: Row, fields: Row): Row {
  for (const rule of config.config.rules.filter((item) => item.entity === 'deals-orders' && item.moyskladToBitrix24.enabled)) {
    if (rule.moyskladToBitrix24.transform.kind !== 'copy') {
      if (rule.criticality === 'critical') throw new Error(`Critical field ${rule.id} has an unsupported transform`);
      continue;
    }
    const attributeId = rule.targetField.match(/^attributes\.([0-9a-f-]{36})$/i)?.[1];
    if (!attributeId) {
      if (rule.criticality === 'critical') throw new Error(`Critical field ${rule.id} has an unsupported MySklad source`);
      continue;
    }
    const attributes = Array.isArray(source.attributes) ? source.attributes.filter(isRecord) : [];
    const matches = attributes.filter((attribute) => attribute.id === attributeId || (isRecord(attribute.meta) && typeof attribute.meta.href === 'string' && attribute.meta.href.endsWith(`/${attributeId}`)));
    if (matches.length > 1) throw new Error(`MySklad attribute ${attributeId} is ambiguous`);
    if (matches.length === 1) {
      const value = matches[0].value;
      const dictionary = config.config.references.dictionaries.find((candidate) => candidate.bitrix24Field === rule.sourceField && candidate.moyskladAttributeId === attributeId);
      if (dictionary) {
        const expected = dictionary.key === 'service'
          ? ['UF_CRM_1766085949', '42', '0ad997c8-8e75-11e3-1ec9-002590a28eca', 'f0177126-8e74-11e3-b761-002590a28eca']
          : dictionary.key === 'payment-method'
            ? ['UF_CRM_1766072752', '44', 'f214f966-dc1a-11f0-0a80-0ef700278459', '0ecffb86-d8a3-11eb-0a80-0dbc000256e5']
            : null;
        if (expected && (dictionary.bitrix24Field !== expected[0] || dictionary.bitrix24ListId !== expected[1] || dictionary.moyskladAttributeId !== expected[2] || dictionary.moyskladDirectoryId !== expected[3])) {
          throw new DealOrderReverseManualReviewError(`Dictionary field ${rule.id} does not match the confirmed service/payment contract`);
        }
        const customEntityId = isRecord(value) && isRecord(value.meta) && typeof value.meta.href === 'string' ? value.meta.href.match(/\/([0-9a-f-]{36})(?:\?.*)?$/i)?.[1] : null;
        const mapped = resolveDictionaryValue(dictionary, 'MOYSKLAD', customEntityId);
        if (mapped.status === 'MAPPED') fields[rule.sourceField] = mapped.bitrix24Id;
        else if (rule.criticality === 'critical') throw new DealOrderReverseManualReviewError(`Critical dictionary field ${rule.id} has no confirmed mapping`);
        continue;
      }
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') fields[rule.sourceField] = value;
      else if (rule.criticality === 'critical') throw new Error(`Critical field ${rule.id} value requires unsupported transformation`);
    }
  }
  return fields;
}
async function msGet(path: string): Promise<unknown> {
  const base = configuredBase('MOYSKLAD_API_BASE_URL');
  const token = process.env.MOYSKLAD_API_TOKEN;
  if (!token) throw new Error('MySklad API read is not configured');
  return requestJson(new URL(path, ensureSlash(base)), { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
}
async function msGetAllPositions(orderId: string): Promise<Row[]> {
  const all: Row[] = [];
  const base = configuredBase('MOYSKLAD_API_BASE_URL');
  const token = process.env.MOYSKLAD_API_TOKEN;
  if (!token) throw new Error('MySklad API read is not configured');
  for (let offset = 0; offset < 10_000;) {
    const url = new URL(`entity/customerorder/${orderId}/positions`, ensureSlash(base));
    url.searchParams.set('limit', '100'); url.searchParams.set('offset', String(offset));
    const body = await requestJson(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    const rows = isRecord(body) && Array.isArray(body.rows) ? body.rows.filter(isRecord) : null;
    if (!rows) throw new Error('MySklad positions response is invalid');
    all.push(...rows); if (rows.length < 100) return all;
    offset += rows.length;
  }
  throw new Error('MySklad customer order contains too many positions');
}
async function b24(method: string, params: Row): Promise<unknown> {
  const base = configuredBase('BITRIX24_REST_BASE_URL');
  const url = new URL(method, ensureSlash(base));
  return requestJson(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(params) }).then((result) => {
    if (!isRecord(result) || result.error) throw new Error(`Bitrix24 ${method} failed`);
    return result.result;
  });
}
async function b24AllRows(dealId: string): Promise<Row[]> {
  const result: Row[] = [];
  for (let start = 0; start < 10_000;) {
    const value = await b24('crm.item.productrow.list', { filter: { ownerId: Number(dealId), ownerType: 'D' }, select: ['*'], start });
    const rows = isRecord(value) && Array.isArray(value.productRows) ? value.productRows.filter(isRecord) : null;
    if (!rows) throw new Error('Bitrix24 product-row readback is invalid');
    result.push(...rows);
    const next = isRecord(value) ? value.next : undefined;
    if (typeof next !== 'number') return result;
    start = next;
  }
  throw new Error('Bitrix24 returned too many product rows');
}
async function b24FindOriginDeals(orderId: string): Promise<Row[]> {
  const result: Row[] = [];
  for (let start = 0; start < 10_000;) {
    const value = await b24('crm.item.list', { entityTypeId: 2, select: ['id', 'title', 'originatorId', 'originId'], filter: { originatorId: 'MOYSKLAD', originId: orderId }, start });
    const page = isRecord(value) && Array.isArray(value.items) ? value.items.filter(isRecord) : null;
    if (!page) throw new Error('Bitrix24 origin-deal search response is invalid');
    result.push(...page);
    const next = isRecord(value) ? value.next : undefined;
    if (typeof next !== 'number') return result;
    start = next;
  }
  throw new Error('Bitrix24 origin-deal search returned too many items');
}
function sameRow(actual: Row, expected: PreparedRow['fields'], dealId: string): boolean {
  return Number(actual.ownerId) === Number(dealId) && actual.ownerType === 'D' && Number(actual.productId) === expected.productId && Number(actual.measureCode) === expected.measureCode && Number(actual.sort) === expected.sort && Number(actual.quantity) === expected.quantity && Number(actual.price) === expected.price;
}
function categoryFromStage(stageId: string): number {
  const prefix = stageId.match(/^C(\d+):/);
  if (prefix) return Number(prefix[1]);
  return 0;
}
async function requestJson(url: URL, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Provider request failed (${response.status})`);
  const body: unknown = await response.json().catch(() => null);
  if (isRecord(body) && body.errors) throw new Error('Provider returned an error response');
  return body;
}
function configuredBase(name: string): URL {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('Provider URL is invalid');
  return url;
}
function ensureSlash(url: URL): string { return url.toString().endsWith('/') ? url.toString() : `${url.toString()}/`; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function readId(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
function readNumericId(value: unknown): string | null { return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^\d{1,20}$/.test(value)) ? String(value) : null; }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
