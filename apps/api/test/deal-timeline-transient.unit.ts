import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DealTimelineNoticeService } from '../src/deals-orders/deal-timeline-notice.service';
import { DatabaseService } from '../src/database.service';
import { Prisma } from '@prisma/client';

test('automatic client-lock contention does not enqueue an alarming deal timeline error', async () => {
  let reads = 0;
  let notices = 0;
  const tx = {
    inboundEvent: { findUnique: async () => { reads++; return { source: 'BITRIX24', externalEntityType: 'deal', externalEntityId: '42' }; } },
    dealTimelineNotice: { createMany: async () => { notices++; } },
  };
  const service = new DealTimelineNoticeService({} as DatabaseService);
  await service.errorForEvent('event-1', 'CLIENT_ENTITY_LOCK_BUSY', tx as unknown as Prisma.TransactionClient);
  assert.equal(reads, 0);
  assert.equal(notices, 0);
  await service.errorForEvent('event-1', 'PRODUCT_UUID_INVALID', tx as unknown as Prisma.TransactionClient);
  assert.equal(notices, 1, 'actionable product identity errors remain visible');
});
