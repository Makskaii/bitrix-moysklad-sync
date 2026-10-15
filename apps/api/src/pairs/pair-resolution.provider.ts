import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { EntityType, isEntityType, PairResolutionInput, PairResolutionResult, PairResolver } from './pair-resolver';
import { isUniqueConstraintError } from './pair-db-errors';
import { lockEntityPairState } from './pair-db-lock';

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
    const review = existingReview
      ? await transaction.pairReviewCase.update({
          where: { id: existingReview.id }, data: { eventId: input.eventId ?? existingReview.eventId },
        })
      : await transaction.pairReviewCase.create({
          data: {
            entityType: input.entityType,
            sourceSystem: input.sourceSystem,
            sourceEntityId: input.externalId,
            eventId: input.eventId,
            reason: 'NO_APPROVED_MATCH_KEY',
          },
        });
    return manualReviewResult(input, review.id);
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
        return review ? manualReviewResult(input, review.id) : { status: 'unavailable', reason: 'PAIR_STORE_UNAVAILABLE' };
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

function manualReviewResult(input: PairResolutionInput, reviewCaseId: string): PairResolutionResult {
  return {
    status: 'manual_review',
    reason: 'NO_APPROVED_MATCH_KEY',
    entityType: input.entityType,
    sourceSystem: input.sourceSystem,
    sourceEntityId: input.externalId,
    reviewCaseId,
  };
}

