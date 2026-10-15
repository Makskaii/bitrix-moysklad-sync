import type { EntityPair } from '@prisma/client';

/** Resolved source/target identity retained for the document pipeline and its future writer. */
export type DocumentClientTarget = Pick<EntityPair,
  'entityType' | 'bitrix24Id' | 'moyskladId' | 'moyskladType' | 'moyskladParentId'>;

export type DocumentClientResolution = {
  company: DocumentClientTarget | null;
  contact: DocumentClientTarget | null;
  /** Set only for a no-client document when an explicit service counterparty was configured. */
  serviceCounterpartyId: string | null;
};

export type MoySkladCustomerOrderClientFields = {
  agent: { meta: { href: string; type: 'counterparty'; mediaType: 'application/json' } };
};

/**
 * The MoySklad customer-order API models `agent` as a counterparty. Contactperson
 * resolution remains separate metadata because the order model has no contactperson field.
 */
export function toMoySkladCustomerOrderClientFields(
  client: DocumentClientResolution,
  apiBaseUrl = 'https://api.moysklad.ru/api/remap/1.2/',
): MoySkladCustomerOrderClientFields | null {
  const counterpartyId = client.company?.moyskladId ?? client.serviceCounterpartyId;
  if (!counterpartyId) return null;
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
  return {
    agent: {
      meta: {
        href: new URL(`entity/counterparty/${encodeURIComponent(counterpartyId)}`, base).href,
        type: 'counterparty',
        mediaType: 'application/json',
      },
    },
  };
}
