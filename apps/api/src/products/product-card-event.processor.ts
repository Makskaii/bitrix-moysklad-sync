import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { ProductCardHttpApi } from './product-card-api';
import { ProductCardRuntimeService } from './product-card-runtime.service';
import { ProductCardSyncResult } from './product-card-sync.service';

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
  ) {}

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
    if (process.env.SYNC_MODE !== 'apply') return;
    try {
      const now = new Date();
      const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
      const pending = await this.database.inboundEvent.findMany({
        where: {
          AND: [
            { OR: [
              { source: 'BITRIX24', eventType: { in: ['CATALOG.PRODUCT.ON.UPDATE', 'CATALOG.PRICE.ON.UPDATE'] } },
              { source: 'MOYSKLAD', eventType: 'UPDATE', externalEntityType: 'product' },
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
    const event = await this.database.inboundEvent.findUnique({
      where: { id: eventId },
      select: { id: true, source: true, eventType: true, externalEntityType: true, externalEntityId: true, payload: true, status: true, attempts: true, retryAfter: true, processingStartedAt: true },
    });
    if (!event || !isDue(event.status, event.retryAfter, event.processingStartedAt)) return null;
    if (!isProductEvent(event.source, event.eventType, event.externalEntityType)) return null;

    const claimed = await this.database.inboundEvent.updateMany({
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
    if (claimed.count !== 1) return null;

    // A price webhook must use a read-only catalog.price.get call to discover
    // its product. Honor global apply/off/pause/direction gates before that API read.
    if (event.source === 'BITRIX24' && event.eventType === 'CATALOG.PRICE.ON.UPDATE') {
      const gate = await this.runtime.preflight('BITRIX24');
      if (gate.status !== 'READY') {
        const result = { ...gate, changedFields: [] as [] };
        await this.applyResult(event.id, event, result);
        return result;
      }
    }

    const supported = await this.resolveProductId(event);
    if (supported.status === 'not-product-event') return null;
    if (supported.status === 'unsupported-product-kind') {
      await this.finish(event.id, 'SKIPPED_UNSUPPORTED_ENTITY', 'PRODUCT_CARD_ENTITY_KIND_UNSUPPORTED');
      return null;
    }
    if (supported.status === 'retryable') {
      const result = { status: 'RETRYABLE_FAILURE' as const, reason: 'PRODUCT_EVENT_ID_RESOLUTION_FAILED', changedFields: [] };
      await this.applyResult(event.id, event, result);
      return result;
    }

    const sideField = event.source === 'BITRIX24' ? 'bitrix24Id' : 'moyskladId';
    const matches = await this.database.entityPair.findMany({
      where: { entityType: 'PRODUCT', active: true, [sideField]: supported.productId },
      select: { id: true, entityType: true, bitrix24Id: true, moyskladId: true, active: true, source: true, reason: true, createdAt: true },
      take: 2,
    });
    if (matches.length !== 1) {
      const reason = matches.length ? 'PRODUCT_PAIR_AMBIGUOUS' : 'PRODUCT_PAIR_NOT_ACTIVE';
      await this.database.manualReviewCase.upsert({
        where: { eventId: event.id },
        create: { eventId: event.id, source: event.source, eventType: event.eventType, externalEntityId: event.externalEntityId, externalEntityType: event.externalEntityType, reason },
        update: { reason },
      });
      await this.finish(event.id, 'MANUAL_REVIEW', reason);
      return { status: 'MANUAL_REVIEW', reason, changedFields: [] };
    }

    try {
      const pinned = await this.fieldSettings.eventConfig(event.id);
      const result = await this.runtime.process({
        pairId: matches[0]!.id,
        source: event.source === 'BITRIX24' ? 'BITRIX24' : 'MOYSKLAD',
        settingsVersion: pinned.version,
        eventId: event.id,
      });
      await this.applyResult(event.id, event, result);
      return result;
    } catch {
      const result = { status: 'RETRYABLE_FAILURE' as const, reason: 'PRODUCT_EVENT_PROCESSING_FAILED', changedFields: [] };
      await this.applyResult(event.id, event, result);
      return result;
    }
  }

  private async resolveProductId(event: {
    source: string; eventType: string | null; externalEntityType: string | null; externalEntityId: string | null; payload: Prisma.JsonValue;
  }): Promise<{ status: 'not-product-event' } | { status: 'unsupported-product-kind' } | { status: 'retryable' } | { status: 'resolved'; productId: string }> {
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
      catch { return { status: 'retryable' }; }
    }
    if (event.source === 'MOYSKLAD' && event.eventType === 'UPDATE' && event.externalEntityType === 'product') {
      const id = event.externalEntityId;
      return id && isUuid(id) ? { status: 'resolved', productId: id } : { status: 'retryable' };
    }
    return { status: 'not-product-event' };
  }

  private async applyResult(eventId: string, event: { source: string; eventType: string | null; externalEntityType: string | null; externalEntityId: string | null; attempts: number }, result: ProductCardSyncResult) {
    switch (result.status) {
      case 'BASELINED':
      case 'UNCHANGED':
      case 'SYNCED':
        await this.database.inboundEvent.updateMany({
          where: { id: eventId, status: 'PROCESSING' },
          data: { status: 'SUCCEEDED', lastSuccessfulAt: new Date(), processingStartedAt: null, lastErrorCategory: null, retryAfter: null },
        });
        await this.database.manualReviewCase.updateMany({ where: { eventId, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
        return;
      case 'MANUAL_REVIEW':
        await this.database.manualReviewCase.upsert({
          where: { eventId },
          create: { eventId, source: event.source, eventType: event.eventType, externalEntityId: event.externalEntityId, externalEntityType: event.externalEntityType, reason: result.reason },
          update: { reason: result.reason, diagnostic: { changedFields: result.changedFields } },
        });
        await this.finish(eventId, 'MANUAL_REVIEW', result.reason);
        return;
      case 'RETRYABLE_FAILURE':
        if (event.attempts + 1 >= 8) {
          await this.database.manualReviewCase.upsert({
            where: { eventId },
            create: { eventId, source: event.source, eventType: event.eventType, externalEntityId: event.externalEntityId, externalEntityType: event.externalEntityType, reason: 'PRODUCT_RETRY_LIMIT_EXCEEDED' },
            update: { reason: 'PRODUCT_RETRY_LIMIT_EXCEEDED' },
          });
          await this.finish(eventId, 'MANUAL_REVIEW', 'PRODUCT_RETRY_LIMIT_EXCEEDED');
          return;
        }
        await this.finish(eventId, 'RETRYABLE_FAILURE', result.reason, new Date(Date.now() + retryDelayMs(event.attempts + 1)));
        return;
      case 'SKIPPED_DISABLED':
        await this.finish(eventId, 'SKIPPED_DISABLED', result.reason);
        return;
      case 'SKIPPED_DIRECTION_DISABLED':
        await this.finish(eventId, 'SKIPPED_DIRECTION_DISABLED', result.reason);
        return;
      case 'DEFERRED_PAUSE':
        await this.finish(eventId, 'DEFERRED_PAUSE', result.reason, new Date(Date.now() + 60_000));
        return;
    }
  }

  private async finish(eventId: string, status: string, reason: string, retryAfter: Date | null = null) {
    await this.database.inboundEvent.updateMany({
      where: { id: eventId, OR: [
        { status: 'RECEIVED' }, { status: 'PROCESSING' },
        { status: 'RETRYABLE_FAILURE' }, { status: 'DEFERRED_PAUSE' },
      ] },
      data: { status, lastErrorCategory: reason, processingStartedAt: null, retryAfter },
    });
  }
}

function retryDelayMs(attempt: number): number { return Math.min(60_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6), 3_600_000); }
function isProductEvent(source: string, eventType: string | null, externalEntityType: string | null): boolean {
  return source === 'BITRIX24'
    ? eventType === 'CATALOG.PRODUCT.ON.UPDATE' || eventType === 'CATALOG.PRICE.ON.UPDATE'
    : source === 'MOYSKLAD' && eventType === 'UPDATE' && externalEntityType === 'product';
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
