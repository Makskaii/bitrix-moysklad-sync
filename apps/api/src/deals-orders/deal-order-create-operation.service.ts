import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database.service';
import { lockEntityPairState } from '../pairs/pair-db-lock';
import { SyncModeService } from '../sync-mode.service';
import { ControlledLiveTestAdmissionService } from '../controlled-live-test-admission.service';

type CustomerOrderPosition = {
  assortment: { meta: { type: string; href: string } };
  quantity: number;
  price: number;
  discount: number;
  vat: number;
  vatEnabled: boolean;
};

export type DealOrderPreparedInput = {
  bitrix24DealId: string;
  bitrix24CompanyId: string | null;
  bitrix24ContactId?: string | null;
  confirmedCustomerPairIds?: string[];
  serviceCounterpartyId?: string | null;
  eventId: string;
  settingsVersion: number;
  sourceProductIds: string[];
  sourceRowIds: string[];
  sourceRowValues: Array<Record<string, unknown>>;
  sourceMeasureCodes: number[];
  skippedRows?: Array<{ sourceRowId: string; reason: string }>;
  unitMappings: Array<{ bitrix24Id: number; moyskladId: string | null; status: 'configured' | 'unmapped' }>;
  payload: {
    agent: Reference;
    organization: Reference;
    store: Reference;
    state: Reference;
    owner: Reference;
    rate: { currency: Reference };
    positions: CustomerOrderPosition[];
    attributes?: Array<{ meta: { href: string; type: 'attributemetadata'; mediaType: 'application/json' }; value: unknown }>;
    [field: string]: unknown;
  };
};

type Reference = { meta: { type: string; href: string } };
type Result =
  | { status: 'CREATED' | 'PARTIAL'; bitrix24DealId: string; moyskladOrderId: string; skippedRows?: Array<{ sourceRowId: string; reason: string }> }
  | { status: 'ALREADY_PAIRED'; bitrix24DealId: string; moyskladOrderId: string };

export class DealOrderPairConflictError extends Error {
  constructor() { super('Customer-order pair became conflicting before persistence'); }
}

/** Durable, retry-safe MySklad creation for a fully preflighted new deal. */
@Injectable()
export class DealOrderCreateOperationService {
  constructor(private readonly database: DatabaseService, private readonly mode: SyncModeService, @Optional() private readonly controlledAdmission?: ControlledLiveTestAdmissionService) {}

  /** Record that a new B24 deal is waiting for complete dependencies. This is
   * deliberately separate from the vendor POST: no external document exists
   * until the preparer has validated every required row/reference. */
  async recordWaiting(bitrix24DealId: string, settingsVersion: number, reason: string) {
    if (!/^\d{1,20}$/.test(bitrix24DealId) || !Number.isInteger(settingsVersion) || settingsVersion < 1) {
      throw new Error('Customer-order waiting operation identity is invalid');
    }
    const existing = await this.database.dealOrderCreateOperation.findUnique({ where: { bitrix24DealId } });
    if (existing) {
      if (existing.status === 'SUCCEEDED') return existing;
      if (existing.status === 'PENDING') return existing;
      return this.database.dealOrderCreateOperation.update({
        where: { bitrix24DealId }, data: { settingsVersion, lastErrorCategory: reason, status: 'WAITING' },
      });
    }
    try {
      return await this.database.dealOrderCreateOperation.create({
        data: { bitrix24DealId, syncId: randomUUID(), payload: {}, settingsVersion, status: 'WAITING', lastErrorCategory: reason },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const raced = await this.database.dealOrderCreateOperation.findUnique({ where: { bitrix24DealId } });
      if (!raced) throw error;
      return raced;
    }
  }

  async recordConflict(bitrix24DealId: string) {
    await this.database.dealOrderCreateOperation.updateMany({
      where: { bitrix24DealId, status: 'PENDING' },
      data: { status: 'CONFLICT', lastErrorCategory: 'PAIR_CONFLICT', leaseToken: null, leaseUntil: null },
    });
  }

  async createAndPair(input: DealOrderPreparedInput, assertWorkerLease?: () => Promise<boolean>): Promise<Result> {
    await this.assertWriteEnabled();
    const existingOperation = await this.database.dealOrderCreateOperation.findUnique({ where: { bitrix24DealId: input.bitrix24DealId } });
    if ((existingOperation?.status === 'SUCCEEDED' || existingOperation?.status === 'PARTIAL') && existingOperation.moyskladOrderId) {
      return { status: existingOperation.status === 'PARTIAL' ? 'PARTIAL' : 'CREATED', bitrix24DealId: input.bitrix24DealId, moyskladOrderId: existingOperation.moyskladOrderId,
        skippedRows: readSkippedRows(existingOperation.skippedRows) };
    }

    const currentPair = await this.database.entityPair.findFirst({
      where: { entityType: 'DEAL', bitrix24Id: input.bitrix24DealId, active: true },
      select: { bitrix24Id: true, moyskladId: true },
    });
    if (currentPair) return { status: 'ALREADY_PAIRED', bitrix24DealId: currentPair.bitrix24Id, moyskladOrderId: currentPair.moyskladId };

    const retryingExternalAttempt = existingOperation?.status === 'PENDING' && !!existingOperation.attemptedAt;
    const storedPairIds = existingOperation ? readPairIds(existingOperation.confirmedCustomerPairIds) : [];
    const legacyAttemptMissingPairIds = retryingExternalAttempt && storedPairIds.length === 0;
    const frozenPairIds = existingOperation?.status === 'WAITING' || legacyAttemptMissingPairIds
      ? (input.confirmedCustomerPairIds ?? [])
      : existingOperation ? storedPairIds : (input.confirmedCustomerPairIds ?? []);
    const operationInput = existingOperation && existingOperation.status !== 'WAITING'
      ? { ...input, confirmedCustomerPairIds: frozenPairIds, payload: existingOperation.payload as unknown as DealOrderPreparedInput['payload'] }
      : { ...input, confirmedCustomerPairIds: frozenPairIds };
    validatePreparedOrder(operationInput);
    if (!retryingExternalAttempt || legacyAttemptMissingPairIds) await this.verifyConfiguredDependencies(operationInput);
    const operation = existingOperation?.status === 'WAITING'
      ? await this.database.dealOrderCreateOperation.update({
          where: { bitrix24DealId: input.bitrix24DealId },
          data: { payload: input.payload as Prisma.InputJsonValue, confirmedCustomerPairIds: frozenPairIds as Prisma.InputJsonValue, skippedRows: (input.skippedRows ?? []) as Prisma.InputJsonValue, settingsVersion: input.settingsVersion, status: 'PENDING', lastErrorCategory: null },
        })
      : existingOperation ?? await this.getOrCreateOperation(input);
    if (legacyAttemptMissingPairIds) {
      await this.database.dealOrderCreateOperation.update({ where: { bitrix24DealId: input.bitrix24DealId }, data: { confirmedCustomerPairIds: frozenPairIds as Prisma.InputJsonValue } });
    }
    if ((operation.status === 'SUCCEEDED' || operation.status === 'PARTIAL') && operation.moyskladOrderId) {
      return { status: operation.status === 'PARTIAL' ? 'PARTIAL' : 'CREATED', bitrix24DealId: input.bitrix24DealId, moyskladOrderId: operation.moyskladOrderId,
        skippedRows: readSkippedRows(operation.skippedRows) };
    }
    if (operation.status !== 'PENDING') throw new Error(`Customer-order create operation is ${operation.status}`);

    // The first fully prepared payload is immutable across retries. In
    // particular, a timeout after POST must reuse the same MySklad syncId and
    // exact positions rather than building a second document from a later event.
    const payload = operation.payload as unknown as DealOrderPreparedInput['payload'];
    const leaseToken = randomUUID();
    const leaseNow = new Date();
    const lease = await this.database.dealOrderCreateOperation.updateMany({
      where: { bitrix24DealId: input.bitrix24DealId, status: 'PENDING', OR: [{ leaseUntil: null }, { leaseUntil: { lte: leaseNow } }] },
      data: { attemptedAt: operation.attemptedAt ?? leaseNow, leaseToken, leaseUntil: new Date(leaseNow.getTime() + 60_000) },
    });
    if (lease.count !== 1) throw new Error('Customer-order create is already in progress');
    const base = moyskladBase();
    const token = process.env.MOYSKLAD_API_TOKEN;
    try {
      if (!token) throw new Error('Customer-order create is not configured');
      let orderId = operation.moyskladOrderId;
      if (!orderId) {
        const created = await this.runCreateMutationAllowed(input, leaseToken, assertWorkerLease, () => requestJson(new URL('entity/customerorder', withSlash(base)), {
          method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ ...payload, syncId: operation.syncId }),
        }));
        if (!isRecord(created) || !isUuid(created.id) || !isRecord(created.meta) || created.meta.type !== 'customerorder') {
          throw new Error('Customer-order create response was invalid');
        }
        const savedId = await this.database.dealOrderCreateOperation.updateMany({
          where: { bitrix24DealId: input.bitrix24DealId, leaseToken },
          data: { moyskladOrderId: created.id },
        });
        if (savedId.count !== 1) throw new Error('Customer-order create lease was lost after provider success');
        orderId = created.id;
      }

      if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') this.controlledAdmission.allowTargetReadback('MOYSKLAD', orderId);
      const order = await requestJson(new URL(`entity/customerorder/${encodeURIComponent(orderId)}?expand=positions`, withSlash(base)), {
        method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      const expectedNativeFields = {
        ...('shipmentAddress' in payload ? { shipmentAddress: payload.shipmentAddress } : {}),
        ...('vatIncluded' in payload ? { vatIncluded: payload.vatIncluded } : {}),
      };
      const verifiedPositions = assertOrderReadback(order, orderId, payload.positions, payload.attributes ?? [], base, expectedNativeFields);
      if (!isRecord(order) || typeof order.name !== 'string' || !order.name.trim()) {
        throw new Error('Customer-order native number is unavailable');
      }
      if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
        const scope = await this.controlledAdmission.scopeForEvent(input.eventId);
        const createdAt = parseMoySkladCreatedAt(order.created);
        if (order.description !== scope.admittedSourceName || !createdAt) throw new Error('CONTROLLED_LIVE_TEST_TARGET_READBACK_INVALID');
        await this.controlledAdmission.bindCreatedTarget(input.eventId, orderId, orderId, order.name, createdAt, scope.runId);
      }
      const shouldWriteSourceNumber = !this.controlledAdmission || process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled' || await this.controlledAdmission.allowsSourceSideWrite(input.eventId);
      if (shouldWriteSourceNumber) await this.runCreateMutationAllowed(input, leaseToken, assertWorkerLease, () => writeBitrixOrderNumber(input.bitrix24DealId, order.name));

      return await this.persistPair(input, orderId, leaseToken, verifiedPositions);
    } catch (error) {
      await this.database.dealOrderCreateOperation.updateMany({
        where: { bitrix24DealId: input.bitrix24DealId, leaseToken },
        data: { leaseToken: null, leaseUntil: null, lastErrorCategory: 'CREATE_RETRYABLE' },
      }).catch(() => undefined);
      throw error;
    }
  }

  private async verifyConfiguredDependencies(input: DealOrderPreparedInput) {
    const agentId = referenceId(input.payload.agent.meta.href);
    const confirmedPairIds = input.confirmedCustomerPairIds ?? [];
    if (!confirmedPairIds.length) {
      if ((input.bitrix24CompanyId !== null) || (input.bitrix24ContactId ?? null) !== null ||
          !input.serviceCounterpartyId || input.serviceCounterpartyId !== agentId) {
        throw new Error('Prepared customer-order service counterparty is not valid for a clientless deal');
      }
    }
    const customerPairs = await this.database.entityPair.findMany({
      where: { id: { in: confirmedPairIds }, entityType: { in: ['COMPANY', 'CONTACT'] }, active: true },
      select: { id: true, entityType: true, bitrix24Id: true, moyskladId: true },
    });
    if (customerPairs.length !== confirmedPairIds.length ||
        (confirmedPairIds.length > 0 && !customerPairs.some((pair) => pair.moyskladId === agentId))) {
      throw new Error('Prepared customer-order customer dependency pair is not active');
    }
    if (input.bitrix24CompanyId !== null) {
      if (!customerPairs.some((pair) => pair.entityType === 'COMPANY' && pair.bitrix24Id === input.bitrix24CompanyId && pair.moyskladId === agentId)) {
        throw new Error('Prepared customer-order company pair is not active');
      }
    } else if ((input.bitrix24ContactId ?? null) !== null) {
      const contactPair = customerPairs.some((pair) => pair.entityType === 'CONTACT' && pair.bitrix24Id === input.bitrix24ContactId);
      const primaryCompanyPair = customerPairs.some((pair) => pair.entityType === 'COMPANY' && pair.moyskladId === agentId);
      if (!contactPair && !primaryCompanyPair) throw new Error('Prepared customer-order contact dependency pair is not active');
    } else {
      throw new Error('Prepared customer-order customer dependency source is missing');
    }

    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!token) throw new Error('Customer-order dependency reads are not configured');
    for (const [reference, type] of [
      [input.payload.agent, 'counterparty'],
      [input.payload.organization, 'organization'],
      [input.payload.store, 'store'],
      [input.payload.owner, 'employee'],
      [input.payload.rate.currency, 'currency'],
      [input.payload.state, 'state'],
    ] as Array<[Reference, string]>) {
      const result = await requestJson(new URL(reference.meta.href), {
        method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      const expectedId = referenceId(reference.meta.href);
      if (!isRecord(result) || result.id !== expectedId || !isRecord(result.meta) || result.meta.type !== type) {
        throw new Error(`Prepared customer-order ${type} reference is unavailable`);
      }
    }

    const positions = input.payload.positions;
    if (input.sourceProductIds.length !== positions.length || input.sourceMeasureCodes.length !== positions.length || input.sourceRowIds.length !== positions.length || input.sourceRowValues.length !== positions.length) {
      throw new Error('Prepared customer-order row mappings are incomplete');
    }
    const targetProducts = new Map<string, { id: string; uomId: string | null }>();
    for (let index = 0; index < positions.length; index++) {
      const sourceProductId = input.sourceProductIds[index];
      const sourceMeasureCode = input.sourceMeasureCodes[index];
      if (!/^\d{1,20}$/.test(sourceProductId) || !Number.isInteger(sourceMeasureCode) || sourceMeasureCode < 1) {
        throw new Error('Prepared customer-order product or unit identity is invalid');
      }
      const mappedUnit = input.unitMappings.find((unit) => unit.bitrix24Id === sourceMeasureCode && unit.status === 'configured' && unit.moyskladId);
      if (!mappedUnit?.moyskladId) throw new Error(`Customer-order unit ${sourceMeasureCode} is not mapped`);
      const targetId = referenceId(positions[index].assortment.meta.href);
      const productPair = await this.database.entityPair.findFirst({
        where: { entityType: 'PRODUCT', bitrix24Id: sourceProductId, moyskladId: targetId, active: true },
        select: { id: true },
      });
      if (!productPair) throw new Error(`Customer-order product ${sourceProductId} does not have an active pair`);
      const prior = targetProducts.get(targetId);
      if (prior) {
        if (prior.uomId !== mappedUnit.moyskladId) throw new Error(`Customer-order product ${sourceProductId} has incompatible row units`);
        continue;
      }
      const pathType = positions[index].assortment.meta.type;
      const product = await requestJson(new URL(`entity/${pathType}/${encodeURIComponent(targetId)}`, withSlash(moyskladBase())), {
        method: 'GET', headers: { authorization: `Bearer ${process.env.MOYSKLAD_API_TOKEN ?? ''}`, accept: 'application/json' },
      });
      if (!isRecord(product) || product.id !== targetId || !isRecord(product.meta) || product.meta.type !== pathType ||
          !isRecord(product.uom) || product.uom.id !== mappedUnit.moyskladId) {
        throw new Error(`Customer-order product ${sourceProductId} unit does not match its configured row unit`);
      }
      targetProducts.set(targetId, { id: targetId, uomId: product.uom.id });
    }
  }

  private async assertWriteEnabled() {
    if (process.env.SYNC_MODE !== 'apply' || (await this.mode.read()).mode !== 'on') {
      throw new Error('Customer-order create is disabled');
    }
    if (!await this.mode.isDirectionEnabled('deals-orders', 'bitrix24ToMoysklad')) {
      throw new Error('Customer-order create direction is disabled');
    }
  }

  private async runCreateMutationAllowed<T>(input: DealOrderPreparedInput, leaseToken: string, assertWorkerLease: (() => Promise<boolean>) | undefined, mutation: () => Promise<T>): Promise<T> {
    const bitrix24DealId = input.bitrix24DealId;
    const pairs = input.confirmedCustomerPairIds?.length ? await this.database.entityPair.findMany({
      where: { id: { in: input.confirmedCustomerPairIds }, entityType: { in: ['COMPANY', 'CONTACT'] } }, select: { id: true, entityType: true },
    }) : [];
    if (pairs.length !== (input.confirmedCustomerPairIds?.length ?? 0)) throw new Error('Confirmed customer lifecycle pairs changed before provider write');
    return this.mode.runDealOrderExternalWrite('bitrix24ToMoysklad', async () => {
      if (assertWorkerLease && !await assertWorkerLease()) return false;
      const operation = await this.database.dealOrderCreateOperation.findUnique({ where: { bitrix24DealId }, select: { leaseToken: true, leaseUntil: true } });
      return operation?.leaseToken === leaseToken && !!operation.leaseUntil && operation.leaseUntil > new Date();
    }, pairs, mutation);
  }

  private async getOrCreateOperation(input: DealOrderPreparedInput) {
    const existing = await this.database.dealOrderCreateOperation.findUnique({ where: { bitrix24DealId: input.bitrix24DealId } });
    if (existing) return existing;
    try {
      return await this.database.dealOrderCreateOperation.create({
        data: {
          bitrix24DealId: input.bitrix24DealId,
          syncId: randomUUID(),
          payload: input.payload as Prisma.InputJsonValue,
          confirmedCustomerPairIds: (input.confirmedCustomerPairIds ?? []) as Prisma.InputJsonValue,
          skippedRows: (input.skippedRows ?? []) as Prisma.InputJsonValue,
          settingsVersion: input.settingsVersion,
          status: 'PENDING',
        },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const raced = await this.database.dealOrderCreateOperation.findUnique({ where: { bitrix24DealId: input.bitrix24DealId } });
      if (!raced) throw error;
      return raced;
    }
  }

  private async persistPair(input: DealOrderPreparedInput, moyskladOrderId: string, leaseToken: string, positions: Array<{ id: string; values: Record<string, unknown> }>): Promise<Result> {
    return this.database.$transaction(async (transaction) => {
      await lockEntityPairState(transaction);
      const operation = await transaction.dealOrderCreateOperation.findFirst({
        where: { bitrix24DealId: input.bitrix24DealId, status: 'PENDING', leaseToken }, select: { bitrix24DealId: true },
      });
      if (!operation) throw new Error('Customer-order create lease was lost before pair persistence');
      const byDeal = await transaction.entityPair.findFirst({ where: { entityType: 'DEAL', bitrix24Id: input.bitrix24DealId, active: true } });
      const byOrder = await transaction.entityPair.findFirst({ where: { entityType: 'DEAL', moyskladId: moyskladOrderId, active: true } });
      if ((byDeal && byDeal.moyskladId !== moyskladOrderId) || (byOrder && byOrder.bitrix24Id !== input.bitrix24DealId)) {
        throw new DealOrderPairConflictError();
      }
      if (!byDeal) {
        const pair = await transaction.entityPair.create({
          data: {
            entityType: 'DEAL', bitrix24Id: input.bitrix24DealId, moyskladId: moyskladOrderId,
            source: 'AUTOMATIC', reason: `Created from Bitrix24 event ${input.eventId}`,
          },
        });
        const rowLinks = correlateRows(input, positions);
        if (rowLinks.length !== input.sourceRowIds.length) throw new Error('Customer-order positions could not be paired unambiguously');
        await transaction.dealOrderPositionPair.createMany({
          data: rowLinks.map((link) => ({
            pairId: pair.id,
            bitrix24ProductRowId: link.bitrix24ProductRowId,
            moyskladPositionId: link.moyskladPositionId,
            bitrix24Values: link.bitrix24Values as Prisma.InputJsonValue,
            moyskladValues: link.moyskladValues as Prisma.InputJsonValue,
          })),
        });
      }
      const skippedRows = readSkippedRows(await transaction.dealOrderCreateOperation.findUniqueOrThrow({ where: { bitrix24DealId: input.bitrix24DealId }, select: { skippedRows: true } }).then((item) => item.skippedRows));
      const partial = skippedRows.length > 0;
      await transaction.dealOrderCreateOperation.update({
        where: { bitrix24DealId: input.bitrix24DealId },
        data: { status: partial ? 'PARTIAL' : 'SUCCEEDED', moyskladOrderId, lastErrorCategory: partial ? 'ROWS_SKIPPED' : null, leaseToken: null, leaseUntil: null },
      });
      await transaction.pairReviewCase.updateMany({
        where: { entityType: 'DEAL', sourceSystem: 'BITRIX24', sourceEntityId: input.bitrix24DealId, status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
      return { status: partial ? 'PARTIAL' : 'CREATED', bitrix24DealId: input.bitrix24DealId, moyskladOrderId, ...(partial ? { skippedRows } : {}) };
    }, { timeout: 30_000 });
  }
}

function validatePreparedOrder(input: DealOrderPreparedInput) {
  if (!/^\d{1,20}$/.test(input.bitrix24DealId) ||
      (input.bitrix24CompanyId !== null && !/^\d{1,20}$/.test(input.bitrix24CompanyId)) ||
      (input.bitrix24ContactId != null && !/^\d{1,20}$/.test(input.bitrix24ContactId)) ||
      !Array.isArray(input.confirmedCustomerPairIds) ||
      input.confirmedCustomerPairIds.length > 10 || new Set(input.confirmedCustomerPairIds).size !== input.confirmedCustomerPairIds.length ||
      input.confirmedCustomerPairIds.some((id) => typeof id !== 'string' || !id.trim()) ||
      !input.eventId || !Number.isInteger(input.settingsVersion) || input.settingsVersion < 1) {
    throw new Error('Prepared customer-order identity is invalid');
  }
  const base = moyskladBase();
  assertReference(input.payload.agent, 'counterparty', base);
  assertReference(input.payload.organization, 'organization', base);
  assertReference(input.payload.store, 'store', base);
  assertReference(input.payload.state, 'state', base);
  assertReference(input.payload.owner, 'employee', base);
  assertReference(input.payload.rate.currency, 'currency', base);
  if (!Array.isArray(input.payload.positions) || input.payload.positions.length > 1000) {
    throw new Error('Prepared customer-order positions are incomplete');
  }
  if ('shipmentAddress' in input.payload && !(input.payload.shipmentAddress === null || typeof input.payload.shipmentAddress === 'string')) {
    throw new Error('Prepared customer-order shipment address is invalid');
  }
  for (const position of input.payload.positions) {
    if (!isRecord(position) || !isRecord(position.assortment) || !isRecord(position.assortment.meta) ||
        position.assortment.meta.type !== 'product' ||
        !isUuidFromHref(position.assortment.meta.href, base, String(position.assortment.meta.type)) ||
        typeof position.quantity !== 'number' || !Number.isFinite(position.quantity) || position.quantity <= 0 ||
        typeof position.price !== 'number' || !Number.isSafeInteger(position.price) || position.price < 0 ||
        typeof position.discount !== 'number' || !Number.isFinite(position.discount) ||
        typeof position.vat !== 'number' || !Number.isInteger(position.vat) ||
        typeof position.vatEnabled !== 'boolean') {
      throw new Error('Prepared customer-order position is incomplete or unsupported');
    }
  }
  if (input.payload.attributes !== undefined) {
    if (!Array.isArray(input.payload.attributes) || input.payload.attributes.length > 100 || new Set(input.payload.attributes.map((attribute) => attribute.meta?.href)).size !== input.payload.attributes.length) {
      throw new Error('Prepared customer-order attributes are incomplete');
    }
    for (const attribute of input.payload.attributes) {
      const href = isRecord(attribute.meta) && typeof attribute.meta.href === 'string' ? new URL(attribute.meta.href) : null;
      const id = href?.origin === base.origin && !href.search && !href.hash
        ? href.pathname.match(/\/entity\/customerorder\/metadata\/attributes\/([0-9a-f-]{36})$/i)?.[1]
        : null;
      if (!id || attribute.meta.type !== 'attributemetadata' || attribute.meta.mediaType !== 'application/json' ||
          !isValidAttributeValue(attribute.value, base)) {
        throw new Error('Prepared customer-order attribute is invalid');
      }
    }
  }
}

function assertReference(reference: Reference, type: string, base: URL) {
  if (!isRecord(reference) || !isRecord(reference.meta) || reference.meta.type !== type ||
      !(type === 'state' ? isStateHref(reference.meta.href, base) : isUuidFromHref(reference.meta.href, base, type))) {
    throw new Error(`Prepared customer-order ${type} reference is invalid`);
  }
}

function referenceId(href: string): string {
  const id = new URL(href).pathname.split('/').at(-1);
  if (!isUuid(id)) throw new Error('Prepared customer-order reference ID is invalid');
  return id;
}

function readPairIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && !!id.trim());
}

function readSkippedRows(value: unknown): Array<{ sourceRowId: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { sourceRowId: string; reason: string } => isRecord(item) &&
    typeof item.sourceRowId === 'string' && typeof item.reason === 'string');
}

function assertOrderReadback(value: unknown, expectedId: string, expectedPositions: CustomerOrderPosition[], expectedAttributes: NonNullable<DealOrderPreparedInput['payload']['attributes']>, base: URL, expectedNativeFields: Record<string, unknown>): Array<{ id: string; values: Record<string, unknown> }> {
  if (!isRecord(value) || value.id !== expectedId || !isRecord(value.meta) || value.meta.type !== 'customerorder' ||
      !isRecord(value.positions) || !Array.isArray(value.positions.rows)) {
    throw new Error('Customer-order readback failed');
  }
  const rows = value.positions.rows;
  if ('vatIncluded' in expectedNativeFields && value.vatIncluded !== expectedNativeFields.vatIncluded) {
    throw new Error('Customer-order VAT inclusion readback differs from the prepared order');
  }
  for (const expected of expectedAttributes) {
    const expectedId = expected.meta.href.match(/\/metadata\/attributes\/([0-9a-f-]{36})$/i)?.[1];
    if (!expectedId) throw new Error('Customer-order attribute ID is invalid');
    const attributes = Array.isArray(value.attributes) ? value.attributes.filter(isRecord) : [];
    const matches = attributes.filter((attribute) => attribute.id === expectedId || attributeIdFromMeta(attribute.meta) === expectedId);
    const actual = matches.length === 1 ? matches[0].value ?? null : matches.length === 0 ? null : Symbol('ambiguous');
    if (typeof actual === 'symbol' || !sameAttributeValue(actual, expected.value, base)) throw new Error('Customer-order attribute readback differs from prepared value');
  }
  for (const [field, expected] of Object.entries(expectedNativeFields)) {
    if (field === 'vatIncluded') continue;
    if (field !== 'shipmentAddress' || !sameScalar(value[field] ?? null, expected)) throw new Error('Customer-order native field readback differs from prepared value');
  }
  if (rows.length !== expectedPositions.length) throw new Error('Customer-order readback positions differ from the prepared order');
  const remaining = rows.slice();
  const verified: Array<{ id: string; values: Record<string, unknown> }> = [];
  for (const expected of expectedPositions) {
    const matches = remaining.map((row, index) => positionMatches(row, expected) ? index : -1).filter((index) => index >= 0);
    if (matches.length !== 1) throw new Error('Customer-order readback positions are missing or ambiguous');
    const [row] = remaining.splice(matches[0], 1);
    if (!isRecord(row) || !isUuid(row.id)) throw new Error('Customer-order readback position ID is unavailable');
    verified.push({ id: row.id, values: row });
  }
  return verified;
}

function attributeIdFromMeta(meta: unknown): string | null {
  if (!isRecord(meta) || typeof meta.href !== 'string') return null;
  return meta.href.match(/\/metadata\/attributes\/([0-9a-f-]{36})(?:\?.*)?$/i)?.[1] ?? null;
}

function sameScalar(left: unknown, right: unknown): boolean {
  if ((left === undefined || left === null) && right === null) return true;
  return left === right;
}

function isValidAttributeValue(value: unknown, base: URL): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return true;
  if (!isRecord(value) || !isRecord(value.meta) || value.meta.type !== 'customentity' || typeof value.meta.href !== 'string') return false;
  try {
    const href = new URL(value.meta.href);
    return href.origin === base.origin && !href.search && !href.hash &&
      href.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/entity/customentity/`) &&
      /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(href.pathname.slice(`${base.pathname.replace(/\/$/, '')}/entity/customentity/`.length));
  } catch { return false; }
}

function sameAttributeValue(left: unknown, right: unknown, base: URL): boolean {
  if ((left === null || left === undefined) && right === null) return true;
  if (sameScalar(left, right)) return true;
  if (!isValidAttributeValue(left, base) || !isValidAttributeValue(right, base) || !isRecord(left) || !isRecord(right) || !isRecord(left.meta) || !isRecord(right.meta)) return false;
  return left.meta.type === right.meta.type && left.meta.href === right.meta.href;
}

function correlateRows(input: DealOrderPreparedInput, positions: Array<{ id: string; values: Record<string, unknown> }>) {
  if (input.sourceRowIds.length !== positions.length || input.sourceRowValues.length !== positions.length || new Set(input.sourceRowIds).size !== input.sourceRowIds.length) return [];
  return positions.map((position, index) => ({
    bitrix24ProductRowId: input.sourceRowIds[index],
    moyskladPositionId: position.id,
    bitrix24Values: input.sourceRowValues[index],
    moyskladValues: position.values,
  }));
}

function positionMatches(value: unknown, expected: CustomerOrderPosition): boolean {
  if (!isRecord(value) || !isRecord(value.assortment) || !isRecord(value.assortment.meta)) return false;
  const expectedMeta = expected.assortment.meta;
  return value.assortment.meta.type === expectedMeta.type && value.assortment.meta.href === expectedMeta.href &&
    value.quantity === expected.quantity && value.price === expected.price && value.discount === expected.discount &&
    value.vat === expected.vat && value.vatEnabled === expected.vatEnabled;
}

async function requestJson(url: URL, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) })
    .catch(() => { throw new Error('Customer-order API request failed'); });
  if (!response.ok) throw new Error(init.method === 'GET' ? 'Customer-order readback failed' : 'Customer-order create request failed');
  return response.json().catch(() => { throw new Error('Customer-order API response was invalid'); });
}

function moyskladBase(): URL {
  const value = process.env.MOYSKLAD_API_BASE_URL;
  try {
    const base = new URL(value ?? '');
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !(local && base.protocol === 'http:')) || base.username || base.password) throw new Error();
    return base;
  } catch { throw new Error('Customer-order API endpoint is invalid'); }
}

async function writeBitrixOrderNumber(dealId: string, orderName: string) {
  const base = bitrixBase();
  const read = async () => {
    const response = await fetch(new URL('crm.deal.get.json', withSlash(base)), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: dealId }), redirect: 'error', signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new Error('Bitrix24 customer-order number read failed'); });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body) || body.error || !isRecord(body.result)) throw new Error('Bitrix24 customer-order number read failed');
    return body.result;
  };
  const current = await read();
  if (current.UF_CRM_1729757435964 !== orderName) {
    const response = await fetch(new URL('crm.deal.update.json', withSlash(base)), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: dealId, 'fields[UF_CRM_1729757435964]': orderName }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new Error('Bitrix24 customer-order number update failed'); });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body) || body.error || body.result !== true) throw new Error('Bitrix24 customer-order number update failed');
  }
  const verified = await read();
  if (verified.UF_CRM_1729757435964 !== orderName) throw new Error('Bitrix24 customer-order number readback failed');
}

function bitrixBase(): URL {
  try {
    const base = new URL(process.env.BITRIX24_REST_BASE_URL ?? '');
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !(local && base.protocol === 'http:')) || base.username || base.password) throw new Error();
    return base;
  } catch { throw new Error('Bitrix24 REST endpoint is invalid'); }
}

function withSlash(url: URL): string { return url.href.endsWith('/') ? url.href : `${url.href}/`; }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function isUuidFromHref(value: unknown, base: URL, type: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === base.origin && url.pathname.endsWith(`/entity/${type}/${url.pathname.split('/').at(-1)}`) &&
      isUuid(url.pathname.split('/').at(-1));
  } catch { return false; }
}
function isStateHref(value: unknown, base: URL): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === base.origin && /\/entity\/customerorder\/metadata\/states\/[0-9a-f-]{36}$/i.test(url.pathname) && isUuid(url.pathname.split('/').at(-1));
  } catch { return false; }
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isUniqueConstraintViolation(error: unknown): boolean { return isRecord(error) && error.code === 'P2002'; }
function parseMoySkladCreatedAt(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const local = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)$/.exec(value);
  const date = new Date(local ? `${local[1]}T${local[2]}+03:00` : value);
  return Number.isFinite(date.getTime()) ? date : null;
}
