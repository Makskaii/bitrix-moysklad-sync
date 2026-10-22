import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { EntityType, isEntityType, PairResolutionInput, PairResolutionReason, PairResolutionResult, PairResolver } from './pair-resolver';
import { isUniqueConstraintError } from './pair-db-errors';
import { lockEntityPairState } from './pair-db-lock';
import { forwardOrderOwnership } from '../deals-orders/forward-order-origin';

@Injectable()
export class PairResolutionProvider implements PairResolver {
  constructor(private readonly database: DatabaseService) {}

  async resolve(input: PairResolutionInput): Promise<PairResolutionResult> {
    if (!isEntityType(input.entityType)) return { status: 'unavailable', reason: 'ENTITY_TYPE_UNSUPPORTED' };
    if (!isInput(input)) return { status: 'unavailable', reason: 'PAIR_STORE_UNAVAILABLE' };
    try {
      return await this.database.$transaction(async (transaction) => {
        await lockEntityPairState(transaction);
        return this.resolveWithinTransaction(transaction, input);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) return this.recoverOpenReviewAfterRace(input);
      return { status: 'unavailable', reason: 'PAIR_STORE_UNAVAILABLE' };
    }
  }

  private async resolveWithinTransaction(transaction: Prisma.TransactionClient, input: PairResolutionInput): Promise<PairResolutionResult> {
    const side = input.sourceSystem === 'BITRIX24' ? 'bitrix24Id' : 'moyskladId';
    const pair = await transaction.entityPair.findFirst({
      where: { entityType: input.entityType, [side]: input.externalId, active: true },
    });
    if (pair) return confirmedPairResult(pair);

    const existingReview = await transaction.pairReviewCase.findFirst({
      where: {
        entityType: input.entityType,
        sourceSystem: input.sourceSystem,
        sourceEntityId: input.externalId,
        status: 'OPEN',
      },
    });
    if (existingReview) {
      const review = await transaction.pairReviewCase.update({
        where: { id: existingReview.id }, data: { eventId: input.eventId ?? existingReview.eventId },
      });
      return manualReviewResult(input, review.id, 'NO_APPROVED_MATCH_KEY');
    }

    const inactivePair = await transaction.entityPair.findFirst({
      where: { entityType: input.entityType, [side]: input.externalId, active: false },
      select: { id: true },
    });
    if (inactivePair) {
      const review = await transaction.pairReviewCase.create({
        data: {
          entityType: input.entityType,
          sourceSystem: input.sourceSystem,
          sourceEntityId: input.externalId,
          eventId: input.eventId,
          reason: 'PAIR_INACTIVE',
        },
      });
      return manualReviewResult(input, review.id, 'PAIR_INACTIVE');
    }

    // An MS CREATE/UPDATE may arrive after our forward POST but before its
    // pair commits. It must wait for that source deal, never reverse-create.
    if (input.entityType === 'DEAL' && input.sourceSystem === 'MOYSKLAD' && ['CREATE', 'UPDATE'].includes(input.eventType ?? '')) {
      const ownership = await forwardOrderOwnership(transaction, input.externalId);
      if (ownership === 'PENDING') return { status: 'unavailable', reason: 'FORWARD_ORDER_PAIR_PENDING' };
      if (ownership === 'CONFLICT') {
        const review = await transaction.pairReviewCase.create({ data: {
          entityType: 'DEAL', sourceSystem: 'MOYSKLAD', sourceEntityId: input.externalId, eventId: input.eventId, reason: 'PAIR_ALREADY_ASSIGNED',
        } });
        return manualReviewResult(input, review.id, 'PAIR_ALREADY_ASSIGNED');
      }
    }

    // MS may deliver the automatic UPDATE immediately after CREATE. A faster
    // UPDATE must not open a permanent review that prevents the authentic
    // pending CREATE from establishing its durable operation and pair.
    if (input.entityType === 'DEAL' && input.sourceSystem === 'MOYSKLAD' && input.eventType === 'UPDATE') {
      const pendingCreate = await transaction.inboundEvent.findFirst({
        where: { source: 'MOYSKLAD', externalEntityType: 'customerorder', externalEntityId: input.externalId,
          eventType: 'CREATE', status: { in: ['RECEIVED', 'PROCESSING', 'RETRYABLE_FAILURE'] } },
        select: { id: true },
      });
      if (pendingCreate) return { status: 'unavailable', reason: 'PAIR_CREATE_PENDING' };
    }

    if (isEligibleFirstDealCreate(input)) return { status: 'unmatched', reason: 'NO_CANDIDATES' };

    const review = await transaction.pairReviewCase.create({
      data: {
        entityType: input.entityType,
        sourceSystem: input.sourceSystem,
        sourceEntityId: input.externalId,
        eventId: input.eventId,
        reason: 'NO_APPROVED_MATCH_KEY',
      },
    });
    return manualReviewResult(input, review.id, 'NO_APPROVED_MATCH_KEY');
  }

  private async recoverOpenReviewAfterRace(input: PairResolutionInput): Promise<PairResolutionResult> {
    try {
      return await this.database.$transaction(async (transaction) => {
        await lockEntityPairState(transaction);
        const side = input.sourceSystem === 'BITRIX24' ? 'bitrix24Id' : 'moyskladId';
        const pair = await transaction.entityPair.findFirst({
          where: { entityType: input.entityType, [side]: input.externalId, active: true },
        });
        if (pair) return confirmedPairResult(pair);
        const review = await transaction.pairReviewCase.findFirst({
          where: { entityType: input.entityType, sourceSystem: input.sourceSystem, sourceEntityId: input.externalId, status: 'OPEN' },
        });
        return review ? manualReviewResult(input, review.id, 'NO_APPROVED_MATCH_KEY') : { status: 'unavailable', reason: 'PAIR_STORE_UNAVAILABLE' };
      });
    } catch {
      return { status: 'unavailable', reason: 'PAIR_STORE_UNAVAILABLE' };
    }
  }
}

function confirmedPairResult(pair: { id: string; entityType: string; bitrix24Id: string; moyskladId: string; moyskladType?: string | null; moyskladParentId?: string | null; source: string }): PairResolutionResult {
  return {
    status: 'confirmed',
    pair: {
      id: pair.id,
      entityType: pair.entityType as EntityType,
      bitrix24Id: pair.bitrix24Id,
      moyskladId: pair.moyskladId,
      moyskladType: pair.moyskladType,
      moyskladParentId: pair.moyskladParentId,
      status: pair.source === 'MANUAL' ? 'MANUAL' : 'CONFIRMED',
      // No automatic match key is approved for v1; every pair here was persisted.
      source: 'PERSISTED',
    },
  };
}

function isInput(input: PairResolutionInput): boolean {
  return (input.sourceSystem === 'BITRIX24' || input.sourceSystem === 'MOYSKLAD') &&
    typeof input.externalId === 'string' && input.externalId.trim().length > 0 && input.externalId.length <= 200 &&
    (input.eventId === undefined || (typeof input.eventId === 'string' && input.eventId.length <= 200));
}

function isEligibleFirstDealCreate(input: PairResolutionInput): boolean {
  return input.entityType === 'DEAL' && (
    input.sourceSystem === 'BITRIX24' && (input.eventType === 'ONCRMDEALADD' || input.eventType === 'ONCRMDEALUPDATE') ||
    input.sourceSystem === 'MOYSKLAD' && input.eventType === 'CREATE'
  );
}

function manualReviewResult(input: PairResolutionInput, reviewCaseId: string, reason: PairResolutionReason): PairResolutionResult {
  return {
    status: 'manual_review',
    reason,
    entityType: input.entityType,
    sourceSystem: input.sourceSystem,
    sourceEntityId: input.externalId,
    reviewCaseId,
  };
}

