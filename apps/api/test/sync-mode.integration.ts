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
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { ReadOnlyFieldDataProvider } from '../src/field-settings/read-only-field-data.provider';
import { SyncRecoveryService } from '../src/sync-recovery.service';
import { ContactSyncProcessor, ContactSyncStatusReader } from '../src/contact-sync.service';
import { EventsController, EventIntakeService } from '../src/events.controller';

@Module({
  controllers: [AdminController, ContactSyncStatusController, SyncModeController, EventsController],
  providers: [
    DatabaseService,
    AdminAccessGuard,
    {
      provide: SyncModeService,
      useFactory: (database: DatabaseService) => new SyncModeService(
        database,
        undefined,
        undefined,
        { active: async () => activePreflightSettings } as unknown as FieldSettingsService,
        {
          fieldCatalogs: async () => {
            if (pauseInvoiceCatalogRead) {
              invoiceCatalogReadStarted?.();
              await new Promise<void>((resolve) => { pauseInvoiceCatalogRead = resolve; });
            }
            return {};
          },
          referenceCatalogs: async () => ({ dealStages: { bitrix24: [], moysklad: [] }, currencies: { bitrix24: [], moysklad: [] } }),
          catalogs: async () => ({ units: { bitrix24: [], moysklad: [] }, productCatalogs: [] }),
          dealOrderCatalogs: async () => ({ stages: fakeDealStages, currencies: fakeDealCurrencies }),
          optionalDealOrderReferenceWarnings: async () => fakeOptionalReferenceWarnings,
          verifyRequiredDealOrderReferences: async () => { fakeRequiredReferenceReads++; return []; },
        } as unknown as ReadOnlyFieldDataProvider,
      ),
      inject: [DatabaseService],
    },
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
let raceContactId: string | null = null;
let raceCounterpartyId: string | null = null;
let raceReadCount = 0;
let raceReadBarrier: Promise<void> = Promise.resolve();
let releaseRaceReads: (() => void) | null = null;
let raceReadsFinished: (() => void) | null = null;
let raceReadCompletion = Promise.resolve();
let raceExternalWrites = 0;
let activePreflightSettings: { version: number; config: Record<string, unknown> } | null = null;
let fakeDealStages: string[] = [];
let fakeDealCurrencies: string[] = [];
let fakeOptionalReferenceWarnings: string[] = [];
let fakeRequiredReferenceReads = 0;
let pauseInvoiceCatalogRead: (() => void) | null = null;
let invoiceCatalogReadStarted: (() => void) | null = null;

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to an isolated PostgreSQL test database');
  process.env.SYNC_MODE = 'apply';
  process.env.SYNC_STATE = 'on';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'bitrix-test-application-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://b24-fake.invalid/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://ms-fake.invalid/api/';
  process.env.MOYSKLAD_API_TOKEN = 'moysklad-test-token';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'bitrix-test-application-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'moysklad-test-webhook-secret';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://aerosystems.bitrix24.ru/rest/user.admin.json')) {
      return Response.json({ result: new URLSearchParams(String(init?.body ?? '')).get('auth') === 'admin-test-token' });
    }
    if (url.startsWith('https://b24-fake.invalid/rest/') || url.startsWith('https://ms-fake.invalid/api/')) {
      if (raceContactId && url.includes('/rest/crm.contact.get.json')) {
        const contactId = new URLSearchParams(String(init?.body ?? '')).get('id');
        if (contactId === raceContactId) {
          raceReadCount++;
          if (raceReadCount === 2) {
            await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
              method: 'PATCH',
              headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
              body: JSON.stringify({ mode: 'pause', confirmed: true }),
            });
            releaseRaceReads?.();
            raceReadsFinished?.();
          } else {
            await raceReadBarrier;
          }
          return Response.json({ result: {
            ID: raceContactId,
            EMAIL: [{ ID: 'email-race', VALUE: 'new@example.test', VALUE_TYPE: 'WORK' }],
            DATE_MODIFY: '2026-10-02T00:00:00+03:00',
          } });
        }
      }
      if (raceCounterpartyId && url.endsWith(`/api/entity/counterparty/${raceCounterpartyId}`)) {
        if (init?.method === 'PUT') {
          raceExternalWrites++;
          return Response.json({ id: raceCounterpartyId, email: 'new@example.test', updated: '2026-10-02 00:00:00.000' });
        }
        raceReadCount++;
        if (raceReadCount === 2) {
          await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
            method: 'PATCH',
            headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'pause', confirmed: true }),
          });
          releaseRaceReads?.();
          raceReadsFinished?.();
        } else {
          await raceReadBarrier;
        }
        return Response.json({ id: raceCounterpartyId, email: 'old@example.test', updated: '2026-10-01 00:00:00.000' });
      }
      if (raceContactId && url.includes('/rest/crm.contact.update.json')) raceExternalWrites++;
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
  await app.get(DatabaseService).fieldSettingsState.deleteMany();
  await app.get(DatabaseService).fieldSettingsVersion.deleteMany();
  await app.get(DatabaseService).syncSetting.create({ data: { id: 'global' } });
  await app.get(DatabaseService).syncDirectionSetting.create({ data: { entityKey: 'contacts-companies' } });
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

test('fresh global and direction settings tolerate concurrent public reads', async () => {
  await app.get(DatabaseService).syncSetting.deleteMany();
  await app.get(DatabaseService).syncDirectionSetting.deleteMany();
  const token = { authorization: 'Bearer admin-test-token' };
  const responses = await Promise.all(Array.from({ length: 24 }, (_, index) => nativeFetch(
    `${apiUrl}/api/admin/sync-mode${index % 2 ? '/entities' : ''}`,
    { headers: token },
  )));
  assert.ok(responses.every((response) => response.status === 200));
  const mode = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, { headers: token });
  assert.deepEqual(await mode.json(), { mode: 'off' });
});

test('administrator can persist Pause through the settings API', async () => {
  const response = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ mode: 'pause', confirmed: true }),
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
  const unconfirmedPause = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'pause' }),
  });
  assert.equal(unconfirmedPause.status, 409);
  assert.deepEqual(await (await nativeFetch(`${apiUrl}/api/admin/sync-mode`, { headers: { authorization: 'Bearer admin-test-token' } })).json(), { mode: 'off' });
});

test('settings list v1 exchange pairs and identifies the partial contact email capability', async () => {
  const restoreDirections = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/contacts-companies`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ bitrix24ToMoysklad: true, moyskladToBitrix24: true, confirmed: true }),
  });
  assert.equal(restoreDirections.status, 200);
  const response = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities`, {
    headers: { authorization: 'Bearer admin-test-token' },
  });
  assert.equal(response.status, 200);
  const entities = await response.json() as Array<{
    key: string;
    ready: boolean;
    implementation: string;
    supportedDirections: string[];
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
  ]);
  assert.equal(entities.length, 5);
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
  assert.deepEqual(entities.slice(1).map(({ key, ready, implementation, supportedDirections, bitrix24ToMoysklad, moyskladToBitrix24 }) => ({
    key, ready, implementation, supportedDirections, bitrix24ToMoysklad, moyskladToBitrix24,
  })), [
    { key: 'deals-orders', ready: true, implementation: 'implemented', supportedDirections: ['bitrix24ToMoysklad', 'moyskladToBitrix24'], bitrix24ToMoysklad: false, moyskladToBitrix24: false },
    { key: 'invoices', ready: true, implementation: 'implemented', supportedDirections: ['bitrix24ToMoysklad', 'moyskladToBitrix24'], bitrix24ToMoysklad: false, moyskladToBitrix24: false },
    { key: 'products-variations', ready: true, implementation: 'implemented', supportedDirections: ['moyskladToBitrix24'], bitrix24ToMoysklad: false, moyskladToBitrix24: false },
    { key: 'service-dictionary', ready: false, implementation: 'not_implemented', supportedDirections: [], bitrix24ToMoysklad: false, moyskladToBitrix24: false },
  ]);
  const unconfirmedDirection = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/contacts-companies`, {
    method: 'PATCH', headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ bitrix24ToMoysklad: false, moyskladToBitrix24: true }),
  });
  assert.equal(unconfirmedDirection.status, 409);
  const unchanged = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities`, { headers: { authorization: 'Bearer admin-test-token' } });
  assert.equal((await unchanged.json() as typeof entities)[0].bitrix24ToMoysklad, true);
});

test('the HTTP preflight blocks incomplete scopes, then permits only after the same gate is satisfied', async () => {
  activePreflightSettings = null;
  const token = { authorization: 'Bearer admin-test-token' };
  const preview = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/invoices/preflight?direction=bitrix24ToMoysklad`, { headers: token });
  assert.equal(preview.status, 200);
  const blockedReport = await preview.json() as { canEnable: boolean; blockers: Array<{ code: string }> };
  assert.equal(blockedReport.canEnable, false);
  assert.ok(blockedReport.blockers.some(({ code }) => code === 'FIELD_SETTINGS_UNAVAILABLE'));
  const blockedPatch = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/invoices`, {
    method: 'PATCH',
    headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ bitrix24ToMoysklad: true, moyskladToBitrix24: false, confirmed: true }),
  });
  assert.equal(blockedPatch.status, 409);
  assert.equal((await app.get(DatabaseService).syncDirectionSetting.findUnique({ where: { entityKey: 'invoices' } }))?.bitrix24ToMoysklad, false);

  activePreflightSettings = { version: 7, config: { rules: [], references: {} } };
  const db = app.get(DatabaseService);
  await db.fieldSettingsVersion.create({ data: { version: 7, config: activePreflightSettings.config as never } });
  await db.fieldSettingsState.create({ data: { id: 'global', version: 7 } });
  const readyPreview = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/invoices/preflight?direction=bitrix24ToMoysklad`, { headers: token });
  const readyReport = await readyPreview.json() as { canEnable: boolean; settingsVersion: number | null };
  assert.equal(readyReport.canEnable, true);
  assert.equal(readyReport.settingsVersion, 7);
  const enabled = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/invoices`, {
    method: 'PATCH',
    headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ bitrix24ToMoysklad: true, moyskladToBitrix24: false, confirmed: true }),
  });
  assert.equal(enabled.status, 200);
  assert.deepEqual(await enabled.json(), { key: 'invoices', bitrix24ToMoysklad: true, moyskladToBitrix24: false });

  await db.fieldSettingsVersion.create({ data: { version: 8, config: activePreflightSettings.config as never } });
  let releaseProviderRead!: () => void;
  let notifyProviderReadStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => { notifyProviderReadStarted = resolve; });
  pauseInvoiceCatalogRead = releaseProviderRead = () => {};
  invoiceCatalogReadStarted = notifyProviderReadStarted;
  const staleEnable = nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/invoices`, {
    method: 'PATCH',
    headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ bitrix24ToMoysklad: true, moyskladToBitrix24: true, confirmed: true }),
  });
  await providerStarted;
  await db.fieldSettingsState.update({ where: { id: 'global' }, data: { version: 8 } });
  activePreflightSettings = { version: 8, config: { rules: [], references: {} } };
  pauseInvoiceCatalogRead?.();
  pauseInvoiceCatalogRead = null;
  invoiceCatalogReadStarted = null;
  const staleResponse = await staleEnable;
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json() as { message: string }).message, 'SYNC_PREFLIGHT_STALE');
  assert.equal((await db.syncDirectionSetting.findUnique({ where: { entityKey: 'invoices' } }))?.moyskladToBitrix24, false);
  const disabled = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/invoices`, {
    method: 'PATCH',
    headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ bitrix24ToMoysklad: false, moyskladToBitrix24: false, confirmed: true }),
  });
  assert.equal(disabled.status, 200);
  assert.deepEqual(await disabled.json(), { key: 'invoices', bitrix24ToMoysklad: false, moyskladToBitrix24: false });
});

test('reverse deal preflight validates MySklad-native references and tolerates failed optional endpoints', async () => {
  const stageId = 'ms-stage-9d3d2d0e';
  const currencyId = 'ms-currency-a30e9635';
  fakeDealStages = [stageId];
  fakeDealCurrencies = [currencyId];
  fakeOptionalReferenceWarnings = ['employees'];
  activePreflightSettings = {
    version: 8,
    config: {
      rules: [],
      references: { namedPairs: [
        { kind: 'dealStages', bitrix24Id: 'B24_STAGE', moyskladId: stageId, status: 'confirmed' },
        { kind: 'currencies', bitrix24Id: 'USD', moyskladId: currencyId, status: 'confirmed' },
      ] },
      dealOrderRuntime: {
        nativeOrderNumberingVerified: false,
        stages: [{ bitrix24StageId: 'B24_STAGE', moyskladId: stageId }],
        currencies: [{ bitrix24Code: 'USD', moyskladId: currencyId }],
      },
    },
  };
  const token = { authorization: 'Bearer admin-test-token' };
  const valid = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/deals-orders/preflight?direction=moyskladToBitrix24`, { headers: token });
  const validReport = await valid.json() as { canEnable: boolean; blockers: Array<{ code: string }>; warnings: Array<{ code: string }> };
  assert.equal(validReport.canEnable, true);
  assert.equal(validReport.blockers.length, 0);
  assert.ok(validReport.warnings.some(({ code }) => code === 'OPTIONAL_REFERENCE_UNAVAILABLE'));
  assert.equal(fakeRequiredReferenceReads, 0, 'reverse mapping must not read MySklad order-creation default IDs');

  fakeDealStages = ['unmapped-ms-stage'];
  const unmapped = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/deals-orders/preflight?direction=moyskladToBitrix24`, { headers: token });
  const unmappedReport = await unmapped.json() as { canEnable: boolean; blockers: Array<{ code: string }> };
  assert.equal(unmappedReport.canEnable, false);
  assert.ok(unmappedReport.blockers.some(({ code }) => code === 'STAGE_MAPPING_UNCONFIRMED'));

  fakeDealStages = [];
  fakeDealCurrencies = [];
  const requiredUnavailable = await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/deals-orders/preflight?direction=moyskladToBitrix24`, { headers: token });
  const requiredReport = await requiredUnavailable.json() as { canEnable: boolean; blockers: Array<{ code: string }> };
  assert.equal(requiredReport.canEnable, false);
  assert.ok(requiredReport.blockers.some(({ code }) => code === 'DEAL_STAGES_UNAVAILABLE'));
  fakeOptionalReferenceWarnings = [];
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
    body: JSON.stringify({ bitrix24ToMoysklad: false, moyskladToBitrix24: true, confirmed: true }),
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
    body: JSON.stringify({ bitrix24ToMoysklad: true, moyskladToBitrix24: true, confirmed: true }),
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
    body: JSON.stringify({ mode: 'pause', confirmed: true }),
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
    body: JSON.stringify({ bitrix24ToMoysklad: false, moyskladToBitrix24: true, confirmed: true }),
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

test('Pause during external reads defers a contact event before any outbound write', async () => {
  const token = { authorization: 'Bearer admin-test-token' };
  await nativeFetch(`${apiUrl}/api/admin/sync-mode/entities/contacts-companies`, {
    method: 'PATCH', headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ bitrix24ToMoysklad: true, moyskladToBitrix24: true, confirmed: true }),
  });
  await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH', headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'on', confirmed: true }),
  });
  const testId = randomUUID();
  raceContactId = `pause-race-contact-${testId}`;
  raceCounterpartyId = `pause-race-counterparty-${testId}`;
  raceReadCount = 0;
  raceExternalWrites = 0;
  raceReadBarrier = new Promise<void>((resolve) => { releaseRaceReads = resolve; });
  raceReadCompletion = new Promise<void>((resolve) => { raceReadsFinished = resolve; });
  await app.get(DatabaseService).contactPair.create({
    data: {
      bitrix24ContactId: raceContactId,
      moyskladCounterpartyId: raceCounterpartyId,
      snapshot: { create: {
        bitrix24Email: 'old@example.test',
        moyskladEmail: 'old@example.test',
        bitrix24UpdatedAt: new Date('2026-10-01T00:00:00.000Z'),
        moyskladUpdatedAt: new Date('2026-10-01T00:00:00.000Z'),
      } },
    },
  });
  const received = await nativeFetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE',
      data: { FIELDS: { ID: raceContactId } },
      auth: { application_token: 'bitrix-test-application-token' },
    }),
  });
  assert.equal(received.status, 200);
  const { eventId } = await received.json() as { eventId: string };
  let raceTimeout: NodeJS.Timeout | undefined;
  await Promise.race([
    raceReadCompletion,
    new Promise<never>((_, reject) => { raceTimeout = setTimeout(() => reject(new Error('Timed out waiting for both fake external reads')), 4_000); }),
  ]);
  if (raceTimeout) clearTimeout(raceTimeout);
  raceReadBarrier = Promise.resolve();

  let eventState = { status: '', attempts: 0 };
  for (let attempt = 0; attempt < 100; attempt++) {
    const statusResponse = await nativeFetch(`${apiUrl}/api/admin/contact-sync/events/${eventId}`, { headers: token });
    eventState = await statusResponse.json() as typeof eventState;
    if (eventState.attempts > 0 && eventState.status !== 'PROCESSING') break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(await nativeFetch(`${apiUrl}/api/admin/sync-mode`, { headers: token }).then((response) => response.json()), { mode: 'pause' });
  assert.equal(eventState.status, 'RECEIVED');
  assert.equal(eventState.attempts, 1);
  assert.equal(raceExternalWrites, 0);
  raceContactId = null;
  raceCounterpartyId = null;
});

test('On does not scan or replay changes missed during Off', async () => {
  const token = { authorization: 'Bearer admin-test-token' };
  recoveryPageRequests.length = 0;
  await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH', headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'off', confirmed: true }),
  });
  const on = await nativeFetch(`${apiUrl}/api/admin/sync-mode`, {
    method: 'PATCH', headers: { ...token, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'on', confirmed: true }),
  });
  assert.equal(on.status, 200);
  const recovery = await nativeFetch(`${apiUrl}/api/admin/sync-mode/recovery`, { headers: token }).then((response) => response.json()) as { status: string; error: string | null };
  assert.equal(recovery.status, 'skipped');
  assert.match(recovery.error ?? '', /not replayed/i);
  assert.equal(recoveryPageRequests.length, 0);
});

test('legacy pending Off recovery jobs are cancelled without provider requests after restart', async () => {
  const token = { authorization: 'Bearer admin-test-token' };
  recoveryPageRequests.length = 0;
  await app.close();
  app = await NestFactory.create(SyncModeTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const status = await nativeFetch(`${apiUrl}/api/admin/sync-mode/recovery`, { headers: token }).then((response) => response.json()) as { status: string };
  assert.equal(status.status, 'skipped');
  assert.equal(recoveryPageRequests.length, 0);
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
