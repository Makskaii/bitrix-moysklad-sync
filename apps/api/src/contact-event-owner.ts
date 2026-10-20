import { DatabaseService } from './database.service';

export type ContactOwnerEvent = {
  source?: string;
  eventType?: string | null;
  externalEntityType?: string | null;
  externalEntityId?: string | null;
};

export type ContactEventOwner = 'CLIENT' | 'LEGACY' | null;

/**
 * The legacy processor is an email-only compatibility path for contacts that
 * already have a legacy ContactPair. New and modern-paired contacts belong to
 * ClientSyncProcessor. This decision is shared by dispatch and both recovery
 * workers so a retry cannot change owners halfway through its lifecycle.
 */
export async function contactEventOwner(database: DatabaseService, event: ContactOwnerEvent): Promise<ContactEventOwner> {
  const sourceId = event.externalEntityId;
  if (!sourceId) return null;

  const isBitrixContact = event.source === 'BITRIX24' && event.externalEntityType === 'contact' &&
    /^ONCRMCONTACT(?:ADD|UPDATE)$/.test(event.eventType ?? '');
  const isMoyskladCounterparty = event.source === 'MOYSKLAD' && event.externalEntityType === 'counterparty' && event.eventType === 'UPDATE';
  if (!isBitrixContact && !isMoyskladCounterparty) return null;

  const [legacyPair, modernPair] = await Promise.all([
    database.contactPair.findFirst({
      where: isBitrixContact ? { bitrix24ContactId: sourceId } : { moyskladCounterpartyId: sourceId },
      select: { id: true },
    }),
    database.entityPair.findFirst({
      where: {
        active: true,
        entityType: isBitrixContact ? 'CONTACT' : { in: ['COMPANY', 'CONTACT'] },
        ...(isBitrixContact ? { bitrix24Id: sourceId } : { moyskladId: sourceId }),
      },
      select: { id: true },
    }),
  ]);

  // If both pair systems contain the source, the current active EntityPair is
  // authoritative; do not let the legacy email path write to another target.
  if (modernPair) return 'CLIENT';
  return legacyPair ? 'LEGACY' : 'CLIENT';
}

export async function legacyOwnsContactEvent(database: DatabaseService, event: ContactOwnerEvent): Promise<boolean> {
  return (await contactEventOwner(database, event)) === 'LEGACY';
}

export async function clientOwnsContactEvent(database: DatabaseService, event: ContactOwnerEvent): Promise<boolean> {
  return (await contactEventOwner(database, event)) === 'CLIENT';
}
