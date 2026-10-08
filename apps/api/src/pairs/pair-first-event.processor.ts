import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { PairResolutionInput, PairResolutionResult, PairResolver, PAIR_RESOLVER } from './pair-resolver';
import { lockEntityPairState } from './pair-db-lock';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { DealOrderBaselineService } from '../deals-orders/deal-order-baseline.service';
import { DealOrderHeaderSyncProcessor } from '../deals-orders/deal-order-header-sync.processor';

const logger = new Logger('PairFirstEventProcessor');

/**
 * Resolves persisted deal/order webhook events before any sync work can be
 * considered. This temporary intake gate deliberately has no writer: it
 * resolves pair identity only, while downstream baseline readiness belongs to
 * the baseline processor. Unresolved identities are durably held for review.
 */
@Injectable()
export class PairFirstEventProcessor {
  constructor(
    private readonly database: DatabaseService,
    @Inject(PAIR_RESOLVER) private readonly resolver: PairResolver,
    @Optional() private readonly fieldSettings?: FieldSettingsService,
    @Optional() private readonly baseline?: DealOrderBaselineService,
    @Optional() private readonly headerSync?: DealOrderHeaderSyncProcessor,
  ) {}

  enqueue(eventId: string): void {
    void this.process(eventId).catch(() => logger.error(JSON.stringify({ eventId, resolution: 'PAIR_STORE_UNAVAILABLE' })));
  }

  async process(eventId: string): Promise<PairResolutionResult | null> {
    const event = await this.database.inboundEvent.findUnique({
      where: { id: eventId },
      select: { id: true, source: true, eventType: true, externalEntityType: true, externalEntityId: true, status: true },
    });
    if (!event || event.status !== 'RECEIVED' || !event.externalEntityId || !isDealOrderEvent(event)) return null;

    const input: PairResolutionInput = {
      entityType: 'DEAL',
      sourceSystem: event.source === 'BITRIX24' ? 'BITRIX24' : 'MOYSKLAD',
      externalId: event.externalEntityId,
      eventId: event.id,
    };

    let result: PairResolutionResult;
    try {
      result = await this.resolver.resolve(input);
    } catch {
      result = { status: 'unavailable', reason: 'PAIR_STORE_UNAVAILABLE' };
    }

    if (result.status !== 'confirmed') {
      result = await this.database.$transaction(async (transaction) => {
        await lockEntityPairState(transaction);
        const side = input.sourceSystem === 'BITRIX24' ? 'bitrix24Id' : 'moyskladId';
        const currentPair = await transaction.entityPair.findFirst({
          where: { entityType: input.entityType, [side]: input.externalId, active: true },
        });
        if (currentPair) {
          return {
            status: 'confirmed',
            pair: {
              id: currentPair.id,
              entityType: input.entityType,
              bitrix24Id: currentPair.bitrix24Id,
              moyskladId: currentPair.moyskladId,
              status: currentPair.source === 'MANUAL' ? 'MANUAL' : 'CONFIRMED',
              source: 'PERSISTED',
            },
          };
        }
        await transaction.inboundEvent.updateMany({
          where: { id: event.id, status: 'RECEIVED' },
          data: { status: 'MANUAL_REVIEW', lastErrorCategory: result.status === 'unavailable' ? 'PAIR_RESOLUTION_UNAVAILABLE' : 'PAIR_REVIEW_REQUIRED' },
        });
        return result;
      });
    }

    if (result.status === 'confirmed' && this.fieldSettings && this.baseline) {
      try {
        const eventConfig = await this.fieldSettings.eventConfig(event.id);
        const baseline = await this.baseline.ensureForConfirmedPair({ pair: result.pair, eventId: event.id, eventConfig });
        if (baseline.status !== 'READY') {
          await this.database.inboundEvent.updateMany({
            where: { id: event.id, status: 'RECEIVED' },
            data: { status: 'MANUAL_REVIEW', lastErrorCategory: `BASELINE_${baseline.reason}` },
          });
        } else if (this.headerSync) {
          const headerResult = await this.headerSync.process({ eventId: event.id, pair: result.pair, eventConfig, baselineId: baseline.baselineId });
          const holdReason = headerHoldReason(headerResult);
          if (holdReason) {
            await this.database.inboundEvent.updateMany({
              where: { id: event.id, status: 'RECEIVED' },
              data: { status: 'MANUAL_REVIEW', lastErrorCategory: holdReason },
            });
          }
        }
      } catch {
        await this.database.inboundEvent.updateMany({
          where: { id: event.id, status: 'RECEIVED' },
          data: { status: 'MANUAL_REVIEW', lastErrorCategory: 'BASELINE_SETTINGS_UNAVAILABLE' },
        });
      }
    }

    logger.log(JSON.stringify({ eventId: event.id, source: event.source, entityType: 'DEAL', resolution: result.status }));
    return result;
  }
}

function headerHoldReason(result: string): string | null {
  switch (result) {
    case 'UNSUPPORTED': return 'DEAL_ORDER_HEADER_UNSUPPORTED';
    case 'BASELINE_MISSING': return 'DEAL_ORDER_BASELINE_MISSING';
    case 'HOLD_CONFLICT': return 'DEAL_ORDER_HEADER_CONFLICT';
    case 'HOLD_READ_FAILED': return 'DEAL_ORDER_HEADER_READ_FAILED';
    case 'HOLD_WRITE_FAILED': return 'DEAL_ORDER_HEADER_WRITE_FAILED';
    default: return null;
  }
}

function isDealOrderEvent(event: { source: string; eventType: string | null; externalEntityType: string | null }): boolean {
  if (event.source === 'BITRIX24') return event.externalEntityType === 'deal' && /^ONCRMDEAL(?:ADD|UPDATE|DELETE)$/.test(event.eventType ?? '');
  return event.source === 'MOYSKLAD' && event.externalEntityType === 'customerorder' && ['CREATE', 'UPDATE', 'DELETE'].includes(event.eventType ?? '');
}
