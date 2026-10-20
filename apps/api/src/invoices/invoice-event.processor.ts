import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
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
import { ControlledLiveTestAdmissionService } from '../controlled-live-test-admission.service';
import { InvoicePairLease, withInvoicePairLock } from './invoice-pair-lock';
import { serviceModeBoundProvider, withServiceModeOn } from '../service-mode-transaction';

const logger = new Logger('InvoiceEventProcessor');
const PROCESSING_LEASE_MS = 60_000;
const RECOVERY_INTERVAL_MS = 1_000;
const MAX_ATTEMPTS = 8;
type Source = 'BITRIX24' | 'MOYSKLAD';
type InvoiceDirection = 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24';
type ProcessStatus = 'SUCCEEDED' | 'UNCHANGED' | 'SKIPPED_PRE_LAUNCH' | 'SKIPPED_DISABLED' | 'SKIPPED_DIRECTION_DISABLED' | 'WAITING_FOR_ORDER' | 'MANUAL_REVIEW' | 'RETRYABLE_FAILURE' | 'DEFERRED_PAUSE';

/** Owns only smart invoices (entityTypeId 31) and MySklad invoiceout documents. */
@Injectable()
export class InvoiceEventProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly active = new Set<string>();
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryScan: Promise<void> | null = null;
  private recoveryCursor: string | null = null;
  private readonly api: InvoiceHttpApi;

  constructor(
    private readonly database: DatabaseService,
    api: InvoiceHttpApi,
    private readonly fieldSettings: FieldSettingsService,
    private readonly syncMode: SyncModeService,
    private readonly databaseRecovery: DatabaseRecoveryService,
    private readonly workerLease: EventWorkerLeaseService,
    private readonly lifecycle: ClientLifecycleService,
    @Optional() private readonly controlledAdmission?: ControlledLiveTestAdmissionService,
  ) { this.api = serviceModeBoundProvider(database, api); }

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
      const scan = await withServiceModeOn(this.database, async (transaction) => {
        const now = new Date();
        const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
        return transaction.inboundEvent.findMany({
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
      });
      if (!scan.enabled) return;
      const pending = scan.value;
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
    catch { return null; }
    if (mode !== 'on') return null;
    if (process.env.SYNC_MODE !== 'apply' && process.env.SYNC_MODE !== 'dry') return null;
    let directionEnabled: boolean;
    try { directionEnabled = await this.syncMode.isDirectionEnabled('invoices', directionKey); }
    catch { return this.finish(event, 'RETRYABLE_FAILURE', 'INVOICE_DIRECTION_READ_FAILED', retryAtForFailure(new Error('INVOICE_DIRECTION_READ_FAILED'), event.attempts + 1), lease); }
    if (!directionEnabled) return this.finish(event, 'SKIPPED_DIRECTION_DISABLED', 'INVOICE_DIRECTION_DISABLED', null, lease);

    const claim = await withServiceModeOn(this.database, (transaction) => transaction.inboundEvent.updateMany({
      where: { id: event.id, OR: [
        { status: 'RECEIVED' }, { status: 'WAITING_FOR_ORDER' },
        { status: 'RETRYABLE_FAILURE', OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }] },
        { status: 'DEFERRED_PAUSE', OR: [{ retryAfter: null }, { retryAfter: { lte: new Date() } }] },
        { status: 'PROCESSING', OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: new Date(Date.now() - PROCESSING_LEASE_MS) } }] },
      ] },
      data: { status: 'PROCESSING', processingStartedAt: new Date(), attempts: { increment: 1 }, retryAfter: null, lastErrorCategory: null },
    }));
    if (!claim.enabled || claim.value.count !== 1) return null;

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
      const groups = config.groups.filter((group) => group.entity === 'smart-invoices');
      const groupError = validateInvoiceGroups(groups, rules);
      if (groupError) return this.finish(event, 'MANUAL_REVIEW', groupError, null, lease);

      const sourceRecord = this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled'
        ? await this.controlledAdmission.withCurrentSourceRead(event.id, source, sourceId, 'invoice', () => source === 'BITRIX24' ? this.api.readBitrix24(sourceId) : this.api.readMoysklad(sourceId))
        : source === 'BITRIX24' ? await this.api.readBitrix24(sourceId) : await this.api.readMoysklad(sourceId);
      const createdAt = invoiceCreatedAt(sourceRecord);
      if (!createdAt) return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_CREATION_TIME_UNAVAILABLE', null, lease);
      if (createdAt.getTime() < boundary.getTime()) return this.finish(event, 'SKIPPED_PRE_LAUNCH', 'PRE_LAUNCH_INVOICE', null, lease);
      if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
        const currentName = controlledInvoiceName(sourceRecord);
        if (!currentName) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_METADATA_INVALID');
        await this.controlledAdmission.admit(event.id, { entity: 'invoice', sourceSystem: source, sourceNativeId: sourceId,
          currentNativeId: sourceId, currentName, sourceCreatedAt: createdAt });
      }

      const link = resolveInvoiceOrderLink(sourceRecord, source);
      if (link.status !== 'linked') return this.finish(event, 'MANUAL_REVIEW', link.status === 'missing' ? 'INVOICE_ORDER_LINK_MISSING' : 'INVOICE_ORDER_LINK_AMBIGUOUS', null, lease);
      const resolveOrder = () => this.resolveOrderPair(source, link.orderId, boundary);
      const order = this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled'
        ? await this.controlledAdmission.runForEvent(event.id, resolveOrder) : await resolveOrder();
      if (order.status === 'WAITING_FOR_ORDER') return this.finish(event, 'WAITING_FOR_ORDER', order.reason, null, lease);
      if (order.status === 'SKIPPED_OUT_OF_SCOPE') return this.finish(event, 'SKIPPED_PRE_LAUNCH', order.reason, null, lease);
      if (order.status === 'MANUAL_REVIEW') return this.finish(event, 'MANUAL_REVIEW', order.reason, null, lease);

      const invoicePair = await this.findInvoicePair(source, sourceId);
      if (invoicePair.status === 'AMBIGUOUS') return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_PAIR_AMBIGUOUS', null, lease);
      if (invoicePair.status === 'TOMBSTONED') return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_PAIR_TOMBSTONED', null, lease);
      if (invoicePair.status === 'NONE') {
        if (process.env.SYNC_MODE === 'dry') return this.finish(event, 'SKIPPED_DISABLED', 'INVOICE_CREATE_REQUIRES_APPLY_MODE', null, lease);
        return await this.withInvoiceIdentityLease(source, sourceId, async () => {
          const create = () => this.createCounterpart({ eventId: event.id, source, sourceId, sourceRecord, orderId: order.pair.moyskladId, dealId: order.pair.bitrix24Id, rules, groups, settings, lease });
          const created = this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled'
            ? await this.controlledAdmission.runForEvent(event.id, create) : await create();
          if (created.status !== 'CREATED') return this.finish(event, created.status, created.reason, created.retryAfter ?? null, lease);
          const bitrix24Id = source === 'BITRIX24' ? sourceId : created.partnerId;
          const moyskladId = source === 'MOYSKLAD' ? sourceId : created.partnerId;
          const readPair = () => Promise.all([this.api.readBitrix24(bitrix24Id), this.api.readMoysklad(moyskladId)] as const);
          const [bitrix, moysklad] = this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled'
            ? await this.controlledAdmission.runForEvent(event.id, readPair) : await readPair();
          if (!invoicePairLinksMatchOrder(bitrix, moysklad, order.pair)) {
            return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_CREATE_READBACK_ORDER_LINK_MISMATCH', null, lease);
          }
          const pair = await this.persistPair(source, sourceId, created.partnerId, order.pair.moyskladId, event.id, lease);
          if (!pair) return this.finish(event, 'RETRYABLE_FAILURE', 'INVOICE_PAIR_PERSIST_FAILED', retryAtForFailure(new Error('INVOICE_PAIR_PERSIST_FAILED'), event.attempts + 1), lease);
          const baselineLock = await withInvoicePairLock(this.database, pair.id, event.id, async (pairLease) => {
            await this.initializeBaseline(pair.id, event.id, settings, rules, groups, bitrix, moysklad, pairLease);
            return true;
          });
          if (!baselineLock) return this.finish(event, 'RETRYABLE_FAILURE', 'INVOICE_PAIR_LOCK_BUSY', retryAtForFailure(new Error('INVOICE_PAIR_LOCK_BUSY'), event.attempts + 1), lease);
          return this.finish(event, 'SUCCEEDED', 'INVOICE_CREATED_AND_PAIRED', null, lease);
        });
      }
      if (invoicePair.pair.moyskladParentId && invoicePair.pair.moyskladParentId !== order.pair.moyskladId) {
        return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_ORDER_PAIR_CHANGED', null, lease);
      }
      const readPair = () => Promise.all([this.api.readBitrix24(invoicePair.pair.bitrix24Id), this.api.readMoysklad(invoicePair.pair.moyskladId)] as const);
      const [bitrix, moysklad] = this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled'
        ? await this.controlledAdmission.runForEvent(event.id, readPair) : await readPair();
      if (!invoicePairLinksMatchOrder(bitrix, moysklad, order.pair)) return this.finish(event, 'MANUAL_REVIEW', 'INVOICE_PAIR_ORDER_LINK_MISMATCH', null, lease);
      const result = await this.lifecycle.withPairActiveLock(invoicePair.pair.id, 'INVOICE', () => withInvoicePairLock(this.database, invoicePair.pair.id, event.id, async (pairLease) => {
        const baselineResult = await this.ensureBaseline(invoicePair.pair, order.pair, event.id, settings, rules, groups, bitrix, moysklad, lease, pairLease);
        if (baselineResult.status === 'SUPERSEDED') return { status: 'UNCHANGED', reason: 'SETTINGS_PIN_SUPERSEDED', retryAfter: null } as const;
        if (baselineResult.status !== 'READY') return baselineResult;
        const sync = () => this.syncFields({ pair: invoicePair.pair, order: order.pair, eventId: event.id, eventConfig: settings, rules, groups, baseline: baselineResult.baseline, bitrix: baselineResult.bitrix, moysklad: baselineResult.moysklad, lease, pairLease });
        return this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled' ? this.controlledAdmission.runForEvent(event.id, sync) : sync();
      }));
      if (!result) return this.finish(event, 'RETRYABLE_FAILURE', 'INVOICE_PAIR_LOCK_BUSY', retryAtForFailure(new Error('INVOICE_PAIR_LOCK_BUSY'), event.attempts + 1), lease);
      return this.finish(event, result.status, result.reason ?? '', result.retryAfter ?? null, lease);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('INVOICE_FIELD_TRANSFORM_CRITICAL:')) {
        return this.finish(event, 'MANUAL_REVIEW', error.message, null, lease);
      }
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
    eventId: string; source: Source; sourceId: string; sourceRecord: InvoiceRecord; orderId: string; dealId: string;
    rules: VersionedFieldSettingsDto['config']['rules']; groups: VersionedFieldSettingsDto['config']['groups']; settings: VersionedFieldSettingsDto; lease: EventWorkerLeaseContext;
  }): Promise<{ status: 'CREATED'; partnerId: string } | { status: 'MANUAL_REVIEW' | 'RETRYABLE_FAILURE'; reason: string; retryAfter?: Date }> {
    const direction: InvoiceDirection = input.source === 'BITRIX24' ? 'BITRIX24_TO_MOYSKLAD' : 'MOYSKLAD_TO_BITRIX24';
    const fields = mappedFields(input.sourceRecord, input.rules, input.groups, direction, input.settings.config, this.fieldSettings);
    if (this.controlledAdmission && process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
      const syntheticName = controlledInvoiceName(input.sourceRecord);
      if (!syntheticName) throw new Error('CONTROLLED_LIVE_TEST_SOURCE_METADATA_INVALID');
      fields[input.source === 'BITRIX24' ? 'name' : 'title'] = syntheticName;
    }
    if (input.source === 'BITRIX24') {
      const existing = await this.api.findMoyskladByExternalCode(input.sourceId);
      if (existing.length > 1) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_RECOVERY_AMBIGUOUS' };
      if (existing.length === 1) {
        const recoveredId = scalarId(existing[0]?.id);
        if (!recoveredId || !isMoyskladId(recoveredId)) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_RECOVERY_INVALID_ID' };
        this.controlledAdmission?.allowTargetReadback('MOYSKLAD', recoveredId);
        const recovered = await this.api.readMoysklad(recoveredId);
        const recoveredLink = resolveInvoiceOrderLink(recovered, 'MOYSKLAD');
        if (recovered.externalCode !== input.sourceId || recoveredLink.status !== 'linked' || recoveredLink.orderId !== input.orderId) {
          return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_RECOVERY_ORDER_LINK_MISMATCH' };
        }
        await this.bindControlledInvoiceTarget(input.eventId, 'MOYSKLAD', recoveredId, recovered);
        return { status: 'CREATED', partnerId: recoveredId };
      }
      await input.lease.assertOwned();
      const partnerId = await this.api.createMoysklad(input.sourceId, input.orderId, fields);
      if (partnerId.startsWith('dry:')) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_DRY_CREATE_READBACK_UNAVAILABLE' };
      this.controlledAdmission?.allowTargetReadback('MOYSKLAD', partnerId);
      const verified = await this.api.readMoysklad(partnerId);
      const link = resolveInvoiceOrderLink(verified, 'MOYSKLAD');
      if (link.status !== 'linked' || link.orderId !== input.orderId) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_READBACK_ORDER_LINK_MISMATCH' };
      await this.bindControlledInvoiceTarget(input.eventId, 'MOYSKLAD', partnerId, verified);
      return { status: 'CREATED', partnerId };
    }
    const existing = await this.api.findBitrix24ByOrigin(input.sourceId);
    if (existing.length > 1) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_RECOVERY_AMBIGUOUS' };
    if (existing.length === 1) {
      const id = scalarId(existing[0]?.id);
      if (!id || !/^\d{1,20}$/.test(id)) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_RECOVERY_INVALID_ID' };
      this.controlledAdmission?.allowTargetReadback('BITRIX24', id);
      const recovered = await this.api.readBitrix24(id);
      const recoveredLink = resolveInvoiceOrderLink(recovered, 'BITRIX24');
      if (String(recovered.originatorId ?? '') !== 'MOYSKLAD' || String(recovered.originId ?? '') !== input.sourceId ||
        recoveredLink.status !== 'linked' || recoveredLink.orderId !== input.dealId) {
        return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_RECOVERY_ORDER_LINK_MISMATCH' };
      }
      await this.bindControlledInvoiceTarget(input.eventId, 'BITRIX24', id, recovered);
      return { status: 'CREATED', partnerId: id };
    }
    await input.lease.assertOwned();
    const partnerId = await this.api.createBitrix24(input.sourceId, input.dealId, fields);
    if (partnerId.startsWith('dry:')) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_DRY_CREATE_READBACK_UNAVAILABLE' };
    this.controlledAdmission?.allowTargetReadback('BITRIX24', partnerId);
    const verified = await this.api.readBitrix24(partnerId);
    const link = resolveInvoiceOrderLink(verified, 'BITRIX24');
    if (link.status !== 'linked' || link.orderId !== input.dealId) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_CREATE_READBACK_ORDER_LINK_MISMATCH' };
    await this.bindControlledInvoiceTarget(input.eventId, 'BITRIX24', partnerId, verified);
    return { status: 'CREATED', partnerId };
  }

  private async bindControlledInvoiceTarget(eventId: string, provider: Source, nativeId: string, record: InvoiceRecord): Promise<void> {
    if (!this.controlledAdmission || process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
    const name = controlledInvoiceName(record);
    const createdAt = invoiceCreatedAt(record);
    if (!name || !createdAt) throw new Error('CONTROLLED_LIVE_TEST_TARGET_READBACK_INVALID');
    await this.controlledAdmission.bindCreatedTarget(eventId, nativeId, nativeId, name, createdAt);
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

  private async initializeBaseline(pairId: string, eventId: string, settings: VersionedFieldSettingsDto, rules: VersionedFieldSettingsDto['config']['rules'], groups: VersionedFieldSettingsDto['config']['groups'], bitrix: InvoiceRecord, moysklad: InvoiceRecord, pairLease: InvoicePairLease) {
    const bitrix24Values = baselineValues(bitrix, rules, groups, 'BITRIX24');
    const moyskladValues = baselineValues(moysklad, rules, groups, 'MOYSKLAD');
    const committed = await pairLease.commit(async (transaction) => {
      await transaction.entityPairBaseline.createMany({ data: [{ pairId, eventId, settingsVersion: settings.version, bitrix24Values: bitrix24Values as unknown as Prisma.InputJsonValue, moyskladValues: moyskladValues as unknown as Prisma.InputJsonValue }], skipDuplicates: true });
      await transaction.entityPairSyncState.upsert({
        where: { pairId },
        create: { pairId, settingsVersion: settings.version, bitrix24Values: bitrix24Values as unknown as Prisma.InputJsonValue, moyskladValues: moyskladValues as unknown as Prisma.InputJsonValue },
        update: {},
      });
    });
    if (!committed.committed) throw new Error('INVOICE_PAIR_LOCK_LOST');
  }

  private async ensureBaseline(
    pair: { id: string; entityType: string; bitrix24Id: string; moyskladId: string }, order: { bitrix24Id: string; moyskladId: string }, eventId: string,
    settings: VersionedFieldSettingsDto, rules: VersionedFieldSettingsDto['config']['rules'], groups: VersionedFieldSettingsDto['config']['groups'],
    bitrix: InvoiceRecord, moysklad: InvoiceRecord, eventLease: EventWorkerLeaseContext, pairLease: InvoicePairLease,
  ): Promise<{ status: 'READY'; baseline: any; bitrix: InvoiceRecord; moysklad: InvoiceRecord } | { status: 'SUPERSEDED' } | { status: 'RETRYABLE_FAILURE' | 'MANUAL_REVIEW'; reason: string; retryAfter?: Date }> {
    let baseline = await this.database.entityPairBaseline.findUnique({ where: { pairId: pair.id } });
    if (!baseline) {
      try { await this.initializeBaseline(pair.id, eventId, settings, rules, groups, bitrix, moysklad, pairLease); }
      catch (error) { return { status: 'RETRYABLE_FAILURE', reason: error instanceof Error ? error.message : 'INVOICE_BASELINE_PERSIST_FAILED', retryAfter: retryAtForFailure(error, 1) }; }
      baseline = await this.database.entityPairBaseline.findUnique({ where: { pairId: pair.id } });
      if (!baseline) return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_BASELINE_PERSIST_FAILED', retryAfter: retryAtForFailure(new Error('INVOICE_BASELINE_PERSIST_FAILED'), 1) };
    }
    if (settings.version < baseline.settingsVersion) return { status: 'SUPERSEDED' };
    let state = await this.database.entityPairSyncState.findUnique({ where: { pairId: pair.id } });
    if (settings.version === baseline.settingsVersion) {
      if (state && state.settingsVersion !== settings.version) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_SYNC_STATE_VERSION_MISMATCH' };
      if (!state) {
        const committed = await pairLease.commit((transaction) => transaction.entityPairSyncState.create({ data: { pairId: pair.id, settingsVersion: settings.version, bitrix24Values: baseline.bitrix24Values as Prisma.InputJsonValue, moyskladValues: baseline.moyskladValues as Prisma.InputJsonValue } }));
        if (!committed.committed) return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_PAIR_LOCK_LOST', retryAfter: retryAtForFailure(new Error('INVOICE_PAIR_LOCK_LOST'), 1) };
        state = await this.database.entityPairSyncState.findUnique({ where: { pairId: pair.id } });
      }
      return state ? { status: 'READY', baseline: state, bitrix, moysklad } : { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_SYNC_STATE_PERSIST_FAILED', retryAfter: retryAtForFailure(new Error('INVOICE_SYNC_STATE_PERSIST_FAILED'), 1) };
    }

    let oldSettings: VersionedFieldSettingsDto;
    try { oldSettings = await this.fieldSettings.version(baseline.settingsVersion); }
    catch { return { status: 'MANUAL_REVIEW', reason: 'INVOICE_SETTINGS_REVISION_SOURCE_UNAVAILABLE' }; }
    const oldRules = oldSettings.config.rules.filter((rule) => rule.entity === 'smart-invoices' && (rule.bitrix24ToMoysklad.enabled || rule.moyskladToBitrix24.enabled));
    const oldGroups = oldSettings.config.groups.filter((group) => group.entity === 'smart-invoices');
    const oldProjection = invoiceSettingsProjection(oldRules, oldGroups);
    const newProjection = invoiceSettingsProjection(rules, groups);
    const changedRules = rules.filter((rule) => rule.entity === 'smart-invoices' && !oldRules.some((old) => stableJson(invoiceRuleSemantic(old)) === stableJson(invoiceRuleSemantic(rule))));
    const changedGroups = groups.filter((group) => group.entity === 'smart-invoices' && !oldGroups.some((old) => stableJson(invoiceGroupSemantic(old)) === stableJson(invoiceGroupSemantic(group))));
    const fingerprint = createHash('sha256').update(stableJson(newProjection)).digest('hex');
    const previousBaseline = {
      settingsVersion: baseline.settingsVersion, bitrix24Values: baseline.bitrix24Values, moyskladValues: baseline.moyskladValues,
      capturedAt: baseline.capturedAt.toISOString(),
      syncState: state ? { settingsVersion: state.settingsVersion, bitrix24Values: state.bitrix24Values, moyskladValues: state.moyskladValues } : null,
    } as Prisma.InputJsonValue;
    try {
      await this.database.entityPairSettingsRevision.upsert({
        where: { pairId_toSettingsVersion: { pairId: pair.id, toSettingsVersion: settings.version } },
        create: { pairId: pair.id, fromSettingsVersion: baseline.settingsVersion, toSettingsVersion: settings.version, status: 'PREPARED', semanticFingerprint: fingerprint, previousBaseline },
        update: {},
      });
    } catch { return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_SETTINGS_REVISION_PERSIST_FAILED', retryAfter: retryAtForFailure(new Error('INVOICE_SETTINGS_REVISION_PERSIST_FAILED'), 1) }; }

    let verifiedBitrix = bitrix;
    let verifiedMoysklad = moysklad;
    if (stableJson(oldProjection) !== stableJson(newProjection)) {
      if (process.env.SYNC_MODE !== 'apply') return { status: 'MANUAL_REVIEW', reason: 'INVOICE_SETTINGS_REVISION_REQUIRES_APPLY' };
      try {
        [verifiedBitrix, verifiedMoysklad] = await Promise.all([this.api.readBitrix24(pair.bitrix24Id), this.api.readMoysklad(pair.moyskladId)]);
      } catch (error) { return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_SETTINGS_REVISION_READ_FAILED', retryAfter: retryAtForFailure(error, 1) }; }
      if (!invoicePairLinksMatchOrder(verifiedBitrix, verifiedMoysklad, order)) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_SETTINGS_REVISION_ORDER_LINK_MISMATCH' };
      const reconciled = await this.reconcileInvoiceRevision(pair, order, eventId, changedRules, changedGroups, settings, verifiedBitrix, verifiedMoysklad, eventLease, pairLease);
      if (reconciled.status !== 'READY') {
        await this.database.entityPairSettingsRevision.updateMany({
          where: { pairId: pair.id, toSettingsVersion: settings.version, status: 'PREPARED' },
          data: { ...(reconciled.status === 'MANUAL_REVIEW' ? { status: 'FAILED' } : {}), errorCategory: reconciled.reason },
        }).catch(() => undefined);
        return reconciled;
      }
      verifiedBitrix = reconciled.bitrix;
      verifiedMoysklad = reconciled.moysklad;
    }

    const baselineB24 = remapInvoiceSnapshot(baseline.bitrix24Values, oldRules, oldGroups, rules, groups, verifiedBitrix, 'BITRIX24');
    const baselineMs = remapInvoiceSnapshot(baseline.moyskladValues, oldRules, oldGroups, rules, groups, verifiedMoysklad, 'MOYSKLAD');
    const stateB24 = remapInvoiceSnapshot(state?.bitrix24Values ?? baseline.bitrix24Values, oldRules, oldGroups, rules, groups, verifiedBitrix, 'BITRIX24');
    const stateMs = remapInvoiceSnapshot(state?.moyskladValues ?? baseline.moyskladValues, oldRules, oldGroups, rules, groups, verifiedMoysklad, 'MOYSKLAD');
    try {
      const committed = await pairLease.commit(async (transaction) => {
        const current = await transaction.entityPairBaseline.findUnique({ where: { pairId: pair.id } });
        if (!current || current.settingsVersion !== baseline.settingsVersion) throw new Error('INVOICE_SETTINGS_REVISION_BASELINE_CHANGED');
        await transaction.entityPairBaseline.update({ where: { pairId: pair.id }, data: { settingsVersion: settings.version, bitrix24Values: baselineB24 as Prisma.InputJsonValue, moyskladValues: baselineMs as Prisma.InputJsonValue } });
        await transaction.entityPairSyncState.upsert({
          where: { pairId: pair.id },
          create: { pairId: pair.id, settingsVersion: settings.version, bitrix24Values: stateB24 as Prisma.InputJsonValue, moyskladValues: stateMs as Prisma.InputJsonValue },
          update: { settingsVersion: settings.version, bitrix24Values: stateB24 as Prisma.InputJsonValue, moyskladValues: stateMs as Prisma.InputJsonValue },
        });
        await transaction.entityPairSettingsRevision.update({
          where: { pairId_toSettingsVersion: { pairId: pair.id, toSettingsVersion: settings.version } },
          data: { status: 'COMPLETE', currentBaseline: { settingsVersion: settings.version, bitrix24Values: baselineB24, moyskladValues: baselineMs } as Prisma.InputJsonValue },
        });
        return transaction.entityPairBaseline.findUnique({ where: { pairId: pair.id } });
      });
      if (!committed.committed || !committed.value) return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_SETTINGS_REVISION_COMMIT_FAILED', retryAfter: retryAtForFailure(new Error('INVOICE_SETTINGS_REVISION_COMMIT_FAILED'), 1) };
      return { status: 'READY', baseline: committed.value, bitrix: verifiedBitrix, moysklad: verifiedMoysklad };
    } catch {
      await this.database.entityPairSettingsRevision.updateMany({ where: { pairId: pair.id, toSettingsVersion: settings.version, status: 'PREPARED' }, data: { status: 'FAILED', errorCategory: 'INVOICE_SETTINGS_REVISION_COMMIT_FAILED' } }).catch(() => undefined);
      return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_SETTINGS_REVISION_COMMIT_FAILED', retryAfter: retryAtForFailure(new Error('INVOICE_SETTINGS_REVISION_COMMIT_FAILED'), 1) };
    }
  }

  private async reconcileInvoiceRevision(
    pair: { id: string; bitrix24Id: string; moyskladId: string }, order: { bitrix24Id: string; moyskladId: string }, eventId: string,
    changedRules: VersionedFieldSettingsDto['config']['rules'], changedGroups: VersionedFieldSettingsDto['config']['groups'], config: VersionedFieldSettingsDto,
    bitrix: InvoiceRecord, moysklad: InvoiceRecord, eventLease: EventWorkerLeaseContext, pairLease: InvoicePairLease,
  ): Promise<{ status: 'READY'; bitrix: InvoiceRecord; moysklad: InvoiceRecord } | { status: 'RETRYABLE_FAILURE' | 'MANUAL_REVIEW'; reason: string; retryAfter?: Date }> {
    const write = async (field: string, value: unknown, sourceFields: string[]): Promise<{ status: 'READY' } | { status: 'RETRYABLE_FAILURE' | 'MANUAL_REVIEW'; reason: string; retryAfter?: Date }> => {
      if (!(isScalar(value) || Array.isArray(value))) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_SETTINGS_REVISION_VALUE_SHAPE_UNSUPPORTED' };
      let latestB24: InvoiceRecord;
      let latestMs: InvoiceRecord;
      try { [latestB24, latestMs] = await Promise.all([this.api.readBitrix24(pair.bitrix24Id), this.api.readMoysklad(pair.moyskladId)]); }
      catch (error) { return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_SETTINGS_REVISION_READ_BEFORE_WRITE_FAILED', retryAfter: retryAtForFailure(error, 1) }; }
      if (!invoicePairLinksMatchOrder(latestB24, latestMs, order)) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_SETTINGS_REVISION_ORDER_LINK_MISMATCH' };
      if (!sameJson(readField(latestB24, field, 'BITRIX24'), readField(bitrix, field, 'BITRIX24')) ||
        sourceFields.some((sourceField) => !sameJson(readField(latestMs, sourceField, 'MOYSKLAD'), readField(moysklad, sourceField, 'MOYSKLAD')))) {
        return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_SETTINGS_REVISION_SOURCE_CHANGED', retryAfter: retryAtForFailure(new Error('INVOICE_SETTINGS_REVISION_SOURCE_CHANGED'), 1) };
      }
      const current = readField(latestB24, field, 'BITRIX24');
      Object.assign(bitrix, latestB24);
      Object.assign(moysklad, latestMs);
      if (!sameJson(current, value)) {
        try {
          await pairLease.assertOwned();
          await this.assertWriteAllowed('MOYSKLAD_TO_BITRIX24', pair.id, eventLease);
          await eventLease.assertOwned();
          await this.api.updateBitrix24(pair.bitrix24Id, { [field]: value });
        } catch (error) {
          return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_SETTINGS_REVISION_WRITE_FAILED', retryAfter: retryAtForFailure(error, 1) };
        }
      }
      let verifiedB24: InvoiceRecord;
      let verifiedMs: InvoiceRecord;
      try { [verifiedB24, verifiedMs] = await Promise.all([this.api.readBitrix24(pair.bitrix24Id), this.api.readMoysklad(pair.moyskladId)]); }
      catch (error) { return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_SETTINGS_REVISION_READBACK_FAILED', retryAfter: retryAtForFailure(error, 1) }; }
      if (!invoicePairLinksMatchOrder(verifiedB24, verifiedMs, order)) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_SETTINGS_REVISION_ORDER_LINK_MISMATCH' };
      if (!sameJson(readField(verifiedB24, field, 'BITRIX24'), value)) return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_SETTINGS_REVISION_READBACK_MISMATCH', retryAfter: retryAtForFailure(new Error('INVOICE_SETTINGS_REVISION_READBACK_MISMATCH'), 1) };
      Object.assign(bitrix, verifiedB24);
      Object.assign(moysklad, verifiedMs);
      return { status: 'READY' };
    };
    for (const rule of changedRules.filter((candidate) => candidate.entity === 'smart-invoices' && (candidate.bitrix24ToMoysklad.enabled || candidate.moyskladToBitrix24.enabled))) {
      if (!rule.moyskladToBitrix24.enabled) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_SETTINGS_REVISION_REQUIRES_MOYSKLAD_AUTHORITY' };
      const transformed = this.fieldSettings.transformFieldResult(config.config, 'smart-invoices', 'MOYSKLAD_TO_BITRIX24', rule.sourceField, moysklad);
      if (!transformed || transformed.status !== 'mapped') return { status: 'MANUAL_REVIEW', reason: 'INVOICE_SETTINGS_REVISION_TRANSFORM_INVALID' };
      const result = await write(rule.sourceField, transformed.value, [rule.targetField]);
      if (result.status !== 'READY') return result;
    }
    for (const group of changedGroups.filter((candidate) => candidate.entity === 'smart-invoices')) {
      if (group.direction !== 'MOYSKLAD_TO_BITRIX24') return { status: 'MANUAL_REVIEW', reason: 'INVOICE_SETTINGS_REVISION_GROUP_REQUIRES_MOYSKLAD_AUTHORITY' };
      const transformed = this.fieldSettings.transformFieldResult(config.config, 'smart-invoices', group.direction, group.targetField, moysklad);
      if (!transformed || transformed.status !== 'mapped') return { status: 'MANUAL_REVIEW', reason: 'INVOICE_SETTINGS_REVISION_GROUP_TRANSFORM_INVALID' };
      const result = await write(group.targetField, transformed.value, group.sourceFields);
      if (result.status !== 'READY') return result;
    }
    const [verifiedB24, verifiedMs] = await Promise.all([this.api.readBitrix24(pair.bitrix24Id), this.api.readMoysklad(pair.moyskladId)]);
    if (!await pairLease.assertOwned()) return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_PAIR_LOCK_LOST', retryAfter: retryAtForFailure(new Error('INVOICE_PAIR_LOCK_LOST'), 1) };
    if (!invoicePairLinksMatchOrder(verifiedB24, verifiedMs, order)) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_SETTINGS_REVISION_ORDER_LINK_MISMATCH' };
    return { status: 'READY', bitrix: verifiedB24, moysklad: verifiedMs };
  }

  private async syncFields(input: {
    pair: { id: string; bitrix24Id: string; moyskladId: string }; order: { bitrix24Id: string; moyskladId: string }; eventId: string; eventConfig: VersionedFieldSettingsDto;
    rules: VersionedFieldSettingsDto['config']['rules']; groups: VersionedFieldSettingsDto['config']['groups']; baseline: any; bitrix: InvoiceRecord; moysklad: InvoiceRecord; lease: EventWorkerLeaseContext; pairLease: InvoicePairLease;
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
      const targetField = plan.direction === 'BITRIX24_TO_MOYSKLAD' ? rule.targetField : rule.sourceField;
      const transformSource = plan.direction === 'BITRIX24_TO_MOYSKLAD' ? input.bitrix : input.moysklad;
      const transformed = this.fieldSettings.transformFieldResult(input.eventConfig.config, 'smart-invoices', plan.direction, targetField, transformSource);
      if (!transformed || transformed.status === 'skip') continue;
      if (transformed.status === 'error') {
        if (rule.criticality === 'critical') return { status: 'MANUAL_REVIEW', reason: `INVOICE_FIELD_TRANSFORM_FAILED:${targetField}` };
        logger.warn(`Optional invoice field transform skipped (${targetField}): ${transformed.reason}`);
        continue;
      }
      const writeValue = transformed.value;
      try {
        if (!await input.pairLease.assertOwned()) return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_PAIR_LOCK_LOST', retryAfter: retryAtForFailure(new Error('INVOICE_PAIR_LOCK_LOST'), 1) };
        await this.assertWriteAllowed(plan.direction, input.pair.id, input.lease);
        if (plan.direction === 'BITRIX24_TO_MOYSKLAD') await this.api.updateMoysklad(input.pair.moyskladId, { [rule.targetField]: writeValue });
        else await this.api.updateBitrix24(input.pair.bitrix24Id, { [rule.sourceField]: writeValue });
        const target = plan.direction === 'BITRIX24_TO_MOYSKLAD' ? await this.api.readMoysklad(input.pair.moyskladId) : await this.api.readBitrix24(input.pair.bitrix24Id);
        const [verifiedB24, verifiedMs] = await Promise.all([this.api.readBitrix24(input.pair.bitrix24Id), this.api.readMoysklad(input.pair.moyskladId)]);
        if (!invoicePairLinksMatchOrder(verifiedB24, verifiedMs, input.order)) {
          return { status: 'MANUAL_REVIEW', reason: 'INVOICE_POST_WRITE_ORDER_LINK_MISMATCH' };
        }
        const actual = plan.direction === 'BITRIX24_TO_MOYSKLAD' ? readField(target, rule.targetField, 'MOYSKLAD') : readField(target, rule.sourceField, 'BITRIX24');
        if (!sameJson(actual, writeValue)) return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_FIELD_READBACK_MISMATCH', retryAfter: retryAtForFailure(new Error('INVOICE_FIELD_READBACK_MISMATCH'), 1) };
        if (plan.direction === 'BITRIX24_TO_MOYSKLAD') msValueCache(input.moysklad, rule.targetField, actual);
        else msValueCache(input.bitrix, rule.sourceField, actual);
      } catch (error) {
        if (error instanceof ProviderFailure && !isRetryableFailure(error)) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_PROVIDER_REJECTED' };
        return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_FIELD_WRITE_FAILED', retryAfter: retryAtForFailure(error, 1) };
      }
    }
    for (const group of input.groups) {
      const key = `group:${group.id}`;
      const sourceSide = group.direction === 'BITRIX24_TO_MOYSKLAD' ? 'BITRIX24' : 'MOYSKLAD';
      const targetSide = sourceSide === 'BITRIX24' ? 'MOYSKLAD' : 'BITRIX24';
      const source = sourceSide === 'BITRIX24' ? input.bitrix : input.moysklad;
      const target = targetSide === 'BITRIX24' ? input.bitrix : input.moysklad;
      const sourceBaseline = jsonRecord(baselineForSide(input.baseline, sourceSide))[key];
      const targetBaseline = jsonRecord(baselineForSide(input.baseline, targetSide))[key];
      if (!isRecord(sourceBaseline) || !('sourceFields' in sourceBaseline) || !isRecord(targetBaseline) || !('targetValue' in targetBaseline)) {
        return { status: 'MANUAL_REVIEW', reason: 'INVOICE_FIELD_GROUP_NOT_IN_BASELINE' };
      }
      const originalFields = jsonRecord(sourceBaseline.sourceFields);
      const sourceChanged = group.sourceFields.some((field) => !sameJson(jsonValue(readField(source, field, sourceSide)), originalFields[field]));
      if (!sourceChanged) continue;
      const currentTarget = readField(target, group.targetField, targetSide);
      const targetChanged = !sameJson(jsonValue(currentTarget), jsonRecord(targetBaseline).targetValue);
      if (targetChanged && sourceSide === 'BITRIX24') continue;
      const transformed = this.fieldSettings.transformFieldResult(input.eventConfig.config, 'smart-invoices', group.direction, group.targetField, source);
      if (!transformed || transformed.status === 'skip') continue;
      if (transformed.status === 'error') {
        if (group.criticality === 'critical') return { status: 'MANUAL_REVIEW', reason: 'INVOICE_FIELD_GROUP_TRANSFORM_FAILED' };
        logger.warn(`Optional invoice field group transform skipped (${group.targetField}): ${transformed.reason}`);
        continue;
      }
      if (!isScalar(transformed.value) && !Array.isArray(transformed.value)) {
        return { status: 'MANUAL_REVIEW', reason: 'INVOICE_FIELD_GROUP_VALUE_SHAPE_UNSUPPORTED' };
      }
      try {
        if (!await input.pairLease.assertOwned()) return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_PAIR_LOCK_LOST', retryAfter: retryAtForFailure(new Error('INVOICE_PAIR_LOCK_LOST'), 1) };
        await this.assertWriteAllowed(group.direction, input.pair.id, input.lease);
        if (targetSide === 'MOYSKLAD') await this.api.updateMoysklad(input.pair.moyskladId, { [group.targetField]: transformed.value });
        else await this.api.updateBitrix24(input.pair.bitrix24Id, { [group.targetField]: transformed.value });
        const verified = targetSide === 'MOYSKLAD' ? await this.api.readMoysklad(input.pair.moyskladId) : await this.api.readBitrix24(input.pair.bitrix24Id);
        const [verifiedB24, verifiedMs] = await Promise.all([this.api.readBitrix24(input.pair.bitrix24Id), this.api.readMoysklad(input.pair.moyskladId)]);
        if (!invoicePairLinksMatchOrder(verifiedB24, verifiedMs, input.order)) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_POST_WRITE_ORDER_LINK_MISMATCH' };
        const actual = readField(verified, group.targetField, targetSide);
        if (!sameJson(actual, transformed.value)) return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_FIELD_GROUP_READBACK_MISMATCH', retryAfter: retryAtForFailure(new Error('INVOICE_FIELD_GROUP_READBACK_MISMATCH'), 1) };
        if (targetSide === 'MOYSKLAD') msValueCache(input.moysklad, group.targetField, actual);
        else msValueCache(input.bitrix, group.targetField, actual);
      } catch (error) {
        if (error instanceof ProviderFailure && !isRetryableFailure(error)) return { status: 'MANUAL_REVIEW', reason: 'INVOICE_PROVIDER_REJECTED' };
        return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_FIELD_GROUP_WRITE_FAILED', retryAfter: retryAtForFailure(error, 1) };
      }
    }
    const [latestB24, latestMs] = await Promise.all([this.api.readBitrix24(input.pair.bitrix24Id), this.api.readMoysklad(input.pair.moyskladId)]);
    if (!invoicePairLinksMatchOrder(latestB24, latestMs, input.order)) {
      return { status: 'MANUAL_REVIEW', reason: 'INVOICE_POST_WRITE_ORDER_LINK_MISMATCH' };
    }
    const bitrix24Values = baselineValues(latestB24, input.rules, input.groups, 'BITRIX24');
    const moyskladValues = baselineValues(latestMs, input.rules, input.groups, 'MOYSKLAD');
    const committed = await input.pairLease.commit((transaction) => transaction.entityPairSyncState.upsert({
      where: { pairId: input.pair.id },
      create: { pairId: input.pair.id, settingsVersion: input.eventConfig.version, bitrix24Values, moyskladValues },
      update: { settingsVersion: input.eventConfig.version, bitrix24Values, moyskladValues },
    }));
    if (!committed.committed) return { status: 'RETRYABLE_FAILURE', reason: 'INVOICE_PAIR_LOCK_LOST', retryAfter: retryAtForFailure(new Error('INVOICE_PAIR_LOCK_LOST'), 1) };
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
    await withServiceModeOn(this.database, async (transaction) => {
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

function mappedFields(source: InvoiceRecord, rules: VersionedFieldSettingsDto['config']['rules'], groups: VersionedFieldSettingsDto['config']['groups'], direction: InvoiceDirection, config: VersionedFieldSettingsDto['config'], fieldSettings: FieldSettingsService): InvoiceRecord {
  const output: InvoiceRecord = {};
  for (const rule of rules) {
    const mapping = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.bitrix24ToMoysklad : rule.moyskladToBitrix24;
    if (!mapping.enabled) continue;
    const sourceField = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.sourceField : rule.targetField;
    const targetField = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.targetField : rule.sourceField;
    if (isExcludedField(sourceField, targetField) || isInvoiceRelationshipField(sourceField) || isInvoiceRelationshipField(targetField)) continue;
    const transformed = fieldSettings.transformFieldResult(config, 'smart-invoices', direction, targetField, source);
    if (transformed?.status === 'mapped') output[targetField] = transformed.value;
    else if (transformed?.status === 'error' && rule.criticality === 'critical') throw new Error(`INVOICE_FIELD_TRANSFORM_CRITICAL:${targetField}`);
    else if (transformed?.status === 'error') logger.warn(`Optional invoice field transform skipped (${targetField}): ${transformed.reason}`);
  }
  for (const group of groups.filter((candidate) => candidate.direction === direction)) {
    const transformed = fieldSettings.transformFieldResult(config, 'smart-invoices', direction, group.targetField, source);
    if (transformed?.status === 'skip') continue;
    if (transformed?.status === 'error') {
      if (group.criticality === 'critical') throw new Error(`INVOICE_FIELD_GROUP_TRANSFORM_CRITICAL:${group.targetField}`);
      logger.warn(`Optional invoice field group transform skipped (${group.targetField}): ${transformed.reason}`);
      continue;
    }
    if (!transformed || !(isScalar(transformed.value) || Array.isArray(transformed.value))) throw new Error('INVOICE_FIELD_GROUP_VALUE_SHAPE_UNSUPPORTED');
    output[group.targetField] = transformed.value;
  }
  return output;
}

function baselineValues(value: InvoiceRecord, rules: VersionedFieldSettingsDto['config']['rules'], groups: VersionedFieldSettingsDto['config']['groups'], side: 'BITRIX24' | 'MOYSKLAD') {
  const values = Object.fromEntries(rules.map((rule) => [
    `rule:${rule.id}`,
    jsonValue(readField(value, side === 'BITRIX24' ? rule.sourceField : rule.targetField, side)),
  ]));
  for (const group of groups) {
    const sourceSide = group.direction === 'BITRIX24_TO_MOYSKLAD' ? 'BITRIX24' : 'MOYSKLAD';
    values[`group:${group.id}`] = side === sourceSide
      ? { sourceFields: Object.fromEntries(group.sourceFields.map((field) => [field, jsonValue(readField(value, field, side))])) }
      : { targetValue: jsonValue(readField(value, group.targetField, side)) };
  }
  return values;
}

function invoiceRuleSemantic(rule: VersionedFieldSettingsDto['config']['rules'][number]) {
  return {
    entity: rule.entity, sourceField: rule.sourceField, targetField: rule.targetField, criticality: rule.criticality,
    bitrix24ToMoysklad: { enabled: rule.bitrix24ToMoysklad.enabled, transform: rule.bitrix24ToMoysklad.transform },
    moyskladToBitrix24: { enabled: rule.moyskladToBitrix24.enabled, transform: rule.moyskladToBitrix24.transform },
  };
}

function invoiceGroupSemantic(group: VersionedFieldSettingsDto['config']['groups'][number]) {
  return { entity: group.entity, direction: group.direction, sourceFields: group.sourceFields, targetField: group.targetField, criticality: group.criticality, transform: group.transform };
}

function invoiceSettingsProjection(rules: VersionedFieldSettingsDto['config']['rules'], groups: VersionedFieldSettingsDto['config']['groups']) {
  return {
    rules: rules.map(invoiceRuleSemantic).sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
    groups: groups.map(invoiceGroupSemantic).sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
  };
}

function remapInvoiceSnapshot(
  snapshot: unknown,
  oldRules: VersionedFieldSettingsDto['config']['rules'], oldGroups: VersionedFieldSettingsDto['config']['groups'],
  newRules: VersionedFieldSettingsDto['config']['rules'], newGroups: VersionedFieldSettingsDto['config']['groups'],
  live: InvoiceRecord, side: Source,
): Record<string, unknown> {
  const prior = jsonRecord(snapshot);
  const result: Record<string, unknown> = {};
  const rules = newRules.filter((rule) => rule.entity === 'smart-invoices');
  const groups = newGroups.filter((group) => group.entity === 'smart-invoices');
  for (const rule of rules) {
    const old = oldRules.find((candidate) => stableJson(invoiceRuleSemantic(candidate)) === stableJson(invoiceRuleSemantic(rule)));
    if (old && `rule:${old.id}` in prior) result[`rule:${rule.id}`] = prior[`rule:${old.id}`];
    else result[`rule:${rule.id}`] = baselineValues(live, [rule], [], side)[`rule:${rule.id}`];
  }
  for (const group of groups) {
    const old = oldGroups.find((candidate) => stableJson(invoiceGroupSemantic(candidate)) === stableJson(invoiceGroupSemantic(group)));
    if (old && `group:${old.id}` in prior) result[`group:${group.id}`] = prior[`group:${old.id}`];
    else result[`group:${group.id}`] = baselineValues(live, [], [group], side)[`group:${group.id}`];
  }
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function baselineForSide(baseline: unknown, side: 'BITRIX24' | 'MOYSKLAD') {
  const values = jsonRecord(baseline);
  return side === 'BITRIX24' ? values.bitrix24Values : values.moyskladValues;
}

function validateInvoiceGroups(groups: VersionedFieldSettingsDto['config']['groups'], rules: VersionedFieldSettingsDto['config']['rules']): string | null {
  const targets = new Set<string>();
  for (const rule of rules) {
    if (rule.bitrix24ToMoysklad.enabled) targets.add(`BITRIX24_TO_MOYSKLAD:${rule.targetField.toLowerCase()}`);
    if (rule.moyskladToBitrix24.enabled) targets.add(`MOYSKLAD_TO_BITRIX24:${rule.sourceField.toLowerCase()}`);
  }
  for (const group of groups) {
    if (group.transform.kind !== 'join-non-empty' || !group.transform.separator || group.sourceFields.length === 0) return 'INVOICE_FIELD_GROUP_UNSUPPORTED';
    if (isInvoiceRelationshipField(group.targetField) || isExcludedField(group.targetField, group.targetField) || group.sourceFields.some((field) => isInvoiceRelationshipField(field) || isExcludedField(field, field))) return 'INVOICE_RELATIONSHIP_MAPPING_UNSUPPORTED';
    const key = `${group.direction}:${group.targetField.toLowerCase()}`;
    if (targets.has(key)) return 'INVOICE_FIELD_GROUP_TARGET_AMBIGUOUS';
    targets.add(key);
  }
  return null;
}

function controlledInvoiceName(record: InvoiceRecord): string | null {
  const name = record.name ?? record.title ?? record.TITLE;
  return typeof name === 'string' && name.trim() ? name : null;
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
function jsonRecord(value: unknown): Record<string, unknown> { return isRecord(value) && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
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
