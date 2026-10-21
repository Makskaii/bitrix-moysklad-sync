import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { resolve } from 'node:path';
import { Controller, Get, Module } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { AdminController } from '../src/admin/admin.controller';
import { AdminAccessGuard } from '../src/admin/admin-access.guard';
import { DatabaseService } from '../src/database.service';
import { ApplicationLaunchController } from '../src/application-launch.controller';

@Controller()
class LaunchTestHealthController {
  @Get('health')
  health() { return { status: 'ok' }; }
}

@Module({
  controllers: [ApplicationLaunchController, LaunchTestHealthController, AdminController],
  providers: [
    AdminAccessGuard,
    { provide: DatabaseService, useValue: { trialAction: { findMany: async () => [], create: async () => { throw new Error('unexpected admin write'); } } } },
  ],
})
class ApplicationLaunchTestModule {}

const nativeFetch = globalThis.fetch;
let app: NestExpressApplication;
let apiUrl: string;

before(async () => {
  app = await NestFactory.create<NestExpressApplication>(ApplicationLaunchTestModule, { logger: false });
  app.useStaticAssets(resolve(__dirname, '../../../../apps/web/dist'));
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
});

after(async () => {
  globalThis.fetch = nativeFetch;
  await app.close();
});

test('Bitrix launch POST returns the same public SPA shell as GET without trusting or reflecting launch credentials', async () => {
  const query = new URLSearchParams({ DOMAIN: 'aerosystems.bitrix24.ru', PROTOCOL: '1', LANG: 'ru', APP_SID: 'SYNTHETIC-APP-SID' });
  const getResponse = await nativeFetch(`${apiUrl}/?${query}`);
  assert.equal(getResponse.status, 200);
  assert.match(getResponse.headers.get('content-type') ?? '', /text\/html/i);
  const getHtml = await getResponse.text();

  const postResponse = await nativeFetch(`${apiUrl}/?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ AUTH_ID: 'SYNTHETIC-AUTH-ID', APPLICATION_TOKEN: 'SYNTHETIC-APPLICATION-TOKEN' }),
  });
  assert.equal(postResponse.status, 200);
  assert.match(postResponse.headers.get('content-type') ?? '', /text\/html/i);
  const postHtml = await postResponse.text();
  assert.equal(postHtml, getHtml);
  for (const syntheticCredential of ['SYNTHETIC-APP-SID', 'SYNTHETIC-AUTH-ID', 'SYNTHETIC-APPLICATION-TOKEN']) {
    assert.equal(postHtml.includes(syntheticCredential), false);
  }
});

test('launch page does not grant anonymous access to privileged APIs and health remains available', async () => {
  const adminResponse = await nativeFetch(`${apiUrl}/api/admin/trial-actions`);
  assert.equal(adminResponse.status, 403);
  const healthResponse = await nativeFetch(`${apiUrl}/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: 'ok' });
});
