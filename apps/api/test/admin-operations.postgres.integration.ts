import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { chromium } from '@playwright/test';
import { ContactSyncProcessor } from '../src/contact-sync.service';
import { LocalAdminPreviewModule } from '../src/admin/local-preview.module';
import { DatabaseService } from '../src/database.service';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { RetentionService } from '../src/retention.service';

const nativeFetch = globalThis.fetch;
const suffix = randomUUID();
const companyId = `issue59-company-${suffix}`;
const msCompanyId = `issue59-ms-company-${suffix}`;
const manualReviewEventId = `issue59-review-${suffix}`;
const openCaseEventId = `issue59-open-${suffix}`;
const eventIds: string[] = [];
const pairIds: string[] = [];
const oldEnv = new Map<string, string | undefined>();
let app: NestExpressApplication;
let apiUrl = '';
let database: DatabaseService;

async function fakeExternalResponse(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.hostname === 'aerosystems.bitrix24.ru' && url.pathname.endsWith('/user.admin.json')) {
    const body = new URLSearchParams(String(init?.body));
    return Response.json({ result: body.get('auth') === 'synthetic-admin-token' });
  }
  if (url.hostname === 'aerosystems.bitrix24.ru' && url.pathname.endsWith('/user.current.json')) {
    const body = new URLSearchParams(String(init?.body));
    return body.get('auth') === 'synthetic-admin-token' ? Response.json({ result: { ID: '59' } }) : Response.json({ error: 'ACCESS_DENIED' });
  }
  if (url.hostname === 'bitrix.fake' && url.pathname.endsWith('/crm.company.list.json')) {
    return Response.json({ result: [{ ID: companyId, UF_CRM_1719834633: msCompanyId, TITLE: 'Verified Bitrix Company' }], total: 1 });
  }
  if (url.hostname === 'bitrix.fake' && url.pathname.endsWith('/crm.contact.list.json')) return Response.json({ result: [], total: 0 });
  if (url.hostname === 'moysklad.fake' && url.pathname.endsWith('/entity/counterparty') && url.searchParams.has('offset')) {
    const offset = Number(url.searchParams.get('offset'));
    if (offset > 0) return Response.json({ rows: [], meta: { size: 1, offset, limit: 1000 } });
    return Response.json({ rows: [{ id: msCompanyId, name: 'Verified MoySklad Company', companyType: 'legal' }], meta: { size: 1, offset, limit: 1000 } });
  }
  if (url.hostname === 'moysklad.fake' && url.pathname.endsWith(`/entity/counterparty/${msCompanyId}/contactpersons`)) {
    return Response.json({ rows: [], meta: { size: 0, offset: Number(url.searchParams.get('offset')), limit: 1000 } });
  }
  return Response.json({ error: 'UNEXPECTED_FAKE_PROVIDER_REQUEST' }, { status: 404 });
}

async function startApp(localPreviewAccess = false) {
  app = await NestFactory.create<NestExpressApplication>(LocalAdminPreviewModule.register(undefined, undefined, localPreviewAccess), { logger: false });
  app.useStaticAssets(resolve(__dirname, '../../../../apps/web/dist'));
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  database = app.get(DatabaseService);
}

async function stopApp() {
  if (app) await app.close();
  app = undefined as unknown as NestExpressApplication;
}

async function adminFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('authorization', 'Bearer synthetic-admin-token');
  return nativeFetch(`${apiUrl}${path}`, { ...init, headers });
}

before(async () => {
  const dbUrl = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(process.env.ADMIN_OPERATIONS_POSTGRES_TEST_ISOLATED, '1', 'explicit isolated database test flag is required');
  assert.match(dbUrl.hostname, /^(localhost|127\.0\.0\.1)$/i, 'refusing to use a remote PostgreSQL host');
  assert.equal(dbUrl.searchParams.get('schema'), 'issue59_admin_api_test', 'refusing to use an unscoped schema');
  for (const key of ['DATABASE_URL', 'DRY_DATABASE_URL', 'SYNC_MODE', 'ADMIN_PREVIEW', 'SYNC_OPERATIONAL_RETENTION_DAYS', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN']) oldEnv.set(key, process.env[key]);
  process.env.SYNC_MODE = 'apply';
  process.env.ADMIN_PREVIEW = '0';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix.fake/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://moysklad.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-moysklad-token';
  globalThis.fetch = fakeExternalResponse as typeof fetch;
  await startApp();
  await database.adminAuditEntry.deleteMany({});
  await database.manualReviewCase.deleteMany({});
  await database.inboundEvent.deleteMany({});
  await database.entityPairBaseline.deleteMany({});
  await database.entityPair.deleteMany({});
  await database.clientInventoryObject.deleteMany({});
  await database.clientInventoryJob.deleteMany({});
  await database.apiAttempt.deleteMany({});
  await database.operationalLog.deleteMany({});
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { serviceMode: 'on' }, update: { serviceMode: 'on' } });
});

after(async () => {
  globalThis.fetch = nativeFetch;
  if (app) await stopApp();
  for (const [key, value] of oldEnv) value === undefined ? delete process.env[key] : process.env[key] = value;
});

test('real admin APIs authorize, inventory labels, review and audit survive a server restart', async () => {
  const missing = await nativeFetch(`${apiUrl}/api/admin/overview`);
  assert.equal(missing.status, 403);
  const denied = await nativeFetch(`${apiUrl}/api/admin/overview`, { headers: { authorization: 'Bearer synthetic-non-admin-token' } });
  assert.equal(denied.status, 403);
  const previewMode = await nativeFetch(`${apiUrl}/api/admin/preview-mode`);
  assert.deepEqual(await previewMode.json(), { enabled: false }, 'external callers cannot turn on local preview bypass');

  const overview = await adminFetch('/api/admin/overview');
  assert.equal(overview.status, 200, await overview.text());

  const startMapping = await adminFetch('/api/admin/client-mapping/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(startMapping.status, 201, await startMapping.text());
  let job = await (await adminFetch('/api/admin/client-mapping')).json() as { status: string };
  for (let i = 0; i < 160 && job.status !== 'complete'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    job = await (await adminFetch('/api/admin/client-mapping')).json() as { status: string };
  }
  assert.equal(job.status, 'complete');
  const unmatched = await (await adminFetch('/api/admin/client-mapping/unmatched?system=BITRIX24&entityType=COMPANY')).json() as { entries: unknown[] };
  assert.deepEqual(unmatched.entries, []);
  const pairsResponse = await adminFetch('/api/admin/pairs?entityType=COMPANY');
  const pairs = await pairsResponse.json() as Array<{ id: string; bitrix24Id: string; moyskladId: string; bitrix24Label: string; moyskladLabel: string; labelStatus: string }>;
  const clientPair = pairs.find((pair) => pair.bitrix24Id === companyId && pair.moyskladId === msCompanyId);
  assert.ok(clientPair);
  assert.equal(clientPair.bitrix24Label, 'Verified Bitrix Company');
  assert.equal(clientPair.moyskladLabel, 'Verified MoySklad Company');
  assert.equal(clientPair.labelStatus, 'CACHED_NAMES_AVAILABLE');
  pairIds.push(clientPair.id);

  const firstPair = await adminFetch('/api/admin/pairs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entityType: 'DEAL', bitrix24Id: `deal-b24-${suffix}`, moyskladId: `deal-ms-1-${suffix}` }) });
  assert.equal(firstPair.status, 201);
  const firstCreated = await firstPair.json() as { id: string };
  pairIds.push(firstCreated.id);
  const secondPair = await adminFetch('/api/admin/pairs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entityType: 'DEAL', bitrix24Id: `deal-b24-${suffix}`, moyskladId: `deal-ms-2-${suffix}`, replaceExisting: true }) });
  assert.equal(secondPair.status, 201);
  const secondCreated = await secondPair.json() as { id: string };
  pairIds.push(secondCreated.id);
  const thirdPair = await adminFetch('/api/admin/pairs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entityType: 'DEAL', bitrix24Id: `deal-b24-${suffix}`, moyskladId: `deal-ms-3-${suffix}`, replaceExisting: true }) });
  assert.equal(thirdPair.status, 201);
  const thirdCreated = await thirdPair.json() as { id: string };
  pairIds.push(thirdCreated.id);

  const event = await database.inboundEvent.create({ data: { id: manualReviewEventId, source: 'BITRIX24', deliveryKey: manualReviewEventId, eventType: 'ONCRMCONTACTUPDATE', externalEntityId: companyId, externalEntityType: 'COMPANY', payload: {}, status: 'MANUAL_REVIEW', attempts: 2 } });
  eventIds.push(event.id);
  await database.manualReviewCase.create({ data: { eventId: event.id, source: 'BITRIX24', externalEntityId: companyId, externalEntityType: 'COMPANY', reason: 'CRITICAL_FIELD_CLEAR_REVIEW', fieldTitle: 'name', previousValue: 'Verified name', proposedValue: 'Verified name' } });
  const openEvent = await database.inboundEvent.create({ data: { id: openCaseEventId, source: 'BITRIX24', deliveryKey: openCaseEventId, eventType: 'ONCRMCONTACTUPDATE', externalEntityId: companyId, externalEntityType: 'COMPANY', payload: {}, status: 'MANUAL_REVIEW', attempts: 1 } });
  eventIds.push(openEvent.id);
  await database.manualReviewCase.create({ data: { eventId: openEvent.id, source: 'BITRIX24', externalEntityId: companyId, externalEntityType: 'COMPANY', reason: 'OPEN_CASE_RESTART_TEST', fieldTitle: 'TITLE', previousValue: 'Previous title', proposedValue: 'Suggested restore title' } });

  const incidentPage = await (await adminFetch('/api/admin/monitoring/incidents?status=OPEN')).json() as { cases: Array<{ id: string; entityLabel: string | null; previousValue: unknown; proposedValue: unknown; valueStatus: string }> };
  const incident = incidentPage.cases.find((row) => row.id && row.previousValue === 'Verified name');
  assert.ok(incident);
  assert.equal(incident.entityLabel, 'Verified Bitrix Company');
  assert.equal(incident.proposedValue, 'Verified name');
  assert.equal(incident.valueStatus, 'AVAILABLE', JSON.stringify(incident));
  const resolved = await adminFetch(`/api/admin/monitoring/incidents/${encodeURIComponent(incident.id)}/resolve`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
  assert.equal(resolved.status, 200, await resolved.text());

  const auditPage = await (await adminFetch('/api/admin/audit?actorId=BITRIX24_USER%3A59&action=PAIR_REASSIGNED&limit=1')).json() as { entries: Array<{ id: string; before: Array<{ moyskladId: string }>; after: { moyskladId: string }; actorId: string }>; nextCursor: string | null };
  assert.equal(auditPage.entries.length, 1);
  assert.equal(auditPage.entries[0]?.actorId, 'BITRIX24_USER:59');
  assert.ok(auditPage.entries[0]?.before[0]?.moyskladId.endsWith('2-' + suffix));
  assert.ok(auditPage.entries[0]?.after.moyskladId.endsWith('3-' + suffix));
  assert.ok(auditPage.nextCursor);
  const nextPage = await (await adminFetch(`/api/admin/audit?actorId=BITRIX24_USER%3A59&action=PAIR_REASSIGNED&limit=1&cursor=${encodeURIComponent(auditPage.nextCursor)}`)).json() as { entries: Array<{ id: string }>; nextCursor: string | null };
  assert.equal(nextPage.entries.length, 1);
  assert.notEqual(nextPage.entries[0]?.id, auditPage.entries[0]?.id);

  const fieldSettings = app.get(FieldSettingsService);
  const previousSettings = await fieldSettings.active();
  const nextSettings = await fieldSettings.save(previousSettings.config, 'synthetic-admin-token');
  const recomputeEventId = `recompute-${suffix}`;
  eventIds.push(recomputeEventId);
  await database.inboundEvent.create({ data: { id: recomputeEventId, source: 'BITRIX24', deliveryKey: recomputeEventId, payload: {}, status: 'SUCCEEDED' } });
  await database.inboundEventSettings.create({ data: { eventId: recomputeEventId, settingsVersion: previousSettings.version } });
  await database.$executeRawUnsafe(`
    CREATE FUNCTION "reject_recompute_audit"() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."action" = 'EVENT_RECOMPUTE_REQUESTED' THEN RAISE EXCEPTION 'Synthetic audit storage failure'; END IF;
      RETURN NEW;
    END; $$
  `);
  await database.$executeRawUnsafe(`CREATE TRIGGER "reject_recompute_audit" BEFORE INSERT ON "AdminAuditEntry" FOR EACH ROW EXECUTE FUNCTION "reject_recompute_audit"()`);
  const processor = app.get(ContactSyncProcessor);
  const originalEnqueue = processor.enqueue.bind(processor);
  const enqueued: string[] = [];
  const enqueueObservations: Array<Promise<{ eventStatus: string | undefined; settingsVersion: number | undefined; auditCount: number }>> = [];
  (processor as unknown as { enqueue: (id: string) => void }).enqueue = (id) => {
    enqueued.push(id);
    enqueueObservations.push((async () => {
      const [eventRow, settingsRow, auditCount] = await Promise.all([
        database.inboundEvent.findUnique({ where: { id } }),
        database.inboundEventSettings.findUnique({ where: { eventId: id } }),
        database.adminAuditEntry.count({ where: { action: 'EVENT_RECOMPUTE_REQUESTED', targetId: id } }),
      ]);
      return { eventStatus: eventRow?.status, settingsVersion: settingsRow?.settingsVersion, auditCount };
    })());
  };
  let failedRecompute: Response;
  try {
    failedRecompute = await adminFetch(`/api/admin/monitoring/events/${recomputeEventId}/recompute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
    });
  } finally {
    await database.$executeRawUnsafe(`DROP TRIGGER "reject_recompute_audit" ON "AdminAuditEntry"`);
    await database.$executeRawUnsafe(`DROP FUNCTION "reject_recompute_audit"()`);
  }
  assert.equal(failedRecompute.status, 500);
  assert.deepEqual(enqueued, [], 'failed audit must not enqueue processing');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: recomputeEventId } })).status, 'SUCCEEDED', 'failed audit rolls back event status');
  assert.equal((await database.inboundEventSettings.findUniqueOrThrow({ where: { eventId: recomputeEventId } })).settingsVersion, previousSettings.version, 'failed audit rolls back event settings repin');
  const successfulRecompute = await adminFetch(`/api/admin/monitoring/events/${recomputeEventId}/recompute`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(successfulRecompute.status, 201);
  assert.deepEqual(enqueued, [recomputeEventId], 'enqueue occurs once after a successful commit');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: recomputeEventId } })).status, 'RECEIVED');
  assert.equal((await database.inboundEventSettings.findUniqueOrThrow({ where: { eventId: recomputeEventId } })).settingsVersion, nextSettings.version);
  assert.equal(await database.adminAuditEntry.count({ where: { action: 'EVENT_RECOMPUTE_REQUESTED', targetId: recomputeEventId } }), 1);
  assert.deepEqual(await enqueueObservations[0], { eventStatus: 'RECEIVED', settingsVersion: nextSettings.version, auditCount: 1 }, 'the enqueue hook observes both event changes and audit already committed');
  (processor as unknown as { enqueue: typeof processor.enqueue }).enqueue = originalEnqueue;

  const baselineEvent = await database.inboundEvent.create({ data: { id: `baseline-${suffix}`, source: 'BITRIX24', deliveryKey: `baseline-${suffix}`, payload: {}, status: 'SUCCEEDED' } });
  eventIds.push(baselineEvent.id);
  await database.entityPairBaseline.create({ data: { pairId: clientPair.id, eventId: baselineEvent.id, settingsVersion: 1, bitrix24Values: { TITLE: 'Verified Bitrix Company' }, moyskladValues: { name: 'Verified MoySklad Company' } } });

  const retainedCaseId = incident.id;
  await stopApp();
  await startApp();
  const afterRestart = await (await adminFetch('/api/admin/monitoring/incidents?status=OPEN')).json() as { cases: Array<{ id: string; eventId: string; status: string }> };
  assert.ok(afterRestart.cases.some((row) => row.eventId === openCaseEventId && row.status === 'OPEN'));
  const auditAfterRestart = await (await adminFetch(`/api/admin/audit?actorId=BITRIX24_USER%3A59&action=MANUAL_REVIEW_RESOLVED`)).json() as { entries: Array<{ targetId: string }> };
  assert.ok(auditAfterRestart.entries.some((row) => row.targetId === retainedCaseId));
  assert.equal((await database.entityPairBaseline.findUnique({ where: { pairId: clientPair.id } }))?.eventId, baselineEvent.id);

  await stopApp();
  process.env.ADMIN_PREVIEW = '1';
  await startApp(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageResponse = await page.goto(apiUrl);
    await page.getByRole('heading', { name: 'Администрирование обмена' }).waitFor({ timeout: 5_000 }).catch(() => undefined);
    assert.ok(await page.getByRole('heading', { name: 'Администрирование обмена' }).count(), `UI failed to render: HTTP ${pageResponse?.status()} ${await page.locator('body').innerText()}`);
    await page.getByRole('button', { name: 'Связи записей' }).click();
    await page.getByText('Verified Bitrix Company').waitFor();
    await page.getByText('Verified MoySklad Company').waitFor();
    await page.getByRole('button', { name: 'Ручная проверка' }).click();
    await page.getByText('Previous title').waitFor();
    await page.getByText('Suggested restore title').waitFor();
    await page.getByRole('button', { name: 'Очередь и попытки' }).click();
    await page.getByText('MANUAL_REVIEW').first().waitFor();
    await page.getByRole('button', { name: 'Логи' }).click();
    await page.getByText('PAIR_REASSIGNED').first().waitFor();
  } finally {
    await browser.close();
    process.env.ADMIN_PREVIEW = '0';
  }

  await assertRetentionBoundaries(database, clientPair.id);
});

async function assertRetentionBoundaries(db: DatabaseService, activePairId: string) {
  const now = new Date();
  const makeEvent = (id: string, ageDays: number, status = 'SUCCEEDED') => db.inboundEvent.create({ data: {
    id, source: 'TEST', deliveryKey: id, payload: {}, status, receivedAt: new Date(now.getTime() - ageDays * 86_400_000),
  } });
  const oldEvent = await makeEvent(`old-event-${suffix}`, 31);
  const oldOpenEvent = await makeEvent(`open-event-${suffix}`, 400, 'MANUAL_REVIEW');
  const dryOldEvent = await makeEvent(`dry-old-event-${suffix}`, 8);
  await db.manualReviewCase.create({ data: { eventId: oldOpenEvent.id, source: 'TEST', reason: 'OPEN_PRESERVED', openedAt: new Date(now.getTime() - 400 * 86_400_000) } });
  const resolvedId = `resolved-case-${suffix}`;
  await db.manualReviewCase.create({ data: { eventId: resolvedId, source: 'TEST', reason: 'OLD_RESOLVED', status: 'RESOLVED', resolvedAt: new Date(now.getTime() - 181 * 86_400_000) } });
  const api = await db.apiAttempt.create({ data: { eventId: oldEvent.id, provider: 'BITRIX24', operation: 'crm.company.get', method: 'POST', succeeded: true, occurredAt: new Date(now.getTime() - 31 * 86_400_000) } });
  const adminLog = await db.operationalLog.create({ data: { category: 'ADMIN', message: 'synthetic old admin operation', occurredAt: new Date(now.getTime() - 31 * 86_400_000) } });
  const errorLog = await db.operationalLog.create({ data: { category: 'ERROR', message: 'synthetic old error', occurredAt: new Date(now.getTime() - 31 * 86_400_000) } });
  const oldAudit = await db.adminAuditEntry.create({ data: { actorId: 'BITRIX24_USER:59', action: 'OLD', targetType: 'TEST', occurredAt: new Date(now.getTime() - 366 * 86_400_000) } });

  process.env.SYNC_MODE = 'apply';
  const retention = app.get(RetentionService);
  const apply = await retention.cleanupExpired(now);
  assert.equal(apply.retentionDays, 30);
  assert.equal(await db.inboundEvent.findUnique({ where: { id: oldEvent.id } }), null);
  assert.ok(await db.inboundEvent.findUnique({ where: { id: oldOpenEvent.id } }), 'open case event is preserved beyond operational retention');
  assert.equal(await db.apiAttempt.findUnique({ where: { id: api.id } }), null);
  assert.equal(await db.operationalLog.findUnique({ where: { id: adminLog.id } }), null, 'ADMIN logs follow ordinary 30-day retention');
  assert.equal(await db.operationalLog.findUnique({ where: { id: errorLog.id } }), null, 'ERROR logs follow ordinary 30-day retention');
  assert.equal(await db.manualReviewCase.findUnique({ where: { eventId: resolvedId } }), null, 'resolved cases expire after 180 days');
  assert.equal(await db.adminAuditEntry.findUnique({ where: { id: oldAudit.id } }), null, 'audit expires after 365 days');
  assert.ok(await db.entityPairBaseline.findUnique({ where: { pairId: activePairId } }), 'active pair baseline remains while the pair is active');

  process.env.SYNC_MODE = 'dry';
  const dry = await retention.cleanupExpired(now);
  assert.equal(dry.retentionDays, 7);
  assert.equal(await db.inboundEvent.findUnique({ where: { id: dryOldEvent.id } }), null, 'dry operational history expires after seven days');
  assert.ok(await db.inboundEvent.findUnique({ where: { id: oldOpenEvent.id } }), 'dry retention also preserves unresolved cases');
}
