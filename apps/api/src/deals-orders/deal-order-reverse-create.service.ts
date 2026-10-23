import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database.service';
import { CLIENT_DEPENDENCY_RESOLVER, ClientDependencyResolver } from '../clients/client-dependency-resolver';
import { NamedReferencePair, VersionedFieldSettingsDto } from '../field-settings/field-settings.dto';
import { lockEntityPairState } from '../pairs/pair-db-lock';
import { SyncModeService } from '../sync-mode.service';
import { writeOperationalLog } from '../monitoring-log';
import { resolveDictionaryValue } from './deal-order-field-runtime.service';
import { moySkladMoneyToBitrix } from './deal-order-money';
import { ProductCatalogCreateService } from '../products/product-catalog-create.service';
import { moyskladUomReferenceId } from './moysklad-uom-reference';
import { matchesReverseUnit } from '../field-settings/unit-reference';
import { ControlledLiveTestAdmissionService } from '../controlled-live-test-admission.service';
import { ServiceModeNotOnError, withServiceModeOn } from '../service-mode-transaction';
import type { EventWorkerLeaseContext } from '../event-worker-lease.service';
import { ProviderFailure, providerResponseFailure } from '../provider-failure';
import { assertNoForwardOrderOwner, ForwardOrderPairPendingError } from './forward-order-origin';

type Row = Record<string, unknown>;
type PreparedRow = { msPositionId: string; snapshot: Row; fields: { ownerId: number; ownerType: 'D'; productId: number; price: number; quantity: number; discountTypeId: 2; discountRate: number; discountSum: 0; taxRate: number | null; taxIncluded: 'Y' | 'N'; measureCode: number; sort: number } };
type Prepared = { orderId: string; eventId: string; settingsVersion: number; sourceSnapshot: Row; fields: Row; rows: PreparedRow[]; skippedRows: Array<{ sourceRowId: string; reason: string }>; companyPairId: string | null; companyId: string | null };
type ReverseStage = { bitrix24StageId: string; moyskladId: string; creationEnabled: boolean };

export function resolveReverseOrderStage(input: {
  sourceStageId: string;
  stages: readonly ReverseStage[];
  namedPairs: readonly Pick<NamedReferencePair, 'kind' | 'bitrix24Id' | 'moyskladId' | 'status'>[];
  unmappedReferencePolicy?: 'hold' | 'confirmed-defaults';
}): { status: 'MAPPED' | 'FALLBACK' | 'UNMAPPED' | 'DISABLED'; stage?: ReverseStage } {
  const mapped = input.stages.find((candidate) => candidate.moyskladId === input.sourceStageId);
  if (mapped) return mapped.creationEnabled ? { status: 'MAPPED', stage: mapped } : { status: 'DISABLED' };
  if (input.unmappedReferencePolicy !== 'confirmed-defaults') return { status: 'UNMAPPED' };
  const candidates = input.stages.filter((candidate) =>
    isMainPreparationStage(candidate.bitrix24StageId) && candidate.creationEnabled &&
    hasUniqueConfirmedStagePair(candidate, input.namedPairs));
  return candidates.length === 1 ? { status: 'FALLBACK', stage: candidates[0] } : { status: 'UNMAPPED' };
}

export type ReverseCreateResult = { status: 'CREATED' | 'PARTIAL' | 'ALREADY_PAIRED'; bitrix24DealId: string; skippedRows?: Array<{ sourceRowId: string; reason: string }> };
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
    @Optional() private readonly productCatalogCreate?: ProductCatalogCreateService,
    @Optional() private readonly controlledAdmission?: ControlledLiveTestAdmissionService,
  ) {}

  private async providerRequest(url: URL, init: RequestInit): Promise<unknown> {
    const result = await withServiceModeOn(this.database, async () => requestJson(url, init));
    if (!result.enabled) throw new ServiceModeNotOnError();
    return result.value;
  }

  private readonly providerGate = (url: URL, init: RequestInit) => this.providerRequest(url, init);

  async createAndPair(input: { moyskladOrderId: string; eventId: string; eventConfig: VersionedFieldSettingsDto; assertWorkerLease?: () => Promise<void>; workerLease?: EventWorkerLeaseContext; controlledSyntheticName?: string }): Promise<ReverseCreateResult> {
    if (!isUuid(input.moyskladOrderId)) throw new Error('Customer-order identity is invalid');
    if (process.env.SYNC_MODE !== 'apply' || (await this.mode.read()).mode !== 'on' || !await this.mode.isDirectionEnabled('deals-orders', 'moyskladToBitrix24')) {
      throw new Error('Reverse deal creation is disabled');
    }
    if (!this.clients) throw new Error('Client dependency resolver is unavailable');

    let operation = await this.database.dealOrderReverseCreateOperation.findUnique({ where: { moyskladOrderId: input.moyskladOrderId }, include: { positions: { orderBy: { moyskladPositionId: 'asc' } } } });
    if ((operation?.status === 'SUCCEEDED' || operation?.status === 'PARTIAL') && operation.bitrix24DealId) return { status: operation.status === 'PARTIAL' ? 'PARTIAL' : 'CREATED', bitrix24DealId: operation.bitrix24DealId, skippedRows: readSkippedRows(operation.skippedRows) };
    const existingPair = await this.database.entityPair.findFirst({ where: { entityType: 'DEAL', moyskladId: input.moyskladOrderId, active: true }, select: { bitrix24Id: true } });
    if (existingPair) return { status: 'ALREADY_PAIRED', bitrix24DealId: existingPair.bitrix24Id };
    await assertNoForwardOrderOwner(this.database, input.moyskladOrderId);
    if (!operation || operation.status === 'WAITING') {
      const prepared = await this.prepare(input);
      if (input.controlledSyntheticName && this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
        prepared.fields.title = input.controlledSyntheticName;
        prepared.fields.UF_CRM_1729757435964 = input.controlledSyntheticName;
        prepared.sourceSnapshot.name = input.controlledSyntheticName;
      }
      const payload = serializePrepared(prepared);
      if (operation) {
          operation = await this.database.dealOrderReverseCreateOperation.update({ where: { moyskladOrderId: input.moyskladOrderId }, data: { payload: payload as Prisma.InputJsonValue, skippedRows: prepared.skippedRows as Prisma.InputJsonValue, settingsVersion: input.eventConfig.version, status: 'PENDING', lastErrorCategory: null }, include: { positions: true } });
      } else {
        try {
          operation = await this.database.dealOrderReverseCreateOperation.create({ data: { moyskladOrderId: input.moyskladOrderId, eventId: input.eventId, syncId: randomUUID(), payload: payload as Prisma.InputJsonValue, skippedRows: prepared.skippedRows as Prisma.InputJsonValue, settingsVersion: input.eventConfig.version, status: 'PENDING' }, include: { positions: true } });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          operation = await this.database.dealOrderReverseCreateOperation.findUniqueOrThrow({ where: { moyskladOrderId: input.moyskladOrderId }, include: { positions: { orderBy: { moyskladPositionId: 'asc' } } } });
          if (operation.status !== 'PENDING') throw new Error(`Reverse deal creation is ${operation.status}`);
        }
      }
      for (const row of prepared.rows) {
        await this.database.dealOrderReversePositionOperation.upsert({
          where: { moyskladOrderId_moyskladPositionId: { moyskladOrderId: input.moyskladOrderId, moyskladPositionId: row.msPositionId } },
          create: { moyskladOrderId: input.moyskladOrderId, moyskladPositionId: row.msPositionId, payload: row as unknown as Prisma.InputJsonValue },
          update: {},
        });
      }
      for (const skipped of prepared.skippedRows) {
        await this.database.dealOrderReversePositionOperation.upsert({
          where: { moyskladOrderId_moyskladPositionId: { moyskladOrderId: input.moyskladOrderId, moyskladPositionId: skipped.sourceRowId } },
          create: { moyskladOrderId: input.moyskladOrderId, moyskladPositionId: skipped.sourceRowId, payload: { sourceRowId: skipped.sourceRowId, reason: skipped.reason } as Prisma.InputJsonValue, status: 'SKIPPED', skipReason: skipped.reason },
          update: { status: 'SKIPPED', skipReason: skipped.reason },
        });
      }
      operation = await this.database.dealOrderReverseCreateOperation.findUniqueOrThrow({ where: { moyskladOrderId: input.moyskladOrderId }, include: { positions: { orderBy: { moyskladPositionId: 'asc' } } } });
    }
    if (operation.status !== 'PENDING') throw new Error(`Reverse deal creation is ${operation.status}`);
    const prepared = deserializePrepared(operation.payload);
    const leaseToken = randomUUID();
    const now = new Date();
    const gatedClaim = await withServiceModeOn(this.database, (transaction) => transaction.dealOrderReverseCreateOperation.updateMany({
      where: { moyskladOrderId: input.moyskladOrderId, status: 'PENDING', OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      data: { leaseToken, attemptedAt: operation.attemptedAt ?? now, leaseUntil: new Date(now.getTime() + 60_000) },
    }));
    if (!gatedClaim.enabled) throw new ServiceModeNotOnError();
    const claim = gatedClaim.value;
    if (claim.count !== 1) throw new Error('Reverse deal create is already in progress');
    try {
      const dealId = operation.bitrix24DealId ?? await this.createOrRecoverDeal(prepared, leaseToken, input.assertWorkerLease);
      if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') this.controlledAdmission.allowTargetReadback('BITRIX24', dealId);
      const verified = await this.verifyDeal(dealId, prepared, leaseToken, input.assertWorkerLease);
      if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
        const createdAt = parseBitrixCreatedAt(verified.createdTime ?? verified.DATE_CREATE);
        if (!createdAt) throw new DealOrderReverseManualReviewError('Controlled target creation timestamp is unavailable');
        await this.controlledAdmission.bindCreatedTarget(input.eventId, dealId, dealId, String(verified.title ?? ''), createdAt);
      }
      await this.createRows(prepared, leaseToken, input.assertWorkerLease ? async () => { await input.assertWorkerLease!(); return true; } : undefined);
      return await this.persistPair(prepared, dealId, leaseToken);
    } catch (error) {
      if (error instanceof ServiceModeNotOnError) throw error;
      // Only a NEW, previously unattempted journal blocked before its first
      // B24 ADD can be returned to preparation. Never reset an older uncertain
      // reverse write. This also avoids poisoning future paired row additions
      // with a stale, never-sent reverse-document payload.
      const waitingForForward = error instanceof ForwardOrderPairPendingError && !operation.attemptedAt && !operation.bitrix24DealId;
      await this.database.dealOrderReverseCreateOperation.updateMany({ where: { moyskladOrderId: input.moyskladOrderId, leaseToken }, data: {
        leaseToken: null, leaseUntil: null, lastErrorCategory: waitingForForward ? 'FORWARD_ORDER_PAIR_PENDING' : 'REVERSE_CREATE_RETRYABLE',
        ...(waitingForForward ? { status: 'WAITING' } : {}),
      } }).catch(() => undefined);
      throw error;
    }
  }

  /** Add only explicitly unlinked MS positions to the existing Bitrix24 deal.
   * The parent operation is a durable row-add journal; no document create or
   * replacement-pair path is invoked. */
  async addPositionsToExistingPair(input: { pairId: string; bitrix24DealId: string; moyskladOrderId: string; eventId: string; eventConfig: VersionedFieldSettingsDto; positionIds: string[]; assertPairLease: () => Promise<boolean>; workerLease?: EventWorkerLeaseContext }): Promise<{ status: 'ROWS_ADDED' | 'PARTIAL'; skippedRows?: Array<{ sourceRowId: string; reason: string }> }> {
    if (!input.positionIds.length) return { status: 'ROWS_ADDED' };
    if (process.env.SYNC_MODE !== 'apply' || (await this.mode.read()).mode !== 'on' || !await this.mode.isDirectionEnabled('deals-orders', 'moyskladToBitrix24')) throw new Error('Reverse row addition is disabled');
    const pair = await this.database.entityPair.findFirst({ where: { id: input.pairId, entityType: 'DEAL', active: true, bitrix24Id: input.bitrix24DealId, moyskladId: input.moyskladOrderId }, select: { id: true } });
    if (!pair) throw new DealOrderReverseManualReviewError('Existing deal/order pair is not active');
    let operation = await this.database.dealOrderReverseCreateOperation.findUnique({ where: { moyskladOrderId: input.moyskladOrderId } });
    if (operation?.bitrix24DealId && operation.bitrix24DealId !== input.bitrix24DealId) throw new DealOrderReverseManualReviewError('Reverse row-add journal belongs to a different deal');
    if (operation?.status === 'PENDING' && operation.leaseUntil && operation.leaseUntil > new Date()) throw new Error('Reverse row-add operation is already in progress');
    let frozen: Prepared;
    if (operation?.status === 'PENDING') {
      if (operation.settingsVersion !== input.eventConfig.version || !operation.payload) throw new DealOrderReverseManualReviewError('Pending reverse row-add journal does not match the pinned settings');
      frozen = deserializePrepared(operation.payload);
      const journaledIds = new Set([...frozen.rows.map((row) => row.msPositionId), ...frozen.skippedRows.map((row) => row.sourceRowId)]);
      if (frozen.orderId !== input.moyskladOrderId || input.positionIds.some((id) => !journaledIds.has(id)) || [...journaledIds].some((id) => !input.positionIds.includes(id))) {
        throw new DealOrderReverseManualReviewError('Pending reverse row-add source positions changed');
      }
    } else {
      const existingB24Rows = await b24AllRows(input.bitrix24DealId, this.providerGate);
      const nextSort = existingB24Rows.reduce((highest, row) => Math.max(highest, Number(row.sort) || 0), 0) + 1;
      const prepared = await this.prepare({ moyskladOrderId: input.moyskladOrderId, eventId: input.eventId, eventConfig: input.eventConfig, positionIds: new Set(input.positionIds), assertPairLease: input.assertPairLease, workerLease: input.workerLease, writePair: { id: pair.id, entityType: 'DEAL' } });
      frozen = { ...prepared, rows: prepared.rows.map((row, index) => ({ ...row, fields: { ...row.fields, sort: nextSort + index } })), skippedRows: prepared.skippedRows.filter((row) => input.positionIds.includes(row.sourceRowId)) };
    }
    const existingLinks = await this.database.dealOrderPositionPair.findMany({ where: { pairId: input.pairId }, select: { moyskladPositionId: true } });
    const linked = new Set(existingLinks.map((item) => item.moyskladPositionId));
    const rows = frozen.rows.filter((row) => input.positionIds.includes(row.msPositionId) && !linked.has(row.msPositionId));
    const skippedRows = frozen.skippedRows.filter((row) => input.positionIds.includes(row.sourceRowId));
    if (!rows.length && !skippedRows.length) return { status: 'ROWS_ADDED' };
    const storedPayload = serializePrepared(frozen);
    if (!operation) operation = await this.database.dealOrderReverseCreateOperation.create({ data: {
      moyskladOrderId: input.moyskladOrderId, syncId: randomUUID(), eventId: input.eventId, payload: storedPayload as Prisma.InputJsonValue,
      skippedRows: skippedRows as Prisma.InputJsonValue, settingsVersion: input.eventConfig.version, status: 'PENDING', bitrix24DealId: input.bitrix24DealId,
    } });
    else if (operation.status !== 'PENDING') operation = await this.database.dealOrderReverseCreateOperation.update({ where: { moyskladOrderId: input.moyskladOrderId }, data: {
      eventId: input.eventId, payload: storedPayload as Prisma.InputJsonValue, skippedRows: skippedRows as Prisma.InputJsonValue,
      settingsVersion: input.eventConfig.version, status: 'PENDING', bitrix24DealId: input.bitrix24DealId, lastErrorCategory: null,
    } });
    for (const row of frozen.rows) await this.database.dealOrderReversePositionOperation.upsert({
      where: { moyskladOrderId_moyskladPositionId: { moyskladOrderId: input.moyskladOrderId, moyskladPositionId: row.msPositionId } },
      create: { moyskladOrderId: input.moyskladOrderId, moyskladPositionId: row.msPositionId, payload: row as unknown as Prisma.InputJsonValue }, update: { payload: row as unknown as Prisma.InputJsonValue },
    });
    for (const row of frozen.rows) await this.database.dealOrderReversePositionOperation.updateMany({
      where: { moyskladOrderId: input.moyskladOrderId, moyskladPositionId: row.msPositionId, status: 'SKIPPED' },
      data: { status: 'PENDING', skipReason: null },
    });
    for (const skipped of skippedRows) await this.database.dealOrderReversePositionOperation.upsert({
      where: { moyskladOrderId_moyskladPositionId: { moyskladOrderId: input.moyskladOrderId, moyskladPositionId: skipped.sourceRowId } },
      create: { moyskladOrderId: input.moyskladOrderId, moyskladPositionId: skipped.sourceRowId, payload: skipped as unknown as Prisma.InputJsonValue, status: 'SKIPPED', skipReason: skipped.reason },
      update: { status: 'SKIPPED', skipReason: skipped.reason },
    });
    const leaseToken = randomUUID(); const now = new Date();
    const gatedClaim = await withServiceModeOn(this.database, (transaction) => transaction.dealOrderReverseCreateOperation.updateMany({ where: { moyskladOrderId: input.moyskladOrderId, status: 'PENDING', OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      data: { attemptedAt: operation.attemptedAt ?? now, leaseToken, leaseUntil: new Date(now.getTime() + 60_000) } }));
    if (!gatedClaim.enabled) throw new ServiceModeNotOnError();
    const claim = gatedClaim.value;
    if (claim.count !== 1) throw new Error('Reverse row-add lease was lost');
    try {
      await this.createRows(frozen, leaseToken, input.assertPairLease, { id: pair.id, entityType: 'DEAL' });
      const operations = await this.database.dealOrderReversePositionOperation.findMany({ where: { moyskladOrderId: input.moyskladOrderId, moyskladPositionId: { in: frozen.rows.map((row) => row.msPositionId) } } });
      const liveRows = await b24AllRows(input.bitrix24DealId, this.providerGate);
      await this.database.$transaction(async (transaction) => {
        const currentPair = await transaction.entityPair.findFirst({ where: { id: input.pairId, entityType: 'DEAL', active: true, bitrix24Id: input.bitrix24DealId, moyskladId: input.moyskladOrderId }, select: { id: true } });
        if (!currentPair) throw new Error('Existing pair changed before row-link persistence');
        for (const rowOperation of operations) {
          if (rowOperation.status !== 'SUCCEEDED' || !rowOperation.bitrix24ProductRowId) throw new Error('Reverse row-add result is not durable');
          const preparedRow = frozen.rows.find((row) => row.msPositionId === rowOperation.moyskladPositionId);
          const b24 = liveRows.find((row) => String(row.id) === rowOperation.bitrix24ProductRowId);
          if (!preparedRow || !b24 || !sameRow(b24, preparedRow.fields, input.bitrix24DealId)) throw new DealOrderReverseManualReviewError('Added Bitrix24 row failed exact readback');
          await transaction.dealOrderPositionPair.upsert({ where: { pairId_bitrix24ProductRowId: { pairId: input.pairId, bitrix24ProductRowId: rowOperation.bitrix24ProductRowId } },
            create: { pairId: input.pairId, bitrix24ProductRowId: rowOperation.bitrix24ProductRowId, moyskladPositionId: preparedRow.msPositionId,
              bitrix24Values: { id: rowOperation.bitrix24ProductRowId, ...preparedRow.fields } as Prisma.InputJsonValue, moyskladValues: preparedRow.snapshot as Prisma.InputJsonValue }, update: {} });
        }
        await transaction.dealOrderReverseCreateOperation.update({ where: { moyskladOrderId: input.moyskladOrderId }, data: {
          status: skippedRows.length ? 'PARTIAL' : 'SUCCEEDED', leaseToken: null, leaseUntil: null,
          skippedRows: skippedRows as Prisma.InputJsonValue, lastErrorCategory: skippedRows.length ? 'ROWS_SKIPPED' : null,
        } });
      }, { timeout: 30_000 });
      return skippedRows.length ? { status: 'PARTIAL', skippedRows } : { status: 'ROWS_ADDED' };
    } catch (error) {
      if (error instanceof ServiceModeNotOnError) throw error;
      await this.database.dealOrderReverseCreateOperation.updateMany({ where: { moyskladOrderId: input.moyskladOrderId, leaseToken }, data: { leaseToken: null, leaseUntil: null, lastErrorCategory: 'REVERSE_ROW_ADD_RETRYABLE' } }).catch(() => undefined);
      throw error;
    }
  }

  private async prepare(input: { moyskladOrderId: string; eventId: string; eventConfig: VersionedFieldSettingsDto; positionIds?: Set<string>; assertPairLease?: () => Promise<boolean>; assertWorkerLease?: () => Promise<void>; workerLease?: EventWorkerLeaseContext; writePair?: { id: string; entityType: string } }): Promise<Prepared> {
    const config = input.eventConfig.config.dealOrderRuntime;
    if (!config || !config.nativeOrderNumberingVerified) throw new DealOrderReverseManualReviewError('Deal-order runtime settings or native numbering confirmation are missing');
      const order = await msGet(`entity/customerorder/${input.moyskladOrderId}?expand=agent,state,rate.currency`, this.providerGate);
    if (!isRecord(order) || order.id !== input.moyskladOrderId || !isRecord(order.agent) || !isRecord(order.agent.meta) || !isUuid(order.agent.id) || !isRecord(order.state) || !isUuid(order.state.id) || !isRecord(order.rate) || !isRecord(order.rate.currency) || !isUuid(order.rate.currency.id) || typeof order.name !== 'string' || !order.name.trim()) {
      throw new DealOrderReverseManualReviewError('Customer-order header is incomplete');
    }
    if (!input.writePair) await assertNoForwardOrderOwner(this.database, input.moyskladOrderId, order.syncId);
    const stageResolution = resolveReverseOrderStage({
      sourceStageId: order.state.id,
      stages: config.stages,
      namedPairs: input.eventConfig.config.references.namedPairs ?? [],
      unmappedReferencePolicy: config.unmappedReferencePolicy,
    });
    const stage = stageResolution.stage;
    if (stageResolution.status === 'DISABLED') {
      throw new DealOrderReverseManualReviewError('Mapped customer-order stage is not enabled for deal creation');
    }
    const stageFallbackUsed = stageResolution.status === 'FALLBACK';
    const currency = config.currencies.find((item) => item.moyskladId === order.rate.currency.id);
    if (!stage || !currency) throw new DealOrderReverseManualReviewError('Customer-order stage or currency has no confirmed Bitrix24 mapping');

    let companyPairId: string | null = null;
    let companyId: string | null = null;
    const configuredServiceId = input.eventConfig.config.serviceCounterpartyId;
    if (order.agent.id !== configuredServiceId) {
      const client = await this.clients?.resolveForDocument({ eventId: input.eventId, sourceSystem: 'MOYSKLAD', entity: 'COMPANY', sourceId: order.agent.id }, input.workerLease);
      if (!client || client.status === 'REVIEW') throw new DealOrderReverseManualReviewError('Customer-order counterparty pair is not confirmed');
      if (client.status !== 'RESOLVED') throw new Error('Customer-order counterparty pair resolution is retryable');
      companyPairId = client.pair.id;
      companyId = client.pair.bitrix24Id;
    }

    const positions = await msGetAllPositions(input.moyskladOrderId, this.providerGate);
    const sourceIds = positions.map((position) => readId(position.id)).filter((id): id is string => !!id);
    if (sourceIds.length !== positions.length || new Set(sourceIds).size !== sourceIds.length) throw new DealOrderReverseManualReviewError('Customer-order position identity is incomplete or ambiguous');
    const rows: PreparedRow[] = [];
    const skippedRows: Array<{ sourceRowId: string; reason: string }> = [];
    const skip = async (sourceRowId: string, reason: string) => {
      skippedRows.push({ sourceRowId, reason });
      await writeOperationalLog(this.database, 'EVENT', `MySklad customer-order position ${sourceRowId} skipped; reason=${reason}`, input.eventId);
    };
    const seenPair = new Set<string>();
    const resolvedProducts = new Map<string, { bitrix24Id: string; uomId: string }>();
    for (const position of positions) {
      const id = readId(position.id)!;
      if (input.positionIds && !input.positionIds.has(id)) continue;
      const assortment = isRecord(position.assortment) ? position.assortment : {};
      const nativeKind = isRecord(assortment.meta) ? assortment.meta.type : undefined;
      // Old normalized fixtures omit meta.type; real native services must never
      // be addressed through the product endpoint (which returns a permanent404).
      const kind = nativeKind === undefined ? 'product' : nativeKind;
      if (kind !== 'product' && kind !== 'service') {
        await skip(id, 'ASSORTMENT_TYPE_UNSUPPORTED');
        continue;
      }
      const assortmentId = readId(assortment.id);
      if (!assortmentId || !isUuid(assortmentId)) {
        await skip(id, 'PRODUCT_ID_MISSING');
        continue;
      }
      let mappedProduct = resolvedProducts.get(assortmentId);
      if (!mappedProduct) {
        let productPairs = await this.database.entityPair.findMany({ where: { entityType: 'PRODUCT', active: true, moyskladId: assortmentId }, select: { bitrix24Id: true, moyskladId: true, moyskladType: true }, take: 2 });
        if (productPairs.length > 1) throw new DealOrderReverseManualReviewError(`MySklad product ${assortmentId} has ambiguous active Bitrix24 pairs`);
        if (productPairs[0]?.moyskladType && productPairs[0].moyskladType !== kind) throw new DealOrderReverseManualReviewError('MySklad assortment kind conflicts with the saved product pair');
        if (!productPairs.length && !config.bitrix24ProductCatalogId) {
          throw new DealOrderReverseManualReviewError('A confirmed Bitrix24 product catalog is required to create a missing product pair');
        }
        const product = await msGet(`entity/${kind}/${encodeURIComponent(assortmentId)}`, this.providerGate);
        if (!isRecord(product) || product.id !== assortmentId || !isRecord(product.meta) || product.meta.type !== kind) {
          throw new DealOrderReverseManualReviewError(`MySklad assortment ${assortmentId} is not a readable product`);
        }
        const uomId = moyskladUomReferenceId(product.uom, configuredBase('MOYSKLAD_API_BASE_URL'));
        const unit = input.eventConfig.config.references.units.filter((candidate) => matchesReverseUnit(candidate, uomId));
        if (unit.length !== 1 || !Number.isInteger(unit[0]?.bitrix24Id) || unit[0].bitrix24Id < 1 || !numericBitrixMeasureCode(unit[0]?.bitrix24Code)) {
          await skip(id, 'UNIT_UNMAPPED');
          continue;
        }
        let bitrix24Id = productPairs[0]?.bitrix24Id;
        if (!bitrix24Id) {
          bitrix24Id = await this.createOrRecoverProductPair({ productId: assortmentId, moyskladType: kind, product, eventId: input.eventId, eventConfig: input.eventConfig, bitrix24MeasureId: unit[0].bitrix24Id, assertPairLease: input.assertPairLease ?? (input.assertWorkerLease ? async () => { await input.assertWorkerLease!(); return true; } : undefined), writePair: input.writePair });
        }
        if (!/^\d{1,20}$/.test(bitrix24Id)) throw new DealOrderReverseManualReviewError(`MySklad product ${assortmentId} has an invalid Bitrix24 pair`);
        mappedProduct = { bitrix24Id, uomId: uomId! };
        resolvedProducts.set(assortmentId, mappedProduct);
      }
      const unit = input.eventConfig.config.references.units.filter((candidate) => matchesReverseUnit(candidate, mappedProduct!.uomId));
      const measureCode = unit.length === 1 ? numericBitrixMeasureCode(unit[0]?.bitrix24Code) : null;
      const price = typeof position.price === 'number' && Number.isFinite(position.price) && position.price >= 0 ? position.price / 100 : null;
      const quantity = typeof position.quantity === 'number' && Number.isFinite(position.quantity) && position.quantity > 0 ? position.quantity : null;
      const discount = typeof position.discount === 'number' && Number.isFinite(position.discount) && position.discount >= 0 && position.discount <= 100 ? position.discount : null;
      const vatEnabled = position.vatEnabled === true;
      const vat = typeof position.vat === 'number' && Number.isFinite(position.vat) && position.vat >= 0 && position.vat <= 100 ? position.vat : null;
      const vatIncluded = vatEnabled ? order.vatIncluded : false;
      const bitrixMoney = price === null || discount === null ? null : moySkladMoneyToBitrix({
        price: typeof position.price === 'number' ? position.price : null, discount, vat, vatEnabled, vatIncluded,
      });
      const rowKey = `${input.moyskladOrderId}:${id}`;
      if (unit.length !== 1 || measureCode === null || price === null || quantity === null || discount === null || !bitrixMoney || (vatEnabled && (vat === null || typeof vatIncluded !== 'boolean'))) {
        const reason = unit.length !== 1 ? 'UNIT_UNMAPPED' : price === null ? 'DOCUMENT_PRICE_MISSING' : quantity === null ? 'QUANTITY_INVALID' : discount === null ? 'DISCOUNT_MAPPING_UNSUPPORTED' : 'VAT_MAPPING_UNSUPPORTED';
        await skip(id, reason);
        continue;
      }
      if (seenPair.has(rowKey)) throw new Error('Customer-order position was duplicated');
      seenPair.add(rowKey);
      rows.push({
        msPositionId: id,
        snapshot: position,
        fields: { ownerId: 0, ownerType: 'D', productId: Number(mappedProduct.bitrix24Id), ...bitrixMoney, quantity, measureCode, sort: rows.length + 1 },
      });
    }
    const dealFields: Row = {
      title: order.name,
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
    if (stageFallbackUsed) {
      await writeOperationalLog(this.database, 'EVENT', 'MySklad customer order used configured Bitrix24 PREPARATION stage; reason=UNMAPPED_SOURCE_STAGE_DEFAULT_APPLIED', input.eventId);
    }
    return { orderId: input.moyskladOrderId, eventId: input.eventId, settingsVersion: input.eventConfig.version, sourceSnapshot: order, fields, rows, skippedRows, companyPairId, companyId };
  }

  private async createOrRecoverDeal(prepared: Prepared, leaseToken: string, assertWorkerLease?: () => Promise<void>): Promise<string> {
    const items = await b24FindOriginDeals(prepared.orderId, this.providerGate);
    if (items.length > 1) throw new DealOrderReverseManualReviewError('Multiple Bitrix24 deals already reference this MySklad customer order');
    let dealId = items.length === 1 ? readNumericId(items[0].id) : null;
    if (items.length === 1 && (items[0].originId !== prepared.orderId || items[0].originatorId !== 'MOYSKLAD')) throw new DealOrderReverseManualReviewError('Bitrix24 deal recovery identity is ambiguous');
    if (!dealId) {
      const created = await this.mode.runDealOrderExternalWrite('moyskladToBitrix24', async () => {
        await assertWorkerLease?.(); await this.assertOperationLease(prepared.orderId, leaseToken);
        await assertNoForwardOrderOwner(this.database, prepared.orderId, prepared.sourceSnapshot.syncId);
        return true;
      }, undefined, () => b24('crm.item.add', { entityTypeId: 2, fields: prepared.fields, useOriginalUfNames: 'Y' }, this.providerGate));
      const item = isRecord(created) && isRecord(created.item) ? created.item : null;
      dealId = item ? readNumericId(item.id) : null;
      if (!dealId) throw new Error('Bitrix24 deal create response did not include a numeric ID');
    }
    const saved = await this.database.dealOrderReverseCreateOperation.updateMany({ where: { moyskladOrderId: prepared.orderId, leaseToken }, data: { bitrix24DealId: dealId } });
    if (saved.count !== 1) throw new Error('Reverse deal operation lease was lost after provider success');
    return dealId;
  }

  /** Create only the missing Bitrix24 prerequisite product, using an explicitly
   * confirmed catalog/unit and a stable external key. MySklad product records
   * are read-only in this path. */
  private async createOrRecoverProductPair(input: { productId: string; moyskladType?: 'product' | 'service'; product: Row; eventId: string; eventConfig: VersionedFieldSettingsDto; bitrix24MeasureId: number; assertPairLease?: () => Promise<boolean>; writePair?: { id: string; entityType: string } }): Promise<string> {
    const creator = this.productCatalogCreate ?? new ProductCatalogCreateService(this.database, this.mode);
    return creator.createOrRecover(input);
  }

  private async verifyDeal(dealId: string, prepared: Prepared, leaseToken: string, assertWorkerLease?: () => Promise<void>): Promise<Row> {
    const read = async () => {
      const result = await b24('crm.item.get', { entityTypeId: 2, id: Number(dealId), useOriginalUfNames: 'Y' }, this.providerGate);
      return isRecord(result) && isRecord(result.item) ? result.item : null;
    };
    const hasExactIdentity = (item: Row | null): item is Row => !!item && String(item.id) === dealId &&
      item.originatorId === 'MOYSKLAD' && item.originId === prepared.orderId &&
      String(item.UF_CRM_1729757435964 ?? '') === String(prepared.sourceSnapshot.name);
    let item = await read();
    if (!hasExactIdentity(item)) {
      throw new DealOrderReverseManualReviewError('Bitrix24 deal readback did not match the durable MySklad order operation');
    }
    if (item.title !== prepared.fields.title) {
      // User-approved source-authoritative title after portal creation rules.
      // This is bounded to the exact journal-owned new deal, never a bulk rename.
      await this.mode.runDealOrderExternalWrite('moyskladToBitrix24', async () => {
        await assertWorkerLease?.();
        await this.assertOperationLease(prepared.orderId, leaseToken);
        return true;
      }, undefined, () => b24('crm.item.update', { entityTypeId: 2, id: Number(dealId), fields: { title: prepared.fields.title }, useOriginalUfNames: 'Y' }, this.providerGate));
      item = await read();
    }
    if (!hasExactIdentity(item) || item.title !== prepared.fields.title) {
      throw new DealOrderReverseManualReviewError('Bitrix24 deal readback did not match the durable MySklad order operation');
    }
    return item;
  }

  private async createRows(prepared: Prepared, leaseToken: string, assertPairLease?: () => Promise<boolean>, writePair?: { id: string; entityType: string }) {
    const dealId = (await this.database.dealOrderReverseCreateOperation.findUniqueOrThrow({ where: { moyskladOrderId: prepared.orderId }, select: { bitrix24DealId: true } })).bitrix24DealId;
    if (!dealId) throw new Error('Reverse deal ID is not persisted');
    const rows = await b24AllRows(dealId, this.providerGate);
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
        const created = await this.mode.runDealOrderExternalWrite('moyskladToBitrix24', async () => { await this.assertOperationLease(prepared.orderId, leaseToken); return !assertPairLease || await assertPairLease(); }, writePair, () => b24('crm.item.productrow.add', { fields: { ...preparedRow.fields, ownerId: Number(dealId) } }, this.providerGate));
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
        if (positionOperation.status === 'SKIPPED') continue;
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
      const partial = prepared.skippedRows.length > 0;
      await transaction.dealOrderReverseCreateOperation.update({ where: { moyskladOrderId: prepared.orderId }, data: { status: partial ? 'PARTIAL' : 'SUCCEEDED', leaseToken: null, leaseUntil: null, lastErrorCategory: partial ? 'ROWS_SKIPPED' : null } });
      await transaction.pairReviewCase.updateMany({ where: { entityType: 'DEAL', sourceSystem: 'MOYSKLAD', sourceEntityId: prepared.orderId, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
      return { status: partial ? 'PARTIAL' : 'CREATED', bitrix24DealId: dealId, ...(partial ? { skippedRows: prepared.skippedRows } : {}) };
    }, { timeout: 30_000 });
  }
}

function serializePrepared(value: Prepared): Row { return JSON.parse(JSON.stringify(value)) as Row; }
function readSkippedRows(value: unknown): Array<{ sourceRowId: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is { sourceRowId: string; reason: string } => isRecord(row) && typeof row.sourceRowId === 'string' && typeof row.reason === 'string');
}
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
type ProviderGate = (url: URL, init: RequestInit) => Promise<unknown>;

async function msGet(path: string, gate: ProviderGate = requestJson): Promise<unknown> {
  const base = configuredBase('MOYSKLAD_API_BASE_URL');
  const token = process.env.MOYSKLAD_API_TOKEN;
  if (!token) throw new Error('MySklad API read is not configured');
  return gate(new URL(path, ensureSlash(base)), { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json;charset=utf-8', 'accept-encoding': 'gzip' } });
}
async function msGetAllPositions(orderId: string, gate: ProviderGate = requestJson): Promise<Row[]> {
  const all: Row[] = [];
  const base = configuredBase('MOYSKLAD_API_BASE_URL');
  const token = process.env.MOYSKLAD_API_TOKEN;
  if (!token) throw new Error('MySklad API read is not configured');
  for (let offset = 0; offset < 10_000;) {
    const url = new URL(`entity/customerorder/${orderId}/positions`, ensureSlash(base));
    url.searchParams.set('limit', '100'); url.searchParams.set('offset', String(offset));
    url.searchParams.set('expand', 'assortment');
    const body = await gate(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json;charset=utf-8', 'accept-encoding': 'gzip' } });
    const rows = isRecord(body) && Array.isArray(body.rows) ? body.rows.filter(isRecord) : null;
    if (!rows) throw new Error('MySklad positions response is invalid');
    all.push(...rows); if (rows.length < 100) return all;
    offset += rows.length;
  }
  throw new Error('MySklad customer order contains too many positions');
}
async function b24(method: string, params: Row, gate: ProviderGate = requestJson): Promise<unknown> {
  const base = configuredBase('BITRIX24_REST_BASE_URL');
  const url = new URL(method, ensureSlash(base));
  return gate(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(params) }).then((response) => {
    if (!isRecord(response) || response.error) throw new Error(`Bitrix24 ${method} failed`);
    const result = response.result;
    if (isRecord(result)) return {
      ...result,
      ...(typeof response.total === 'number' && result.total === undefined ? { total: response.total } : {}),
      ...(typeof response.next === 'number' && result.next === undefined ? { next: response.next } : {}),
    };
    return result;
  });
}
async function b24AllRows(dealId: string, gate: ProviderGate = requestJson): Promise<Row[]> {
  const result: Row[] = [];
  for (let start = 0; start < 10_000;) {
    const value = await b24('crm.item.productrow.list', { filter: { '=ownerId': Number(dealId), '=ownerType': 'D' }, start }, gate);
    const rows = isRecord(value) && Array.isArray(value.productRows) ? value.productRows : null;
    if (!rows || rows.some((row) => !isRecord(row) || !readNumericId(row.id) || String(row.ownerId) !== dealId || row.ownerType !== 'D')) throw new Error('Bitrix24 product-row readback is invalid');
    if (rows.some((row) => result.some((prior) => String(prior.id) === String(row.id))) || new Set(rows.map((row) => String(row.id))).size !== rows.length) throw new Error('Bitrix24 product-row identities are duplicated');
    result.push(...rows);
    const next = isRecord(value) ? value.next : undefined;
    if (typeof next !== 'number') return result;
    if (!Number.isSafeInteger(next) || next <= start || !rows.length) throw new Error('Bitrix24 product-row pagination is invalid');
    start = next;
  }
  throw new Error('Bitrix24 returned too many product rows');
}
async function b24FindOriginDeals(orderId: string, gate: ProviderGate = requestJson): Promise<Row[]> {
  const result: Row[] = [];
  for (let start = 0; start < 10_000;) {
    const value = await b24('crm.item.list', { entityTypeId: 2, select: ['id', 'title', 'originatorId', 'originId'], filter: { originatorId: 'MOYSKLAD', originId: orderId }, start }, gate);
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
function numericBitrixMeasureCode(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function categoryFromStage(stageId: string): number {
  const prefix = stageId.match(/^C(\d+):/);
  if (prefix) return Number(prefix[1]);
  return 0;
}
function isMainPreparationStage(stageId: string): boolean {
  return stageId === 'PREPARATION' || stageId === '0:PREPARATION';
}
function hasUniqueConfirmedStagePair(
  stage: ReverseStage,
  pairs: readonly Pick<NamedReferencePair, 'kind' | 'bitrix24Id' | 'moyskladId' | 'status'>[],
): boolean {
  const sourceKeys = stage.bitrix24StageId === 'PREPARATION'
    ? new Set(['PREPARATION', '0:PREPARATION'])
    : new Set([stage.bitrix24StageId]);
  const matches = pairs.filter((pair) => pair.kind === 'dealStages' && sourceKeys.has(pair.bitrix24Id));
  return matches.length === 1 && matches[0]?.status === 'confirmed' && matches[0]?.moyskladId === stage.moyskladId;
}
async function requestJson(url: URL, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(12_000) });
  if (!response.ok) {
    const msBase = configuredBase('MOYSKLAD_API_BASE_URL');
    const provider = url.origin === msBase.origin && url.pathname.startsWith(msBase.pathname.replace(/\/?$/, '/')) ? 'MOYSKLAD' : 'BITRIX24';
    let failure = providerResponseFailure(provider, response.status, response.headers.get('retry-after'));
    const nativeRetry = response.headers.get('x-lognex-retry-after');
    if (provider === 'MOYSKLAD' && response.status === 429 && nativeRetry && /^\d+$/.test(nativeRetry) && Number.isSafeInteger(Number(nativeRetry))) {
      // MySklad's native header is a duration in milliseconds, not seconds.
      const nativeAt = new Date(Date.now() + Math.min(Number(nativeRetry), 60 * 60_000));
      if (!failure.retryAfterAt || nativeAt > failure.retryAfterAt) failure = new ProviderFailure(provider, response.status, nativeAt);
    }
    // Retain the existing credential-free message while preserving Retry-After
    // for the durable event scheduler rather than retrying into a rate limit.
    failure.message = `Provider request failed (${response.status})`;
    throw failure;
  }
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
function isUniqueViolation(error: unknown): boolean { return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'; }
// MySklad native identifiers use UUID-shaped hex groups without RFC variant/version restrictions.
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value); }
function parseBitrixCreatedAt(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
