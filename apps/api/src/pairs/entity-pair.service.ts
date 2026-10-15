import { ConflictException, Injectable, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { EntityType, isEntityType } from './pair-resolver';
import { isUniqueConstraintError } from './pair-db-errors';
import { lockEntityPairState } from './pair-db-lock';

export type { EntityType } from './pair-resolver';

/** Stable service/API shape for an active persisted entity pair. */
export type EntityPairDto = {
  id: string;
  entityType: EntityType;
  bitrix24Id: string;
  moyskladId: string;
  moyskladType: string | null;
  moyskladParentId: string | null;
  active: true;
  source: string;
  reason: string | null;
  createdAt: Date;
};

/** Stable queue shape for an unresolved source-side identity. */
export type PairReviewDto = {
  id: string;
  entityType: EntityType;
  sourceSystem: 'BITRIX24' | 'MOYSKLAD';
  sourceEntityId: string;
  eventId: string | null;
  reason: string;
  status: 'OPEN';
  openedAt: Date;
  resolvedAt: Date | null;
};

type PairSourceSystem = 'BITRIX24' | 'MOYSKLAD';

export type AssignEntityPairInput = {
  entityType: EntityType;
  bitrix24Id: string;
  moyskladId: string;
  moyskladType?: 'counterparty' | 'contactperson' | 'customerorder' | 'product';
  moyskladParentId?: string;
  replaceExisting?: boolean;
};

@Injectable()
export class EntityPairService {
  constructor(private readonly database: DatabaseService) {}

  async listActive(entityType?: EntityType): Promise<EntityPairDto[]> {
    const rows = await this.database.entityPair.findMany({
      where: { active: true, ...(entityType ? { entityType } : {}) },
      orderBy: [{ entityType: 'asc' }, { createdAt: 'desc' }],
      select: { id: true, entityType: true, bitrix24Id: true, moyskladId: true, moyskladType: true, moyskladParentId: true, active: true, source: true, reason: true, createdAt: true },
    });
    return rows.map((row) => ({ ...row, entityType: row.entityType as EntityType, active: true }));
  }

  async listOpenReviews(): Promise<PairReviewDto[]> {
    const rows = await this.database.pairReviewCase.findMany({
      where: { status: 'OPEN' }, orderBy: { openedAt: 'asc' },
      select: { id: true, entityType: true, sourceSystem: true, sourceEntityId: true, eventId: true, reason: true, status: true, openedAt: true, resolvedAt: true },
    });
    return rows.map((row) => ({ ...row, entityType: row.entityType as EntityType, sourceSystem: row.sourceSystem as PairSourceSystem, status: 'OPEN' as const }));
  }

  async assign(input: AssignEntityPairInput): Promise<EntityPairDto> {
    validate(input);
    try {
      return await this.database.$transaction(async (transaction) => {
        await lockEntityPairState(transaction);
        const conflicts = await transaction.entityPair.findMany({
          where: {
            entityType: input.entityType,
            active: true,
            OR: [{ bitrix24Id: input.bitrix24Id }, { moyskladId: input.moyskladId }],
          },
        });
        if (conflicts.length && !input.replaceExisting) throw new ConflictException('PAIR_ALREADY_ASSIGNED');

        if (conflicts.length) {
          await transaction.entityPair.updateMany({
            where: { id: { in: conflicts.map((pair) => pair.id) }, active: true },
            data: { active: false },
          });
          for (const conflict of conflicts) {
            const oldSourceStillPaired = await transaction.entityPair.findFirst({
              where: { entityType: input.entityType, bitrix24Id: conflict.bitrix24Id, active: true },
              select: { id: true },
            });
            if (!oldSourceStillPaired && conflict.bitrix24Id !== input.bitrix24Id) {
              await transaction.clientInventoryObject.updateMany({
                where: { system: 'BITRIX24', entityType: input.entityType, externalId: conflict.bitrix24Id },
                data: { status: 'UNMATCHED', reason: 'ADMIN_REASSIGNED' },
              });
            }
            const oldTargetStillPaired = await transaction.entityPair.findFirst({
              where: { entityType: input.entityType, moyskladId: conflict.moyskladId, active: true },
              select: { id: true },
            });
            if (!oldTargetStillPaired && conflict.moyskladId !== input.moyskladId) {
              await transaction.clientInventoryObject.updateMany({
                where: { system: 'MOYSKLAD', entityType: input.entityType, externalId: conflict.moyskladId },
                data: { status: 'UNMATCHED', reason: 'ADMIN_REASSIGNED' },
              });
            }
          }
        }
        const pair = await transaction.entityPair.create({
          data: {
            entityType: input.entityType,
            bitrix24Id: input.bitrix24Id,
            moyskladId: input.moyskladId,
            moyskladType: input.moyskladType ?? null,
            moyskladParentId: input.moyskladParentId ?? null,
            active: true,
            source: 'MANUAL',
            reason: conflicts.length ? 'ADMIN_REASSIGNED' : 'ADMIN_ASSIGNED',
          },
        });
        await transaction.pairReviewCase.updateMany({
          where: {
            entityType: input.entityType,
            sourceSystem: 'BITRIX24',
            sourceEntityId: input.bitrix24Id,
            status: 'OPEN',
          },
          data: { status: 'RESOLVED', resolvedAt: new Date() },
        });
        if (input.entityType === 'CONTACT' || input.entityType === 'COMPANY') {
          await transaction.clientInventoryObject.updateMany({
            where: { system: 'BITRIX24', entityType: input.entityType, externalId: input.bitrix24Id },
            data: { status: 'MATCHED', reason: null },
          });
          await transaction.clientInventoryObject.updateMany({
            where: {
              system: 'MOYSKLAD', entityType: input.entityType, externalId: input.moyskladId,
              nativeType: input.moyskladType,
            },
            data: { status: 'MATCHED', reason: null },
          });
        }
        await transaction.pairReviewCase.updateMany({
          where: {
            entityType: input.entityType,
            sourceSystem: 'MOYSKLAD',
            sourceEntityId: input.moyskladId,
            status: 'OPEN',
          },
          data: { status: 'RESOLVED', resolvedAt: new Date() },
        });
        if (input.entityType === 'DEAL') await transaction.inboundEvent.updateMany({
          where: {
            source: 'BITRIX24', externalEntityType: 'deal', externalEntityId: input.bitrix24Id,
            status: 'MANUAL_REVIEW', lastErrorCategory: { in: ['PAIR_REVIEW_REQUIRED', 'PAIR_RESOLUTION_UNAVAILABLE'] },
          },
          data: { status: 'RECEIVED', lastErrorCategory: null },
        });
        if (input.entityType === 'DEAL') await transaction.inboundEvent.updateMany({
          where: {
            source: 'MOYSKLAD', externalEntityType: 'customerorder', externalEntityId: input.moyskladId,
            status: 'MANUAL_REVIEW', lastErrorCategory: { in: ['PAIR_REVIEW_REQUIRED', 'PAIR_RESOLUTION_UNAVAILABLE'] },
          },
          data: { status: 'RECEIVED', lastErrorCategory: null },
        });
        return { ...pair, entityType: pair.entityType as EntityType, active: true };
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (isUniqueConstraintError(error)) throw new ConflictException('PAIR_ALREADY_ASSIGNED');
      throw error;
    }
  }
}

function validate(input: AssignEntityPairInput): void {
  if (!isEntityType(input.entityType)) throw new BadRequestException('entityType is unsupported');
  if (!isId(input.bitrix24Id)) throw new BadRequestException('bitrix24Id is required');
  if (!isId(input.moyskladId)) throw new BadRequestException('moyskladId is required');
  if (input.moyskladType !== undefined && !['counterparty', 'contactperson', 'customerorder', 'product'].includes(input.moyskladType)) {
    throw new BadRequestException('moyskladType is unsupported');
  }
  if (input.moyskladType === 'contactperson' && (input.entityType !== 'CONTACT' || !input.moyskladParentId)) {
    throw new BadRequestException('A contactperson pair must be a CONTACT with its parent counterparty ID');
  }
  if (input.entityType === 'CONTACT' && input.moyskladType !== 'counterparty' && input.moyskladType !== 'contactperson') {
    throw new BadRequestException('A CONTACT pair must specify moyskladType as counterparty or contactperson');
  }
  if (input.entityType === 'COMPANY' && input.moyskladType !== 'counterparty') {
    throw new BadRequestException('A COMPANY pair must specify moyskladType as counterparty');
  }
  if (input.moyskladParentId !== undefined && input.moyskladType !== 'contactperson') {
    throw new BadRequestException('Only a contactperson pair may specify moyskladParentId');
  }
  if (input.moyskladParentId !== undefined && !isId(input.moyskladParentId)) throw new BadRequestException('moyskladParentId is invalid');
  if (input.replaceExisting !== undefined && typeof input.replaceExisting !== 'boolean') {
    throw new BadRequestException('replaceExisting must be boolean');
  }
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
}

