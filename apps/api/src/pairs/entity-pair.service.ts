import { ConflictException, Injectable, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { EntityType, isEntityType } from './pair-resolver';
import { isUniqueConstraintError } from './pair-db-errors';
import { lockEntityPairState } from './pair-db-lock';
import { createAdminAuditEntry } from '../admin/admin-audit.service';

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
  bitrix24Label?: string | null;
  moyskladLabel?: string | null;
  labelStatus?: 'CACHED_NAMES_AVAILABLE' | 'CACHED_NAMES_UNAVAILABLE';
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
  sourceLabel: string | null;
  labelStatus: 'CACHED_NAME_AVAILABLE' | 'CACHED_NAME_UNAVAILABLE';
};

type PairSourceSystem = 'BITRIX24' | 'MOYSKLAD';

export type AssignEntityPairInput = {
  entityType: EntityType;
  bitrix24Id: string;
  moyskladId: string;
  moyskladType?: 'counterparty' | 'contactperson' | 'customerorder' | 'invoiceout' | 'product';
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
    const labels = await this.database.clientInventoryObject.findMany({
      where: { OR: rows.flatMap((row) => [
        { system: 'BITRIX24', entityType: row.entityType, externalId: row.bitrix24Id },
        { system: 'MOYSKLAD', entityType: row.entityType, externalId: row.moyskladId },
      ]) },
      select: { system: true, entityType: true, externalId: true, displayLabel: true },
    });
    const labelByKey = new Map(labels.map((row) => [`${row.system}:${row.entityType}:${row.externalId}`, row.displayLabel]));
    return rows.map((row) => {
      const bitrix24Label = labelByKey.get(`BITRIX24:${row.entityType}:${row.bitrix24Id}`) ?? null;
      const moyskladLabel = labelByKey.get(`MOYSKLAD:${row.entityType}:${row.moyskladId}`) ?? null;
      return { ...row, entityType: row.entityType as EntityType, active: true, bitrix24Label, moyskladLabel,
        labelStatus: bitrix24Label && moyskladLabel ? 'CACHED_NAMES_AVAILABLE' as const : 'CACHED_NAMES_UNAVAILABLE' as const };
    });
  }

  async listOpenReviews(): Promise<PairReviewDto[]> {
    const rows = await this.database.pairReviewCase.findMany({
      where: { status: 'OPEN' }, orderBy: { openedAt: 'asc' },
      select: { id: true, entityType: true, sourceSystem: true, sourceEntityId: true, eventId: true, reason: true, status: true, openedAt: true, resolvedAt: true },
    });
    const labels = await this.database.clientInventoryObject.findMany({
      where: { OR: rows.map((row) => ({ system: row.sourceSystem, entityType: row.entityType, externalId: row.sourceEntityId })) },
      select: { system: true, entityType: true, externalId: true, displayLabel: true },
    });
    const labelByKey = new Map(labels.map((row) => [`${row.system}:${row.entityType}:${row.externalId}`, row.displayLabel]));
    return rows.map((row) => {
      const sourceLabel = labelByKey.get(`${row.sourceSystem}:${row.entityType}:${row.sourceEntityId}`) ?? null;
      return { ...row, entityType: row.entityType as EntityType, sourceSystem: row.sourceSystem as PairSourceSystem, status: 'OPEN' as const,
        sourceLabel, labelStatus: sourceLabel ? 'CACHED_NAME_AVAILABLE' as const : 'CACHED_NAME_UNAVAILABLE' as const };
    });
  }

  async assign(input: AssignEntityPairInput, actorId?: string): Promise<EntityPairDto> {
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
        if (actorId) await createAdminAuditEntry(transaction, {
          actorId,
          action: conflicts.length ? 'PAIR_REASSIGNED' : 'PAIR_CREATED',
          targetType: 'EntityPair',
          targetId: pair.id,
          reason: pair.reason,
          before: conflicts.map(({ id, entityType, bitrix24Id, moyskladId, moyskladType, moyskladParentId, reason }) => ({ id, entityType, bitrix24Id, moyskladId, moyskladType, moyskladParentId, reason })),
          after: { id: pair.id, entityType: pair.entityType, bitrix24Id: pair.bitrix24Id, moyskladId: pair.moyskladId, moyskladType: pair.moyskladType, moyskladParentId: pair.moyskladParentId, reason: pair.reason },
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
        return { ...pair, entityType: pair.entityType as EntityType, active: true, labelStatus: 'CACHED_NAMES_UNAVAILABLE' as const };
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
  if (input.moyskladType !== undefined && !['counterparty', 'contactperson', 'customerorder', 'invoiceout', 'product'].includes(input.moyskladType)) {
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

