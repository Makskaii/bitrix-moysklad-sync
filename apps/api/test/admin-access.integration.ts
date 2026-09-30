import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AdminController } from '../src/admin/admin.controller';
import { AdminAccessGuard } from '../src/admin/admin-access.guard';
import { DatabaseService } from '../src/database.service';

const actions = {
  findMany: async () => [],
  create: async ({ data }: { data: { message: string } }) => ({
    id: 'action-1', message: data.message, createdAt: new Date('2026-09-30T00:00:00.000Z'),
  }),
};

@Module({
  controllers: [AdminController],
  providers: [
    AdminAccessGuard,
    { provide: DatabaseService, useValue: { trialAction: actions } },
  ],
})
class AdminAccessTestModule {}

const nativeFetch = globalThis.fetch;
let app: INestApplication;
let apiUrl: string;

before(async () => {
  app = await NestFactory.create(AdminAccessTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
});

after(async () => {
  globalThis.fetch = nativeFetch;
  await app.close();
});

function mockBitrix(responseFor: (token: string, signal?: AbortSignal) => Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://aerosystems.bitrix24.ru/rest/user.admin.json')) {
      const token = new URLSearchParams(String(init?.body ?? '')).get('auth') ?? '';
      return responseFor(token, init?.signal ?? undefined);
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
}

async function adminRequest(token: string, method: 'GET' | 'POST' = 'GET') {
  return nativeFetch(`${apiUrl}/api/admin/trial-actions`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify({ message: 'integration check' }) } : {}),
  });
}

test('known administrator can read and perform an administrative action with their user token', async () => {
  let checks = 0;
  mockBitrix(async (token) => {
    checks++;
    assert.equal(token, 'admin-test-token');
    return Response.json({ result: true });
  });

  assert.equal((await adminRequest('admin-test-token')).status, 200);
  assert.equal((await adminRequest('admin-test-token', 'POST')).status, 201);
  assert.equal(checks, 2, 'user.admin is called independently for each admin action');
});

test('known non-administrator is denied on reads and writes', async () => {
  mockBitrix(async (token) => {
    assert.equal(token, 'staff-test-token');
    return Response.json({ result: false });
  });

  assert.equal((await adminRequest('staff-test-token')).status, 403);
  assert.equal((await adminRequest('staff-test-token', 'POST')).status, 403);
});

test('method errors and malformed results fail closed', async () => {
  mockBitrix(async (_token) => new Response(JSON.stringify({ error: 'ACCESS_DENIED' }), { status: 200 }));
  assert.equal((await adminRequest('error-test-token')).status, 403);

  mockBitrix(async (_token) => Response.json({ result: 'true' }));
  assert.equal((await adminRequest('malformed-test-token', 'POST')).status, 403);
});

test('a timed out Bitrix24 check fails closed', async () => {
  mockBitrix((_token, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  assert.equal((await adminRequest('timeout-test-token')).status, 403);
});
