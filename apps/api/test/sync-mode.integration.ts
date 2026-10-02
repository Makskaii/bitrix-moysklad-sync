import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AdminController } from '../src/admin/admin.controller';
import { AdminAccessGuard } from '../src/admin/admin-access.guard';
import { SyncModeController } from '../src/admin/sync-mode.controller';
import { ContactSyncStatusController } from '../src/admin/contact-sync-status.controller';
import { DatabaseService } from '../src/database.service';
import { SyncModeService } from '../src/sync-mode.service';
import { SyncRecoveryService } from '../src/sync-recovery.service';
import { ContactSyncProcessor, ContactSyncStatusReader } from '../src/contact-sync.service';
import { EventsController, EventIntakeService } from '../src/events.controller';

@Module({
  controllers: [AdminController, ContactSyncStatusController, SyncModeController, EventsController],
  providers: [
    DatabaseService,
    AdminAccessGuard,
    SyncModeService,
    SyncRecoveryService,
    ContactSyncProcessor,
    ContactSyncStatusReader,
    EventIntakeService,
  ],
})
class SyncModeTestModule {}

const nativeFetch = globalThis.fetch;
let app: INestApplication;
let apiUrl: string;
let externalApiCalls = 0;
const recoveryPageRequests: string[] = [];
let failResumeMoyskladSecondPage = false;

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to an isolated PostgreSQL test database');
  process.env.SYNC_MODE = 'apply';
  process.env.SYNC_STATE = 'on';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'bitrix-test-application-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://b24-fake.invalid/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://ms-fake.invalid/api/';
  process.env.MOYSKLAD_API_TOKEN = 'moysklad-test-token';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://aerosystems.bitrix24.ru/rest/user.admin.json')) {
      return Response.json({ result: new URLSearchParams(String(init?.body ?? '')).get('auth') === 'admin-test-token' });
    }
    if (url.startsWith('https://b24-fake.invalid/rest/') || url.startsWith('https://ms-fake.invalid/api/')) {
      if (url.includes('/rest/crm.contact.list.json')) {
        const form = new URLSearchParams(String(init?.body ?? ''));
        recoveryPageRequests.push(`${url}?${form.toString()}`);
        const start = Number(form.get('start') ?? 0);
        return Response.json(start === 0
          ? { result: [{ ID: 'resume-contact-1' }], next: 50 }
          : { result: [{ ID: 'resume-contact-2' }] });
      }
      if (url.includes('/api/entity/counterparty?')) {
        recoveryPageRequests.push(url);
        const requestUrl = new URL(url);
        const offset = Number(requestUrl.searchParams.get('offset') ?? 0);
        if (failResumeMoyskladSecondPage && offset === 1_000) return new Response('', { status: 503 });
        return Response.json(offset === 0
          ? { rows: Array.from({ length: 1_000 }, (_, index) => ({ id: `resume-counterparty-${index}` })), meta: { size: 1_001, limit: 1_000, offset: 0 } }
          : { rows: [{ id: 'resume-counterparty-1000' }], meta: { size: 1_001, limit: 1_000, offset: 1_000 } });
      }
      externalApiCalls++;
      return Response.json({ result: { ID: 'external-contact', EMAIL: [], DATE_MODIFY: '2026-10-01T00:00:00+03:00' }, email: 'old@example.test', updated: '2026-10-01 00:00:00.000' });
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
  app = await NestFactory.create(SyncModeTestModule, { logger: false });
  await app.get(DatabaseService).syncSetting.deleteMany();
  await app.get(DatabaseService).syncDirectionSetting.deleteMany();
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
});

after(async () => {
  globalThis.fetch = nativeFetch;
  await app?.close();
});

test('administrator reads Off as the persisted initial service mode', async () => {
  const response = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    headers: { authorization: 'Bearer admin-test-token' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { mode: 'off' });
});

test('administrator can persist Pause through the settings API', async () => {
  const response = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ mode: 'pause' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { mode: 'pause' });

  const read = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    headers: { authorization: 'Bearer admin-test-token' },
  });
  assert.deepEqual(await read.json(), { mode: 'pause' });
  await app.close();
  app = await NestFactory.create(SyncModeTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  const afterRestart = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    headers: { authorization: 'Bearer admin-test-token' },
  });
  assert.deepEqual(await afterRestart.json(), { mode: 'pause' });
});

test('administrator must explicitly confirm risky global mode transitions', async () => {
  await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'off', confirmed: true }),
  });
  const unconfirmed = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'on' }),
  });
  assert.equal(unconfirmed.status, 409);
  const unchanged = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    headers: { authorization: 'Bearer admin-test-token' },
  });
  assert.deepEqual(await unchanged.json(), { mode: 'off' });
});

test('settings list v1 exchange pairs and identifies the partial contact email capability', async () => {
  const restoreDirections = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/contacts-companies`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ bitrix24ToMoysklad: true, moyskladToBitrix24: true }),
  });
  assert.equal(restoreDirections.status, 200);
  const response = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities`, {
    headers: { authorization: 'Bearer admin-test-token' },
  });
  assert.equal(response.status, 200);
  const entities = await response.json() as Array<{
    key: string;
    ready: boolean;
    directionScope: string | null;
    bitrix24ToMoysklad: boolean;
    moyskladToBitrix24: boolean;
  }>;
  assert.deepEqual(entities.map(({ key }) => key), [
    'contacts-companies',
    'deals-orders',
    'invoices',
    'products-variations',
    'service-dictionary',
    'reference-mappings',
  ]);
  assert.deepEqual({
    key: entities[0].key,
    ready: entities[0].ready,
    directionScope: entities[0].directionScope,
    bitrix24ToMoysklad: entities[0].bitrix24ToMoysklad,
    moyskladToBitrix24: entities[0].moyskladToBitrix24,
  }, {
    key: 'contacts-companies',
    ready: true,
    directionScope: 'CONTACT_EMAIL_EXISTING_PAIRS',
    bitrix24ToMoysklad: true,
    moyskladToBitrix24: true,
  });
  assert.ok(entities.slice(1).every(({ ready, bitrix24ToMoysklad, moyskladToBitrix24 }) =>
    !ready && !bitrix24ToMoysklad && !moyskladToBitrix24));
});

test('administrator cannot enable an entity whose exchange is not ready', async () => {
  const response = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/deals-orders`, {
    method: 'PATCH',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ bitrix24ToMoysklad: true, moyskladToBitrix24: true }),
  });
  assert.equal(response.status, 409);
});

test('a disabled direction is skipped once and does not replay after it is re-enabled', async () => {
  externalApiCalls = 0;
  await app.get(DatabaseService).inboundEvent.updateMany({
    where: { status: { in: ['RECEIVED', 'RETRYABLE_FAILURE'] } },
    data: { status: 'MANUAL_REVIEW' },
  });
  const token = { authorization: 'Bearer admin-test-token' };
  const changeMode = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH',
    headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'on', confirmed: true }),
  });
  assert.equal(changeMode.status, 200);
  const disableDirection = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/contacts-companies`, {
    method: 'PATCH',
    headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ bitrix24ToMoysklad: false, moyskladToBitrix24: true }),
  });
  assert.equal(disableDirection.status, 200);

  const contactId = `skipped-contact-${randomUUID()}`;
  const event = await nativeFetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: contactId } },
      auth: { application_token: 'bitrix-test-application-token' },
    }),
  });
  assert.equal(event.status, 200);
  const { eventId } = await event.json() as { eventId: string };
  const getStatus = () => nativeFetch(`${apiUrl}/api/admin/contact-sync/events/${eventId}`, { headers: token });
  const skipped = await getStatus();
  assert.equal((await skipped.json() as { status: string }).status, 'SKIPPED_DIRECTION_DISABLED');

  const enableDirection = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/contacts-companies`, {
    method: 'PATCH',
    headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ bitrix24ToMoysklad: true, moyskladToBitrix24: true }),
  });
  assert.equal(enableDirection.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const afterEnable = await getStatus();
  assert.equal((await afterEnable.json() as { status: string }).status, 'SKIPPED_DIRECTION_DISABLED');
  await app.close();
  app = await NestFactory.create(SyncModeTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const afterRestart = await nativeFetch(`${apiUrl}/api/admin/contact-sync/events/${eventId}`, {
    headers: { authorization: 'Bearer admin-test-token' },
  });
  assert.equal((await afterRestart.json() as { status: string }).status, 'SKIPPED_DIRECTION_DISABLED');
  assert.equal(externalApiCalls, 0);
});

test('Pause stores a contact event without calling either external API', async () => {
  externalApiCalls = 0;
  const pause = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'pause' }),
  });
  assert.equal(pause.status, 200);
  const testId = randomUUID();
  const bitrixContactId = `pause-contact-${testId}`;
  await app.get(DatabaseService).contactPair.create({
    data: {
      bitrix24ContactId: bitrixContactId,
      moyskladCounterpartyId: `pause-counterparty-${testId}`,
      snapshot: {
        create: {
          bitrix24Email: 'old@example.test',
          moyskladEmail: 'old@example.test',
          bitrix24UpdatedAt: new Date('2026-10-01T00:00:00.000Z'),
          moyskladUpdatedAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      },
    },
  });
  const event = await nativeFetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: bitrixContactId } },
      auth: { application_token: 'bitrix-test-application-token' },
    }),
  });
  assert.equal(event.status, 200);
  const { eventId } = await event.json() as { eventId: string };
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  const status = await nativeFetch(`${apiUrl}/api/admin/contact-sync/events/${eventId}`, {
    headers: { authorization: 'Bearer admin-test-token' },
  });
  assert.equal(status.status, 200);
  assert.equal((await status.json() as { status: string }).status, 'RECEIVED');
  assert.equal(externalApiCalls, 0);
});

test('events received during Pause stay skipped if their direction is disabled before On resumes', async () => {
  const token = { authorization: 'Bearer admin-test-token' };
  const contactId = `paused-direction-${randomUUID()}`;
  const received = await nativeFetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMCONTACTUPDATE', data: { FIELDS: { ID: contactId } }, auth: { application_token: 'bitrix-test-application-token' } }),
  });
  const { eventId } = await received.json() as { eventId: string };
  const disable = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/contacts-companies`, {
    method: 'PATCH', headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ bitrix24ToMoysklad: false, moyskladToBitrix24: true }),
  });
  assert.equal(disable.status, 200);
  const on = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH', headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'on', confirmed: true }),
  });
  assert.equal(on.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const status = await nativeFetch(`${apiUrl}/api/admin/contact-sync/events/${eventId}`, { headers: token });
  assert.equal((await status.json() as { status: string }).status, 'SKIPPED_DIRECTION_DISABLED');
  assert.equal(externalApiCalls, 0);
});

test('On resumes Off with a bounded changed-since scan and completes every provider page', async () => {
  const token = { authorization: 'Bearer admin-test-token' };
  recoveryPageRequests.length = 0;
  await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/contacts-companies`, {
    method: 'PATCH', headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ bitrix24ToMoysklad: true, moyskladToBitrix24: true }),
  });
  await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH', headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'off', confirmed: true }),
  });
  const on = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH', headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'on', confirmed: true }),
  });
  assert.equal(on.status, 200);
  const deadline = Date.now() + 4_000;
  let recovery: Response;
  do {
    recovery = await nativeFetch(`${apiUrl}/api/admin/sync-mode/recovery`, { headers: token });
    if (recovery.status === 200 && (await recovery.clone().json() as { status: string }).status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  assert.equal(recovery.status, 200);
  assert.equal((await recovery.json() as { status: string }).status, 'complete');
  assert.equal(recoveryPageRequests.filter((request) => request.includes('crm.contact.list.json')).length, 2);
  assert.equal(recoveryPageRequests.filter((request) => request.includes('/entity/counterparty?')).length, 2);
  assert.ok(recoveryPageRequests.some((request) => request.includes('filter%5B%3E%3DDATE_MODIFY%5D')));
  assert.ok(recoveryPageRequests.some((request) => request.includes('filter%5B%3C%3DDATE_MODIFY%5D')));
  assert.ok(recoveryPageRequests.some((request) => request.includes('updated%3E%3D')));
  assert.ok(recoveryPageRequests.some((request) => request.includes('updated%3C%3D')));
});

test('failed Off recovery keeps the incomplete page cursor and retry resumes there', async () => {
  const token = { authorization: 'Bearer admin-test-token' };
  recoveryPageRequests.length = 0;
  failResumeMoyskladSecondPage = true;
  await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH', headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'off', confirmed: true }),
  });
  await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH', headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'on', confirmed: true }),
  });
  const deadline = Date.now() + 4_000;
  let status = { status: '' };
  while (Date.now() < deadline) {
    const response = await nativeFetch(`${apiUrl}/api/admin/sync-mode/recovery`, { headers: token });
    status = await response.json() as { status: string };
    if (status.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(status.status, 'failed');
  const failed = await nativeFetch(`${apiUrl}/api/admin/sync-mode/recovery`, { headers: token }).then((response) => response.json()) as { provider: string; moyskladOffset: number };
  assert.equal(failed.provider, 'MOYSKLAD');
  assert.equal(failed.moyskladOffset, 1_000);

  await app.close();
  app = await NestFactory.create(SyncModeTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  let restartedFailure = { status: '', provider: '', moyskladOffset: 0 };
  const restartDeadline = Date.now() + 4_000;
  while (Date.now() < restartDeadline) {
    restartedFailure = await nativeFetch(`${apiUrl}/api/admin/sync-mode/recovery`, { headers: token }).then((response) => response.json()) as typeof restartedFailure;
    const failedPageRetries = recoveryPageRequests.filter((request) =>
      request.includes('/entity/counterparty?') && new URL(request).searchParams.get('offset') === '1000').length;
    if (restartedFailure.status === 'failed' && failedPageRetries >= 2) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      restartedFailure = await nativeFetch(`${apiUrl}/api/admin/sync-mode/recovery`, { headers: token }).then((response) => response.json()) as typeof restartedFailure;
      if (restartedFailure.status === 'failed') break;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(restartedFailure.status, 'failed');
  assert.equal(restartedFailure.provider, 'MOYSKLAD');
  assert.equal(restartedFailure.moyskladOffset, 1_000);

  failResumeMoyskladSecondPage = false;
  await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH', headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'on', confirmed: true }),
  });
  const retryDeadline = Date.now() + 4_000;
  while (Date.now() < retryDeadline) {
    const response = await nativeFetch(`${apiUrl}/api/admin/sync-mode/recovery`, { headers: token });
    status = await response.json() as { status: string };
    if (status.status === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(status.status, 'complete');
  const offsets = recoveryPageRequests.filter((request) => request.includes('/entity/counterparty?')).map((request) => Number(new URL(request).searchParams.get('offset')));
  assert.equal(offsets[0], 0);
  assert.equal(offsets.filter((offset) => offset === 0).length, 1, 'retry must not restart the completed first page');
  assert.ok(offsets.length >= 3 && offsets.slice(1).every((offset) => offset === 1_000), 'retry must remain on the incomplete second page until completion');
});

test('Off stops webhook intake while the administrator settings remain available', async () => {
  const changed = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ mode: 'off', confirmed: true }),
  });
  assert.equal(changed.status, 200);

  const event = await nativeFetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: 'contact-off-test' } },
      auth: { application_token: 'bitrix-test-application-token' },
    }),
  });
  assert.equal(event.status, 410);

  const adminRead = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    headers: { authorization: 'Bearer admin-test-token' },
  });
  assert.deepEqual(await adminRead.json(), { mode: 'off' });
});
