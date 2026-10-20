import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database.service';
import { writeOperationalLog } from '../monitoring-log';
import { VersionedFieldSettingsDto } from '../field-settings/field-settings.dto';
import { PairResolutionResult } from '../pairs/pair-resolver';
import { DealOrderPairLease, withDealOrderPairLock } from './deal-order-pair-lock';
import { bitrixMoneyToMoySklad, moySkladMoneyToBitrix } from './deal-order-money';
import { DealOrderWriteDirection, DealOrderWriteGateError, SyncModeService } from '../sync-mode.service';
import { DealOrderReverseCreateService, DealOrderReverseManualReviewError } from './deal-order-reverse-create.service';
import { ServiceModeNotOnError, withServiceModeOn } from '../service-mode-transaction';

type ConfirmedPair = Extract<PairResolutionResult, { status: 'confirmed' }>['pair'];
type Result = { status: 'SYNCED'; rowValuesChanged?: boolean } | { status: 'PARTIAL'; reason: 'DEAL_ORDER_POSITION_ROWS_SKIPPED'; skippedRows: Array<{ sourceSystem: 'BITRIX24' | 'MOYSKLAD'; sourceRowId: string; reason: string }> } | { status: 'MANUAL_REVIEW'; reason: string } | { status: 'RETRY'; reason: string };
type Row = Record<string, unknown>;
type Position = { id: string; quantity: number; price: number; discount?: number; vat?: number; vatEnabled?: boolean; vatIncluded?: boolean | null; assortment?: Row };
const logger = new Logger('DealOrderPositionRuntimeService');

class InvalidPositionSetError extends Error {}

/** Addressed, idempotent quantity/price writes and row-level reconciliation for
 * confirmed deal/order row links. Unsupported tax/discount semantics are held. */
@Injectable()
export class DealOrderPositionRuntimeService {
  constructor(private readonly database: DatabaseService, private readonly mode: SyncModeService, private readonly reverseCreate?: DealOrderReverseCreateService) {}

  private async providerRequest(url: URL, init: RequestInit): Promise<unknown> {
    const result = await withServiceModeOn(this.database, async () => requestJson(url, init));
    if (!result.enabled) throw new ServiceModeNotOnError();
    return result.value;
  }

  private readonly providerGate = (url: URL, init: RequestInit) => this.providerRequest(url, init);

  async process(input: { pair: ConfirmedPair; eventId: string; eventConfig: VersionedFieldSettingsDto }): Promise<Result> {
    if (input.pair.entityType !== 'DEAL') return { status: 'MANUAL_REVIEW', reason: 'UNSUPPORTED_ENTITY' };
    if (process.env.SYNC_MODE !== 'apply') return { status: 'MANUAL_REVIEW', reason: 'SYNC_MODE_NOT_APPLY' };
    return await withDealOrderPairLock(this.database, input.pair.id, input.eventId, (lease) => this.processLocked(input, lease)) ??
      { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_BUSY' };
  }

  private async processLocked(input: { pair: ConfirmedPair; eventId: string; eventConfig: VersionedFieldSettingsDto }, lease: DealOrderPairLease): Promise<Result> {
    const assertOwner = lease.assertOwner;
    const runMutation = (direction: DealOrderWriteDirection, mutation: () => Promise<unknown>) => this.mode.runDealOrderExternalWrite(direction, assertOwner, { id: input.pair.id, entityType: 'DEAL' }, mutation);
    const pair = await this.database.entityPair.findFirst({
      where: { id: input.pair.id, entityType: 'DEAL', active: true, bitrix24Id: input.pair.bitrix24Id, moyskladId: input.pair.moyskladId },
      select: { id: true, bitrix24Id: true, moyskladId: true },
    });
    if (!pair) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_PAIR_NOT_ACTIVE' };
    let links = await this.database.dealOrderPositionPair.findMany({ where: { pairId: pair.id }, orderBy: { bitrix24ProductRowId: 'asc' } });

    let b24Rows: Row[];
    let msRows: Position[];
    try {
      [b24Rows, msRows] = await Promise.all([readAllBitrixRows(pair.bitrix24Id, this.providerGate), readAllMoySkladPositions(pair.moyskladId, this.providerGate)]);
    } catch (error) {
      if (error instanceof ServiceModeNotOnError) throw error;
      if (error instanceof InvalidPositionSetError) {
        logger.warn(JSON.stringify({ eventId: input.eventId, pairId: pair.id, reason: 'DEAL_ORDER_POSITION_SET_INVALID' }));
        return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_POSITION_SET_INVALID' };
      }
      return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_READ_FAILED' };
    }
    const hasVat = b24Rows.some((row) => row.taxRate !== null && row.taxRate !== undefined) || msRows.some((row) => row.vatEnabled === true);
    let msVatIncluded: boolean | null = null;
    if (hasVat) {
      try { msVatIncluded = await readMoySkladVatIncluded(pair.moyskladId, this.providerGate); }
      catch (error) { if (error instanceof ServiceModeNotOnError) throw error; return { status: 'RETRY', reason: 'DEAL_ORDER_VAT_HEADER_READ_FAILED' }; }
      if (msVatIncluded === null) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_VAT_HEADER_UNAVAILABLE' };
      const sourceVatModes = new Set(b24Rows.filter((row) => row.taxRate !== null && row.taxRate !== undefined).map((row) => row.taxIncluded));
      if (sourceVatModes.size > 1) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_VAT_INCLUSION_CONFLICT' };
      if ([...sourceVatModes].some((mode) => mode !== 'Y' && mode !== 'N')) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_VAT_INCLUSION_CONFLICT' };
      if (sourceVatModes.size === 1 && (sourceVatModes.has('Y') !== msVatIncluded)) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_VAT_INCLUSION_CONFLICT' };
      msRows = msRows.map((row) => ({ ...row, vatIncluded: msVatIncluded }));
    }
    if (!links.length) return this.bootstrapHistoricalLinks(pair.id, pair.moyskladId, input.eventId, input.eventConfig, b24Rows, msRows, lease);
    const skippedRows: Array<{ sourceSystem: 'BITRIX24' | 'MOYSKLAD'; sourceRowId: string; reason: string }> = [];
    let linkedSourceIds = new Set(links.map((link) => link.bitrix24ProductRowId));
    let linkedTargetIds = new Set(links.map((link) => link.moyskladPositionId));
    const newRows = b24Rows.filter((row) => !linkedSourceIds.has(String(row.id)));
    let unlinkedTargets = msRows.filter((row) => !linkedTargetIds.has(row.id));
    if (unlinkedTargets.length > newRows.length) {
      if (newRows.length || !this.reverseCreate) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_POSITION_SET_CHANGED' };
      const directionSetting = await this.database.syncDirectionSetting.findUnique({ where: { entityKey: 'deals-orders' }, select: { moyskladToBitrix24: true } });
      if (!(directionSetting?.moyskladToBitrix24 ?? true)) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_DIRECTION_DISABLED' };
      try {
        const added = await this.reverseCreate.addPositionsToExistingPair({ pairId: pair.id, bitrix24DealId: pair.bitrix24Id, moyskladOrderId: pair.moyskladId,
          eventId: input.eventId, eventConfig: input.eventConfig, positionIds: unlinkedTargets.map((position) => position.id), assertPairLease: assertOwner });
        for (const skipped of added.skippedRows ?? []) skippedRows.push({ sourceSystem: 'MOYSKLAD', sourceRowId: skipped.sourceRowId, reason: skipped.reason });
      } catch (error) {
        if (error instanceof DealOrderReverseManualReviewError) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_REVERSE_POSITION_REVIEW' };
        if (error instanceof DealOrderWriteGateError) return { status: 'RETRY', reason: error.message };
        return { status: 'RETRY', reason: 'DEAL_ORDER_REVERSE_POSITION_ADD_FAILED' };
      }
      links = await this.database.dealOrderPositionPair.findMany({ where: { pairId: pair.id }, orderBy: { bitrix24ProductRowId: 'asc' } });
      linkedSourceIds = new Set(links.map((link) => link.bitrix24ProductRowId));
      linkedTargetIds = new Set(links.map((link) => link.moyskladPositionId));
      unlinkedTargets = msRows.filter((row) => !linkedTargetIds.has(row.id));
      const skippedTargetIds = new Set(skippedRows.map((row) => row.sourceRowId));
      if (unlinkedTargets.some((row) => !skippedTargetIds.has(row.id)) || msRows.length > links.length + skippedTargetIds.size) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_POSITION_SET_CHANGED' };
    }
    if (msRows.length > links.length + newRows.length + skippedRows.length) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_POSITION_SET_CHANGED' };
    linkedSourceIds = new Set(links.map((link) => link.bitrix24ProductRowId));
    linkedTargetIds = new Set(links.map((link) => link.moyskladPositionId));
    const productIds = [...new Set(b24Rows.map((row) => String(row.productId)))];
    const productPairs = await this.database.entityPair.findMany({
      where: { entityType: 'PRODUCT', active: true, bitrix24Id: { in: productIds } },
      select: { bitrix24Id: true, moyskladId: true },
    });
    const aliases = await this.database.productDuplicateAlias.findMany({ where: { duplicateBitrix24Id: { in: productIds } }, select: { duplicateBitrix24Id: true, canonicalPairId: true } });
    const canonicalIds = aliases.map((alias) => alias.canonicalPairId);
    const canonicalPairs = canonicalIds.length ? await this.database.entityPair.findMany({ where: { id: { in: canonicalIds }, entityType: 'PRODUCT', active: true }, select: { id: true, moyskladId: true } }) : [];
    const canonicalById = new Map(canonicalPairs.map((pair) => [pair.id, pair.moyskladId]));
    productPairs.push(...aliases.flatMap((alias) => canonicalById.has(alias.canonicalPairId) ? [{ bitrix24Id: alias.duplicateBitrix24Id, moyskladId: canonicalById.get(alias.canonicalPairId)! }] : []));
    const sourceById = new Map(b24Rows.map((row) => [String(row.id), row]));
    const targetById = new Map(msRows.map((row) => [row.id, row]));
    const plans: Array<{ linkId: string; source: Row; target: Position; quantity: number; price: number; discount: number; vat: number; vatEnabled: boolean; bitrixPrice: number; bitrixDiscountRate: number; bitrixTaxRate: number | null; bitrixTaxIncluded: 'Y' | 'N'; direction: 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24' | 'ECHO' }> = [];
    const deletions: Array<{ linkId: string; direction: 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24'; target?: Position; source?: Row }> = [];
    const alreadyDeleted: string[] = [];
    const skipRow = async (sourceSystem: 'BITRIX24' | 'MOYSKLAD', sourceRowId: string, reason: string) => {
      const entry = { sourceSystem, sourceRowId, reason };
      skippedRows.push(entry);
      await writeOperationalLog(this.database, 'EVENT', JSON.stringify({ type: 'DEAL_ORDER_POSITION_ROW_SKIPPED', pairId: pair.id,
        eventId: input.eventId, settingsVersion: input.eventConfig.version, ...entry }), input.eventId);
    };
    for (const link of links) {
      const source = sourceById.get(link.bitrix24ProductRowId);
      const target = targetById.get(link.moyskladPositionId);
      if (!target) {
        if (source) {
          if (!sameSourceValue(source, link.bitrix24Values) || !sameProductAndUnit(source, link.bitrix24Values)) {
            await skipRow('BITRIX24', link.bitrix24ProductRowId, 'DEAL_ORDER_POSITION_DELETE_CONFLICT');
            continue;
          }
          const directionSetting = await this.database.syncDirectionSetting.findUnique({ where: { entityKey: 'deals-orders' }, select: { moyskladToBitrix24: true } });
          if (!(directionSetting?.moyskladToBitrix24 ?? true)) { await skipRow('BITRIX24', link.bitrix24ProductRowId, 'DEAL_ORDER_DIRECTION_DISABLED'); continue; }
          deletions.push({ linkId: link.id, direction: 'MOYSKLAD_TO_BITRIX24', source });
          continue;
        }
        alreadyDeleted.push(link.id);
        continue;
      }
      if (!source) {
        if (!sameTargetValue(target, link.moyskladValues) || !sameProductTarget(target, link.moyskladValues)) {
          await skipRow('MOYSKLAD', link.moyskladPositionId, 'DEAL_ORDER_POSITION_DELETE_CONFLICT');
          continue;
        }
        const directionSetting = await this.database.syncDirectionSetting.findUnique({ where: { entityKey: 'deals-orders' }, select: { bitrix24ToMoysklad: true } });
        if (!(directionSetting?.bitrix24ToMoysklad ?? true)) { await skipRow('MOYSKLAD', link.moyskladPositionId, 'DEAL_ORDER_DIRECTION_DISABLED'); continue; }
        deletions.push({ linkId: link.id, direction: 'BITRIX24_TO_MOYSKLAD', target });
        continue;
      }
      const desired = sourceValues(source);
      const targetMoney = moySkladMoneyToBitrix({ price: target.price, discount: target.discount ?? 0, vat: target.vat ?? 0, vatEnabled: target.vatEnabled ?? false, vatIncluded: target.vatIncluded ?? msVatIncluded });
      if (!desired || !targetMoney) { await skipRow('BITRIX24', link.bitrix24ProductRowId, 'DEAL_ORDER_POSITION_VALUE_UNSUPPORTED'); continue; }
      if (!sameProductAndUnit(source, link.bitrix24Values) || !sameProductTarget(target, link.moyskladValues)) {
        await skipRow('BITRIX24', link.bitrix24ProductRowId, 'DEAL_ORDER_POSITION_IDENTITY_CHANGED');
        continue;
      }
      const mappedUnit = input.eventConfig.config.references.units.find((unit) => unit.bitrix24Id === source.measureCode && unit.status === 'configured' && unit.moyskladId);
      const linkedProducts = productPairs.filter((candidate) => candidate.bitrix24Id === String(source.productId));
      const targetProductId = assortmentId(target.assortment);
      if (!mappedUnit?.moyskladId || linkedProducts.length !== 1 || linkedProducts[0].moyskladId !== targetProductId) {
        await skipRow('BITRIX24', link.bitrix24ProductRowId, 'DEAL_ORDER_POSITION_DEPENDENCY_CHANGED');
        continue;
      }
      try {
        const product = await this.providerRequest(new URL(`entity/product/${encodeURIComponent(targetProductId)}`, withSlash(moyskladBase())), { method: 'GET', headers: msHeaders() });
        if (!isRecord(product) || product.id !== targetProductId || !isRecord(product.meta) || product.meta.type !== 'product' || !isRecord(product.uom) || product.uom.id !== mappedUnit.moyskladId) {
          await skipRow('BITRIX24', link.bitrix24ProductRowId, 'DEAL_ORDER_POSITION_DEPENDENCY_CHANGED');
          continue;
        }
      } catch (error) { if (error instanceof ServiceModeNotOnError) throw error; return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_DEPENDENCY_READ_FAILED' }; }
      const sourceChanged = !sameSourceValue(source, link.bitrix24Values);
      const targetChanged = !sameTargetValue(target, link.moyskladValues);
      const direction = targetChanged ? 'MOYSKLAD_TO_BITRIX24' : sourceChanged ? 'BITRIX24_TO_MOYSKLAD' : 'ECHO';
      const directionSetting = await this.database.syncDirectionSetting.findUnique({ where: { entityKey: 'deals-orders' }, select: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } });
      if (direction === 'MOYSKLAD_TO_BITRIX24' && !(directionSetting?.moyskladToBitrix24 ?? true) ||
          direction === 'BITRIX24_TO_MOYSKLAD' && !(directionSetting?.bitrix24ToMoysklad ?? true)) {
        await skipRow(direction === 'MOYSKLAD_TO_BITRIX24' ? 'MOYSKLAD' : 'BITRIX24', direction === 'MOYSKLAD_TO_BITRIX24' ? link.moyskladPositionId : link.bitrix24ProductRowId, 'DEAL_ORDER_DIRECTION_DISABLED');
        continue;
      }
      plans.push({ linkId: link.id, source, target, quantity: desired.quantity, price: desired.price, discount: desired.discount, vat: desired.vat, vatEnabled: desired.vatEnabled,
        bitrixPrice: targetMoney.price, bitrixDiscountRate: targetMoney.discountRate, bitrixTaxRate: targetMoney.taxRate, bitrixTaxIncluded: targetMoney.taxIncluded, direction });
    }
    if (b24Rows.some((row) => !links.some((link) => link.bitrix24ProductRowId === String(row.id)))) {
      if (!newRows.length) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_POSITION_SET_CHANGED' };
    }
    if (newRows.length && (plans.some((plan) => plan.direction !== 'ECHO') || deletions.length)) {
      return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_POSITION_SET_CHANGED' };
    }
    if (newRows.length) {
      const directionSetting = await this.database.syncDirectionSetting.findUnique({ where: { entityKey: 'deals-orders' }, select: { bitrix24ToMoysklad: true } });
      if (!(directionSetting?.bitrix24ToMoysklad ?? true)) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_DIRECTION_DISABLED' };
      const added = await this.addRows(pair.id, pair.moyskladId, newRows, input.eventConfig, runMutation, assertOwner, skippedRows, skipRow);
      if (added.status !== 'SYNCED' && added.status !== 'PARTIAL') return added;
    }

    for (const plan of plans) {
      if (plan.direction === 'ECHO') continue;
      try {
        let verifiedB24: Row;
        let verifiedMs: Row;
        if (plan.direction === 'BITRIX24_TO_MOYSKLAD') {
          const currentTarget = await readMoySkladPosition(pair.moyskladId, plan.target.id, this.providerGate);
          if (!sameTargetValue(currentTarget, plan.target) || !sameProductTarget(currentTarget, plan.target)) return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_CHANGED_BEFORE_WRITE' };
          if (plan.target.quantity !== plan.quantity || plan.target.price !== plan.price || plan.target.discount !== plan.discount || plan.target.vat !== plan.vat || plan.target.vatEnabled !== plan.vatEnabled) {
            await runMutation('bitrix24ToMoysklad', () => this.providerRequest(new URL(`entity/customerorder/${encodeURIComponent(pair.moyskladId)}/positions/${encodeURIComponent(plan.target.id)}`, withSlash(moyskladBase())), {
              method: 'PUT', headers: msHeaders(), body: JSON.stringify({ quantity: plan.quantity, price: plan.price, discount: plan.discount, vat: plan.vat, vatEnabled: plan.vatEnabled }),
            }));
          }
          const verified = await this.providerRequest(new URL(`entity/customerorder/${encodeURIComponent(pair.moyskladId)}/positions/${encodeURIComponent(plan.target.id)}`, withSlash(moyskladBase())), { method: 'GET', headers: msHeaders() });
          if (!isRecord(verified) || verified.id !== plan.target.id || verified.quantity !== plan.quantity || verified.price !== plan.price || verified.discount !== plan.discount || verified.vat !== plan.vat || verified.vatEnabled !== plan.vatEnabled) return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_READBACK_MISMATCH' };
          verifiedB24 = sourceSnapshot(plan.source);
          verifiedMs = targetSnapshot(verified);
        } else {
          const currentRows = await readAllBitrixRows(pair.bitrix24Id, this.providerGate);
          const currentSource = currentRows.find((row) => String(row.id) === String(plan.source.id));
          const currentTarget = await readMoySkladPosition(pair.moyskladId, plan.target.id, this.providerGate);
          if (!currentSource || !sameSourceValue(currentSource, plan.source) || !sameTargetValue(currentTarget, plan.target) || !sameProductTarget(currentTarget, plan.target)) {
            return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_CHANGED_BEFORE_WRITE' };
          }
          const quantity = plan.target.quantity;
          const price = plan.bitrixPrice;
          await runMutation('moyskladToBitrix24', () => updateBitrixRow(plan.source.id, quantity, price, plan.bitrixDiscountRate, plan.bitrixTaxRate, plan.bitrixTaxIncluded, this.providerGate));
          const rows = await readAllBitrixRows(pair.bitrix24Id, this.providerGate);
          const verified = rows.find((row) => String(row.id) === String(plan.source.id));
          if (!verified || verified.quantity !== quantity || verified.price !== price || verified.discountRate !== plan.bitrixDiscountRate || verified.taxRate !== plan.bitrixTaxRate || verified.taxIncluded !== plan.bitrixTaxIncluded) return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_READBACK_MISMATCH' };
          verifiedB24 = sourceSnapshot(verified);
          verifiedMs = targetSnapshot(plan.target);
        }
        if (!await assertOwner()) return { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_LOCK_LOST' };
        await this.database.dealOrderPositionPair.update({
          where: { id: plan.linkId },
          data: { bitrix24Values: verifiedB24 as Prisma.InputJsonValue, moyskladValues: verifiedMs as Prisma.InputJsonValue, lastSyncedAt: new Date() },
        });
      } catch (error) {
        throwIfServiceModeNotOn(error);
        if (error instanceof DealOrderWriteGateError) return { status: 'RETRY', reason: error.message };
        return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_WRITE_FAILED' };
      }
    }
    for (const deletion of deletions) {
      try {
        if (deletion.direction === 'MOYSKLAD_TO_BITRIX24') {
          const latestSource = await readAllBitrixRows(pair.bitrix24Id, this.providerGate);
          const latestTargetRows = await readAllMoySkladPositions(pair.moyskladId, this.providerGate);
          const currentSource = latestSource.find((row) => String(row.id) === String(deletion.source?.id));
          if (!currentSource || !sameSourceValue(currentSource, deletion.source) || latestTargetRows.some((row) => row.id === links.find((link) => link.id === deletion.linkId)?.moyskladPositionId)) {
            return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_CHANGED_BEFORE_WRITE' };
          }
          await runMutation('moyskladToBitrix24', () => deleteBitrixRow(deletion.source?.id, this.providerGate));
          const afterDelete = await readAllBitrixRows(pair.bitrix24Id, this.providerGate);
          if (afterDelete.some((row) => String(row.id) === String(deletion.source?.id))) return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_DELETE_READBACK_MISMATCH' };
          const unlinked = await lease.commit((transaction) => transaction.dealOrderPositionPair.delete({ where: { id: deletion.linkId } }));
          if (!unlinked.committed) return { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_LOCK_LOST' };
          continue;
        }
        const target = deletion.target;
        if (!target) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_POSITION_PAIR_MISSING' };
        const latestSource = await readAllBitrixRows(pair.bitrix24Id, this.providerGate);
        const latestTarget = await readMoySkladPosition(pair.moyskladId, target.id, this.providerGate);
        if (latestSource.some((row) => String(row.id) === links.find((link) => link.id === deletion.linkId)?.bitrix24ProductRowId) ||
            !sameTargetValue(latestTarget, target) || !sameProductTarget(latestTarget, target)) {
          return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_CHANGED_BEFORE_WRITE' };
        }
        await runMutation('bitrix24ToMoysklad', () => this.providerRequest(new URL(`entity/customerorder/${encodeURIComponent(pair.moyskladId)}/positions/${encodeURIComponent(target.id)}`, withSlash(moyskladBase())), {
          method: 'DELETE', headers: msHeaders(),
        }));
        const afterDelete = await readAllMoySkladPositions(pair.moyskladId, this.providerGate);
        if (afterDelete.some((row) => row.id === target.id)) return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_DELETE_READBACK_MISMATCH' };
        const unlinked = await lease.commit((transaction) => transaction.dealOrderPositionPair.delete({ where: { id: deletion.linkId } }));
        if (!unlinked.committed) return { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_LOCK_LOST' };
      } catch (error) { throwIfServiceModeNotOn(error); return { status: 'RETRY', reason: error instanceof DealOrderWriteGateError ? error.message : 'DEAL_ORDER_POSITION_DELETE_FAILED' }; }
    }
    if (alreadyDeleted.length) {
      const unlinked = await lease.commit((transaction) => transaction.dealOrderPositionPair.deleteMany({ where: { id: { in: alreadyDeleted } } }));
      if (!unlinked.committed) return { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_LOCK_LOST' };
    }
    const rowValuesChanged = plans.some((plan) => plan.direction !== 'ECHO') || deletions.length > 0 || newRows.length > 0 || alreadyDeleted.length > 0;
    if (skippedRows.length) return { status: 'PARTIAL', reason: 'DEAL_ORDER_POSITION_ROWS_SKIPPED', skippedRows };
    return rowValuesChanged ? { status: 'SYNCED', rowValuesChanged: true } : { status: 'SYNCED' };
  }

  /** Bootstrap only when unique, confirmed product identity produces a one-to-one row relation on both sides. */
  private async bootstrapHistoricalLinks(
    pairId: string,
    orderId: string,
    eventId: string,
    eventConfig: VersionedFieldSettingsDto,
    b24Rows: Row[],
    msRows: Position[],
    lease: DealOrderPairLease,
  ): Promise<Result> {
    const hold = (reason: string): Result => {
      logger.warn(JSON.stringify({ eventId, pairId, reason }));
      return { status: 'MANUAL_REVIEW', reason };
    };
    if (!b24Rows.length || b24Rows.length !== msRows.length) return hold('DEAL_ORDER_POSITION_BOOTSTRAP_AMBIGUOUS');
    const productCounts = new Map<string, number>();
    for (const row of b24Rows) {
      const id = String(row.productId ?? '');
      productCounts.set(id, (productCounts.get(id) ?? 0) + 1);
    }
    if ([...productCounts.values()].some((count) => count !== 1)) return hold('DEAL_ORDER_POSITION_BOOTSTRAP_AMBIGUOUS');

    const productIds = [...productCounts.keys()];
    const productPairs = await this.database.entityPair.findMany({
      where: { entityType: 'PRODUCT', active: true, bitrix24Id: { in: productIds } },
      select: { bitrix24Id: true, moyskladId: true },
    });
    const aliases = await this.database.productDuplicateAlias.findMany({ where: { duplicateBitrix24Id: { in: productIds } }, select: { duplicateBitrix24Id: true, canonicalPairId: true } });
    const canonicalIds = aliases.map((alias) => alias.canonicalPairId);
    const canonicalPairs = canonicalIds.length ? await this.database.entityPair.findMany({ where: { id: { in: canonicalIds }, entityType: 'PRODUCT', active: true }, select: { id: true, moyskladId: true } }) : [];
    const canonicalById = new Map(canonicalPairs.map((pair) => [pair.id, pair.moyskladId]));
    productPairs.push(...aliases.flatMap((alias) => canonicalById.has(alias.canonicalPairId) ? [{ bitrix24Id: alias.duplicateBitrix24Id, moyskladId: canonicalById.get(alias.canonicalPairId)! }] : []));
    const productBySource = new Map<string, string>();
    for (const id of productIds) {
      const candidates = productPairs.filter((candidate) => candidate.bitrix24Id === id);
      if (candidates.length !== 1 || !isUuid(candidates[0].moyskladId)) return hold('DEAL_ORDER_POSITION_BOOTSTRAP_PRODUCT_PAIR_MISSING');
      productBySource.set(id, candidates[0].moyskladId);
    }

    const targetCounts = new Map<string, number>();
    for (const row of msRows) {
      const id = row.assortment && isRecord(row.assortment.meta) && row.assortment.meta.type === 'product' ? assortmentId(row.assortment) : null;
      if (!id) return hold('DEAL_ORDER_POSITION_BOOTSTRAP_AMBIGUOUS');
      targetCounts.set(id, (targetCounts.get(id) ?? 0) + 1);
    }
    if ([...targetCounts.values()].some((count) => count !== 1)) return hold('DEAL_ORDER_POSITION_BOOTSTRAP_AMBIGUOUS');

    const linkedTargets = new Set<string>();
    const snapshots: Array<{ bitrix24ProductRowId: string; moyskladPositionId: string; bitrix24Values: Row; moyskladValues: Row }> = [];
    for (const source of b24Rows) {
      const sourceId = String(source.id);
      const productId = String(source.productId);
      const targetProductId = productBySource.get(productId);
      const target = msRows.find((candidate) => candidate.assortment && assortmentId(candidate.assortment) === targetProductId);
      if (!target || !targetProductId || linkedTargets.has(target.id)) return hold('DEAL_ORDER_POSITION_BOOTSTRAP_AMBIGUOUS');
      const desired = sourceValues(source);
      const mappedUnit = eventConfig.config.references.units.find((unit) => unit.bitrix24Id === source.measureCode && unit.status === 'configured' && unit.moyskladId);
      if (!desired || !mappedUnit?.moyskladId || !isUuid(mappedUnit.moyskladId) ||
          !isRecord(target.assortment) || !isRecord(target.assortment.meta) || target.assortment.meta.type !== 'product' || !Number.isFinite(target.quantity) || target.quantity <= 0 ||
          !Number.isFinite(target.price) || target.price < 0 || (target.discount ?? 0) !== 0 || (target.vatEnabled ?? false) || (target.vat ?? 0) !== 0) {
        return hold('DEAL_ORDER_POSITION_BOOTSTRAP_VALUE_OR_UNIT_UNSUPPORTED');
      }
      try {
        const product = await this.providerRequest(new URL(`entity/product/${encodeURIComponent(targetProductId)}`, withSlash(moyskladBase())), { method: 'GET', headers: msHeaders() });
        if (!isRecord(product) || product.id !== targetProductId || !isRecord(product.meta) || product.meta.type !== 'product' || !isRecord(product.uom) || product.uom.id !== mappedUnit.moyskladId) {
          return hold('DEAL_ORDER_POSITION_BOOTSTRAP_DEPENDENCY_MISMATCH');
        }
      } catch (error) { if (error instanceof ServiceModeNotOnError) throw error; return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_BOOTSTRAP_DEPENDENCY_READ_FAILED' }; }
      linkedTargets.add(target.id);
      snapshots.push({
        bitrix24ProductRowId: sourceId, moyskladPositionId: target.id,
        bitrix24Values: sourceSnapshot(source), moyskladValues: targetSnapshot(target),
      });
    }
    if (linkedTargets.size !== msRows.length) return hold('DEAL_ORDER_POSITION_BOOTSTRAP_AMBIGUOUS');
    try {
      const committed = await lease.commit((transaction) => transaction.dealOrderPositionPair.createMany({
        data: snapshots.map((snapshot) => ({ pairId, ...snapshot, bitrix24Values: snapshot.bitrix24Values as Prisma.InputJsonValue, moyskladValues: snapshot.moyskladValues as Prisma.InputJsonValue })),
      }));
      if (!committed.committed) return { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_LOCK_LOST' };
      return { status: 'SYNCED' };
    } catch { return hold('DEAL_ORDER_POSITION_BOOTSTRAP_STORE_FAILED'); }
  }

  private async addRows(pairId: string, orderId: string, rows: Row[], eventConfig: VersionedFieldSettingsDto, runMutation: (direction: DealOrderWriteDirection, mutation: () => Promise<unknown>) => Promise<unknown>, assertOwner: () => Promise<boolean>, skippedRows: Array<{ sourceSystem: 'BITRIX24' | 'MOYSKLAD'; sourceRowId: string; reason: string }>, skipRow: (sourceSystem: 'BITRIX24' | 'MOYSKLAD', sourceRowId: string, reason: string) => Promise<void>): Promise<Result> {
    const units = eventConfig.config.references.units;
    for (const row of rows) {
      const rowId = String(row.id);
      const desired = sourceValues(row);
      const productId = String(row.productId ?? '');
      const measureCode = row.measureCode;
      const unit = units.find((candidate) => candidate.bitrix24Id === measureCode && candidate.status === 'configured' && candidate.moyskladId);
      if (!desired || !/^\d{1,20}$/.test(rowId) || !/^\d{1,20}$/.test(productId) || !Number.isInteger(measureCode) || !unit?.moyskladId) {
        await skipRow('BITRIX24', rowId, 'DEAL_ORDER_POSITION_DEPENDENCY_CHANGED');
        continue;
      }
      let candidates = await this.database.entityPair.findMany({ where: { entityType: 'PRODUCT', active: true, bitrix24Id: productId }, select: { moyskladId: true }, take: 2 });
      if (!candidates.length) {
        const alias = await this.database.productDuplicateAlias.findUnique({ where: { duplicateBitrix24Id: productId }, select: { canonicalPairId: true } });
        const canonical = alias ? await this.database.entityPair.findFirst({ where: { id: alias.canonicalPairId, entityType: 'PRODUCT', active: true }, select: { moyskladId: true } }) : null;
        if (canonical) candidates = [canonical];
      }
      if (candidates.length !== 1 || !isUuid(candidates[0].moyskladId)) { await skipRow('BITRIX24', rowId, 'DEAL_ORDER_POSITION_DEPENDENCY_CHANGED'); continue; }
      let product: unknown;
      try {
        product = await this.providerRequest(new URL(`entity/product/${encodeURIComponent(candidates[0].moyskladId)}`, withSlash(moyskladBase())), { method: 'GET', headers: msHeaders() });
      } catch (error) {
        throwIfServiceModeNotOn(error);
        if (error instanceof PositionProviderRequestError && error.status === 404) {
          await skipRow('BITRIX24', rowId, 'DEAL_ORDER_PRODUCT_NOT_FOUND');
          continue;
        }
        if (isTransientProductLookupFailure(error)) return { status: 'RETRY', reason: 'DEAL_ORDER_PRODUCT_READ_RETRYABLE' };
        return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_PRODUCT_READ_REJECTED' };
      }
      if (!isRecord(product) || product.id !== candidates[0].moyskladId || !isRecord(product.meta) || product.meta.type !== 'product' || !isRecord(product.uom) || typeof product.uom.id !== 'string') {
        return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_PRODUCT_READ_INVALID' };
      }
      if (product.uom.id !== unit.moyskladId) {
        await skipRow('BITRIX24', rowId, 'DEAL_ORDER_POSITION_UNIT_MISMATCH');
        continue;
      }
      const payload = {
        assortment: { meta: { type: 'product', href: new URL(`entity/product/${encodeURIComponent(product.id)}`, withSlash(moyskladBase())).href } },
        quantity: desired.quantity, price: desired.price, discount: desired.discount, vat: desired.vat, vatEnabled: desired.vatEnabled,
      };
      let operation;
      try {
        operation = await this.database.dealOrderPositionAddOperation.upsert({
          where: { pairId_bitrix24ProductRowId: { pairId, bitrix24ProductRowId: rowId } },
          create: { pairId, bitrix24ProductRowId: rowId, payload: payload as Prisma.InputJsonValue },
          update: {},
        });
      } catch { return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_ADD_STORE_FAILED' }; }
      if (stableJson(operation.payload) !== stableJson(payload)) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_POSITION_ADD_PAYLOAD_CHANGED' };
      if (operation.status === 'SUCCEEDED' && operation.moyskladPositionId) {
        return await this.persistAddedRow(pairId, row, operation.moyskladPositionId, payload, operation.id, undefined, assertOwner);
      }
      const now = new Date();
      if (operation.leaseUntil && operation.leaseUntil > now) return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_ADD_IN_PROGRESS' };
      const leaseToken = randomUUID();
      const lease = await this.database.dealOrderPositionAddOperation.updateMany({
        where: { id: operation.id, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        data: { leaseToken, leaseUntil: new Date(now.getTime() + 60_000) },
      });
      if (lease.count !== 1) return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_ADD_IN_PROGRESS' };
      const isRetryAfterAttempt = operation.attemptedAt !== null;
      if (!isRetryAfterAttempt) await this.database.dealOrderPositionAddOperation.update({
        where: { id: operation.id }, data: { attemptedAt: now },
      });
      try {
        if (operation.moyskladPositionId) {
          const recovered = await readMoySkladPosition(orderId, operation.moyskladPositionId, this.providerGate);
          if (!positionMatches(recovered, payload)) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_POSITION_ADD_READBACK_MISMATCH' };
          return await this.persistAddedRow(pairId, row, operation.moyskladPositionId, payload, operation.id, leaseToken, assertOwner);
        }
        const latestSourceRows = await readAllBitrixRows((await this.database.entityPair.findUniqueOrThrow({ where: { id: pairId }, select: { bitrix24Id: true } })).bitrix24Id, this.providerGate);
        const latestSource = latestSourceRows.find((candidate) => String(candidate.id) === rowId);
        if (!latestSource || !sameSourceValue(latestSource, row) || !sameProductAndUnit(latestSource, row)) return this.addUncertain(operation.id, leaseToken, 'DEAL_ORDER_POSITION_ADD_SOURCE_CHANGED');
        const currentRows = await readAllMoySkladPositions(orderId, this.providerGate);
        const knownLinks = await this.database.dealOrderPositionPair.findMany({ where: { pairId }, select: { moyskladPositionId: true } });
        const known = new Set(knownLinks.map((link) => link.moyskladPositionId));
        const unlinked = currentRows.filter((position) => !known.has(position.id));
        const exact = unlinked.filter((position) => positionMatches(position, payload));
        const recoveryError = classifyPositionAddRecovery(isRetryAfterAttempt, exact.length);
        if (recoveryError) return this.addUncertain(operation.id, leaseToken, recoveryError);
        const created = await runMutation('bitrix24ToMoysklad', () => this.providerRequest(new URL(`entity/customerorder/${encodeURIComponent(orderId)}/positions`, withSlash(moyskladBase())), {
          method: 'POST', headers: msHeaders(), body: JSON.stringify(payload),
        }));
        if (!isRecord(created) || !isUuid(created.id)) return this.addUncertain(operation.id, leaseToken, 'DEAL_ORDER_POSITION_ADD_RESPONSE_INVALID');
        const savedPositionId = await this.database.dealOrderPositionAddOperation.updateMany({
          where: { id: operation.id, leaseToken }, data: { moyskladPositionId: created.id },
        });
        if (savedPositionId.count !== 1) return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_ADD_LEASE_LOST_AFTER_PROVIDER_SUCCESS' };
        const readback = await this.providerRequest(new URL(`entity/customerorder/${encodeURIComponent(orderId)}/positions/${encodeURIComponent(created.id)}`, withSlash(moyskladBase())), { method: 'GET', headers: msHeaders() });
        if (!isRecord(readback) || readback.id !== created.id || !positionMatches(readback, payload)) return this.addUncertain(operation.id, leaseToken, 'DEAL_ORDER_POSITION_ADD_READBACK_MISMATCH');
        return await this.persistAddedRow(pairId, row, created.id, payload, operation.id, leaseToken, assertOwner);
      } catch (error) {
        throwIfServiceModeNotOn(error);
        await this.database.dealOrderPositionAddOperation.updateMany({ where: { id: operation.id, leaseToken }, data: { leaseToken: null, leaseUntil: null, lastErrorCategory: 'ADD_OUTCOME_UNKNOWN' } }).catch(() => undefined);
        if (error instanceof DealOrderWriteGateError) return { status: 'RETRY', reason: error.message };
        return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_ADD_OUTCOME_UNKNOWN' };
      }
    }
    return skippedRows.length ? { status: 'PARTIAL', reason: 'DEAL_ORDER_POSITION_ROWS_SKIPPED', skippedRows } : { status: 'SYNCED' };
  }

  private async persistAddedRow(pairId: string, source: Row, positionId: string, payload: Row, operationId: string, leaseToken?: string, assertOwner?: () => Promise<boolean>): Promise<Result> {
    try {
      const position = await this.providerRequest(new URL(`entity/customerorder/${encodeURIComponent((await this.database.entityPair.findUniqueOrThrow({ where: { id: pairId }, select: { moyskladId: true } })).moyskladId)}/positions/${encodeURIComponent(positionId)}`, withSlash(moyskladBase())), { method: 'GET', headers: msHeaders() });
      if (!isRecord(position) || position.id !== positionId || !positionMatches(position, payload)) return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_ADD_READBACK_MISMATCH' };
      if (assertOwner && !await assertOwner()) return { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_LOCK_LOST' };
      await this.database.$transaction(async (transaction) => {
        await transaction.dealOrderPositionPair.upsert({
          where: { pairId_bitrix24ProductRowId: { pairId, bitrix24ProductRowId: String(source.id) } },
          create: { pairId, bitrix24ProductRowId: String(source.id), moyskladPositionId: positionId, bitrix24Values: sourceSnapshot(source) as Prisma.InputJsonValue, moyskladValues: targetSnapshot(position) as Prisma.InputJsonValue },
          update: {},
        });
        await transaction.dealOrderPositionAddOperation.update({ where: { id: operationId }, data: { status: 'SUCCEEDED', moyskladPositionId: positionId, lastErrorCategory: null, leaseToken: null, leaseUntil: null } });
      });
      return { status: 'SYNCED' };
    } catch (error) {
      throwIfServiceModeNotOn(error);
      return { status: 'RETRY', reason: 'DEAL_ORDER_POSITION_ADD_STORE_FAILED' };
    }
  }

  private async addUncertain(operationId: string, leaseToken: string, reason: string): Promise<Result> {
    await this.database.dealOrderPositionAddOperation.updateMany({ where: { id: operationId, leaseToken }, data: { status: 'UNCERTAIN', lastErrorCategory: reason, leaseToken: null, leaseUntil: null } });
    return { status: 'MANUAL_REVIEW', reason };
  }
}

export function classifyPositionAddRecovery(attempted: boolean, matchingUnlinkedCount: number): string | null {
  // Matching values are not an identity proof: another actor can create an
  // indistinguishable position. Never attach it to a Bitrix row implicitly.
  if (matchingUnlinkedCount > 0) return 'DEAL_ORDER_POSITION_ADD_IDENTITY_UNPROVEN';
  if (attempted) return 'DEAL_ORDER_POSITION_ADD_OUTCOME_UNKNOWN';
  return null;
}

function sourceValues(row: Row): { quantity: number; price: number; discount: number; vat: number; vatEnabled: boolean; vatIncluded: boolean | null } | null {
  const quantity = row.quantity;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) return null;
  const money = bitrixMoneyToMoySklad(row);
  return money ? { quantity, price: money.price, discount: money.discount, vat: money.vat, vatEnabled: money.vatEnabled, vatIncluded: money.vatIncluded } : null;
}

function sameProductAndUnit(source: Row, old: unknown): boolean {
  return isRecord(old) && String(source.productId) === String(old.productId) && source.measureCode === old.measureCode;
}
function sameProductTarget(target: Position, old: unknown): boolean {
  if (!isRecord(old)) return false;
  const oldAssortment = isRecord(old.assortment) && isRecord(old.assortment.meta) ? old.assortment.meta.href : null;
  const newAssortment = isRecord(target.assortment) && isRecord(target.assortment.meta) ? target.assortment.meta.href : null;
  return oldAssortment === newAssortment;
}
function assortmentId(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.meta) || typeof value.meta.href !== 'string') return null;
  try { const href = new URL(value.meta.href); const id = href.pathname.split('/').at(-1) ?? ''; return isUuid(id) && /\/entity\/(?:product|service)\//.test(href.pathname) ? id : null; } catch { return null; }
}
function sameSourceValue(row: Row, old: unknown): boolean {
  if (!isRecord(old)) return false;
  const usesNetPrice = row.discountRate !== 0 || row.discountSum !== 0 || row.taxRate !== null && row.taxRate !== undefined;
  return row.quantity === old.quantity && row.price === old.price && (!usesNetPrice || row.priceNetto === old.priceNetto) &&
    row.discountTypeId === old.discountTypeId && row.discountRate === old.discountRate && row.discountSum === old.discountSum &&
    row.taxRate === old.taxRate && ((row.taxRate === null || row.taxRate === undefined) || row.taxIncluded === old.taxIncluded);
}
function sameTargetValue(row: Position, old: unknown): boolean {
  return isRecord(old) && row.quantity === old.quantity && row.price === old.price && row.discount === old.discount && row.vat === old.vat && row.vatEnabled === old.vatEnabled;
}
function positionMatches(value: unknown, expected: Row): boolean {
  if (!isRecord(value) || !isRecord(value.assortment) || !isRecord(value.assortment.meta) || !isRecord(expected.assortment) || !isRecord(expected.assortment.meta)) return false;
  return value.assortment.meta.type === expected.assortment.meta.type && value.assortment.meta.href === expected.assortment.meta.href &&
    value.quantity === expected.quantity && value.price === expected.price && value.discount === expected.discount && value.vat === expected.vat && value.vatEnabled === expected.vatEnabled;
}
function stableJson(value: unknown): string { return JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child); }
function sourceSnapshot(row: Row): Row { return { productId: String(row.productId), measureCode: row.measureCode, quantity: row.quantity, price: row.price, priceNetto: row.priceNetto, discountTypeId: row.discountTypeId, discountRate: row.discountRate, discountSum: row.discountSum, taxRate: row.taxRate, taxIncluded: row.taxIncluded }; }
function targetSnapshot(row: Row): Row { return { assortment: row.assortment, quantity: row.quantity, price: row.price, discount: row.discount, vat: row.vat, vatEnabled: row.vatEnabled }; }

type ProviderGate = (url: URL, init: RequestInit) => Promise<unknown>;

async function readAllBitrixRows(id: string, gate: ProviderGate = requestJson): Promise<Row[]> {
  const all: Row[] = [];
  let start = 0;
  let expectedTotal: number | null = null;
  do {
    const url = new URL('crm.item.productrow.list', withSlash(bitrixBase()));
    url.searchParams.set('filter[=ownerType]', 'D'); url.searchParams.set('filter[=ownerId]', id); url.searchParams.set('start', String(start));
    const body = await gate(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ 'filter[=ownerType]': 'D', 'filter[=ownerId]': id, start: String(start) }) });
    if (!isRecord(body) || !isRecord(body.result) || !Array.isArray(body.result.productRows) || typeof body.total !== 'number' || body.result.productRows.some((row) => !isRecord(row))) throw new Error();
    if (expectedTotal === null) expectedTotal = body.total;
    else if (body.total !== expectedTotal) throw new InvalidPositionSetError();
    const rows = body.result.productRows as Row[];
    all.push(...rows); start += rows.length;
    if (rows.length === 0 && start < expectedTotal || all.length > 1000) throw new InvalidPositionSetError();
  } while (start < (expectedTotal ?? 0));
  if (expectedTotal === null || all.length !== expectedTotal) throw new InvalidPositionSetError();
  if (all.some((row) => !/^\d{1,20}$/.test(String(row.id)))) throw new Error();
  if (new Set(all.map((row) => String(row.id))).size !== all.length) throw new InvalidPositionSetError();
  return all;
}

async function readAllMoySkladPositions(orderId: string, gate: ProviderGate = requestJson): Promise<Position[]> {
  const base = moyskladBase();
  const first = new URL(`entity/customerorder/${encodeURIComponent(orderId)}/positions`, withSlash(base));
  const rows: Position[] = [];
  let next: URL | null = first;
  let expectedSize: number | null = null;
  while (next) {
    const page = await gate(next, { method: 'GET', headers: msHeaders() });
    if (!isRecord(page) || !Array.isArray(page.rows) || !isRecord(page.meta) || typeof page.meta.size !== 'number') throw new Error();
    if (expectedSize === null) expectedSize = page.meta.size;
    if (page.rows.some((row) => !isRecord(row) || !isUuid(row.id))) throw new Error();
    rows.push(...page.rows as Position[]);
    const href = page.meta.nextHref;
    next = typeof href === 'string' ? safeNextHref(href, base) : null;
    if (rows.length > 1000 || (!next && rows.length !== expectedSize)) throw new Error();
  }
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new InvalidPositionSetError();
  return rows;
}

async function readMoySkladVatIncluded(orderId: string, gate: ProviderGate = requestJson): Promise<boolean | null> {
  const value = await gate(new URL(`entity/customerorder/${encodeURIComponent(orderId)}`, withSlash(moyskladBase())), { method: 'GET', headers: msHeaders() });
  if (!isRecord(value) || value.id !== orderId || typeof value.vatIncluded !== 'boolean') return null;
  return value.vatIncluded;
}

async function readMoySkladPosition(orderId: string, positionId: string, gate: ProviderGate = requestJson): Promise<Position> {
  const value = await gate(new URL(`entity/customerorder/${encodeURIComponent(orderId)}/positions/${encodeURIComponent(positionId)}`, withSlash(moyskladBase())), { method: 'GET', headers: msHeaders() });
  if (!isRecord(value) || value.id !== positionId || typeof value.quantity !== 'number' || typeof value.price !== 'number') throw new Error();
  return value as Position;
}

async function updateBitrixRow(rowId: unknown, quantity: number, price: number, discountRate: number, taxRate: number | null, taxIncluded: 'Y' | 'N', gate: ProviderGate = requestJson): Promise<void> {
  if (!/^\d{1,20}$/.test(String(rowId))) throw new Error();
  const body = JSON.stringify({ id: String(rowId), fields: { quantity, price, discountTypeId: 2, discountRate, discountSum: 0, taxRate, taxIncluded } });
  const result = await gate(new URL('crm.item.productrow.update', withSlash(bitrixBase())), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  if (!isRecord(result) || !isRecord(result.result) || !isRecord(result.result.productRow) || String(result.result.productRow.id) !== String(rowId)) throw new Error();
}

async function deleteBitrixRow(rowId: unknown, gate: ProviderGate = requestJson): Promise<void> {
  if (!/^\d{1,20}$/.test(String(rowId))) throw new Error();
  const body = new URLSearchParams({ id: String(rowId) });
  await gate(new URL('crm.item.productrow.delete', withSlash(bitrixBase())), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
}

class PositionProviderRequestError extends Error {
  constructor(readonly status: number | null, readonly failure: 'NETWORK' | 'HTTP' | 'INVALID_BODY') { super(`POSITION_PROVIDER_${failure}`); }
}
function throwIfServiceModeNotOn(error: unknown): void {
  if (error instanceof ServiceModeNotOnError || error instanceof DealOrderWriteGateError && (error.reason === 'OFF' || error.reason === 'PAUSE')) {
    throw new ServiceModeNotOnError();
  }
}
function isTransientProductLookupFailure(error: unknown): boolean {
  if (!(error instanceof PositionProviderRequestError)) return false;
  if (error.failure === 'NETWORK') return true;
  return error.status === 408 || error.status === 425 || error.status === 429 || (error.status !== null && error.status >= 500);
}
function safeNextHref(href: string, base: URL): URL { const next = new URL(href); if (next.origin !== base.origin || !next.pathname.includes('/entity/customerorder/')) throw new Error(); return next; }
async function requestJson(url: URL, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => { throw new PositionProviderRequestError(null, 'NETWORK'); });
  if (!response.ok) throw new PositionProviderRequestError(response.status, 'HTTP');
  if (init.method === 'DELETE') return null;
  return response.json().catch(() => { throw new PositionProviderRequestError(response.status, 'INVALID_BODY'); });
}
function bitrixBase(): URL { return configuredBase('BITRIX24_REST_BASE_URL'); }
function moyskladBase(): URL { return configuredBase('MOYSKLAD_API_BASE_URL'); }
function configuredBase(name: string): URL {
  const url = new URL(process.env[name] ?? '');
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error();
  return url;
}
function withSlash(url: URL): string { return url.href.endsWith('/') ? url.href : `${url.href}/`; }
function msHeaders(): HeadersInit { const token = process.env.MOYSKLAD_API_TOKEN; if (!token) throw new Error(); return { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' }; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
