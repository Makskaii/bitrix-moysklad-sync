export const PAIR_RESOLVER = Symbol('PAIR_RESOLVER');

export const ENTITY_TYPES = ['CONTACT', 'COMPANY', 'DEAL', 'PRODUCT', 'INVOICE'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export type PairSourceSystem = 'BITRIX24' | 'MOYSKLAD';
export type PairResolutionReason =
  | 'NO_APPROVED_MATCH_KEY'
  | 'AMBIGUOUS_CANDIDATES'
  | 'INCOMPLETE_EVIDENCE'
  | 'PAIR_ALREADY_ASSIGNED'
  | 'PAIR_INACTIVE'
  | 'ENTITY_TYPE_UNSUPPORTED'
  | 'PAIR_STORE_UNAVAILABLE';

export type PairResolutionInput = {
  entityType: EntityType;
  sourceSystem: PairSourceSystem;
  externalId: string;
  eventId?: string;
  eventType?: string | null;
};

export type PairResolutionResult =
  | {
      status: 'confirmed';
      pair: {
        id: string;
        entityType: EntityType;
        bitrix24Id: string;
        moyskladId: string;
        moyskladType?: string | null;
        moyskladParentId?: string | null;
        status: 'CONFIRMED' | 'MANUAL';
      source: 'PERSISTED';
      };
    }
  | { status: 'unmatched'; reason: 'NO_CANDIDATES' }
  | {
      status: 'manual_review';
      reason: PairResolutionReason;
      entityType: EntityType;
      sourceSystem: PairSourceSystem;
      sourceEntityId: string;
      reviewCaseId: string;
    }
  | { status: 'unavailable'; reason: 'PAIR_STORE_UNAVAILABLE' | 'ENTITY_TYPE_UNSUPPORTED' };

export interface PairResolver {
  resolve(input: PairResolutionInput): Promise<PairResolutionResult>;
}

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === 'string' && (ENTITY_TYPES as readonly string[]).includes(value);
}
