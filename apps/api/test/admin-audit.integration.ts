import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createAdminAuditEntry, readBitrixUserId } from '../src/admin/admin-audit.service';

test('admin audit stores bounded change values with nested secrets redacted', async () => {
  let stored: Record<string, unknown> | undefined;
  await createAdminAuditEntry({ adminAuditEntry: { create: async ({ data }) => { stored = data; return data; } } }, {
    actorId: 'BITRIX24_USER:42', action: 'PAIR_REASSIGNED', targetType: 'EntityPair', targetId: 'pair-1',
    before: { bitrix24Id: '42', access_token: 'do-not-store', fields: [{ title: 'Name', value: 'Ada' }] },
    after: { moyskladId: 'uuid-9', reason: 'Confirmed by operator' },
  });
  assert.deepEqual(stored?.before, { bitrix24Id: '42', access_token: '[redacted]', fields: [{ title: 'Name', value: 'Ada' }] });
  assert.deepEqual(stored?.after, { moyskladId: 'uuid-9', reason: 'Confirmed by operator' });
  assert.equal(stored?.actorId, 'BITRIX24_USER:42');
});

test('administrator identity reads only a numeric Bitrix24 user ID and fails closed', async () => {
  const success = await readBitrixUserId('opaque-token', async (_input, init) => {
    assert.equal(new URLSearchParams(String(init?.body)).get('auth'), 'opaque-token');
    return Response.json({ result: { ID: '42' } });
  });
  assert.equal(success, 'BITRIX24_USER:42');
  const denied = await readBitrixUserId('opaque-token', async () => Response.json({ error: 'ACCESS_DENIED' }));
  assert.equal(denied, null);
});
