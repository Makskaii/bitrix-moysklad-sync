import { EntityPair } from '@prisma/client';
import { ClientEntity, ClientSystem } from './client-runtime-resolver';
import type { EventWorkerLeaseContext } from '../event-worker-lease.service';

export const CLIENT_DEPENDENCY_RESOLVER = Symbol('CLIENT_DEPENDENCY_RESOLVER');

export type ClientDependencyInput = {
  /** The owning deal/order event. Its pinned field-settings version is authoritative. */
  eventId: string;
  sourceSystem: ClientSystem;
  entity: ClientEntity;
  sourceId: string;
  /** Current durable attempt number for bounded fallback scheduling. */
  attempt?: number;
  /** Explicit parent company relationship when the native contact record omits it. */
  primaryCompanySourceId?: string | null;
};

export type ClientDependencyResolution =
  | { status: 'RESOLVED'; pair: EntityPair; selectedSourceId: string; reason: string }
  | { status: 'OMITTED'; reason: 'DUPLICATE_CONTACT'; companyPair: EntityPair }
  | { status: 'REVIEW'; reason: string }
  | { status: 'RETRY'; reason: string; retryAfter?: Date };

/** Resolves only a document's explicit client dependencies; it does not scan or rewrite documents. */
export interface ClientDependencyResolver {
  resolveForDocument(input: ClientDependencyInput, lease?: EventWorkerLeaseContext): Promise<ClientDependencyResolution>;
}
