import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { InvoiceEventProcessor } from '../src/invoices/invoice-event.processor';

test('invoice sync processor owns only smart-invoice/invoiceout create and update events', () => {
  const processor = new InvoiceEventProcessor({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  for (const event of [
    { source: 'BITRIX24', eventType: 'ONCRMDYNAMICITEMADD', externalEntityType: 'invoice' },
    { source: 'BITRIX24', eventType: 'ONCRMDYNAMICITEMUPDATE', externalEntityType: 'invoice' },
    { source: 'MOYSKLAD', eventType: 'CREATE', externalEntityType: 'invoiceout' },
    { source: 'MOYSKLAD', eventType: 'UPDATE', externalEntityType: 'invoiceout' },
  ]) assert.equal(processor.supports(event), true);

  for (const event of [
    { source: 'BITRIX24', eventType: 'ONCRMDYNAMICITEMDELETE', externalEntityType: 'invoice' },
    { source: 'BITRIX24', eventType: 'ONCRMDYNAMICITEMADD', externalEntityType: 'deal' },
    { source: 'MOYSKLAD', eventType: 'DELETE', externalEntityType: 'invoiceout' },
    { source: 'MOYSKLAD', eventType: 'CREATE', externalEntityType: 'customerorder' },
  ]) assert.equal(processor.supports(event), false);
});
