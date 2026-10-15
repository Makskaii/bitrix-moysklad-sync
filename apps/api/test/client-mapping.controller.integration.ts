import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LOCAL_ADMIN_PREVIEW_ACCESS } from '../src/admin/admin-access.guard';
import { ClientMappingController } from '../src/admin/client-mapping.controller';
import { ClientMappingService } from '../src/clients/client-mapping.service';

let app: INestApplication;
let apiUrl: string;
const requests: unknown[][] = [];

@Module({
  controllers: [ClientMappingController],
  providers: [
    { provide: LOCAL_ADMIN_PREVIEW_ACCESS, useValue: true },
    { provide: ClientMappingService, useValue: { listUnmatched: async (...args: unknown[]) => { requests.push(args); return { entries: [], nextCursor: null }; } } },
  ],
})
class ClientMappingControllerTestModule {}

before(async () => {
  process.env.ADMIN_PREVIEW = '1';
  app = await NestFactory.create(ClientMappingControllerTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
});

after(async () => {
  if (app) {
    (app.getHttpServer() as import('node:http').Server).closeAllConnections();
    await app.close();
  }
});

test('unmatched inventory API forwards system/entity filters and cursor', async () => {
  const response = await fetch(`${apiUrl}/api/admin/client-mapping/unmatched?system=MOYSKLAD&entityType=CONTACT&cursor=eyJ4IjoxfQ`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { entries: [], nextCursor: null });
  assert.deepEqual(requests.at(-1), ['MOYSKLAD', 'CONTACT', 'eyJ4IjoxfQ']);
});

test('unmatched inventory API rejects unsupported filters', async () => {
  const response = await fetch(`${apiUrl}/api/admin/client-mapping/unmatched?system=OTHER`);
  assert.equal(response.status, 400);
});
