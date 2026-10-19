import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { DatabaseRecoveryService } from '../database-recovery.service';
import { EventWorkerLeaseContext, EventWorkerLeaseService } from '../event-worker-lease.service';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { VersionedFieldSettingsDto } from '../field-settings/field-settings.dto';
import { SyncModeService } from '../sync-mode.service';
import { ClientLifecycleService } from '../clients/client-lifecycle.service';
import { ProviderFailure, isRetryableFailure, retryAtForFailure } from '../provider-failure';
import { lockEntityPairState } from '../pairs/pair-db-lock';
import { invoiceCreatedAt, invoicePairLinksMatchOrder, resolveInvoiceOrderLink } from './invoice-contract';
import { InvoiceHttpApi, InvoiceRecord } from './invoice-http-api';
import { InvoiceFieldRule, planInvoiceField } from './invoice-field-plan';

const logger = new Logger('InvoiceEventProcessor');
const PROCESSING_LEASE_MS = 60_000;
const RECOVERY_INTERVAL_MS = 1_000;
const MAX_ATTEMPTS = 8;
type Source = 'BITRIX24' | 'MOYSKLAD';
type InvoiceDirection = 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24';
type ProcessStatus = 'SUCCEEDED' | 'SKIPPED_PRE_LAUNCH' | 'SKIPPED_DISABLED' | 'SKIPPED_DIRECTION_DISABLED' | 'WAITING_FOR_ORDER' | 'MANUAL_REVIEW' | 'RETRYABLE_FAILURE' | 'DEFERRED_PAUSE';

/** Owns only smart invoices (entityTypeId 31) and MySklad invoiceout documents. */
@Injectable()
export class InvoiceEventProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly active = new Set<string>();
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryScan: Promise<void> | null = null;
  private recoveryCursor: string | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly api: InvoiceHttpApi,
    private readonly fieldSettings: FieldSettingsService,
    private readonly syncMode: SyncModeService,
    private readonly databaseRecovery: DatabaseRecoveryService,
    private readonly workerLease: EventWorkerLeaseService,
    private readonly lifecycle: ClientLifecycleService,
  ) {}

  supports(event: { source: string; eventType: string | null; externalEntityType: string | null }): boolean {
    return event.source === 'BITRIX24'
      ? event.externalEntityType === 'invoice' && /^ONCRMDYNAMICITEM(?:ADD|UPDATE)$/.test(event.eventType ?? '')
      : event.source === 'MOYSKLAD' && event.externalEntityType === 'invoiceout' && ['CREATE', 'UPDATE'].includes(event.eventType ?? '');
  }

  onApplicationBootstrap() {
    this.requestRecoveryScan();
    this.recoveryTimer = setInterval(() => this.requestRecoveryScan(), RECOVERY_INTERVAL_MS);
    this.recoveryTimer.unref();
  }

  async onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await this.recoveryScan;
  }

  enqueue(eventId: string): void {
    if (this.active.has(eventId)) return;
    this.active.add(eventId);
    void this.process(eventId).catch(() => logger.error(JSON.stringify({ eventId, status: 'INVOICE_EVENT_PROCESSING_FAILED' })))
      .finally(() => this.active.delete(eventId));
  }

  async process(eventId: string) {
    return this.workerLease.run(eventId, (lease) => this.processWithLease(eventId, lease));
  }

  private requestRecoveryScan() {
    if (this.recoveryScan) return;
    this.recoveryScan = this.resumePendingEvents().catch(() => undefined).finally(() => { this.recoveryScan = null; });
  }

  private async resumePendingEvents() {
    try {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
      const pending = await this.database.inboundEvent.findMany({
        where: {
          AND: [
            { OR: [
              { source: 'BITRIX24', externalEntityType: 'invoice', eventType: { in: ['ONCRMDYNAMICITEMADD', 'ONCRMDYNAMICITEMUPDATE'] } },
              { source: 'MOYSKLAD', externalEntityType: 'invoiceout', eventType: { in: ['CREATE', 'UPDATE'] } },
            ] },
            { OR: [
              { status: 'RECEIVED' },
              { status: 'WAITING_FOR_ORDER' },
              { status: 'RETRYABLE_FAILURE', OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
              { status: 'DEFERRED_PAUSE', OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] },
              { status: 'PROCESSING', OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: staleBefore } }] },
            ] },
            ...(this.recoveryCursor ? [{ id: { gt: this.recoveryCursor } }] : []),
          ],
        },
        select: { id: true }, orderBy: { id: 'asc' }, take: 100,
      });
      if (pending.length) this.recoveryCursor = pending.length === 100 ? pending[pending.length - 1]!.id : null;
      else if (this.recoveryCursor) this.recoveryCursor = null;
      for (const event of pending) this.enqueue(event.id);
    } catch {
      // The next bounded scan rediscovers persisted work.
    }
  }

  private async processWithLease(eventId: string, lease: EventWorkerLeaseContext) {
    const event = await this.database.inboundEvent.findUnique({ where: { id: eventId } });
    if (!event || !this.supports(event) || !event.externalEntityId || !isDue(event.status, event.retryAfter, event.processingStartedAt)) return null;
    const source = event.source as Source;
    const sourceId = event.externalEntityId;
    const direction: InvoiceDirection = source === 'BITRIX24' ? 'BITRIX24_TO_MOYSKLAD' : 'MOYSKLAD_TO_BITRIX24';
    const directionKey = source === 'BITRIX24' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';

    let mode: 'on' | 'pause' | 'off';
    try { mode = (await this.syncMode.read()).mode; }
    catch { return this.finish(event, 'RETRYABLE_FAILURE', 'INVOICE_SERVICE_MODE_READ_FAILED', retryAtForFailure(new Error('INVOICE_SERVICE_MODE_READ_FAILED'), event.attempts + 1), lease); }
    if (mode === 'off') return this.finish(event, 'SKIPPED_DISABLED', 'SERVICE_MODE_OFF', null, lease);
    if (mode === 'pause') return this.finish(event, 'DEFERRED_PAUSE', 'SERVICE_PAUSED', new Date(Date.now() + 60_000), lease);
    if (process.env.SYNC_MODE !== 'apply' && process.env.SYNC_MODE !== 'dry') return this.finish(event, 'SKIPPED_DISABLED', 'SYNC_MODE_REQUIRED', null, lease);
    let directionEnabled: boolean;
    try { directionEnabled = await this.syncMode.isDirectionEnabled('invoices', directionKey); }
    catch { return this.finish(event, 'RETRYABLE_FAILURE', 'INVOICE_DIRECTION_READ_FAILED', retryAtForFailure(new Error('INVOICE_DIRECTION_READ_FAILED'), event.attempts + 1), lease); }
    if (!directionEnabled) return this.finish(event, 'SKIPPED_DIRECTION_DISABLED', 'INVOICE_DIRECTION_DISABLED', null, lease);

    const claim = await this.database.inboundEvent.updateMany({
      where: { id: event.id, OR: [
        { status: 'RECEIVED' }, { status: 'WAITING_FOR_ORDER' },
        { status: 'RETRYABLE_FAILURE', OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }] },
        { status: 'DEFERRED_PAUSE', OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }] },
        { status: 'PROCESSING', OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: new Date(Date.now() - PROCESSING_LEASE_MS) } }] },
      ] },
      data: { status: 'PROCESSING', processingStartedAt: new Date(), attempts: { increment: 1 }, retryAfter: null, lastErrorCategory: null },
    });
    if (claim.count !== 1) return null;

    try {
      const boundary = await this.databaseRecovery.launchBoundary();
      if (!boundary) return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_LAUNCH_BOUNDARY_UNAVAILABLE', null, lease);
      const settings = await this.fieldSettings.eventConfig(event.id);
      const config = settings.config;
      const invoiceRules = config.rules.filter((rule) => rule.entity === 'smart-invoices');
      if (invoiceRules.some((rule) => (rule.bitrix24ToMoysklad.enabled || rule.moyskladToBitrix24.enabled) &&
        (isInvoiceRelationshipField(rule.sourceField) || isInvoiceRelationshipField(rule.targetField)))) {
        return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_RELATIONSHIP_MAPPING_UNSUPPORTED', null, lease);
      }
      const rules = invoiceRules.filter((rule) => rule.bitrix24ToMoysklad.enabled || rule.moyskladToBitrix24.enabled);
      if (config.groups.some((group) => group.entity === 'smart-invoices')) return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_FIELD_GROUPS_UNSUPPORTED', null, lease);

      const sourceRecord = source === 'BITRIX24' ? await this.api.readBitrix24(sourceId) : await this.api.readMoysklad(sourceId);
      const createdAt = invoiceCreatedAt(sourceRecord);
      if (!createdAt) return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_CREATION_TIME_UNAVAILABLE', null, lease);
      if (createdAt.getTime() < boundary.getTime()) return this.finish(event, 'SKIPPED_PRE_LAUNCH', 'PRE_LAUNCH_INVOICE', null, lease);

      const link = resolveInvoiceOrderLink(sourceRecord, source);
      if (link.status !== 'linked') return this.finish(event, 'MANUAL_REVIEW', link.status === 'missing' ? 'INVOICE_ORDER_LINK_MISSING' : 'INVOICE_ORDER_LINK_AMBIGUOUS', null, lease);
      const order = await this.resolveOrderPair(source, link.orderId, boundary);
      if (order.status === 'WAITING_FOR_ORDER') return this.finish(event, 'WAITING_FOR_ORDER', order.reason, null, lease);
      if (order.status === 'SKIPPED_OUT_OF_SCOPE') return this.finish(event, 'SKIPPED_PRE_LAUNCH', order.reason, null, lease);
      if (order.status === 'MANUAL_REVIEW') return this.finish(event, 'MANUAL_REVIEW', order.reason, null, lease);

      const invoicePair = await this.findInvoicePair(source, sourceId);
      if (invoicePair.status === 'AMBIGUOUS') return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_PAIR_AMBIGUOUS', null, lease);
      if (invoicePair.status === 'TOMBSTONED') return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_PAIR_TOMBSTONED', null, lease);
      if (invoicePair.status === 'NONE') {
        if (process.env.SYNC_MODE === 'dry') return this.finish(event, 'SKIPPED_DISABLED', 'INVOICE_CREATE_REQUIRES_APPLY_MODE', null, lease);
        return await this.withInvoiceIdentityLease(source, sourceId, async () => {
          const created = await this.createCounterpart({ source, sourceId, sourceRecord, orderId: order.pair.moyskladId, dealId: order.pair.bitrix24Id, rules, settings, lease });
          if (created.status !== 'CREATED') return this.finish(event, created.status, created.reason, created.retryAfter ?? null, lease);
          const bitrix24Id = source === 'BITRIX24' ? sourceId : created.partnerId;
          const moyskladId = source === 'MOYSKLAD' ? sourceId : created.partnerId;
          const [bitrix, moysklad] = await Promise.all([this.api.readBitrix24(bitrix24Id), this.api.readMoysklad(moyskladId)]);
          if (!invoicePairLinksMatchOrder(bitrix, moysklad, order.pair)) {
            return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_CREATE_READBACK_ORDER_LINK_MISMATCH', null, lease);
          }
          const pair = await this.persistPair(source, sourceId, created.partnerId, order.pair.moyskladId, event.id, lease);
          if (!pair) return this.finish(event, 'RETRYABLE_FAILURE', 'INVOICE_PAIR_PERSIST_FAILED', retryAtForFailure(new Error('INVOICE_PAIR_PERSIST_FAILED'), event.attempts + 1), lease);
          await this.initializeBaseline(pair.id, event.id, settings, rules, bitrix, moysklad);
          return this.finish(event, 'SUCCEEDED', 'INVOICE_CREATED_AND_PAIRED', null, lease);
        });
      }
      if (invoicePair.pair.moyskladParentId && invoicePair.pair.moyskladParentId !== order.pair.moyskladId) {
        return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_ORDER_PAIR_CHANGED', null, lease);
      }
      const [bitrix, moysklad] = await Promise.all([this.api.readBitrix24(invoicePair.pair.bitrix24Id), this.api.readMoysklad(invoicePair.pair.moyskladId)]);
      if (!invoicePairLinksMatchOrder(bitrix, moysklad, order.pair)) return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_PAIR_ORDER_LINK_MISMATCH', null, lease);
      const baseline = await this.ensureBaseline(invoicePair.pair.id, event.id, settings, rules, bitrix, moysklad);
      if (baseline === 'VERSION_MISMATCH') return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_SETTINGS_VERSION_MISMATCH', null, lease);
      const result = await this.lifecycle.withPairActiveLock(invoicePair.pair.id, 'INVOICE', () =>
        this.syncFields({ pair: invoicePair.pair, order: order.pair, eventId: event.id, eventConfig: settings, rules, baseline, bitrix, moysklad, lease }));
      return this.finish(event, result.status, result.reason ?? '', result.retryAfter ?? null, lease);
    } catch (error) {
      if (error instanceof ProviderFailure && !isRetryableFailure(error)) {
        return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_PROVIDER_REJECTED', null, lease);
      }
      const retryAfter = retryAtForFailure(error, event.attempts + 1);
      if (event.attempts + 1 >= MAX_ATTEMPTS) return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_RETRY_LIMIT_EXCEEDED', null, lease);
      return this.finish(event, 'RETRYABLE_FAILURE', 'INVOICE_PROVIDER_OR_PROCESSING_FAILURE', retryAfter, lease);
    }
  }

  private async resolveOrderPair(source: Source, orderId: string, boundary: Date): Promise<
    | { status: 'READY'; pair: { id: string; bitrix24Id: string; moyskladId: string } }
    | { status: 'WAITING_FOR_ORDER'; reason: string }
    | { status: 'SKIPPED_OUT_OF_SCOPE'; reason: string }
    | { status: 'MANUAL_REVIEW'; reason: string }
  > {
    const field = source === 'BITRIX24' ? 'bitrix24Id' : 'moyskladId';
    const pairs = await this.database.entityPair.findMany({ where: { entityType: 'DEAL', active: true, [field]: orderId }, select: { id: true, bitrix24Id: true, moyskladId: true }, take: 2 });
    if (pairs.length > 1) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_ORDER_PAIR_AMBIGUOUS' };
    try {
      const document = source === 'BITRIX24' ? await this.api.readDeal(orderId) : await this.api.readCustomerOrder(orderId);
      const createdAt = invoiceCreatedAt(document);
      if (!createdAt) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_ORDER_CREATION_TIME_UNAVAILABLE' };
      if (createdAt.getTime() < boundary.getTime()) return { status: 'SKIPPED_OUT_OF_SCOPE', reason: 'INVOICE_LINKED_ORDER_PRE_LAUNCH' };
      if (pairs.length === 1) return { status: 'READY', pair: pairs[0]! };
      return { status: 'WAITING_FOR_ORDER', reason: 'INVOICE_LINKED_ORDER_PAIR_PENDING' };
    } catch (error) {
      if (error instanceof ProviderFailure && isRetryableFailure(error)) throw error;
      return { status: 'MANUAL_REVIEW', reason: 'INVOICE_LINKED_ORDER_UNAVAILABLE' };
    }
  }

  private async createCounterpart(input: {
    source: Source; sourceId: string; sourceRecord: InvoiceRecord; orderId: string; dealId: string;
    rules: VersionedFieldSettingsDto['config']['rules']; settings: VersionedFieldSettingsDto; lease: EventWorkerLeaseContext;
  }): Promise<{ status: 'CREATED'; partnerId: string } | { status: 'MANUAL_REVIEW' | 'RETRYABLE_FAILURE'; reason: string; retryAfter?: Date }> {
    const direction: InvoiceDirection = input.source === 'BITRIX24' ? 'BITRIX24_TO_MOYSKLAD' : 'MOYSKLAD_TO_BITRIX24';
    const fields = mappedFields(input.sourceRecord, input.rules, direction);
    if (input.source === 'BITRIX24') {
      const existing = await this.api.findMoyskladByExternalCode(input.sourceId);
      if (existing.length > 1) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_RECOVERY_AMBIGUOUS' };
      if (existing.length === 1) {
        const recoveredId = scalarId(existing[0]?.id);
        if (!recoveredId || !isMoyskladId(recoveredId)) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_RECOVERY_INVALID_ID' };
        const recovered = await this.api.readMoysklad(recoveredId);
        const recoveredLink = resolveInvoiceOrderLink(recovered, 'MOYSKLAD');
        if (recovered.externalCode !== input.sourceId || recoveredLink.status !== 'linked' || recoveredLink.orderId !== input.orderId) {
          return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_RECOVERY_ORDER_LINK_MISMATCH' };
        }
        return { status: 'CREATED', partnerId: recoveredId };
      }
      await input.lease.assertOwned();
      const partnerId = await this.api.createMoysklad(input.sourceId, input.orderId, fields);
      if (partnerId.startsWith('dry:')) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_DRY_CREATE_READBACK_UNAVAILABLE' };
      const verified = await this.api.readMoysklad(partnerId);
      const link = resolveInvoiceOrderLink(verified, 'MOYSKLAD');
      if (link.status !== 'linked' || link.orderId !== input.orderId) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_READBACK_ORDER_LINK_MISMATCH' };
      return { status: 'CREATED', partnerId };
    }
    const existing = await this.api.findBitrix24ByOrigin(input.sourceId);
    if (existing.length > 1) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_RECOVERY_AMBIGUOUS' };
    if (existing.length === 1) {
      const id = scalarId(existing[0]?.id);
      if (!id || !/^\d{1,20}$/.test(id)) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_RECOVERY_INVALID_ID' };
      const recovered = await this.api.readBitrix24(id);
      const recoveredLink = resolveInvoiceOrderLink(recovered, 'BITRIX24');
      if (String(recovered.originatorId ?? '') !== 'MOYSKLAD' || String(recovered.originId ?? '') !== input.sourceId ||
        recoveredLink.status !== 'linked' || recoveredLink.orderId !== input.dealId) {
        return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_RECOVERY_ORDER_LINK_MISMATCH' };
      }
      return { status: 'CREATED', partnerId: id };
    }
    await input.lease.assertOwned();
    const partnerId = await this.api.createBitrix24(input.sourceId, input.dealId, fields);
    if (partnerId.startsWith('dry:')) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_DRY_CREATE_READBACK_UNAVAILABLE' };
    const verified = await this.api.readBitrix24(partnerId);
    const link = resolveInvoiceOrderLink(verified, 'BITRIX24');
    if (link.status !== 'linked' || link.orderId !== input.dealId) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_READBACK_ORDER_LINK_MISMATCH' };
    return { status: 'CREATED', partnerId };
  }

  private async persistPair(source: Source, sourceId: string, partnerId: string, orderId: string, eventId: string, lease: EventWorkerLeaseContext) {
    const bitrix24Id = source === 'BITRIX24' ? sourceId : partnerId;
    const moyskladId = source === 'MOYSKLAD' ? sourceId : partnerId;
    await lease.assertOwned();
    return this.database.$transaction(async (transaction) => {
      await lockEntityPairState(transaction);
      const bySource = await transaction.entityPair.findFirst({ where: { entityType: 'INVOICE', active: true, bitrix24Id } });
      const byTarget = await transaction.entityPair.findFirst({ where: { entityType: 'INVOICE', active: true, moyskladId } });
      if (bySource || byTarget) {
        if (bySource?.id && bySource.id === byTarget?.id && bySource.bitrix24Id === bitrix24Id && bySource.moyskladId === moyskladId) return bySource;
        return null;
      }
      return transaction.entityPair.create({ data: {
        entityType: 'INVOICE', bitrix24Id, moyskladId, moyskladType: 'invoiceout', moyskladParentId: orderId,
        source: 'AUTOMATIC', reason: `Invoice pair created by event ${eventId}`,
      } });
    });
  }

  private async findInvoicePair(source: Source, sourceId: string): Promise<
    | { status: 'NONE' }
    | { status: 'AMBIGUOUS' }
    | { status: 'TOMBSTONED' }
    | { status: 'FOUND'; pair: { id: string; entityType: string; bitrix24Id: string; moyskladId: string; moyskladParentId: string | null; lifecycleStatus: string } }
  > {
    const key = source === 'BITRIX24' ? 'bitrix24Id' : 'moyskladId';
    const rows = await this.database.entityPair.findMany({ where: { entityType: 'INVOICE', [key]: sourceId }, select: { id: true, entityType: true, bitrix24Id: true, moyskladId: true, moyskladParentId: true, lifecycleStatus: true, active: true }, take: 2 });
    if (rows.length > 1) return { status: 'AMBIGUOUS' };
    if (!rows.length) return { status: 'NONE' };
    const pair = rows[0]!;
    if (!pair.active || pair.lifecycleStatus !== 'ACTIVE') return { status: 'TOMBSTONED' };
    return { status: 'FOUND', pair };
  }

  private async initializeBaseline(pairId: string, eventId: string, settings: VersionedFieldSettingsDto, rules: VersionedFieldSettingsDto['config']['rules'], bitrix: InvoiceRecord, moysklad: InvoiceRecord) {
    const bitrix24Values = baselineValues(bitrix, rules, 'BITRIX24');
    const moyskladValues = baselineValues(moysklad, rules, 'MOYSKLAD');
    await this.database.entityPairBaseline.createMany({ data: [{ pairId, eventId, settingsVersion: settings.version, bitrix24Values: bitrix24Values as unknown as Prisma.InputJsonValue, moyskladValues: moyskladValues as unknown as Prisma.InputJsonValue }], skipDuplicates: true });
    await this.database.entityPairSyncState.upsert({
      where: { pairId },
      create: { pairId, settingsVersion: settings.version, bitrix24Values: bitrix24Values as unknown as Prisma.InputJsonValue, moyskladValues: moyskladValues as unknown as Prisma.InputJsonValue },
      update: {},
    });
  }

  private async ensureBaseline(pairId: string, eventId: string, settings: VersionedFieldSettingsDto, rules: VersionedFieldSettingsDto['config']['rules'], bitrix: InvoiceRecord, moysklad: InvoiceRecord) {
    const baseline = await this.database.entityPairBaseline.findUnique({ where: { pairId } });
    if (baseline && baseline.settingsVersion !== settings.version) return 'VERSION_MISMATCH' as const;
    if (!baseline) {
      await this.initializeBaseline(pairId, eventId, settings, rules, bitrix, moysklad);
      return this.database.entityPairBaseline.findUnique({ where: { pairId } });
    }
    const state = await this.database.entityPairSyncState.findUnique({ where: { pairId } });
    if (state && state.settingsVersion !== settings.version) return 'VERSION_MISMATCH' as const;
    if (!state) await this.database.entityPairSyncState.create({ data: { pairId, settingsVersion: settings.version, bitrix24Values: baseline.bitrix24Values as Prisma.InputJsonValue, moyskladValues: baseline.moyskladValues as Prisma.InputJsonValue } });
    return baseline;
  }

  private async syncFields(input: {
    pair: { id: string; bitrix24Id: string; moyskladId: string }; order: { bitrix24Id: string; moyskladId: string }; eventId: string; eventConfig: VersionedFieldSettingsDto;
    rules: VersionedFieldSettingsDto['config']['rules']; baseline: any; bitrix: InvoiceRecord; moysklad: InvoiceRecord; lease: EventWorkerLeaseContext;
  }): Promise<{ status: ProcessStatus; reason?: string; retryAfter?: Date }> {
    const directions = await this.database.syncDirectionSetting.findUnique({ where: { entityKey: 'invoices' }, select: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } });
    const baselineB24 = jsonRecord(input.baseline.bitrix24Values);
    const baselineMs = jsonRecord(input.baseline.moyskladValues);
    for (const rule of input.rules) {
      const key = `rule:${rule.id}`;
      if (!(key in baselineB24) || !(key in baselineMs)) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_FIELD_NOT_IN_BASELINE' };
      const b24Value = readField(input.bitrix, rule.sourceField, 'BITRIX24');
      const msValue = readField(input.moysklad, rule.targetField, 'MOYSKLAD');
      const plan = planInvoiceField({
        rule: rule as unknown as InvoiceFieldRule,
        bitrix24: b24Value,
        moysklad: msValue,
        baselineBitrix24: baselineB24[key],
        baselineMoysklad: baselineMs[key],
        directions: { bitrix24ToMoysklad: directions?.bitrix24ToMoysklad ?? true, moyskladToBitrix24: directions?.moyskladToBitrix24 ?? true },
      });
      if (plan.action === 'HOLD') return { status: 'MANUAL_REVIEW', reason: `INVOICE_FIELD_${plan.reason}` };
      if (plan.action === 'ECHO') continue;
      try {
        await this.assertWriteAllowed(plan.direction, input.pair.id, input.lease);
        if (plan.direction === 'BITRIX24_TO_MOYSKLAD') await this.api.updateMoysklad(input.pair.moyskladId, { [rule.targetField]: plan.value });
        else await this.api.updateBitrix24(input.pair.bitrix24Id, { [rule.sourceField]: plan.value });
        const target = plan.direction === 'BITRIX24_TO_MOYSKLAD' ? await this.api.readMoysklad(input.pair.moyskladId) : await this.api.readBitrix24(input.pair.bitrix24Id);
        const [verifiedB24, verifiedMs] = await Promise.all([this.api.readBitrix24(input.pair.bitrix24Id), this.api.readMoysklad(input.pair.moyskladId)]);
        if (!invoicePairLinksMatchOrder(verifiedB24, verifiedMs, input.order)) {
          return { status: 'MANUAL_REVIEW', reason: 'INVOICE_POST_WRITE_ORDER_LINK_MISMATCH' };
        }
        const actual = plan.direction === 'BITRIX24_TO_MOYSKLAD' ? readField(target, rule.targetField, 'MOYSKLAD') : readField(target, rule.sourceField, 'BITRIX24');
        if (!sameJson(actual, plan.value)) return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_FIELD_READBACK_MISMATCH', retryAfter: retryAtForFailure(new Error('INVOICE_FIELD_READBACK_MISMATCH'), 1) };
        if (plan.direction === 'BITRIX24_TO_MOYSKLAD') msValueCache(input.moysklad, rule.targetField, actual);
        else msValueCache(input.bitrix, rule.sourceField, actual);
      } catch (error) {
        if (error instanceof ProviderFailure && !isRetryableFailure(error)) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_PROVIDER_REJECTED' };
        return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_FIELD_WRITE_FAILED', retryAfter: retryAtForFailure(error, 1) };
      }
    }
    const [latestB24, latestMs] = await Promise.all([this.api.readBitrix24(input.pair.bitrix24Id), this.api.readMoysklad(input.pair.moyskladId)]);
    if (!invoicePairLinksMatchOrder(latestB24, latestMs, input.order)) {
      return { status: 'MANUAL_REVIEW', reason: 'INVOICE_POST_WRITE_ORDER_LINK_MISMATCH' };
    }
    const bitrix24Values = baselineValues(latestB24, input.rules, 'BITRIX24');
    const moyskladValues = baselineValues(latestMs, input.rules, 'MOYSKLAD');
    await this.database.entityPairSyncState.upsert({
      where: { pairId: input.pair.id },
      create: { pairId: input.pair.id, settingsVersion: input.eventConfig.version, bitrix24Values, moyskladValues },
      update: { settingsVersion: input.eventConfig.version, bitrix24Values, moyskladValues },
    });
    return { status: 'SUCCEEDED' };
  }

  private async assertWriteAllowed(direction: InvoiceDirection, pairId: string, lease: EventWorkerLeaseContext) {
    const setting = await this.database.syncSetting.findUnique({ where: { id: 'global' }, select: { serviceMode: true } });
    if (!setting || setting.serviceMode !== 'on') throw new Error('INVOICE_WRITE_BLOCKED_SERVICE_MODE');
    if (!await this.databaseRecovery.assertReady()) throw new Error('INVOICE_WRITE_BLOCKED_RECOVERY');
    const directionKey = direction === 'BITRIX24_TO_MOYSKLAD' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
    if (!await this.syncMode.isDirectionEnabled('invoices', directionKey)) throw new Error('INVOICE_WRITE_BLOCKED_DIRECTION');
    await lease.assertOwned();
    const pair = await this.database.entityPair.findFirst({ where: { id: pairId, entityType: 'INVOICE', active: true, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
    if (!pair) throw new Error('INVOICE_PAIR_NOT_ACTIVE');
  }

  private async withInvoiceIdentityLease<T>(source: Source, sourceId: string, work: () => Promise<T>): Promise<T> {
    const identity = createHash('sha256').update([source, 'INVOICE', sourceId].join('\0')).digest('hex');
    const entityKey = `client:${identity}`;
    const ownerToken = randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + PROCESSING_LEASE_MS);
    const reclaimed = await this.database.inboundEntityLock.updateMany({
      where: { entityKey, leaseExpiresAt: { lte: now } },
      data: { ownerToken, eventId: `invoice-create:${source}:${sourceId}`, leaseExpiresAt },
    });
    if (reclaimed.count !== 1) {
      try {
        await this.database.inboundEntityLock.create({ data: { entityKey, ownerToken, eventId: `invoice-create:${source}:${sourceId}`, leaseExpiresAt } });
      } catch {
        throw new Error('INVOICE_CREATE_LEASE_BUSY');
      }
    }
    try {
      return await work();
    } finally {
      await this.database.inboundEntityLock.deleteMany({ where: { entityKey, ownerToken } }).catch(() => undefined);
    }
  }

  private async finish(event: any, status: ProcessStatus, reason: string, retryAfter: Date | null, lease: EventWorkerLeaseContext) {
    await lease.assertOwned();
    await this.database.$transaction(async (transaction) => {
      await lease.assertOwnedIn?.(transaction);
      if (status === 'MANUAL_REVIEW') {
        await transaction.manualReviewCase.upsert({
          where: { eventId: event.id },
          create: { eventId: event.id, source: event.source, eventType: event.eventType, externalEntityId: event.externalEntityId, externalEntityType: event.externalEntityType, reason },
          update: { reason },
        });
      }
      if (status === 'SUCCEEDED') await transaction.manualReviewCase.updateMany({ where: { eventId: event.id, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedAt: new Date() } });
      await transaction.inboundEvent.updateMany({
        where: { id: event.id, OR: [{ status: 'PROCESSING' }, { status: 'RECEIVED' }, { status: 'WAITING_FOR_ORDER' }, { status: 'RETRYABLE_FAILURE' }, { status: 'DEFERRED_PAUSE' }] },
        data: { status, lastErrorCategory: reason || null, processingStartedAt: null, retryAfter, ...(status === 'SUCCEEDED' ? { lastSuccessfulAt: new Date() } : {}) },
      });
    });
    return { status, reason };
  }
}

function mappedFields(source: InvoiceRecord, rules: VersionedFieldSettingsDto['config']['rules'], direction: InvoiceDirection): InvoiceRecord {
  const output: InvoiceRecord = {};
  for (const rule of rules) {
    const mapping = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.bitrix24ToMoysklad : rule.moyskladToBitrix24;
    if (!mapping.enabled || mapping.transform.kind !== 'copy') continue;
    const sourceField = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.sourceField : rule.targetField;
    const targetField = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.targetField : rule.sourceField;
    const value = readField(source, sourceField, direction === 'BITRIX24_TO_MOYSKLAD' ? 'BITRIX24' : 'MOYSKLAD');
    if (value !== undefined && isScalar(value) && !isExcludedField(sourceField, targetField) &&
      !isInvoiceRelationshipField(sourceField) && !isInvoiceRelationshipField(targetField)) output[targetField] = value;
  }
  return output;
}

function baselineValues(value: InvoiceRecord, rules: VersionedFieldSettingsDto['config']['rules'], side: 'BITRIX24' | 'MOYSKLAD') {
  return Object.fromEntries(rules.map((rule) => [
    `rule:${rule.id}`,
    jsonValue(readField(value, side === 'BITRIX24' ? rule.sourceField : rule.targetField, side)),
  ]));
}

function readField(record: InvoiceRecord, field: string, source: Source): unknown {
  const attribute = field.match(/^attributes\.([0-9a-f-]{36})$/i);
  if (source === 'MOYSKLAD' && attribute && Array.isArray(record.attributes)) {
    const row = record.attributes.find((candidate) => isRecord(candidate) && (candidate.id === attribute[1] || recordId(candidate.meta) === attribute[1]));
    return isRecord(row) ? row.value : undefined;
  }
  return record[field];
}
function msValueCache(record: InvoiceRecord, field: string, value: unknown) { record[field] = value; }
function isExcludedField(source: string, target: string) { return [source, target].some((field) => ['payedsum', 'shippedsum', 'payments', 'shipment'].includes(field.toLowerCase())); }
function isInvoiceRelationshipField(field: string) { return ['parentid2', 'customerorder'].includes(field.toLowerCase()); }
function isScalar(value: unknown): boolean { return value === null || ['string', 'number', 'boolean'].includes(typeof value); }
function jsonValue(value: unknown): Prisma.InputJsonValue { return (value === undefined ? null : value) as Prisma.InputJsonValue; }
function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> { return isRecord(value) && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function recordId(value: unknown): string | null { if (!isRecord(value) || typeof value.href !== 'string') return null; return value.href.split('/').filter(Boolean).at(-1) ?? null; }
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function scalarId(value: unknown): string | null { return typeof value === 'string' || typeof value === 'number' ? String(value) : null; }
function isMoyskladId(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isDue(status: string, retryAfter: Date | null, processingStartedAt: Date | null): boolean {
  const now = Date.now();
  return status === 'RECEIVED' || status === 'WAITING_FOR_ORDER' ||
    (['RETRYABLE_FAILURE', 'DEFERRED_PAUSE'].includes(status) && (!retryAfter || retryAfter.getTime() <= now)) ||
    (status === 'PROCESSING' && (!processingStartedAt || processingStartedAt.getTime() < now - PROCESSING_LEASE_MS));
}
