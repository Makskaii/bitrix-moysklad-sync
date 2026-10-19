import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventDispatcherService, InboundEventMetadata, InboundEventProcessor } from '../src/event-dispatcher.service';

test('dispatcher routes to its core owner and lets an explicit processor own matching events', async () => {
  const calls: string[] = [];
  const processor = (name: string): InboundEventProcessor => ({
    supports: () => true,
    enqueue: (eventId) => calls.push(`${name}:${eventId}`),
  });
  const events: Record<string, InboundEventMetadata> = {
    'event-1': { id: 'event-1', source: 'BITRIX24', eventType: 'ONCRMCONTACTUPDATE', externalEntityType: 'contact', externalEntityId: '1' },
    'event-2': { id: 'event-2', source: 'MOYSKLAD', eventType: 'UPDATE', externalEntityType: 'counterparty', externalEntityId: '2' },
    'event-3': { id: 'event-3', source: 'BITRIX24', eventType: 'ONCRMDEALUPDATE', externalEntityType: 'deal', externalEntityId: '3' },
    'event-4': { id: 'event-4', source: 'MOYSKLAD', eventType: 'CREATE', externalEntityType: 'customerorder', externalEntityId: '4' },
    'event-5': { id: 'event-5', source: 'BITRIX24', eventType: 'ONCRMCOMPANYUPDATE', externalEntityType: 'company', externalEntityId: '5' },
  };
  const dispatcher = new EventDispatcherService(
    { inboundEvent: { findUnique: async ({ where }: { where: { id: string } }) => events[where.id] } } as never,
    processor('contacts') as never,
    processor('pairs') as never,
    [{ supports: (event) => event.id === 'event-2' || event.id === 'event-5', enqueue: (eventId) => calls.push(`extra:${eventId}`) }],
  );

  await dispatcher.dispatch('event-1');
  await dispatcher.dispatch('event-2');
  await dispatcher.dispatch('event-3');
  await dispatcher.dispatch('event-4');
  await dispatcher.dispatch('event-5');

  assert.deepEqual(calls, [
    'contacts:event-1',
    'extra:event-2',
    'pairs:event-3',
    'pairs:event-4',
    'extra:event-5',
  ]);
});

test('dispatcher routes product and smart-invoice events to their registered processors', async () => {
  const deliveries: string[] = [];
  const events: Record<string, InboundEventMetadata> = {
    product: { id: 'product', source: 'MOYSKLAD', eventType: 'UPDATE', externalEntityType: 'product', externalEntityId: 'p-1' },
    invoice: { id: 'invoice', source: 'BITRIX24', eventType: 'ONCRMDYNAMICITEMUPDATE', externalEntityType: 'invoice', externalEntityId: 'i-1' },
  };
  const owner = (name: string, entityType: string): InboundEventProcessor => ({
    supports: (event) => event.externalEntityType === entityType,
    enqueue: (eventId) => deliveries.push(`${name}:${eventId}`),
  });
  const dispatcher = new EventDispatcherService(
    { inboundEvent: { findUnique: async ({ where }: { where: { id: string } }) => events[where.id] } } as never,
    { enqueue: () => assert.fail('non-client events must not route to contacts') } as never,
    { enqueue: () => assert.fail('non-deal events must not route to pair resolution') } as never,
    [owner('products', 'product'), owner('invoices', 'invoice')],
  );

  await dispatcher.dispatch('product');
  await dispatcher.dispatch('invoice');

  assert.deepEqual(deliveries, ['products:product', 'invoices:invoice']);
});
