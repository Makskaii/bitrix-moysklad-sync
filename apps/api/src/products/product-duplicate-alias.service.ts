import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { writeOperationalLog } from '../monitoring-log';
import { lockEntityPairState } from '../pairs/pair-db-lock';

export type ProductDuplicateEvidence = {
  nameExact: true;
  configuredPriceType: string;
  priceEqual: true;
  currencyVerified: true;
  taxComparable: true;
  selectionReason: 'EARLIEST_CREATION_DATE' | 'CREATION_DATE_TIED_NATIVE_ID' | 'CREATION_DATE_UNAVAILABLE_NATIVE_ID';
  duplicateCreatedAt: string | null;
  canonicalCreatedAt: string | null;
  selectionCandidateCreatedAt?: string | null;
  selectionCandidateCreatedAtSource?: string;
};

export class ProductDuplicateAliasConflictError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

@Injectable()
export class ProductDuplicateAliasService {
  constructor(private readonly database: DatabaseService) {}

  async record(input: {
    duplicateBitrix24Id: string;
    canonicalPairId: string;
    moyskladType: 'product' | 'service';
    reason: string;
    evidence: ProductDuplicateEvidence;
  }) {
    if (!/^\d{1,20}$/.test(input.duplicateBitrix24Id)) throw new ProductDuplicateAliasConflictError('PRODUCT_DUPLICATE_ID_INVALID');
    const alias = await this.database.$transaction(async (transaction) => {
      await lockEntityPairState(transaction);
      const canonical = await transaction.entityPair.findFirst({
        where: { id: input.canonicalPairId, entityType: 'PRODUCT', active: true, moyskladType: input.moyskladType },
        select: { id: true, bitrix24Id: true, moyskladId: true },
      });
      if (!canonical) throw new ProductDuplicateAliasConflictError('PRODUCT_DUPLICATE_CANONICAL_PAIR_NOT_ACTIVE');
      if (canonical.bitrix24Id === input.duplicateBitrix24Id) throw new ProductDuplicateAliasConflictError('PRODUCT_DUPLICATE_CANONICAL_ID_MATCH');

      const existing = await transaction.productDuplicateAlias.findUnique({ where: { duplicateBitrix24Id: input.duplicateBitrix24Id } });
      if (existing) {
        if (existing.canonicalPairId !== canonical.id) throw new ProductDuplicateAliasConflictError('PRODUCT_DUPLICATE_ALIAS_CONFLICT');
        return existing;
      }
      const occupied = await transaction.entityPair.findFirst({
        where: { entityType: 'PRODUCT', active: true, bitrix24Id: input.duplicateBitrix24Id }, select: { id: true },
      });
      if (occupied) throw new ProductDuplicateAliasConflictError('PRODUCT_DUPLICATE_ID_ALREADY_PAIRED');
      return transaction.productDuplicateAlias.create({ data: {
        duplicateBitrix24Id: input.duplicateBitrix24Id,
        canonicalBitrix24Id: canonical.bitrix24Id,
        canonicalMoyskladId: canonical.moyskladId,
        canonicalPairId: canonical.id,
        moyskladType: input.moyskladType,
        reason: input.reason,
        evidence: input.evidence as unknown as Prisma.InputJsonValue,
      } });
    });
    await writeOperationalLog(this.database, 'EVENT', JSON.stringify({
      type: 'PRODUCT_DUPLICATE_ALIAS_RECORDED', aliasId: alias.id,
      duplicateBitrix24Id: alias.duplicateBitrix24Id,
      canonicalBitrix24Id: alias.canonicalBitrix24Id,
      canonicalMoyskladId: alias.canonicalMoyskladId,
      selectionReason: input.evidence.selectionReason,
    }), alias.id);
    return alias;
  }

  async resolveBitrix24Product(bitrix24Id: string): Promise<
    | { status: 'PAIR'; pair: { id: string; bitrix24Id: string; moyskladId: string; moyskladType: string | null } }
    | { status: 'ALIAS'; alias: { id: string; duplicateBitrix24Id: string; canonicalBitrix24Id: string; canonicalMoyskladId: string; canonicalPairId: string; moyskladType: string; reason: string } }
    | { status: 'NONE' }
  > {
    const alias = await this.database.productDuplicateAlias.findUnique({
      where: { duplicateBitrix24Id: bitrix24Id },
      select: { id: true, duplicateBitrix24Id: true, canonicalBitrix24Id: true, canonicalMoyskladId: true, canonicalPairId: true, moyskladType: true, reason: true },
    });
    if (alias) {
      const canonical = await this.database.entityPair.findFirst({
        where: { id: alias.canonicalPairId, entityType: 'PRODUCT', active: true },
        select: { id: true, bitrix24Id: true, moyskladId: true, moyskladType: true },
      });
      return canonical ? { status: 'ALIAS', alias } : { status: 'NONE' };
    }
    const pair = await this.database.entityPair.findFirst({
      where: { entityType: 'PRODUCT', active: true, bitrix24Id },
      select: { id: true, bitrix24Id: true, moyskladId: true, moyskladType: true },
    });
    return pair ? { status: 'PAIR', pair } : { status: 'NONE' };
  }

  list() {
    return this.database.productDuplicateAlias.findMany({
      orderBy: [{ createdAt: 'desc' }, { duplicateBitrix24Id: 'asc' }],
      select: { id: true, duplicateBitrix24Id: true, canonicalBitrix24Id: true, canonicalMoyskladId: true, canonicalPairId: true, moyskladType: true, reason: true, evidence: true, createdAt: true },
      take: 500,
    });
  }
}
