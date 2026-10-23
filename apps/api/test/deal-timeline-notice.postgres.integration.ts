import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { before, after, test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { DealTimelineNoticeService } from '../src/deals-orders/deal-timeline-notice.service';
import { dealTimelineMessage } from '../src/deals-orders/deal-timeline-message';

const db = new DatabaseService();
const service = new DealTimelineNoticeService(db);
const originalFetch = globalThis.fetch;
const originalEnv = { SYNC_MODE: process.env.SYNC_MODE, BITRIX24_REST_BASE_URL: process.env.BITRIX24_REST_BASE_URL };
let comments: Array<{ ID: string; COMMENT: string; dealId: string }> = [];
let loseAck = false;
let adds = 0;
let reads = 0;

before(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /side22_timeline_test/);
  assert.equal(process.env.TIMELINE_TEST_ISOLATED, '1');
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_REST_BASE_URL = 'https://timeline.fake/rest/';
  await db.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  await db.syncDirectionSetting.upsert({ where: { entityKey: 'deals-orders' }, create: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: false }, update: { bitrix24ToMoysklad: true } });
  globalThis.fetch = async (input, init = {}) => {
    const target = new URL(String(input));
    assert.equal(target.hostname, 'timeline.fake');
    assert.equal(init.method, 'POST');
    const params = new URLSearchParams(String(init.body));
    if (target.pathname.endsWith('/crm.timeline.comment.list.json')) {
      reads++;
      return Response.json({ result: comments.filter((c) => c.dealId === params.get('filter[ENTITY_ID]')) });
    }
    assert.ok(target.pathname.endsWith('/crm.timeline.comment.add.json'));
    adds++;
    const comment = { ID: String(adds), COMMENT: params.get('fields[COMMENT]')!, dealId: params.get('fields[ENTITY_ID]')! };
    comments.push(comment);
    if (loseAck) { loseAck = false; throw new Error('synthetic acknowledgement loss'); }
    return Response.json({ result: Number(comment.ID) });
  };
});

after(async () => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  await db.$disconnect();
});

test('human messages never echo raw diagnostic data and include a safe order link', () => {
  const unknown = dealTimelineMessage({ kind: 'ERROR', reason: 'SECRET token https://private/payload' });
  assert.equal(unknown.includes('SECRET'), false);
  assert.ok(dealTimelineMessage({ kind: 'ERROR', reason: 'RUNTIME_REFERENCES_MISSING' }).includes('повторена автоматически'));
  assert.ok(dealTimelineMessage({ kind: 'CREATED', moyskladOrderId: '11111111-1111-4111-8111-111111111111' }).includes('https://online.moysklad.ru/app/#customerorder/edit?id='));
});

test('repeated errors and two concurrent workers post exactly one readable comment', async () => {
  const input = { bitrix24DealId: '91001', kind: 'ERROR' as const, reason: 'RUNTIME_REFERENCES_MISSING' };
  await Promise.all([service.enqueue(input), service.enqueue(input)]);
  assert.equal(await db.dealTimelineNotice.count({ where: { bitrix24DealId: '91001' } }), 1);
  await Promise.all([service.drain(), new DealTimelineNoticeService(db).drain()]);
  assert.equal(comments.filter((c) => c.dealId === '91001').length, 1);
  assert.equal((await db.dealTimelineNotice.findFirstOrThrow({ where: { bitrix24DealId: '91001' } })).status, 'POSTED');
});

test('lost comment acknowledgement is recovered by native readback, never a repeated ADD', async () => {
  await service.enqueue({ bitrix24DealId: '91002', kind: 'ERROR', reason: 'PRODUCT_UUID_INVALID' });
  loseAck = true;
  const beforeAdds = adds;
  await service.drain();
  assert.equal(adds, beforeAdds + 1);
  const pending = await db.dealTimelineNotice.findFirstOrThrow({ where: { bitrix24DealId: '91002' } });
  assert.equal(pending.status, 'PENDING');
  await db.dealTimelineNotice.update({ where: { id: pending.id }, data: { retryAfter: new Date(0) } });
  await service.drain();
  assert.equal(adds, beforeAdds + 1);
  assert.equal((await db.dealTimelineNotice.findUniqueOrThrow({ where: { id: pending.id } })).status, 'POSTED');
});

test('pending error is superseded by successful creation; a later update error is still shown', async () => {
  await service.enqueue({ bitrix24DealId: '91003', kind: 'ERROR', reason: 'SOURCE_READ_FAILED' });
  await service.enqueue({ bitrix24DealId: '91003', kind: 'CREATED', moyskladOrderId: '11111111-1111-4111-8111-111111111111' });
  await service.drain();
  assert.equal(comments.filter((c) => c.dealId === '91003').length, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.enqueue({ bitrix24DealId: '91003', kind: 'ERROR', reason: 'FIELD_MAPPING_UNSUPPORTED' });
  await service.drain();
  assert.equal(comments.filter((c) => c.dealId === '91003').length, 2);
});

test('pause leaves notices durable without making any provider requests', async () => {
  await service.enqueue({ bitrix24DealId: '91004', kind: 'ERROR', reason: 'SOURCE_READ_FAILED' });
  await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'pause' } });
  const beforeRequests = reads + adds;
  await service.drain();
  assert.equal(reads + adds, beforeRequests);
  assert.equal((await db.dealTimelineNotice.findFirstOrThrow({ where: { bitrix24DealId: '91004' } })).status, 'PENDING');
  await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  await service.drain();
  assert.equal(comments.filter((c) => c.dealId === '91004').length, 1);
});
