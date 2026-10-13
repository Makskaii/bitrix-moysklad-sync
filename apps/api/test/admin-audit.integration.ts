import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { AdminAccessGuard, LOCAL_ADMIN_PREVIEW_ACCESS } from '../src/admin/admin-access.guard';
import { AdminAuditController } from '../src/admin/admin-audit.controller';
import { AdminAuditService, readBitrixUserId } from '../src/admin/admin-audit.service';
import { manualReviewDetails } from '../src/admin/manual-review-details';
import { DatabaseService } from '../src/database.service';

const entries: Array<Record<string, unknown>> = [];
const database = {
  inboundEvent: { groupBy: async () => [{ status: 'RECEIVED', _count: { _all: 3 } }, { status: 'MANUAL_REVIEW', _count: { _all: 1 } }] },
  manualReviewCase: { count: async () => 1 },
  pairReviewCase: { count: async () => 2 },
  entityPair: { count: async () => 12 },
  syncSetting: { findUnique: async () => ({ serviceMode: 'pause' }) },
  adminAuditEntry: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `audit-${entries.length + 1}`, occurredAt: new Date('2026-10-12T10:00:00.000Z'), ...data };
      entries.unshift(row);
      return row;
    },
    findMany: async ({ where = {}, take = 50 }: { where?: Record<string, unknown>; take?: number }) => entries
      .filter((entry) => Object.entries(where).every(([key, value]) => entry[key] === value))
      .slice(0, take),
  },
};

@Module({
  controllers: [AdminAuditController],
  providers: [
    AdminAccessGuard,
    AdminAuditService,
    { provide: LOCAL_ADMIN_PREVIEW_ACCESS, useValue: true },
    { provide: DatabaseService, useValue: database },
  ],
})
class AdminAuditTestModule {}

const nativeFetch = globalThis.fetch;
let app: INestApplication;
let apiUrl: string;

before(async () => {
  process.env.ADMIN_PREVIEW = '1';
  app = await NestFactory.create(AdminAuditTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
});

after(async () => {
  globalThis.fetch = nativeFetch;
  delete process.env.ADMIN_PREVIEW;
  await app.close();
});

test('administrator overview exposes service, queue, pair and manual-review counts', async () => {
  const response = await nativeFetch(`${apiUrl}/api/admin/overview`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    mode: 'pause',
    queue: { RECEIVED: 3, MANUAL_REVIEW: 1 },
    openManualReviews: 1,
    openPairReviews: 2,
    activePairs: 12,
  });
});

test('audit timeline supports bounded pagination and filters without exposing credentials', async () => {
  const service = new AdminAuditService(database as unknown as DatabaseService);
  await service.recordAdminChange({
    actorId: '42', action: 'FIELD_SETTINGS_SAVED', entityType: 'field-settings', after: {
      version: 7,
      apiToken: 'must-not-be-stored',
      mapping: { title: 'Номер заказа', value: '16675N' },
    },
  });
  const response = await nativeFetch(`${apiUrl}/api/admin/audit?targetType=field-settings&limit=1`);
  assert.equal(response.status, 200);
  const page = await response.json() as { entries: Array<{ actorId: string; after: Record<string, unknown> }>; nextCursor: string | null };
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0]?.actorId, '42');
  assert.equal((page.entries[0]?.after.apiToken), '[redacted]');
  assert.deepEqual(page.entries[0]?.after.mapping, { title: 'Номер заказа', value: '16675N' });
});

test('administrator identity lookup validates and returns only the Bitrix user ID', async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://aerosystems.bitrix24.ru/rest/user.current.json');
    assert.equal(new URLSearchParams(String(init?.body)).get('auth'), 'temporary-test-token');
    return Response.json({ result: { ID: 123 } });
  }) as typeof fetch;
  assert.equal(await readBitrixUserId('temporary-test-token'), '123');
  assert.equal(await readBitrixUserId('not-a-token', async () => Response.json({ result: { ID: 'admin' } })), null);
});

test('manual-review details preserve explicit previous and proposed values without guessing missing values', () => {
  const details = manualReviewDetails({ entityLabel: 'Сделка 104', fieldTitle: 'Телефон', oldValue: '+7 900 000-00-00', proposedValue: null });
  assert.equal(details.entityLabel, 'Сделка 104');
  assert.equal(details.fieldTitle, 'Телефон');
  assert.equal(details.previousValue, '+7 900 000-00-00');
  assert.equal(details.proposedValue, Prisma.JsonNull);
  assert.deepEqual(manualReviewDetails({ reason: 'no previous state' }), {});
});

test('outside explicitly enabled local preview, audit reads remain forbidden', async () => {
  delete process.env.ADMIN_PREVIEW;
  const response = await nativeFetch(`${apiUrl}/api/admin/audit`);
  assert.equal(response.status, 403);
  process.env.ADMIN_PREVIEW = '1';
});
