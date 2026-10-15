import { EntityPair } from '@prisma/client';
import { ClientEntity, ClientSystem } from './client-runtime-resolver';
import type { EventWorkerLeaseContext } from '../event-worker-lease.service';
import type { DocumentClientResolution } from './document-client-contract';

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
  /** Used only by the durable optional contact retry worker after the owner event has completed. */
  optionalRetry?: boolean;
  /** Failures remain attached to the separate contact retry journal, not the document review state. */
  optionalDependency?: boolean;
};

export type ClientDependencyResolution =
  | { status: 'RESOLVED'; pair: EntityPair; companyPair: EntityPair | null; selectedSourceId: string; reason: string }
  | { status: 'OMITTED'; reason: 'DUPLICATE_CONTACT'; companyPair: EntityPair }
  | { status: 'REVIEW'; reason: string }
  | { status: 'RETRY'; reason: string; retryAfter?: Date };

/** Resolves only a document's explicit client dependencies; it does not scan or rewrite documents. */
export interface ClientDependencyResolver {
  resolveForDocument(input: ClientDependencyInput, lease?: EventWorkerLeaseContext): Promise<ClientDependencyResolution>;
  scheduleOptionalContactRetry(input: ClientDependencyInput, reason: string, retryAfter?: Date): Promise<void>;
}

export type { DocumentClientResolution };
