import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { ProductCardHttpApi } from './product-card-api';
import { ProductCardRuntimeService } from './product-card-runtime.service';
import { ProductCardPrice, ProductCardSettings, ProductCardSyncResult } from './product-card-sync.service';
import { InboundEventMetadata } from '../event-dispatcher.service';
import { EventWorkerLeaseContext, EventWorkerLeaseService } from '../event-worker-lease.service';
import { isRetryableFailure, retryAtForFailure } from '../provider-failure';
import { DatabaseRecoveryService } from '../database-recovery.service';
import { ProductCatalogCreateService, ProductCatalogManualReviewError } from './product-catalog-create.service';
import { ControlledLiveTestAdmissionService } from '../controlled-live-test-admission.service';

const logger = new Logger('ProductCardEventProcessor');
const PROCESSING_LEASE_MS = 60_000;
const EVENT_BATCH_DELAY_MS = 250;

/**
 * Dispatches supported update events only to already-persisted PRODUCT hardpairs.
 * The event intake owns authentication and event persistence; this processor
 * never searches, creates, or guesses a product pair.
 */
@Injectable()
export class ProductCardEventProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryScan: Promise<void> | null = null;
  private readonly active = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly bitrixApi: ProductCardHttpApi,
    private readonly fieldSettings: FieldSettingsService,
    private readonly runtime: ProductCardRuntimeService,
    @Optional() private readonly workerLease?: EventWorkerLeaseService,
    @Optional() private readonly catalogCreate?: ProductCatalogCreateService,
    @Optional() private readonly databaseRecovery?: DatabaseRecoveryService,
    @Optional() private readonly controlledAdmission?: ControlledLiveTestAdmissionService,
  ) {}

  supports(event: InboundEventMetadata): boolean {
    return isProductEvent(event.source, event.eventType, event.externalEntityType);
  }

  onApplicationBootstrap() {
    this.requestRecoveryScan();
    this.recoveryTimer = setInterval(() => this.requestRecoveryScan(), 1_000);
    this.recoveryTimer.unref();
  }

  async onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await this.recoveryScan;
  }

  enqueue(eventId: string): void {
    if (this.active.has(eventId)) return;
    this.active.add(eventId);
    const timer = setTimeout(() => {
      void this.process(eventId)
        .catch(() => logger.error(JSON.stringify({ eventId, status: 'PRODUCT_EVENT_PROCESSOR_FAILED' })))
        .finally(() => this.active.delete(eventId));
    }, EVENT_BATCH_DELAY_MS);
    timer.unref();
  }

  private requestRecoveryScan() {
    if (this.recoveryScan) return;
    this.recoveryScan = this.resumeProductEvents()
      .catch(() => undefined)
      .finally(() => { this.recoveryScan = null; });
  }

  private async resumeProductEvents() {
    if (process.env.SYNC_MODE !== 'apply' && process.env.SYNC_MODE !== 'dry') return;
    try {
      const now = new Date();
      const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
      const pending = await this.database.inboundEvent.findMany({
        where: {
          AND: [
            { OR: [
              { source: 'BITRIX24', eventType: { in: ['CATALOG.PRODUCT.ON.ADD', 'CATALOG.PRODUCT.ON.UPDATE', 'CATALOG.PRICE.ON.ADD', 'CATALOG.PRICE.ON.UPDATE', 'CATALOG.PRICE.ON.DELETE'] } },
              { source: 'MOYSKLAD', eventType: { in: ['CREATE', 'UPDATE'] }, externalEntityType: { in: ['product', 'service'] } },
            ] },
            { OR: [
              { status: 'RECEIVED' },
              { status: 'RETRYABLE_FAILURE', OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
              { status: 'DEFERRED_PAUSE', OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
              { status: 'PROCESSING', OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: staleBefore } }] },
            ] },
          ],
        },
        select: { id: true },
        take: 100,
      });
      for (const event of pending) this.enqueue(event.id);
    } catch {
      // A later timer tick retries database discovery without blocking startup.
    }
  }

  async process(eventId: string): Promise<ProductCardSyncResult | null> {
    if (this.workerLease) return this.workerLease.run(eventId, (workerLease) => this.processWithLease(eventId, workerLease));
    return this.processWithLease(eventId);
  }

  private async processWithLease(eventId: string, workerLease?: EventWorkerLeaseContext): Promise<ProductCardSyncResult | null> {
    const event = await this.database.inboundEvent.findUnique({
      where: { id: eventId },
      select: { id: true, source: true, eventType: true, externalEntityType: true, externalEntityId: true, payload: true, status: true, attempts: true, retryAfter: true, processingStartedAt: true },
    });
    if (!event || !isDue(event.status, event.retryAfter, event.processingStartedAt)) return null;
    if (!isProductEvent(event.source, event.eventType, event.externalEntityType)) return null;

    const claimed = await this.database.$transaction(async (transaction) => {
      await assertWorkerLeaseInTransaction(workerLease, transaction);
      return transaction.inboundEvent.updateMany({
      where: {
        id: event.id,
        OR: [
          { status: 'RECEIVED' },
          { status: 'RETRYABLE_FAILURE', OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }] },
          { status: 'DEFERRED_PAUSE', OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }] },
          { status: 'PROCESSING', OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: new Date(Date.now() - PROCESSING_LEASE_MS) } }] },
        ],
      },
      data: { status: 'PROCESSING', attempts: { increment: 1 }, processingStartedAt: new Date(), lastErrorCategory: null, retryAfter: null },
      });
    });
    if (claimed.count !== 1) return null;

    // Ignore every Bitrix24 catalog change before resolving its product or pair.
    // This also keeps legacy direction settings from reopening reverse writes.
    if (event.source === 'BITRIX24') {
      const gate = await this.runtime.preflight('BITRIX24');
      if (gate.status !== 'READY') {
        const result = { ...gate, changedFields: [] as [] };
        await this.applyResult(event.id, event, result, workerLease);
        return result;
      }
    }

    const attempt = event.attempts + 1;
    const supported = await this.resolveProductId(event, attempt);
    if (supported.status === 'not-product-event') return null;
    if (supported.status === 'unsupported-product-kind') {
      await this.finish(event.id, 'SKIPPED_UNSUPPORTED_ENTITY', 'PRODUCT_CARD_ENTITY_KIND_UNSUPPORTED', null, workerLease);
      return null;
    }
    if (supported.status === 'retryable') {
      if (supported.permanent) {
        const result = { status: 'MANUAL_REVIEW' as const, reason: 'PRODUCT_PROVIDER_REJECTED', changedFields: [] };
        await this.applyResult(event.id, event, result, workerLease);
        return result;
      }
      const result = { status: 'RETRYABLE_FAILURE' as const, reason: 'PRODUCT_EVENT_ID_RESOLUTION_FAILED', changedFields: [], ...(supported.retryAfter ? { retryAfter: supported.retryAfter } : {}) };
      await this.applyResult(event.id, event, result, workerLease);
      return result;
    }

    const sideField = event.source === 'BITRIX24' ? 'bitrix24Id' : 'moyskladId';
    const nativeKindFilter = event.source === 'MOYSKLAD'
      ? (event.externalEntityType === 'service' ? { moyskladType: 'service' } : { OR: [{ moyskladType: 'product' }, { moyskladType: null }] })
      : {};
    let matches = await this.database.entityPair.findMany({
      where: { entityType: 'PRODUCT', active: true, [sideField]: supported.productId, ...nativeKindFilter },
      select: { id: true, entityType: true, bitrix24Id: true, moyskladId: true, moyskladType: true, active: true, source: true, reason: true, createdAt: true },
      take: 2,
    });
    if (!matches.length && event.source === 'MOYSKLAD' && event.eventType === 'CREATE' && ['product', 'service'].includes(event.externalEntityType ?? '')) {
      const created = await this.createPostBoundaryProduct({ productId: supported.productId, kind: event.externalEntityType as 'product' | 'service', eventId: event.id, attempt, workerLease });
      if (created) {
        matches = await this.database.entityPair.findMany({
          where: { entityType: 'PRODUCT', active: true, moyskladId: supported.productId, moyskladType: event.externalEntityType },
          select: { id: true, entityType: true, bitrix24Id: true, moyskladId: true, moyskladType: true, active: true, source: true, reason: true, createdAt: true }, take: 2,
        });
      }
      if (!created) return null;
    }
    if (matches.length !== 1) {
      const reason = matches.length ? 'PRODUCT_PAIR_AMBIGUOUS' : 'PRODUCT_PAIR_NOT_ACTIVE';
      await this.applyResult(event.id, event, { status: 'MANUAL_REVIEW', reason, changedFields: [] }, workerLease);
      return { status: 'MANUAL_REVIEW', reason, changedFields: [] };
    }

    try {
      await workerLease?.assertOwned();
      const pinned = await this.fieldSettings.eventConfig(event.id);
      const run = () => this.runtime.process({
          pairId: matches[0]!.id,
          source: event.source === 'BITRIX24' ? 'BITRIX24' : 'MOYSKLAD',
          settingsVersion: pinned.version,
          eventId: event.id,
          attempt,
          ...(workerLease ? { assertWorkerLease: workerLease.assertOwned } : {}),
        });
      let result: ProductCardSyncResult;
      if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
        const entity = event.externalEntityType === 'service' ? 'catalog-service' : 'catalog-product';
        const kind = entity === 'catalog-service' ? 'service' : 'product';
        const sourceSystem = event.source as 'BITRIX24' | 'MOYSKLAD';
        const sourceRecord = await this.controlledAdmission.withCurrentSourceRead(event.id, sourceSystem, supported.productId, entity, async () =>
          sourceSystem === 'BITRIX24' ? this.bitrixApi.readBitrix24(supported.productId, kind) : this.bitrixApi.readMoysklad(supported.productId, kind));
        const sourceCreatedAt = sourceRecord.createdAt ? new Date(sourceRecord.createdAt) : null;
        if (!sourceRecord.name || !sourceCreatedAt || !Number.isFinite(sourceCreatedAt.getTime())) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_METADATA_INVALID');
        await this.controlledAdmission.admit(event.id, { entity, sourceSystem, sourceNativeId: supported.productId, currentNativeId: supported.productId,
          currentName: sourceRecord.name, sourceCreatedAt });
        result = await this.controlledAdmission.runForEvent(event.id, run);
      } else {
        result = await run();
      }
      await this.applyResult(event.id, event, result, workerLease);
      return result;
    } catch {
      await workerLease?.assertOwned();
      const result = { status: 'RETRYABLE_FAILURE' as const, reason: 'PRODUCT_EVENT_PROCESSING_FAILED', changedFields: [] };
      await this.applyResult(event.id, event, result, workerLease);
      return result;
    }
  }

  private async createPostBoundaryProduct(input: { productId: string; kind: 'product' | 'service'; eventId: string; attempt: number; workerLease?: EventWorkerLeaseContext }): Promise<boolean> {
    const pendingEvent = await this.database.inboundEvent.findUnique({ where: { id: input.eventId }, select: { source: true, eventType: true, externalEntityType: true, externalEntityId: true, attempts: true } });
    if (!pendingEvent) return false;
    try {
      const gate = await this.runtime.preflight('MOYSKLAD');
      if (gate.status !== 'READY') {
        await this.applyResult(input.eventId, pendingEvent, { ...gate, changedFields: [] }, input.workerLease);
        return false;
      }
      const entity = input.kind === 'service' ? 'catalog-service' : 'catalog-product';
      const record = this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled'
        ? await this.controlledAdmission.withCurrentSourceRead(input.eventId, 'MOYSKLAD', input.productId, entity, () => this.bitrixApi.readMoyskladRecord(input.productId, input.kind))
        : await this.bitrixApi.readMoyskladRecord(input.productId, input.kind);
      const createdAt = typeof record.created === 'string' ? new Date(record.created) : null;
      const boundary = await this.databaseRecovery?.launchBoundary().catch(() => null);
      if (!boundary || !createdAt || !Number.isFinite(createdAt.getTime())) {
        await this.applyResult(input.eventId, pendingEvent, { status: 'MANUAL_REVIEW', reason: 'PRODUCT_LAUNCH_BOUNDARY_OR_CREATED_AT_UNAVAILABLE', changedFields: [] }, input.workerLease);
        return false;
      }
      if (createdAt.getTime() < boundary.getTime()) {
        await this.finish(input.eventId, 'SKIPPED_PRE_LAUNCH', 'PRE_LAUNCH_PRODUCT', null, input.workerLease);
        return false;
      }
      if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
        if (typeof record.name !== 'string' || !record.name) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_METADATA_INVALID');
        await this.controlledAdmission.admit(input.eventId, { entity, sourceSystem: 'MOYSKLAD', sourceNativeId: input.productId,
          currentNativeId: String(record.id ?? ''), currentName: record.name, sourceCreatedAt: createdAt });
      }
      const pinned = await this.fieldSettings.eventConfig(input.eventId);
      const settings = pinned.config as unknown as ProductCardSettings;
      const snapshot = await this.bitrixApi.readMoysklad(input.productId, input.kind);
      const unitId = mappedUnitId(snapshot.unitId, settings);
      const prices = initialMappedPrices(snapshot.prices, settings);
      const creator = this.catalogCreate;
      if (!creator) throw new ProductCatalogManualReviewError('PRODUCT_CREATE_RUNTIME_UNAVAILABLE');
      const create = () => creator.createOrRecover({
        productId: input.productId, product: record, moyskladType: input.kind, eventId: input.eventId, eventConfig: pinned,
        ...(unitId === undefined ? {} : { bitrix24MeasureId: unitId }), prices, writeGate: 'PRODUCT_CATALOG',
        ...(input.workerLease ? { assertPairLease: async () => { await input.workerLease!.assertOwned(); return true; } } : {}),
      });
      if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') await this.controlledAdmission.runForEvent(input.eventId, create);
      else await create();
      return true;
    } catch (error) {
      if (error instanceof ProductCatalogManualReviewError) {
        await this.applyResult(input.eventId, pendingEvent, { status: 'MANUAL_REVIEW', reason: error.reason, changedFields: [] }, input.workerLease);
        return false;
      }
      if (!isRetryableFailure(error)) {
        await this.applyResult(input.eventId, pendingEvent, { status: 'MANUAL_REVIEW', reason: 'PRODUCT_CREATE_PROVIDER_REJECTED', changedFields: [] }, input.workerLease);
        return false;
      }
      await this.applyResult(input.eventId, pendingEvent, { status: 'RETRYABLE_FAILURE', reason: 'PRODUCT_CREATE_RETRYABLE', changedFields: [], retryAfter: retryAtForFailure(error, input.attempt) }, input.workerLease);
      return false;
    }
  }

  private async resolveProductId(event: {
    source: string; eventType: string | null; externalEntityType: string | null; externalEntityId: string | null; payload: Prisma.JsonValue;
  }, attempt: number): Promise<{ status: 'not-product-event' } | { status: 'unsupported-product-kind' } | { status: 'retryable'; retryAfter?: Date; permanent?: boolean } | { status: 'resolved'; productId: string }> {
    if (event.source === 'BITRIX24' && event.eventType === 'CATALOG.PRODUCT.ON.UPDATE') {
      const root = asRecord(event.payload);
      const data = asRecord(root.data);
      const fields = asRecord(data.FIELDS);
      const type = Number(fields.TYPE);
      if (type !== 1) return { status: 'unsupported-product-kind' };
      const id = readScalar(fields.ID) ?? event.externalEntityId;
      return id && /^\d{1,20}$/.test(id) ? { status: 'resolved', productId: id } : { status: 'retryable' };
    }
    if (event.source === 'BITRIX24' && event.eventType === 'CATALOG.PRICE.ON.UPDATE') {
      const root = asRecord(event.payload);
      const data = asRecord(root.data);
      const fields = asRecord(data.FIELDS);
      const priceId = readScalar(fields.ID) ?? event.externalEntityId;
      if (!priceId || !/^\d{1,20}$/.test(priceId)) return { status: 'retryable' };
      try { return { status: 'resolved', productId: await this.bitrixApi.readBitrix24PriceProductId(priceId) }; }
      catch (error) {
        return isRetryableFailure(error)
          ? { status: 'retryable', retryAfter: retryAtForFailure(error, attempt) }
          : { status: 'retryable', permanent: true };
      }
    }
    if (event.source === 'MOYSKLAD' && ['CREATE', 'UPDATE'].includes(event.eventType ?? '') && ['product', 'service'].includes(event.externalEntityType ?? '')) {
      const id = event.externalEntityId;
      return id && isUuid(id) ? { status: 'resolved', productId: id } : { status: 'retryable' };
    }
    return { status: 'not-product-event' };
  }

  private async applyResult(eventId: string, event: { source: string; eventType: string | null; externalEntityType: string | null; externalEntityId: string | null; attempts: number }, result: ProductCardSyncResult, workerLease?: EventWorkerLeaseContext) {
    await this.database.$transaction(async (transaction) => {
    await assertWorkerLeaseInTransaction(workerLease, transaction);
    const finish = async (status: string, reason: string, retryAfter: Date | null = null) => transaction.inboundEvent.updateMany({
      where: { id: eventId, OR: [{ status: 'PROCESSING' }, { status: 'RECEIVED' }, { status: 'RETRYABLE_FAILURE' }, { status: 'DEFERRED_PAUSE' }] },
      data: { status, lastErrorCategory: reason, processingStartedAt: null, retryAfter, ...(status === 'SUCCEEDED' ? { lastSuccessfulAt: new Date() } : {}) },
    });
    switch (result.status) {
      case 'BASELINED':
      case 'UNCHANGED':
      case 'SYNCED':
        await finish('SUCCEEDED', '', null);
        await transaction.manualReviewCase.updateMany({ where: { eventId, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
        return;
      case 'MANUAL_REVIEW':
        await transaction.manualReviewCase.upsert({
          where: { eventId },
          create: { eventId, source: event.source, eventType: event.eventType, externalEntityId: event.externalEntityId, externalEntityType: event.externalEntityType, reason: result.reason },
          update: { reason: result.reason, diagnostic: { changedFields: result.changedFields } },
        });
        await finish('MANUAL_REVIEW', result.reason);
        return;
      case 'RETRYABLE_FAILURE':
        if (event.attempts + 1 >= 8) {
          await transaction.manualReviewCase.upsert({
            where: { eventId },
            create: { eventId, source: event.source, eventType: event.eventType, externalEntityId: event.externalEntityId, externalEntityType: event.externalEntityType, reason: 'PRODUCT_RETRY_LIMIT_EXCEEDED' },
            update: { reason: 'PRODUCT_RETRY_LIMIT_EXCEEDED' },
          });
          await finish('MANUAL_REVIEW', 'PRODUCT_RETRY_LIMIT_EXCEEDED');
          return;
        }
        await finish('RETRYABLE_FAILURE', result.reason, result.retryAfter ?? new Date(Date.now() + retryDelayMs(event.attempts + 1)));
        return;
      case 'SKIPPED_DISABLED':
        await finish('SKIPPED_DISABLED', result.reason);
        return;
      case 'SKIPPED_DIRECTION_DISABLED':
        await finish('SKIPPED_DIRECTION_DISABLED', result.reason);
        return;
      case 'DEFERRED_PAUSE':
        await finish('DEFERRED_PAUSE', result.reason, new Date(Date.now() + 60_000));
        return;
    }
    });
  }

  private async finish(eventId: string, status: string, reason: string, retryAfter: Date | null = null, workerLease?: EventWorkerLeaseContext) {
    await this.database.$transaction(async (transaction) => {
      await assertWorkerLeaseInTransaction(workerLease, transaction);
      await transaction.inboundEvent.updateMany({
      where: { id: eventId, OR: [
        { status: 'RECEIVED' }, { status: 'PROCESSING' },
        { status: 'RETRYABLE_FAILURE' }, { status: 'DEFERRED_PAUSE' },
      ] },
      data: { status, lastErrorCategory: reason, processingStartedAt: null, retryAfter },
      });
    });
  }
}

async function assertWorkerLeaseInTransaction(
  workerLease: EventWorkerLeaseContext | undefined,
  transaction: Prisma.TransactionClient,
): Promise<void> {
  if (workerLease?.assertOwnedIn) await workerLease.assertOwnedIn(transaction);
  else await workerLease?.assertOwned();
}

function retryDelayMs(attempt: number): number { return Math.min(60_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6), 3_600_000); }
function isProductEvent(source: string, eventType: string | null, externalEntityType: string | null): boolean {
  return source === 'BITRIX24'
    ? eventType === 'CATALOG.PRODUCT.ON.ADD' || eventType === 'CATALOG.PRODUCT.ON.UPDATE' || /^CATALOG\.PRICE\.ON\.(ADD|UPDATE|DELETE)$/.test(eventType ?? '')
    : source === 'MOYSKLAD' && ['CREATE', 'UPDATE'].includes(eventType ?? '') && ['product', 'service'].includes(externalEntityType ?? '');
}
function isDue(status: string, retryAfter: Date | null, processingStartedAt: Date | null): boolean {
  const now = Date.now();
  return status === 'RECEIVED' ||
    ((status === 'RETRYABLE_FAILURE' || status === 'DEFERRED_PAUSE') && (!retryAfter || retryAfter.getTime() <= now)) ||
    (status === 'PROCESSING' && (!processingStartedAt || processingStartedAt.getTime() < now - PROCESSING_LEASE_MS));
}
function readScalar(value: unknown): string | null { return typeof value === 'string' || typeof value === 'number' ? String(value) : null; }
function asRecord(value: unknown): Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : {}; }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }

function mappedUnitId(moyskladUnitId: string | null, settings: ProductCardSettings): number | undefined {
  if (!moyskladUnitId) return undefined;
  const rows = settings.references.units.filter((item) => asRecord(item).status === 'configured' && String(asRecord(item).moyskladId) === moyskladUnitId);
  if (rows.length !== 1 || !Number.isInteger(asRecord(rows[0]).bitrix24Id)) throw new ProductCatalogManualReviewError('PRODUCT_UNIT_MAPPING_MISSING_OR_AMBIGUOUS');
  return Number(asRecord(rows[0]).bitrix24Id);
}

function initialMappedPrices(source: ProductCardPrice[], settings: ProductCardSettings): Array<{ catalogGroupId: number; value: number; currency: string }> {
  const result: Array<{ catalogGroupId: number; value: number; currency: string }> = [];
  for (const candidate of settings.references.priceTypes) {
    const row = asRecord(candidate);
    if (row.status !== 'configured' || typeof row.moyskladId !== 'string' || !Number.isInteger(row.bitrix24Id)) continue;
    const matches = source.filter((price) => price.typeId === row.moyskladId);
    if (matches.length > 1) throw new ProductCatalogManualReviewError('PRODUCT_PRICE_SOURCE_AMBIGUOUS');
    if (!matches.length) continue;
    const price = matches[0]!;
    const currency = price.currency.trim().toUpperCase();
    if (!Number.isFinite(price.value) || price.value < 0 || !/^[A-Z]{3}$/.test(currency)) throw new ProductCatalogManualReviewError('PRODUCT_PRICE_CURRENCY_OR_VALUE_UNAVAILABLE');
    result.push({ catalogGroupId: Number(row.bitrix24Id), value: price.value, currency });
  }
  return result;
}
