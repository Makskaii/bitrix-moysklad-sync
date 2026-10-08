import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AdminAccessGuard } from '../src/admin/admin-access.guard';
import { HistoricalDealOrderMatchingController } from '../src/admin/historical-deal-order-matching.controller';
import { HistoricalDealOrderMatchingService } from '../src/historical-deal-order-matching.service';

let app: INestApplication;
let apiUrl: string;
let serviceCalls = 0;
let originalFetch: typeof fetch;
let originalAdminPreview: string | undefined;

@Module({
  controllers: [HistoricalDealOrderMatchingController],
  providers: [AdminAccessGuard, {
    provide: HistoricalDealOrderMatchingService,
    useValue: {
      readStatus: async () => { serviceCalls++; return { run: null }; },
      startPreview: async () => { serviceCalls++; return { run: null }; },
      listResults: async () => { serviceCalls++; return { results: [] }; },
      applyPreview: async () => { serviceCalls++; return { run: null }; },
    },
  }],
})
class HistoricalMatchingAdminTestModule {}

before(async () => {
  originalFetch = globalThis.fetch;
  originalAdminPreview = process.env.ADMIN_PREVIEW;
  process.env.ADMIN_PREVIEW = '1';
  app = await NestFactory.create(HistoricalMatchingAdminTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalAdminPreview === undefined) delete process.env.ADMIN_PREVIEW; else process.env.ADMIN_PREVIEW = originalAdminPreview;
  await app.close();
});

test('historical matching routes remain behind the per-request Bitrix administrator check', async () => {
  const status = await originalFetch(`${apiUrl}/api/admin/historical-matching/status`);
  assert.equal(status.status, 403);
  const apply = await originalFetch(`${apiUrl}/api/admin/historical-matching/apply`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'synthetic-run', confirmed: true }),
  });
  assert.equal(apply.status, 403);
  assert.equal(serviceCalls, 0, 'unauthorized requests must not reach the matching service');

  globalThis.fetch = (async (input, init) => {
    if (String(input).startsWith('https://aerosystems.bitrix24.ru/rest/user.admin.json')) {
      const token = new URLSearchParams(String(init?.body ?? '')).get('auth');
      assert.equal(token, 'synthetic-admin-token');
      return Response.json({ result: true });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  const authorized = await originalFetch(`${apiUrl}/api/admin/historical-matching/status`, { headers: { authorization: 'Bearer synthetic-admin-token' } });
  assert.equal(authorized.status, 200);
  assert.equal(serviceCalls, 1);
});
