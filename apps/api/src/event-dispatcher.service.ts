import { Inject, Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { ContactSyncProcessor } from './contact-sync.service';
import { PairFirstEventProcessor } from './pairs/pair-first-event.processor';

export const ADDITIONAL_EVENT_PROCESSORS = Symbol('ADDITIONAL_EVENT_PROCESSORS');

export interface InboundEventProcessor {
  supports(event: InboundEventMetadata): boolean;
  enqueue(eventId: string): void;
}

export interface InboundEventMetadata {
  id: string;
  source: string;
  eventType: string | null;
  externalEntityType: string | null;
  externalEntityId: string | null;
}

/** Fans a durably stored event out to processors, which own their event-type gates. */
@Injectable()
export class EventDispatcherService {
  constructor(
    private readonly database: DatabaseService,
    private readonly contacts: ContactSyncProcessor,
    private readonly pairs: PairFirstEventProcessor,
    @Optional() @Inject(ADDITIONAL_EVENT_PROCESSORS) private readonly additional: InboundEventProcessor[] = [],
  ) {}

  async dispatch(eventId: string): Promise<void> {
    const event = await this.database.inboundEvent.findUnique({
      where: { id: eventId },
      select: { id: true, source: true, eventType: true, externalEntityType: true, externalEntityId: true },
    });
    if (!event) return;
    const supported = this.additional.filter((processor) => processor.supports(event));
    if (supported.length) {
      // An explicitly registered processor owns its event class. In particular,
      // a client processor supersedes the legacy EMAIL-only handler.
      for (const processor of supported) processor.enqueue(eventId);
      return;
    }
    if (isContactEvent(event)) this.contacts.enqueue(eventId);
    else if (isDealOrderEvent(event)) this.pairs.enqueue(eventId);
  }
}

function isContactEvent(event: InboundEventMetadata): boolean {
  return (event.source === 'BITRIX24' && event.eventType?.startsWith('ONCRMCONTACT') === true) ||
    (event.source === 'MOYSKLAD' && event.eventType === 'UPDATE' && event.externalEntityType === 'counterparty');
}

function isDealOrderEvent(event: InboundEventMetadata): boolean {
  return (event.source === 'BITRIX24' && event.externalEntityType === 'deal' && /^ONCRMDEAL(?:ADD|UPDATE|DELETE)$/.test(event.eventType ?? '')) ||
    (event.source === 'MOYSKLAD' && event.externalEntityType === 'customerorder' && ['CREATE', 'UPDATE', 'DELETE'].includes(event.eventType ?? ''));
}
