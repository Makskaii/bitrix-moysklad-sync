import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { DryRunDocumentReader } from '../dry-run-document-reader';
import { VersionedFieldSettingsDto } from '../field-settings/field-settings.dto';
import { PairResolutionResult } from '../pairs/pair-resolver';
import { lockEntityPairState } from '../pairs/pair-db-lock';
import { SyncModeService } from '../sync-mode.service';
import { assertApplyExternalWrite } from '../external-write-guard';
import { DryRunWriteJournal } from '../dry-run-write-journal';
import { ProviderFailure, isRetryableFailure, retryAtForFailure, providerResponseFailure } from '../provider-failure';

type Pair = Extract<PairResolutionResult, { status: 'confirmed' }>['pair'];
type HeaderResult = 'DISABLED' | 'UNSUPPORTED' | 'BASELINE_MISSING' | 'BASELINE_INITIALIZED' | 'NOOP' | 'UPDATED' | 'HOLD_CONFLICT' | 'HOLD_READ_FAILED' | 'HOLD_WRITE_FAILED' | { status: 'RETRYABLE_FAILURE'; retryAfter: Date };
const FIELD = 'deal-order-comments';

/** Local-release-only header exchange. It intentionally cannot update fields beyond COMMENTS/description. */
@Injectable()
export class DealOrderHeaderSyncProcessor {
  constructor(private readonly database: DatabaseService, private readonly reader: DryRunDocumentReader, private readonly mode: SyncModeService, private readonly dryWrites?: DryRunWriteJournal) {}

  async process(input: { eventId: string; pair: Pair; eventConfig: VersionedFieldSettingsDto; baselineId: string; attempt?: number; assertWorkerLease?: () => Promise<void> }): Promise<HeaderResult> {
    if (process.env.ADMIN_PREVIEW !== '1' || process.env.LOCAL_HEADER_EXCHANGE !== '1' || process.env.LOCAL_HEADER_EXCHANGE_READY !== '1' || (process.env.SYNC_MODE !== 'apply' && process.env.SYNC_MODE !== 'dry') || (await this.mode.read()).mode !== 'on') return 'DISABLED';
    if (input.pair.entityType !== 'DEAL' || input.baselineId !== input.pair.id) return 'UNSUPPORTED';
    const base24 = localEndpoint(process.env.BITRIX24_REST_BASE_URL);
    const baseMs = localEndpoint(process.env.MOYSKLAD_API_BASE_URL);
    if (!base24 || !baseMs) return 'DISABLED';

    const event = await this.database.inboundEvent.findUnique({ where: { id: input.eventId }, select: { source: true } });
    if (!event) return 'UNSUPPORTED';
    const direction = event.source === 'BITRIX24' ? 'BITRIX24_TO_MOYSKLAD' : event.source === 'MOYSKLAD' ? 'MOYSKLAD_TO_BITRIX24' : null;
    if (!direction) return 'UNSUPPORTED';
    const rule = input.eventConfig.config.rules.find((candidate) => candidate.entity === 'deals-orders' && candidate.sourceField === 'COMMENTS' && candidate.targetField === 'description');
    if (!rule || (rule.bitrix24ToMoysklad.transform.kind !== 'copy' && rule.moyskladToBitrix24.transform.kind !== 'copy')) return 'UNSUPPORTED';

    return this.database.$transaction(async (transaction) => {
    // Manual pair assignment/reassignment uses this same advisory lock. Hold it
    // through target readback and state persistence so an old mapping cannot
    // be written after a concurrent reassignment wins.
    await lockEntityPairState(transaction);
    const pair = await transaction.entityPair.findFirst({ where: { id: input.pair.id, entityType: 'DEAL', active: true, bitrix24Id: input.pair.bitrix24Id, moyskladId: input.pair.moyskladId }, select: { id: true } });
    const baseline = await transaction.entityPairBaseline.findUnique({ where: { pairId: input.pair.id } });
    if (!pair || !baseline || baseline.settingsVersion !== input.eventConfig.version) return 'BASELINE_MISSING';
    const baselineB24 = scalar((baseline.bitrix24Values as Record<string, unknown>)[`rule:${rule.id}`]);
    const baselineMs = scalar((baseline.moyskladValues as Record<string, unknown>)[`rule:${rule.id}`]);
    const previous = await transaction.entityPairSyncState.findUnique({ where: { pairId: pair.id } });
    if (!previous) {
      await transaction.entityPairSyncState.createMany({ data: [{ pairId: pair.id, settingsVersion: baseline.settingsVersion, bitrix24Values: { ...jsonRecord(baseline.bitrix24Values), [FIELD]: baselineB24 }, moyskladValues: { ...jsonRecord(baseline.moyskladValues), [FIELD]: baselineMs } }], skipDuplicates: true });
      return 'BASELINE_INITIALIZED';
    }
    if (previous.settingsVersion !== baseline.settingsVersion) return 'BASELINE_MISSING';

    let b24: Record<string, unknown>;
    let ms: Record<string, unknown>;
    try {
      [ms, b24] = await Promise.all([
        this.reader.readMoySkladCustomerOrderForBaseline(input.pair.moyskladId),
        this.reader.readBitrix24DealForBaseline(input.pair.bitrix24Id),
      ]);
    } catch (error) {
      if (error instanceof ProviderFailure && isRetryableFailure(error)) return { status: 'RETRYABLE_FAILURE', retryAfter: retryAtForFailure(error, input.attempt ?? 1) };
      return 'HOLD_READ_FAILED';
    }
    const b24Value = scalar(b24.COMMENTS);
    const msValue = scalar(ms.description);
    if (b24Value === null || msValue === null) return 'HOLD_CONFLICT';
    const lastB24 = scalar((previous.bitrix24Values as Record<string, unknown>)[FIELD]);
    const lastMs = scalar((previous.moyskladValues as Record<string, unknown>)[FIELD]);
    if (lastB24 === null || lastMs === null) return 'HOLD_CONFLICT';
    if (b24Value === msValue) {
      await input.assertWorkerLease?.();
      await this.persist(transaction, pair.id, baseline.settingsVersion, b24Value, msValue);
      return 'NOOP';
    }

    const b24Changed = b24Value !== lastB24;
    const msChanged = msValue !== lastMs;
    if (!b24Changed && !msChanged) return 'NOOP';
    let writeTo: 'BITRIX24' | 'MOYSKLAD';
    let value: string;
    if (b24Changed && msChanged) {
      // MySklad wins conflicts, even when the triggering webhook came from B24.
      writeTo = 'BITRIX24'; value = msValue;
    } else if (msChanged) {
      writeTo = 'BITRIX24'; value = msValue;
    } else {
      writeTo = 'MOYSKLAD'; value = b24Value;
    }
    const enabled = writeTo === 'MOYSKLAD' ? rule.bitrix24ToMoysklad.enabled : rule.moyskladToBitrix24.enabled;
    const transform = writeTo === 'MOYSKLAD' ? rule.bitrix24ToMoysklad.transform.kind : rule.moyskladToBitrix24.transform.kind;
    if (!enabled || transform !== 'copy') return 'HOLD_CONFLICT';
    try {
      await input.assertWorkerLease?.();
      const proposed = process.env.SYNC_MODE === 'dry' && this.dryWrites
        ? await this.dryWrites.propose({
          eventId: input.eventId,
          provider: writeTo,
          entityType: writeTo === 'MOYSKLAD' ? 'customerorder' : 'deal',
          entityId: writeTo === 'MOYSKLAD' ? input.pair.moyskladId : input.pair.bitrix24Id,
          operation: 'UPDATE',
          fields: writeTo === 'MOYSKLAD' ? { description: value } : { COMMENTS: value },
        })
        : false;
      if (!proposed) {
        try {
          if (writeTo === 'MOYSKLAD') await this.writeMoySklad(baseMs, input.pair.moyskladId, value);
          else await this.writeBitrix24(base24, input.pair.bitrix24Id, value);
        } catch (error) {
          if (!(error instanceof ProviderFailure)) throw error;
          if (!isRetryableFailure(error)) return 'HOLD_WRITE_FAILED';
          const readback = writeTo === 'MOYSKLAD'
            ? await this.reader.readMoySkladCustomerOrderForBaseline(input.pair.moyskladId)
            : await this.reader.readBitrix24DealForBaseline(input.pair.bitrix24Id);
          if (scalar(writeTo === 'MOYSKLAD' ? readback.description : readback.COMMENTS) !== value) {
            return { status: 'RETRYABLE_FAILURE', retryAfter: retryAtForFailure(error, input.attempt ?? 1) };
          }
        }
      }
      const verified = writeTo === 'MOYSKLAD'
        ? await this.reader.readMoySkladCustomerOrderForBaseline(input.pair.moyskladId)
        : await this.reader.readBitrix24DealForBaseline(input.pair.bitrix24Id);
      if (scalar(writeTo === 'MOYSKLAD' ? verified.description : verified.COMMENTS) !== value) return 'HOLD_WRITE_FAILED';
      await input.assertWorkerLease?.();
      await this.persist(transaction, pair.id, baseline.settingsVersion, writeTo === 'BITRIX24' ? value : b24Value, writeTo === 'MOYSKLAD' ? value : msValue);
      return 'UPDATED';
    } catch (error) {
      if (error instanceof ProviderFailure && isRetryableFailure(error)) return { status: 'RETRYABLE_FAILURE', retryAfter: retryAtForFailure(error, input.attempt ?? 1) };
      if (error instanceof ProviderFailure) return 'HOLD_WRITE_FAILED';
      throw error;
    }
    }, { timeout: 60_000 });
  }

  private async writeMoySklad(base: URL, id: string, value: string) {
    assertApplyExternalWrite('MOYSKLAD', 'DEAL_ORDER_HEADER_UPDATE');
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!token) throw new Error('write token unavailable');
    const response = await fetch(new URL(`entity/customerorder/${encodeURIComponent(id)}`, withSlash(base)), {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: value }), redirect: 'error', signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
    if (!response.ok) throw providerResponseFailure('MOYSKLAD', response.status, response.headers.get('retry-after'));
  }

  private async writeBitrix24(base: URL, id: string, value: string) {
    assertApplyExternalWrite('BITRIX24', 'DEAL_ORDER_HEADER_UPDATE');
    const response = await fetch(new URL('crm.deal.update.json', withSlash(base)), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id, 'fields[COMMENTS]': value }), redirect: 'error', signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new ProviderFailure('BITRIX24', null); });
    if (!response.ok) throw providerResponseFailure('BITRIX24', response.status, response.headers.get('retry-after'));
    const body: unknown = await response.json().catch(() => { throw new ProviderFailure('BITRIX24', null); });
    if (!isRecord(body) || body.error || body.result !== true) throw new ProviderFailure('BITRIX24', 400);
  }

  private async persist(transaction: Prisma.TransactionClient, pairId: string, settingsVersion: number, b24: string, ms: string) {
    const previous = await transaction.entityPairSyncState.findUnique({ where: { pairId }, select: { bitrix24Values: true, moyskladValues: true } });
    const bitrix24Values = { ...jsonRecord(previous?.bitrix24Values), [FIELD]: b24 };
    const moyskladValues = { ...jsonRecord(previous?.moyskladValues), [FIELD]: ms };
    await transaction.entityPairSyncState.upsert({
      where: { pairId },
      create: { pairId, settingsVersion, bitrix24Values, moyskladValues },
      update: { settingsVersion, bitrix24Values, moyskladValues },
    });
  }
}

function localEndpoint(value?: string): URL | null {
  try {
    const url = new URL(value ?? '');
    // Do not permit DNS names (including localhost) here: the local-release
    // escape hatch must not become a way to contact a remotely-resolved host.
    return ['127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:' && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function withSlash(url: URL): string { return url.href.endsWith('/') ? url.href : `${url.href}/`; }
function scalar(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function jsonRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
