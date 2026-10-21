import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { LocalAdminPreviewModule } from '../src/admin/local-preview.module';
import { DatabaseRecoveryService } from '../src/database-recovery.service';
import { DatabaseService } from '../src/database.service';
import { ProductCardEventProcessor } from '../src/products/product-card-event.processor';

const databaseUrl = process.env.PRODUCT_CREATE_EVENT_TEST_DATABASE_URL;
const activeApps: INestApplication[] = [];
let app: INestApplication | undefined;
let fakeApi: Server | undefined;
let apiUrl = '';
let fakeBase = '';
const requests: Array<{ method: string; path: string; body: string }> = [];
const createdCards = new Map<string, Record<string, unknown>>();
const priceRows = new Map<string, Array<{ id: string; productId: number; catalogGroupId: number; price: number; currency: string }>>();
const fakeDocumentRows = [{ orderId: 'synthetic-existing-order', rowId: 'synthetic-existing-row', productId: 'seed-product', quantity: 2, price: 17.5 }];
let documentWriteAttempts = 0;
let sourceRecords = new Map<string, Record<string, unknown>>();
const bitrixCatalogRecords = new Map<string, Record<string, unknown>>();
const moyskladCandidates = new Map<string, Array<{ id: string; created: string | null }>>();
let nextCardId = 80_000_000 + Math.floor(Math.random() * 10_000_000);
const oldEnv = new Map<string, string | undefined>();
const fakeErrors: unknown[] = [];
let earlyEcho: { sourceId: string; stage: 'ADD' | 'PRICE' } | null = null;
const echoObservations: Array<{ id: string; target: string; targetSaved: boolean; pairCount: number; waitingAttempts: number }> = [];
let echoReadFailure: number | null = null;
let finishImportOnList: { sourceId: string; targetId: string; originId: string } | null = null;

function assertIsolatedTarget(value: string) {
  const target = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(target.hostname), 'refusing to run product-create event integration against a non-local database');
  assert.ok(['/aerosystems_offline_acceptance_test', '/sync_issue79_integration_create_event_test', '/sync_issue79_date_validation_test', '/sync_issue79_product_audit_20261021_test', '/sync_issue79_root_description_20261021_test', '/sync_issue79_root_product_echo_20261021_test'].includes(target.pathname), 'requires an explicitly allowlisted disposable database');
  const schema = target.searchParams.get('schema') ?? '';
  assert.ok(/^issue61_create_event_[a-z0-9_]+$/.test(schema) || target.pathname === '/sync_issue79_date_validation_test' && schema === 'issue79_date_validation', 'requires a dedicated fresh test schema');
}

before(async () => {
  if (!databaseUrl) return;
  for (const key of ['DATABASE_URL', 'SYNC_MODE', 'ADMIN_PREVIEW', 'BITRIX24_EVENT_APPLICATION_TOKEN', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN', 'MOYSKLAD_WEBHOOK_SECRET']) oldEnv.set(key, process.env[key]);
  assertIsolatedTarget(databaseUrl);
  process.env.DATABASE_URL = databaseUrl;
  process.env.SYNC_MODE = 'apply';
  process.env.ADMIN_PREVIEW = '1';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-b24-event-token';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-only-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'synthetic-product-create-secret';
  fakeApi = createServer((request, response) => { void reply(request, response).catch(error => {
    fakeErrors.push(error);
    if (!response.headersSent) response.writeHead(500);
    response.end(JSON.stringify({ error: 'synthetic provider assertion failed' }));
  }); });
  await new Promise<void>((resolve) => fakeApi!.listen(0, '127.0.0.1', resolve));
  const address = fakeApi.address();
  assert.ok(address && typeof address !== 'string');
  fakeBase = `http://127.0.0.1:${address.port}/`;
  process.env.BITRIX24_REST_BASE_URL = `${fakeBase}b24/rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${fakeBase}ms/api/remap/1.2/`;

  app = await NestFactory.create(LocalAdminPreviewModule.register(), { logger: false });
  await app.listen(0, '127.0.0.1');
  activeApps.push(app);
  apiUrl = await app.getUrl();
  const database = app.get(DatabaseService);
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on', offSince: null } });
  await database.syncDirectionSetting.upsert({
    where: { entityKey: 'products-variations' },
    create: { entityKey: 'products-variations', bitrix24ToMoysklad: false, moyskladToBitrix24: true },
    update: { bitrix24ToMoysklad: false, moyskladToBitrix24: true },
  });
  if (!await app.get(DatabaseRecoveryService).assertReady()) {
    await app.get(DatabaseRecoveryService).confirmRecovery({
      previousLaunchBoundary: '2026-01-01T00:00:00.000Z', pairsRestored: true, lostEventsAcknowledged: true,
      acknowledgement: 'Synthetic fixture confirms the isolated disposable schema and synthetic event history.',
    }, 'BITRIX24_USER:999999');
  }
  // Recovery confirmation intentionally leaves service mode OFF; enable only this
  // synthetic integration fixture after the isolated readiness acknowledgement.
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on', offSince: null } });
});

after(async () => {
  for (const activeApp of activeApps) {
    (activeApp.getHttpServer() as Server).closeAllConnections();
    await activeApp.close();
  }
  if (fakeApi) await new Promise<void>((resolve, reject) => fakeApi!.close((error) => error ? reject(error) : resolve()));
  for (const [key, value] of oldEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.deepEqual(fakeErrors, [], 'fake provider assertions must drain before natural exit');
});

test('product-create event harness accepts only its dedicated loopback databases and fresh schemas', () => {
  assert.doesNotThrow(() => assertIsolatedTarget('postgresql://x@127.0.0.1:58341/sync_issue79_integration_create_event_test?schema=issue61_create_event_issue79'));
  assert.doesNotThrow(() => assertIsolatedTarget('postgresql://x@127.0.0.1:58341/sync_issue79_date_validation_test?schema=issue79_date_validation'));
  assert.throws(() => assertIsolatedTarget('postgresql://x@127.0.0.1:58341/sync_issue79_date_validation_test?schema=public'), /dedicated fresh test schema/);
  assert.throws(() => assertIsolatedTarget('postgresql://x@127.0.0.1:58341/production?schema=issue61_create_event_issue79'), /allowlisted disposable database/);
  assert.throws(() => assertIsolatedTarget('postgresql://x@example.invalid:58341/sync_issue79_integration_create_event_test?schema=issue61_create_event_issue79'), /non-local/);
  assert.throws(() => assertIsolatedTarget('postgresql://x@127.0.0.1:58341/sync_issue79_integration_create_event_test?schema=public'), /dedicated fresh test schema/);
});

test('post-boundary product and service CREATE intake creates/readbacks one card and durable native-kind pair; repeats and pre-boundary events do not duplicate', { skip: !databaseUrl }, async () => {
  assert.ok(app);
  requests.length = 0;
  const database = app.get(DatabaseService);
  const settingsVersion = 910_000 + Math.floor(Math.random() * 80_000);
  const priceType = randomUUID();
  const currencyId = randomUUID();
  const config = {
    schemaVersion: 1,
    productCatalogRuntime: { bitrix24CatalogId: '77', moyskladFields: ['name', 'code', 'description'] },
    rules: [{ id: 'catalog-name', entity: 'catalog', sourceField: 'name', targetField: 'name',
      bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }],
    groups: [], references: { units: [], priceTypes: [{ bitrix24Id: 2, moyskladId: priceType, status: 'configured' }], dictionaries: [], namedPairs: [] }, serviceCounterpartyId: null,
  };
  await database.fieldSettingsVersion.create({ data: { version: settingsVersion, config } });
  await database.fieldSettingsState.upsert({ where: { id: 'global' }, create: { id: 'global', version: settingsVersion }, update: { version: settingsVersion } });

  for (const kind of ['product', 'service'] as const) {
    const id = randomUUID();
    sourceRecords.set(id, { id, meta: { type: kind }, name: `${kind}-after-boundary`, code: `${kind}-code`, description: `${kind} description`, created: '2026-02-01T00:00:00.000Z', updated: '2026-10-18T00:00:00.000Z',
      salePrices: [{ value: 23700, currency: { isoCode: 'RUB', meta: { href: `${fakeBase}ms/api/remap/1.2/entity/currency/${currencyId}` } }, priceType: { meta: { href: `${fakeBase}ms/api/remap/1.2/context/companysettings/pricetype/${priceType}` } } }] });
    const first = await sendCreate(kind, id, `post-boundary-${kind}-1`);
    assert.equal(first.status, 200);
    const firstId = oneEventId(await first.json());
    await waitForStatus(database, firstId, 'SUCCEEDED');

    const pair = await database.entityPair.findFirstOrThrow({ where: { entityType: 'PRODUCT', moyskladId: id, active: true } });
    assert.equal(pair.moyskladType, kind, 'durable pair records the native MySklad type');
    assert.equal(pair.source, 'AUTO');
    const operation = await database.dealOrderReverseProductOperation.findUniqueOrThrow({ where: { moyskladProductId: id } });
    assert.equal(operation.status, 'SUCCEEDED');
    assert.equal(operation.bitrix24ProductId, pair.bitrix24Id);
    assert.equal(createdCards.get(pair.bitrix24Id)?.xmlId, `MOYSKLAD_${kind.toUpperCase()}_${id}`);
    assert.equal((createdCards.get(pair.bitrix24Id)?.property108 as { value: string }).value, id);
    assert.equal(priceRows.get(pair.bitrix24Id)?.length, 1);
    assert.equal(priceRows.get(pair.bitrix24Id)?.[0].price, 237, 'CREATE copies 23700 kopecks as 237 RUB, never 23700 RUB');

    const addsBeforeRepeat = requests.filter(({ path }) => isCreatePath(path, kind)).length;
    const repeated = await sendCreate(kind, id, `post-boundary-${kind}-2`);
    assert.equal(repeated.status, 200);
    await waitForStatus(database, oneEventId(await repeated.json()), 'SUCCEEDED');
    assert.equal((await database.entityPair.count({ where: { entityType: 'PRODUCT', moyskladId: id, active: true } })), 1);
    assert.equal(requests.filter(({ path }) => isCreatePath(path, kind)).length, addsBeforeRepeat, 'a repeated CREATE resolves the established pair without another B24 card create');

    if (kind === 'service') {
      const baseline = await sendUpdate(kind, id, 'service-baseline');
      assert.equal(baseline.status, 200);
      await waitForStatus(database, oneEventId(await baseline.json()), 'SUCCEEDED');
      sourceRecords.set(id, { ...sourceRecords.get(id), name: 'service-renamed-after-boundary' });
      const update = await sendUpdate(kind, id, 'service-update');
      assert.equal(update.status, 200);
      const updateEventId = oneEventId(await update.json());
      await waitForStatus(database, updateEventId, 'SUCCEEDED');
      assert.equal(createdCards.get(pair.bitrix24Id)?.name, 'service-renamed-after-boundary', 'service UPDATE is read back from the service endpoint and applies to the service card');
      assert.equal(requests.some(({ path }) => path.includes('catalog.product.service.update.json')), true, 'service lifecycle uses service-specific UPDATE endpoint');
      assert.equal(requests.some(({ path }) => path.includes('catalog.product.update.json')), false, 'service UPDATE never routes through product UPDATE');
    }

    const staleId = randomUUID();
    sourceRecords.set(staleId, { id: staleId, meta: { type: kind }, name: `${kind}-before-boundary`, code: `${kind}-old`, created: '2025-12-31T23:59:59.000Z' });
    const addsBeforeStale = requests.filter(({ path }) => isCreatePath(path, kind)).length;
    const stale = await sendCreate(kind, staleId, `pre-boundary-${kind}`);
    assert.equal(stale.status, 200);
    await waitForStatus(database, oneEventId(await stale.json()), 'SKIPPED_PRE_LAUNCH');
    assert.equal(await database.entityPair.count({ where: { entityType: 'PRODUCT', moyskladId: staleId } }), 0);
    assert.equal(requests.filter(({ path }) => isCreatePath(path, kind)).length, addsBeforeStale, 'pre-boundary CREATE cannot write a B24 card');

    const repeatStale = await sendCreate(kind, staleId, `pre-boundary-${kind}-repeat`);
    assert.equal(repeatStale.status, 200);
    await waitForStatus(database, oneEventId(await repeatStale.json()), 'SKIPPED_PRE_LAUNCH');
    assert.equal(await database.entityPair.count({ where: { entityType: 'PRODUCT', moyskladId: staleId } }), 0);
    assert.equal(requests.filter(({ path }) => isCreatePath(path, kind)).length, addsBeforeStale);
  }

  const providerCallsBeforeDisabledPrice = requests.length;
  const priceUpdate = await fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'CATALOG.PRICE.ON.UPDATE', data: { FIELDS: { ID: '99001' } }, auth: { application_token: 'synthetic-b24-event-token' } }),
  });
  assert.equal(priceUpdate.status, 200);
  await waitForStatus(database, oneEventId(await priceUpdate.json()), 'SKIPPED_DIRECTION_DISABLED');
  assert.equal(requests.length, providerCallsBeforeDisabledPrice, 'the disabled Bitrix24 price direction cannot read or write catalog/document APIs');

  assert.equal(requests.some(({ path }) => /crm\.deal|customerorder|invoiceout|document/i.test(path)), false, 'catalog create and retries do not touch document APIs');
});

test('MySklad CREATE audit moment is an exact, bounded fallback only when provider created is absent', { skip: !databaseUrl }, async () => {
  assert.ok(app);
  const database = app.get(DatabaseService);
  const boundary = await app.get(DatabaseRecoveryService).launchBoundary();
  assert.ok(boundary);
  const settingsVersion = 1_310_000 + Math.floor(Math.random() * 80_000);
  await database.fieldSettingsVersion.create({ data: { version: settingsVersion, config: {
    schemaVersion: 1, productCatalogRuntime: { bitrix24CatalogId: '77', moyskladFields: ['name', 'code'] },
    rules: [{ id: 'catalog-create-audit-test', entity: 'catalog', sourceField: 'name', targetField: 'name',
      bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }],
    groups: [], references: { units: [], priceTypes: [], dictionaries: [], namedPairs: [] }, serviceCounterpartyId: null,
  } } });
  await database.fieldSettingsState.upsert({ where: { id: 'global' }, create: { id: 'global', version: settingsVersion }, update: { version: settingsVersion } });

  const validMoment = new Date(Date.now() - 5_000);
  const primaryId = randomUUID();
  const mixedFirstId = randomUUID();
  const primaryName = `audit-create mixed-batch ${randomUUID()}`;
  const mixedName = `audit-create mixed-batch-first ${randomUUID()}`;
  sourceRecords.set(primaryId, auditBackedProduct(primaryId, primaryName));
  sourceRecords.set(mixedFirstId, { ...auditBackedProduct(mixedFirstId, mixedName), created: '2026-10-01T00:00:00.000Z' });
  const primaryAddCount = requests.filter(({ path }) => isCreatePath(path, 'product')).length;
  const batch = await sendMoyskladBatch([
    auditProductEvent(mixedFirstId, 'product', 'CREATE'),
    auditProductEvent(primaryId, 'product', 'CREATE'),
  ], auditContext(validMoment), `audit-batch-${randomUUID()}`);
  assert.equal(batch.status, 200);
  const batchBody = await batch.json() as { eventIds?: string[] };
  assert.equal(batchBody.eventIds?.length, 2);
  for (const eventId of batchBody.eventIds ?? []) await waitForStatus(database, eventId, 'SUCCEEDED');
  const primaryPair = await database.entityPair.findFirstOrThrow({ where: { entityType: 'PRODUCT', moyskladId: primaryId, active: true } });
  assert.equal(primaryPair.source, 'AUTO');
  assert.equal(requests.filter(({ path }) => isCreatePath(path, 'product')).length, primaryAddCount + 2);
  const provenance = await database.operationalLog.findFirstOrThrow({ where: { referenceId: batchBody.eventIds![1], message: { contains: 'PRODUCT_CREATE_LAUNCH_TIMESTAMP_ACCEPTED' } } });
  assert.equal(JSON.parse(provenance.message).timestampSource, 'MOYSKLAD_CREATE_AUDIT_CONTEXT_MOMENT');
  assert.equal(JSON.parse(provenance.message).createdAt, validMoment.toISOString());

  const serviceId = randomUUID();
  sourceRecords.set(serviceId, { ...auditBackedProduct(serviceId, `audit-service-${serviceId}`),
    meta: { type: 'service', href: `${fakeBase}ms/api/remap/1.2/entity/service/${serviceId}` } });
  const beforeServiceCreates = requests.filter(({ path }) => isCreatePath(path, 'service')).length;
  const serviceResponse = await sendMoyskladBatch([auditProductEvent(serviceId, 'service')], auditContext(validMoment), `audit-service-${randomUUID()}`);
  assert.equal(serviceResponse.status, 200);
  await waitForStatus(database, oneEventId(await serviceResponse.json()), 'SUCCEEDED');
  assert.equal(requests.filter(({ path }) => isCreatePath(path, 'service')).length, beforeServiceCreates + 1);
  assert.equal((await database.entityPair.findFirstOrThrow({ where: { entityType: 'PRODUCT', moyskladId: serviceId, active: true } })).moyskladType, 'service');

  const beforeRejectedCreates = requests.filter(({ path }) => isCreatePath(path, 'product')).length;
  const cases: Array<{ label: string; created?: unknown; moment?: Date; eventOverrides?: Record<string, unknown>; auditHref?: string; audit?: boolean; expectedStatus: string; expectedReason?: string }> = [
    { label: 'missing-audit-context', audit: false, expectedStatus: 'MANUAL_REVIEW', expectedReason: 'PRODUCT_LAUNCH_BOUNDARY_OR_CREATED_AT_UNAVAILABLE' },
    { label: 'future-moment', moment: new Date(Date.now() + 60_000), expectedStatus: 'MANUAL_REVIEW', expectedReason: 'PRODUCT_LAUNCH_BOUNDARY_OR_CREATED_AT_UNAVAILABLE' },
    { label: 'pre-boundary-moment', moment: new Date(boundary.getTime() - 1_000), expectedStatus: 'SKIPPED_PRE_LAUNCH' },
    { label: 'foreign-audit-href', moment: validMoment, auditHref: 'https://attacker.invalid/api/remap/1.2/audit/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expectedStatus: 'MANUAL_REVIEW', expectedReason: 'PRODUCT_LAUNCH_BOUNDARY_OR_CREATED_AT_UNAVAILABLE' },
    { label: 'foreign-entity-href', moment: validMoment, eventOverrides: { meta: { type: 'product', href: 'https://attacker.invalid/api/remap/1.2/entity/product/REPLACE' } }, expectedStatus: 'MANUAL_REVIEW', expectedReason: 'PRODUCT_LAUNCH_BOUNDARY_OR_CREATED_AT_UNAVAILABLE' },
    { label: 'wrong-account', moment: validMoment, eventOverrides: { accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, expectedStatus: 'MANUAL_REVIEW', expectedReason: 'PRODUCT_LAUNCH_BOUNDARY_OR_CREATED_AT_UNAVAILABLE' },
    { label: 'malformed-provider-created', created: 'not-a-provider-date', moment: validMoment, expectedStatus: 'MANUAL_REVIEW', expectedReason: 'PRODUCT_LAUNCH_BOUNDARY_OR_CREATED_AT_UNAVAILABLE' },
    { label: 'null-provider-created', created: null, moment: validMoment, expectedStatus: 'MANUAL_REVIEW', expectedReason: 'PRODUCT_LAUNCH_BOUNDARY_OR_CREATED_AT_UNAVAILABLE' },
    { label: 'invalid-calendar-provider-created', created: '2026-02-30T12:00:00Z', moment: validMoment, expectedStatus: 'MANUAL_REVIEW', expectedReason: 'PRODUCT_LAUNCH_BOUNDARY_OR_CREATED_AT_UNAVAILABLE' },
    { label: 'invalid-offset-provider-created', created: '2026-10-21T12:00:00+24:00', moment: validMoment, expectedStatus: 'MANUAL_REVIEW', expectedReason: 'PRODUCT_LAUNCH_BOUNDARY_OR_CREATED_AT_UNAVAILABLE' },
    { label: 'future-provider-created', created: new Date(Date.now() + 60_000).toISOString(), moment: validMoment, expectedStatus: 'MANUAL_REVIEW', expectedReason: 'PRODUCT_LAUNCH_BOUNDARY_OR_CREATED_AT_UNAVAILABLE' },
  ];
  for (const scenario of cases) {
    const id = randomUUID();
    const name = `audit-create reject-${scenario.label} ${randomUUID()}`;
    sourceRecords.set(id, { ...auditBackedProduct(id, name), ...(scenario.created === undefined ? {} : { created: scenario.created }) });
    const event = auditProductEvent(id, 'product', 'CREATE', scenario.eventOverrides);
    if (scenario.label === 'foreign-entity-href') (event.meta as { href: string }).href = (event.meta as { href: string }).href.replace('REPLACE', id);
    const response = await sendMoyskladBatch([event], scenario.audit === false ? undefined : auditContext(scenario.moment ?? validMoment, scenario.auditHref), `audit-reject-${scenario.label}-${randomUUID()}`);
    assert.equal(response.status, 200);
    const eventId = oneEventId(await response.json());
    await waitForStatus(database, eventId, scenario.expectedStatus);
    const saved = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId }, select: { lastErrorCategory: true } });
    if (scenario.expectedReason) assert.equal(saved.lastErrorCategory, scenario.expectedReason);
    assert.equal(await database.entityPair.count({ where: { entityType: 'PRODUCT', moyskladId: id } }), 0);
  }

  const preBoundaryId = randomUUID();
  const preBoundaryName = `audit-create provider-pre-boundary ${randomUUID()}`;
  sourceRecords.set(preBoundaryId, { ...auditBackedProduct(preBoundaryId, preBoundaryName), created: '2025-12-31T23:59:59.000Z' });
  const preBoundaryResponse = await sendMoyskladBatch([auditProductEvent(preBoundaryId, 'product', 'CREATE')], auditContext(validMoment), `audit-provider-pre-boundary-${randomUUID()}`);
  assert.equal(preBoundaryResponse.status, 200);
  const preBoundaryEventId = oneEventId(await preBoundaryResponse.json());
  await waitForStatus(database, preBoundaryEventId, 'SKIPPED_PRE_LAUNCH');
  assert.equal(await database.entityPair.count({ where: { entityType: 'PRODUCT', moyskladId: preBoundaryId } }), 0);
  assert.equal(requests.filter(({ path }) => isCreatePath(path, 'product')).length, beforeRejectedCreates,
    'all rejected/freshness-negative cases and the pre-boundary provider-created record perform no B24 CREATE');

  const updateId = randomUUID();
  const updateName = `audit-create update-must-not-create ${randomUUID()}`;
  sourceRecords.set(updateId, auditBackedProduct(updateId, updateName));
  const updateResponse = await sendMoyskladBatch([auditProductEvent(updateId, 'product', 'UPDATE')], auditContext(validMoment), `audit-update-${randomUUID()}`);
  assert.equal(updateResponse.status, 200);
  const updateEventId = oneEventId(await updateResponse.json());
  await waitForStatus(database, updateEventId, 'MANUAL_REVIEW');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: updateEventId }, select: { lastErrorCategory: true } })).lastErrorCategory, 'PRODUCT_PAIR_NOT_ACTIVE');
  assert.equal(requests.filter(({ path }) => isCreatePath(path, 'product')).length, beforeRejectedCreates,
    'an UPDATE event never uses its audit moment to enter the CREATE path');

  const conflictingId = randomUUID();
  sourceRecords.set(conflictingId, auditBackedProduct(conflictingId, `audit-create conflicting duplicate ${randomUUID()}`));
  const duplicatePayload = { auditContext: auditContext(validMoment), events: [
    auditProductEvent(conflictingId, 'product', 'CREATE'), auditProductEvent(conflictingId, 'product', 'UPDATE'),
  ] };
  const conflictEvent = await database.inboundEvent.create({ data: {
    source: 'MOYSKLAD', deliveryKey: `audit-conflicting-duplicate-${randomUUID()}`, eventType: 'CREATE',
    externalEntityType: 'product', externalEntityId: conflictingId, payload: duplicatePayload,
    receivedAt: new Date(), status: 'RECEIVED',
  } });
  await app.get(ProductCardEventProcessor).process(conflictEvent.id);
  await waitForStatus(database, conflictEvent.id, 'MANUAL_REVIEW');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: conflictEvent.id }, select: { lastErrorCategory: true } })).lastErrorCategory,
    'PRODUCT_LAUNCH_BOUNDARY_OR_CREATED_AT_UNAVAILABLE');
  assert.equal(await database.entityPair.count({ where: { entityType: 'PRODUCT', moyskladId: conflictingId } }), 0);
  assert.equal(requests.filter(({ path }) => isCreatePath(path, 'product')).length, beforeRejectedCreates,
    'conflicting same-ID events cannot create a B24 card using shared audit metadata');
});

test('public Bitrix24 catalog webhook persists earliest-date, deterministic ties, and never redefines a saved pair', { skip: !databaseUrl }, async () => {
  assert.ok(app);
  const database = app.get(DatabaseService);
  const settingsVersion = 1_200_000 + Math.floor(Math.random() * 80_000);
  const priceType = randomUUID();
  await database.fieldSettingsVersion.create({ data: { version: settingsVersion, config: {
    schemaVersion: 1, productCatalogRuntime: { bitrix24CatalogId: '77', moyskladFields: ['name'] },
    rules: [{ id: 'catalog-name-date-test', entity: 'catalog', sourceField: 'name', targetField: 'name',
      bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }],
    groups: [], references: { units: [], priceTypes: [{ bitrix24Id: 2, moyskladId: priceType, status: 'configured' }], dictionaries: [], namedPairs: [] }, serviceCounterpartyId: null,
  } } });
  await database.fieldSettingsState.upsert({ where: { id: 'global' }, create: { id: 'global', version: settingsVersion }, update: { version: settingsVersion } });

  async function setupCandidates(name: string, b24Id: string, rows: Array<{ id: string; createdAt: string | null }>) {
    const b24Created = '2026-10-10T00:00:00.000Z';
    bitrixCatalogRecords.set(b24Id, { id: Number(b24Id), type: 1, name, dateCreate: b24Created, iblockId: 77, vatId: 2, vatIncluded: false });
    priceRows.set(b24Id, [{ id: String(Number(b24Id) + 50), productId: Number(b24Id), catalogGroupId: 2, price: 25, currency: 'RUB' }]);
    moyskladCandidates.set(name, rows.map(({ id, createdAt }) => ({ id, created: createdAt })));
    for (const { id, createdAt } of rows) sourceRecords.set(id, {
      id, meta: { type: 'product' }, name, created: createdAt, updated: '2026-10-18T00:00:00.000Z', vatEnabled: true, vatIncluded: false, vat: 20,
      salePrices: [{ value: 2500, currency: { isoCode: 'RUB', meta: { href: `${fakeBase}ms/api/remap/1.2/entity/currency/12345678-1234-1234-1234-123456789abc` } }, priceType: { meta: { href: `${fakeBase}ms/api/remap/1.2/context/companysettings/pricetype/${priceType}` } } }],
    });
  }
  const freshB24Id = () => String(8_000_000_000_000_000 + Math.floor(Math.random() * 500_000_000_000_000));
  const orderedCandidateIds = () => [randomUUID(), randomUUID()].sort();
  async function postCatalogAdd(id: string, requestId: string) {
    const response = await fetch(`${apiUrl}/webhooks/bitrix24`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'CATALOG.PRODUCT.ON.ADD', data: { FIELDS: { ID: id, TYPE: 1 } }, auth: { application_token: 'synthetic-b24-event-token' } }) });
    assert.equal(response.status, 200);
    const eventId = oneEventId(await response.json());
    await waitForStatus(database, eventId, 'SUCCEEDED');
    return { eventId, requestId };
  }

  requests.length = 0;
  const [newer, earliest] = orderedCandidateIds();
  const earliestB24Id = freshB24Id();
  const earliestName = `date-earliest synthetic ${randomUUID()}`;
  await setupCandidates(earliestName, earliestB24Id, [
    { id: newer, createdAt: '2026-10-02T00:00:00.000Z' }, { id: earliest, createdAt: '2026-10-01T00:00:00.000Z' },
  ]);
  const earliestEvent = await postCatalogAdd(earliestB24Id, 'earliest');
  const earliestPair = await database.entityPair.findFirstOrThrow({ where: { entityType: 'PRODUCT', bitrix24Id: earliestB24Id, active: true } });
  assert.equal(earliestPair.moyskladId, earliest, 'public webhook persisted the earliest-created exact candidate despite its greater native ID');
  const earliestLog = await database.operationalLog.findFirstOrThrow({ where: { message: { contains: `"bitrix24Id":"${earliestB24Id}"` } } });
  assert.equal(JSON.parse(earliestLog.message).selectionReason, 'EARLIEST_CREATION_DATE');

  const [equalB, equalA] = orderedCandidateIds();
  const equalB24Id = freshB24Id();
  const equalName = `date-tie synthetic ${randomUUID()}`;
  await setupCandidates(equalName, equalB24Id, [
    { id: equalA, createdAt: '2026-10-01T00:00:00.000Z' }, { id: equalB, createdAt: '2026-10-01T00:00:00.000Z' },
  ]);
  const equalEvent = await postCatalogAdd(equalB24Id, 'equal');
  const equalPair = await database.entityPair.findFirstOrThrow({ where: { entityType: 'PRODUCT', bitrix24Id: equalB24Id, active: true } });
  assert.equal(equalPair.moyskladId, equalB);
  const equalLog = await database.operationalLog.findFirstOrThrow({ where: { message: { contains: `"bitrix24Id":"${equalB24Id}"` } } });
  assert.equal(JSON.parse(equalLog.message).selectionReason, 'CREATION_DATE_TIED_NATIVE_ID');

  const [missingB, missingA] = orderedCandidateIds();
  const missingB24Id = freshB24Id();
  const missingName = `date-missing synthetic ${randomUUID()}`;
  await setupCandidates(missingName, missingB24Id, [
    { id: missingA, createdAt: null }, { id: missingB, createdAt: null },
  ]);
  const missingEvent = await postCatalogAdd(missingB24Id, 'missing');
  const missingPair = await database.entityPair.findFirstOrThrow({ where: { entityType: 'PRODUCT', bitrix24Id: missingB24Id, active: true } });
  assert.equal(missingPair.moyskladId, missingB);
  const missingLog = await database.operationalLog.findFirstOrThrow({ where: { message: { contains: `"bitrix24Id":"${missingB24Id}"` } } });
  assert.equal(JSON.parse(missingLog.message).selectionReason, 'CREATION_DATE_UNAVAILABLE_NATIVE_ID');

  const [earlierUnpaired, savedPairCandidate] = orderedCandidateIds();
  const savedB24Id = freshB24Id();
  const savedName = `saved-pair synthetic ${randomUUID()}`;
  await setupCandidates(savedName, savedB24Id, [
    { id: earlierUnpaired, createdAt: '2026-09-01T00:00:00.000Z' }, { id: savedPairCandidate, createdAt: '2026-10-01T00:00:00.000Z' },
  ]);
  const saved = await database.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: savedB24Id, moyskladId: savedPairCandidate, moyskladType: 'product', source: 'MANUAL', active: true } });
  const savedEvent = await postCatalogAdd(savedB24Id, 'saved-pair');
  const stillSaved = await database.entityPair.findFirstOrThrow({ where: { id: saved.id, active: true } });
  assert.equal(stillSaved.moyskladId, savedPairCandidate, 'existing pair wins before exact candidate ranking');
  assert.equal(await database.productDuplicateAlias.count({ where: { duplicateBitrix24Id: savedB24Id } }), 0);
  assert.equal(requests.some(({ method, path }) => method === 'PUT' || path.includes('.update.json')), false, 'matching and restoration make no provider writes');
  assert.ok(savedEvent.eventId);
});

test('MySklad product UPDATE applies confirmed price and UOM mappings through the webhook runtime without touching document rows', { skip: !databaseUrl }, async () => {
  assert.ok(app);
  const database = app.get(DatabaseService);
  const productId = randomUUID();
  const bitrix24Id = String(nextCardId++);
  const configuredPriceType = randomUUID();
  const unconfiguredPriceType = randomUUID();
  const oldUnitId = randomUUID();
  const newUnitId = randomUUID();
  const currencyId = randomUUID();
  const b24PriceId = String(nextCardId++);
  const settingsVersion = 990_000 + Math.floor(Math.random() * 9_000);
  const originalDocumentRows = structuredClone(fakeDocumentRows);
  documentWriteAttempts = 0;
  const configuredPrice = { id: b24PriceId, productId: Number(bitrix24Id), catalogGroupId: 2, price: 10, currency: 'RUB' };
  const unrelatedPrice = { id: String(Number(b24PriceId) + 1), productId: Number(bitrix24Id), catalogGroupId: 9, price: 777, currency: 'RUB' };
  priceRows.set(bitrix24Id, [configuredPrice, unrelatedPrice]);
  const productCard = { id: Number(bitrix24Id), type: 1, name: 'Paired catalog item', code: 'SKU-1', detailText: 'catalog only', measure: 3, xmlId: `MOYSKLAD_PRODUCT_${productId}` };
  createdCards.set(bitrix24Id, productCard);
  sourceRecords.set(productId, {
    id: productId, meta: { type: 'product' }, name: 'Paired catalog item', code: 'SKU-1', description: 'catalog only',
    created: '2026-02-01T00:00:00.000Z', updated: '2026-10-18T00:00:00.000Z',
    uom: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/uom/${oldUnitId}` } },
    salePrices: [
      { value: 1000, currency: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/currency/${currencyId}` }, isoCode: 'RUB' }, priceType: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/context/companysettings/pricetype/${configuredPriceType}` } } },
      { value: 77700, currency: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/currency/${currencyId}` }, isoCode: 'RUB' }, priceType: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/context/companysettings/pricetype/${unconfiguredPriceType}` } } },
    ],
  });
  const config = {
    schemaVersion: 1,
    productCatalogRuntime: { bitrix24CatalogId: '77', moyskladFields: ['name', 'code', 'description'] },
    rules: [{ id: 'catalog-name', entity: 'catalog', sourceField: 'name', targetField: 'name',
      bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }],
    groups: [],
    references: {
      units: [
        { bitrix24Id: 3, moyskladId: oldUnitId, status: 'configured' },
        { bitrix24Id: 4, moyskladId: newUnitId, status: 'configured' },
      ],
      priceTypes: [{ bitrix24Id: 2, moyskladId: configuredPriceType, status: 'configured' }],
      dictionaries: [], namedPairs: [],
    },
    serviceCounterpartyId: null,
  };
  const pair = await database.entityPair.create({ data: {
    entityType: 'PRODUCT', bitrix24Id, moyskladId: productId, moyskladType: 'product', source: 'MANUAL', active: true,
  } });
  await database.fieldSettingsVersion.create({ data: { version: settingsVersion, config } });
  await database.fieldSettingsState.update({ where: { id: 'global' }, data: { version: settingsVersion } });
  requests.length = 0;
  try {
    const baselineResponse = await sendUpdate('product', productId, 'catalog-price-uom-baseline');
    assert.equal(baselineResponse.status, 200);
    await waitForStatus(database, oneEventId(await baselineResponse.json()), 'SUCCEEDED');

    const source = sourceRecords.get(productId)!;
    source.uom = { meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/uom/${newUnitId}` } };
    source.salePrices = [
      { value: 1825, currency: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/currency/${currencyId}` }, isoCode: 'RUB' }, priceType: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/context/companysettings/pricetype/${configuredPriceType}` } } },
      { value: 77700, currency: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/currency/${currencyId}` }, isoCode: 'RUB' }, priceType: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/context/companysettings/pricetype/${unconfiguredPriceType}` } } },
    ];
    const updateResponse = await sendUpdate('product', productId, 'catalog-price-uom-update');
    assert.equal(updateResponse.status, 200);
    const updateEventId = oneEventId(await updateResponse.json());
    await waitForStatus(database, updateEventId, 'SUCCEEDED');

    assert.equal(productCard.measure, 4, 'configured MySklad UOM mapping is written to the existing B24 catalog card');
    assert.equal(priceRows.get(bitrix24Id)?.find((row) => row.id === b24PriceId)?.price, 18.25, 'configured sale price updates the exact existing B24 catalog price row');
    assert.equal(priceRows.get(bitrix24Id)?.find((row) => row.id === unrelatedPrice.id)?.price, 777, 'unconfigured price type remains untouched');
    (source.salePrices as Array<{ value: number }>)[0].value = 0;
    const zeroResponse = await sendUpdate('product', productId, 'catalog-price-zero');
    assert.equal(zeroResponse.status, 200);
    await waitForStatus(database, oneEventId(await zeroResponse.json()), 'SUCCEEDED');
    assert.equal(priceRows.get(bitrix24Id)?.find((row) => row.id === b24PriceId)?.price, 0, 'zero is copied without inventing a replacement price');
    const providerCalls = requests.map(({ path }) => path);
    assert.ok(providerCalls.some((path) => path.includes('catalog.price.update.json')), 'the configured price is written through Bitrix catalog.price.update');
    assert.ok(providerCalls.some((path) => path.includes('catalog.product.update.json')), 'the configured UOM is written through Bitrix catalog.product.update');
    assert.ok(providerCalls.filter((path) => path.includes('catalog.price.list.json')).length >= 2, 'price write is confirmed by a provider readback');
    assert.equal(providerCalls.some((path) => /crm\.deal|crm\.item\.productrow|customerorder|invoiceout|productrows\.set/i.test(path)), false, 'catalog price/UOM update cannot write or replace existing document rows');
    assert.equal(documentWriteAttempts, 0, 'the fake provider observed no document write operation');
    assert.deepEqual(fakeDocumentRows, originalDocumentRows, 'an already-existing document row remains unchanged');
    assert.deepEqual(await database.entityPair.findUniqueOrThrow({ where: { id: pair.id } }).then((saved) => [saved.bitrix24Id, saved.moyskladId, saved.active]), [bitrix24Id, productId, true], 'catalog update retains exact product pair identity');
  } finally {
    await database.inboundEvent.deleteMany({ where: { deliveryKey: { in: ['catalog-price-uom-baseline', 'catalog-price-uom-update'] } } });
    await database.entityPair.deleteMany({ where: { id: pair.id } });
    createdCards.delete(bitrix24Id);
    priceRows.delete(bitrix24Id);
    sourceRecords.delete(productId);
  }
});

async function sendCreate(kind: 'product' | 'service', id: string, requestId: string) {
  return fetch(`${apiUrl}/webhooks/moysklad/synthetic-product-create-secret?requestId=${encodeURIComponent(requestId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'CREATE', meta: { type: kind, href: `${fakeBase}entity/${kind}/${id}` } }] }),
  });
}

test('actual public product CREATE/UPDATE complete with approved emoji projection, price, UUID and one durable pair', { skip: !databaseUrl }, async () => {
  assert.ok(app);
  const database = app.get(DatabaseService);
  const version = 1_710_000 + Math.floor(Math.random() * 10_000);
  const priceType = randomUUID();
  const rule = (sourceField: string, targetField: string) => ({ id: sourceField, entity: 'catalog', sourceField, targetField,
    bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } });
  await database.fieldSettingsVersion.create({ data: { version, config: {
    schemaVersion: 1, productCatalogRuntime: { bitrix24CatalogId: '77', moyskladFields: ['name', 'description'] },
    rules: [rule('name', 'name'), rule('detailText', 'description')], groups: [], serviceCounterpartyId: null,
    references: { units: [], priceTypes: [{ bitrix24Id: 2, moyskladId: priceType, status: 'configured' }], dictionaries: [], namedPairs: [] },
  } } });
  await database.fieldSettingsState.update({ where: { id: 'global' }, data: { version } });
  const cases = [
    ['😀тест Ё & <b>literal</b>\nEND', 'тест Ё & <b>literal</b>\nEND'],
    ['тест 😀 Ё & <b>literal</b>\nEND', 'тест  Ё & <b>literal</b>\nEND'],
    ['тест Ё & <b>literal</b>\nEND😀', 'тест Ё & <b>literal</b>\nEND'],
    ['тест Ё © ♥ <b>literal</b>\nEND', 'тест Ё © ♥ <b>literal</b>\nEND'],
    ['😀👨‍👩‍👧‍👦', ''],
  ];
  for (const [raw, projected] of cases) {
    const id = randomUUID();
    const source = { id, meta: { type: 'product' }, name: `description-${id}`, description: raw,
      created: '2026-02-01T00:00:00.000Z', salePrices: [{ value: 1234, currency: { isoCode: 'RUB', meta: { href: `${fakeBase}ms/api/remap/1.2/entity/currency/${randomUUID()}` } },
        priceType: { meta: { href: `${fakeBase}ms/api/remap/1.2/context/companysettings/pricetype/${priceType}` } } }] };
    sourceRecords.set(id, source);
    const deliver = async (action: 'CREATE' | 'UPDATE', suffix: string) => {
      const response = await (action === 'CREATE' ? sendCreate : sendUpdate)('product', id, `text-${id}-${suffix}`);
      assert.equal(response.status, 200);
      const eventId = oneEventId(await response.json());
      await waitForStatus(database, eventId, 'SUCCEEDED');
    };
    await deliver('CREATE', 'create');
    const pair = await database.entityPair.findFirstOrThrow({ where: { entityType: 'PRODUCT', moyskladId: id, active: true } });
    const card = createdCards.get(pair.bitrix24Id)!;
    assert.equal(card.detailText ?? '', projected);
    if (projected) assert.equal(card.detailTextType, 'text');
    assert.equal((card.property108 as { value: string }).value, id);
    assert.equal(priceRows.get(pair.bitrix24Id)?.[0].price, 12.34);
    const operation = await database.dealOrderReverseProductOperation.findUniqueOrThrow({ where: { moyskladProductId: id } });
    assert.equal(operation.status, 'SUCCEEDED');
    assert.equal((operation.payload as any).fields.detailText ?? '', projected, 'journal freezes the approved projection, not a lossy native prefix');
    await deliver('UPDATE', 'baseline');
    source.description = `REV2 ${raw} TAIL😀`;
    await deliver('UPDATE', 'changed');
    assert.equal(card.detailText, `REV2 ${projected} TAIL`);
    assert.equal(card.detailTextType, 'text');
    assert.equal(source.description, `REV2 ${raw} TAIL😀`, 'MySklad source is never changed');
    const writes = requests.filter(row => /catalog\.product\.(add|update)(\.json)?$/.test(row.path)).length;
    await deliver('UPDATE', 'repeat');
    assert.equal(requests.filter(row => /catalog\.product\.(add|update)(\.json)?$/.test(row.path)).length, writes, 'repeat is a stable no-op');
    assert.equal(await database.entityPair.count({ where: { entityType: 'PRODUCT', moyskladId: id } }), 1);
    assert.equal([...createdCards.values()].filter(value => value.xmlId === `MOYSKLAD_PRODUCT_${id}`).length, 1);
    source.description = '😀';
    await deliver('UPDATE', 'emoji-only');
    assert.equal(card.detailText ?? '', '', 'emoji-only update clears the optional description instead of retaining stale text');
    await deliver('UPDATE', 'empty-repeat');
  }
  const id = randomUUID();
  sourceRecords.set(id, { id, meta: { type: 'product' }, name: `unsupported-${id}`, description: 'A𠀀B', created: '2026-02-01T00:00:00.000Z' });
  const before = createdCards.size;
  const rejected = await sendCreate('product', id, `text-${id}-unsupported`);
  const eventId = oneEventId(await rejected.json());
  await waitForStatus(database, eventId, 'MANUAL_REVIEW');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } })).lastErrorCategory, 'PRODUCT_DESCRIPTION_UNSUPPORTED_CHARACTER');
  assert.equal(createdCards.size, before, 'unsupported non-emoji text stops BEFORE any partial provider CREATE');
  assert.equal(await database.dealOrderReverseProductOperation.count({ where: { moyskladProductId: id } }), 0);
  const heldId = randomUUID();
  const heldTarget = String(nextCardId++);
  const frozenFields = { iblockId: 77, active: 'Y', name: `held-${heldId}`, xmlId: `MOYSKLAD_PRODUCT_${heldId}`,
    property108: { value: heldId }, detailText: 'old 😀 tail', detailTextType: 'text' };
  sourceRecords.set(heldId, { id: heldId, meta: { type: 'product' }, name: frozenFields.name, description: frozenFields.detailText, created: '2026-02-01T00:00:00.000Z' });
  createdCards.set(heldTarget, { id: Number(heldTarget), type: 1, ...frozenFields, detailText: 'old ' });
  await database.dealOrderReverseProductOperation.create({ data: { moyskladProductId: heldId, syncId: randomUUID(), eventId: `old-${heldId}`, settingsVersion: version,
    bitrix24CatalogId: '77', payload: { fields: frozenFields, xmlId: frozenFields.xmlId, catalogId: '77', prices: [], kind: 'product' } } });
  const heldBefore = await database.dealOrderReverseProductOperation.findUniqueOrThrow({ where: { moyskladProductId: heldId } });
  const heldResponse = await sendCreate('product', heldId, `text-${heldId}-held`);
  const heldEvent = oneEventId(await heldResponse.json());
  await waitForStatus(database, heldEvent, 'MANUAL_REVIEW');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: heldEvent } })).lastErrorCategory, 'PRODUCT_CREATE_RECOVERY_MISMATCH');
  const heldAfter = await database.dealOrderReverseProductOperation.findUniqueOrThrow({ where: { moyskladProductId: heldId } });
  assert.deepEqual(heldAfter.payload, heldBefore.payload, 'old raw frozen journal is NOT silently rewritten to fit a partial native card');
  assert.equal(heldAfter.bitrix24ProductId, null);
  assert.equal(await database.entityPair.count({ where: { moyskladId: heldId } }), 0);
  assert.equal(createdCards.get(heldTarget)?.detailText, 'old ');
  assert.equal(documentWriteAttempts, 0);
});

async function sendMoyskladBatch(events: Array<Record<string, unknown>>, audit: Record<string, unknown> | undefined, requestId: string) {
  return fetch(`${apiUrl}/webhooks/moysklad/synthetic-product-create-secret?requestId=${encodeURIComponent(requestId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events, ...(audit ? { auditContext: audit } : {}) }),
  });
}

test('actual public product/service ADD echoes wait before target-save AND pair-commit, then naturally resume without review or duplicate', { skip: !databaseUrl }, async () => {
  assert.ok(app);
  const db = app.get(DatabaseService);
  const version = 1_810_000 + Math.floor(Math.random() * 10_000);
  const priceType = randomUUID();
  await db.fieldSettingsVersion.create({ data: { version, config: {
    schemaVersion: 1, productCatalogRuntime: { bitrix24CatalogId: '77', moyskladFields: ['name', 'code'] },
    rules: [{ id: 'echo-name', entity: 'catalog', sourceField: 'name', targetField: 'name',
      bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } }, moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }],
    groups: [], serviceCounterpartyId: null, references: { units: [], priceTypes: [{ bitrix24Id: 2, moyskladId: priceType, status: 'configured' }], dictionaries: [], namedPairs: [] },
  } } });
  await db.fieldSettingsState.update({ where: { id: 'global' }, data: { version } });
  for (const kind of ['product', 'service'] as const) for (const stage of ['ADD', 'PRICE'] as const) {
    const id = randomUUID();
    sourceRecords.set(id, { id, meta: { type: kind }, name: `echo-${kind}-${stage}-${id}`, code: `E-${id.slice(0, 8)}`, created: '2026-02-01T00:00:00.000Z',
      salePrices: [{ value: 1234, currency: { isoCode: 'RUB', meta: { href: `${fakeBase}ms/api/remap/1.2/entity/currency/${randomUUID()}` } },
        priceType: { meta: { href: `${fakeBase}ms/api/remap/1.2/context/companysettings/pricetype/${priceType}` } } }] });
    earlyEcho = { sourceId: id, stage };
    const response = await sendCreate(kind, id, `echo-${kind}-${stage}-${id}`);
    const originEventId = oneEventId(await response.json());
    await waitForStatus(db, originEventId, 'SUCCEEDED');
    const observed = echoObservations.at(-1)!;
    assert.equal(observed.targetSaved, stage === 'PRICE', 'ADD echo is held before provider ADD ACK/target ID save; price echo is held after target save but before pair commit');
    assert.equal(observed.pairCount, 0);
    assert.equal(observed.waitingAttempts, 0, 'ordinary import dependency waiting does not spend failure attempts');
    for (let tick = 0; tick < 400; tick += 1) {
      const echo = await db.inboundEvent.findUniqueOrThrow({ where: { id: observed.id } });
      if (echo.status === 'SUCCEEDED') break;
      assert.notEqual(echo.status, 'MANUAL_REVIEW', echo.lastErrorCategory ?? 'false echo review');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const echo = await db.inboundEvent.findUniqueOrThrow({ where: { id: observed.id } });
    assert.equal(echo.status, 'SUCCEEDED');
    assert.equal(echo.attempts, 1);
    assert.equal(await db.manualReviewCase.count({ where: { eventId: observed.id } }), 0);
    assert.equal(await db.entityPair.count({ where: { entityType: 'PRODUCT', moyskladId: id, bitrix24Id: observed.target, moyskladType: kind, active: true } }), 1);
    const journal = await db.dealOrderReverseProductOperation.findUniqueOrThrow({ where: { moyskladProductId: id } });
    assert.equal(journal.status, 'SUCCEEDED');
    assert.equal(journal.bitrix24ProductId, observed.target);
    assert.equal(priceRows.get(observed.target)?.length, 1);
    const source = sourceRecords.get(id)!;
    source.name = `${source.name} REV2`;
    for (const suffix of ['update', 'repeat']) {
      const update = await sendUpdate(kind, id, `echo-${id}-${suffix}`);
      await waitForStatus(db, oneEventId(await update.json()), 'SUCCEEDED');
    }
    assert.equal(createdCards.get(observed.target)?.name, source.name);
    assert.equal([...createdCards.values()].filter(card => card.xmlId === `MOYSKLAD_${kind.toUpperCase()}_${id}`).length, 1);
    assert.equal(requests.filter(row => row.method === 'POST' && /\/entity\/(product|service)(\?|$)/.test(row.path)).length, 0, 'no reverse provider CREATE');
    assert.equal(await db.operationalLog.count({ where: { referenceId: observed.id, message: { contains: 'PRODUCT_IMPORT_ECHO_DEFERRED' } } }), 1);
    assert.equal(await db.operationalLog.count({ where: { referenceId: observed.id, message: { contains: 'PRODUCT_IMPORT_ECHO_RESUMED' } } }), 1);
  }
});

async function deliverEarlyEcho(card: Record<string, unknown>, stage: 'ADD' | 'PRICE') {
  const wanted = earlyEcho;
  if (!wanted || wanted.stage !== stage || !String(card.xmlId).endsWith(wanted.sourceId)) return;
  earlyEcho = null;
  const db = app!.get(DatabaseService);
  const response = await fetch(`${apiUrl}/webhooks/bitrix24`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMPRODUCTADD', data: { FIELDS: { ID: String(card.id) } }, auth: { application_token: 'synthetic-b24-event-token' } }) });
  assert.equal(response.status, 200);
  const id = oneEventId(await response.json());
  await waitForStatus(db, id, 'RETRYABLE_FAILURE');
  const waiting = await db.inboundEvent.findUniqueOrThrow({ where: { id } });
  assert.equal(waiting.lastErrorCategory, 'PRODUCT_IMPORT_ECHO_WAITING');
  assert.ok(waiting.retryAfter && waiting.retryAfter > new Date());
  const journal = await db.dealOrderReverseProductOperation.findUniqueOrThrow({ where: { moyskladProductId: wanted.sourceId } });
  echoObservations.push({ id, target: String(card.id), targetSaved: journal.bitrix24ProductId !== null,
    pairCount: await db.entityPair.count({ where: { entityType: 'PRODUCT', moyskladId: wanted.sourceId } }), waitingAttempts: waiting.attempts });
}

test('own import echo provenance rejects forged/ambiguous/conflicting/failed creations and bad auth without provider writes', { skip: !databaseUrl }, async () => {
  assert.ok(app);
  const db = app.get(DatabaseService);
  const fixture = async (scenario: string) => {
    const id = randomUUID(); const target = String(nextCardId++); const now = new Date(Date.now() - 1_000);
    const fields = { iblockId: 77, name: `echo-negative-${id}`, xmlId: `MOYSKLAD_PRODUCT_${id}`, active: 'Y', property108: { value: id } };
    const card: Record<string, unknown> = { ...fields, id: Number(target), type: 1 };
    const origin = await db.inboundEvent.create({ data: { source: scenario === 'wrong-origin' ? 'BITRIX24' : 'MOYSKLAD', deliveryKey: `echo-fixture-${id}`,
      eventType: 'CREATE', externalEntityType: 'product', externalEntityId: id, payload: {}, processingStartedAt: new Date(), status: scenario === 'failed-origin' ? 'MANUAL_REVIEW' : 'PROCESSING' } });
    if (scenario !== 'no-journal') await db.dealOrderReverseProductOperation.create({ data: {
      moyskladProductId: id, syncId: randomUUID(), eventId: origin.id, settingsVersion: (await db.fieldSettingsState.findUniqueOrThrow({ where: { id: 'global' } })).version,
      bitrix24CatalogId: '77', createdAt: now, attemptedAt: scenario === 'future-operation' ? new Date(Date.now() + 60_000) : now,
      status: scenario === 'failed-operation' ? 'FAILED' : scenario === 'succeeded-without-pair' ? 'SUCCEEDED' : 'PENDING',
      bitrix24ProductId: scenario === 'occupied-target' ? '999999999' : scenario === 'succeeded-without-pair' ? target : null,
      payload: { kind: scenario === 'wrong-kind' ? 'service' : 'product', catalogId: '77', xmlId: fields.xmlId, fields, prices: [] },
    } });
    if (scenario === 'wrong-uuid') card.property108 = { value: randomUUID() };
    if (scenario === 'wrong-catalog') card.iblockId = 78;
    if (scenario === 'changed-fields') card.name = 'different native fields';
    if (scenario === 'duplicate-native') createdCards.set(String(nextCardId++), { ...card, id: nextCardId - 1 });
    if (scenario === 'inactive-pair') await db.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: target, moyskladId: id, moyskladType: 'product', active: false, source: 'MANUAL' } });
    createdCards.set(target, card);
    return { id, target, origin };
  };
  const sendEcho = async (target: string, token = 'synthetic-b24-event-token') => fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'ONCRMPRODUCTADD', data: { FIELDS: { ID: target, TYPE: 1 } }, auth: { application_token: token } }),
  });
  for (const scenario of ['no-journal', 'wrong-origin', 'wrong-uuid', 'wrong-catalog', 'changed-fields', 'wrong-kind', 'occupied-target', 'duplicate-native', 'inactive-pair', 'failed-origin', 'failed-operation', 'succeeded-without-pair', 'future-operation']) {
    const own = await fixture(scenario);
    const beforePairs = await db.entityPair.count();
    const beforeAdds = requests.filter(row => /catalog\.(product|price).*(add|update)(\.json)?$/.test(row.path) || row.method === 'PUT').length;
    const response = await sendEcho(own.target);
    assert.equal(response.status, 200);
    const eventId = oneEventId(await response.json());
    await waitForStatus(db, eventId, 'MANUAL_REVIEW');
    assert.match((await db.inboundEvent.findUniqueOrThrow({ where: { id: eventId } })).lastErrorCategory ?? '', /^PRODUCT_IMPORT_ECHO_/);
    assert.equal(await db.entityPair.count(), beforePairs, `${scenario}: cannot seed/repair a pair`);
    assert.equal(requests.filter(row => /catalog\.(product|price).*(add|update)(\.json)?$/.test(row.path) || row.method === 'PUT').length, beforeAdds, `${scenario}: no provider write`);
  }
  const authFixture = await fixture('auth');
  const beforeAuthEvents = await db.inboundEvent.count(); const calls = requests.length;
  assert.equal((await sendEcho(authFixture.target, 'not-the-auth-token')).status, 401);
  assert.equal(await db.inboundEvent.count(), beforeAuthEvents);
  assert.equal(requests.length, calls);

  const transient = await fixture('transient'); echoReadFailure = 429;
  const transientResponse = await sendEcho(transient.target); const transientId = oneEventId(await transientResponse.json());
  await waitForStatus(db, transientId, 'RETRYABLE_FAILURE');
  const transientEvent = await db.inboundEvent.findUniqueOrThrow({ where: { id: transientId } });
  assert.equal(transientEvent.lastErrorCategory, 'PRODUCT_IMPORT_ECHO_READ_FAILED');
  assert.ok(transientEvent.retryAfter && transientEvent.retryAfter > new Date());
  assert.equal(await db.manualReviewCase.count({ where: { eventId: transientId } }), 0);

  const permanent = await fixture('permanent'); echoReadFailure = 403;
  const permanentResponse = await sendEcho(permanent.target); const permanentId = oneEventId(await permanentResponse.json());
  await waitForStatus(db, permanentId, 'MANUAL_REVIEW');
  assert.equal((await db.inboundEvent.findUniqueOrThrow({ where: { id: permanentId } })).lastErrorCategory, 'PRODUCT_IMPORT_ECHO_READ_FAILED');

  const late = await fixture('late-commit');
  sourceRecords.set(late.id, { id: late.id, meta: { type: 'product' }, name: createdCards.get(late.target)!.name });
  finishImportOnList = { sourceId: late.id, targetId: late.target, originId: late.origin.id };
  const lateResponse = await sendEcho(late.target); const lateId = oneEventId(await lateResponse.json());
  await waitForStatus(db, lateId, 'SUCCEEDED');
  assert.equal(await db.manualReviewCase.count({ where: { eventId: lateId } }), 0, 'a commit overlapping the identity read is not mistaken for an inconsistent failed import');

  // Lower-level budget/clock fixture only. The four preceding public scheduled
  // startup/resume acceptance cases keep their real timers and natural waiting.
  const processor = app.get(ProductCardEventProcessor);
  await processor.onModuleDestroy();
  const prolonged = await fixture('prolonged');
  const waiting = await db.inboundEvent.create({ data: { source: 'BITRIX24', deliveryKey: `echo-budget-${prolonged.id}`,
    eventType: 'ONCRMPRODUCTADD', externalEntityType: 'product', externalEntityId: prolonged.target,
    payload: { event: 'ONCRMPRODUCTADD', data: { FIELDS: { ID: prolonged.target, TYPE: 1 } } },
    status: 'RETRYABLE_FAILURE', attempts: 7, retryAfter: new Date(0) } });
  for (let turn = 0; turn < 12; turn += 1) {
    if (turn) await db.inboundEvent.update({ where: { id: waiting.id }, data: { retryAfter: new Date(0) } }); // only own disposable fixture deadline
    const result = await processor.process(waiting.id);
    assert.equal(result?.status, 'RETRYABLE_FAILURE');
    assert.ok(result && 'reason' in result && result.reason === 'PRODUCT_IMPORT_ECHO_WAITING');
    const saved = await db.inboundEvent.findUniqueOrThrow({ where: { id: waiting.id } });
    assert.equal(saved.attempts, 7, 'waiting neither spends a failure attempt nor erases seven prior genuine failures');
    assert.equal(saved.status, 'RETRYABLE_FAILURE');
    assert.ok(saved.retryAfter && saved.retryAfter > new Date());
    const beforeEarly = requests.length;
    assert.equal(await processor.process(waiting.id), null, 'persisted future deadline prevents another provider read');
    assert.equal(requests.length, beforeEarly);
  }
  assert.equal(await db.manualReviewCase.count({ where: { eventId: waiting.id } }), 0);
});

const syntheticMoyskladAccountId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function auditProductEvent(id: string, kind: 'product' | 'service', action: 'CREATE' | 'UPDATE' = 'CREATE', overrides: Record<string, unknown> = {}) {
  return { action, accountId: syntheticMoyskladAccountId, meta: { type: kind, href: `${fakeBase}ms/api/remap/1.2/entity/${kind}/${id}` }, ...overrides };
}

function auditContext(moment: Date, href?: string) {
  return { moment: toMoyskladLocal(moment), meta: { type: 'audit', href: href ?? `${fakeBase}ms/api/remap/1.2/audit/${randomUUID()}` } };
}

function toMoyskladLocal(date: Date): string {
  const local = new Date(date.getTime() + 3 * 60 * 60 * 1_000);
  return `${local.toISOString().slice(0, 10)} ${local.toISOString().slice(11, 23)}`;
}

function auditBackedProduct(id: string, name: string): Record<string, unknown> {
  return { id, accountId: syntheticMoyskladAccountId, meta: { type: 'product', href: `${fakeBase}ms/api/remap/1.2/entity/product/${id}` },
    name, code: `audit-${id.slice(0, 8)}`, description: 'synthetic authenticated CREATE audit fallback' };
}

async function sendUpdate(kind: 'product' | 'service', id: string, requestId: string) {
  return fetch(`${apiUrl}/webhooks/moysklad/synthetic-product-create-secret?requestId=${encodeURIComponent(requestId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ action: 'UPDATE', meta: { type: kind, href: `${fakeBase}entity/${kind}/${id}` } }] }),
  });
}

function oneEventId(value: unknown): string {
  assert.ok(typeof value === 'object' && value !== null && 'eventId' in value && typeof value.eventId === 'string');
  return value.eventId;
}

function isCreatePath(path: string, kind: 'product' | 'service') {
  const method = new URL(path, fakeBase).pathname.replace(/\.json$/i, '');
  return method.endsWith(kind === 'product' ? 'catalog.product.add' : 'catalog.product.service.add');
}

async function waitForStatus(database: DatabaseService, eventId: string, status: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const event = await database.inboundEvent.findUnique({ where: { id: eventId }, select: { status: true, lastErrorCategory: true } });
    if (event?.status === status) return;
    if (event && ['MANUAL_REVIEW', 'RETRYABLE_FAILURE', 'SKIPPED_UNSUPPORTED_ENTITY'].includes(event.status)) {
      const recentCalls = requests.slice(-20).map(({ method, path, body }) => ({ method, path, body }));
      assert.equal(event.status, status, `event stopped as ${event.status}: ${event.lastErrorCategory}; recent fake API calls=${JSON.stringify(recentCalls)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const event = await database.inboundEvent.findUnique({ where: { id: eventId }, select: { status: true, lastErrorCategory: true } });
  assert.fail(`event ${eventId} did not reach ${status}: ${JSON.stringify(event)}`);
}

async function reply(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  const path = request.url ?? '';
  requests.push({ method: request.method ?? '', path, body });
  response.setHeader('content-type', 'application/json');
  const pathname = new URL(path, fakeBase).pathname;
  const method = pathname.replace(/\.json$/i, '');
  const parsedPath = new URL(path, fakeBase);
  if (/catalog\.product(?:\.service)?\.get$/.test(method) && echoReadFailure !== null) {
    const status = echoReadFailure; echoReadFailure = null;
    response.writeHead(status, { 'retry-after': '30' }); response.end(JSON.stringify({ error: 'synthetic echo read failure' })); return;
  }
  if (method.endsWith('catalog.product.get')) {
    const id = new URLSearchParams(body).get('id') ?? '';
    const record = bitrixCatalogRecords.get(id);
    if (record) { response.writeHead(200); response.end(JSON.stringify({ result: { product: record } })); return; }
  }
  if (method.endsWith('catalog.price.list')) {
    const payload = parseProviderBody(body) as { filter?: { productId?: number; catalogGroupId?: number } };
    const id = String(payload.filter?.productId ?? new URLSearchParams(body).get('filter[productId]') ?? '');
    const prices = (priceRows.get(id) ?? []).filter(row=>payload.filter?.catalogGroupId===undefined||row.catalogGroupId===payload.filter.catalogGroupId);
    response.writeHead(200); response.end(JSON.stringify({ result: { prices, total: prices.length } })); return;
  }
  if (method.endsWith('catalog.price.add')) {
    const payload = parseProviderBody(body) as { fields: { productId: number; catalogGroupId: number; price: number; currency: string } };
    const fields=payload.fields;
    const row={id:String(nextCardId++),productId:fields.productId,catalogGroupId:fields.catalogGroupId,price:fields.price,currency:fields.currency};
    const id=String(fields.productId);priceRows.set(id,[...(priceRows.get(id)??[]),row]);
    await deliverEarlyEcho(createdCards.get(id) ?? {}, 'PRICE');
    response.writeHead(200);response.end(JSON.stringify({result:{price:row}}));return;
  }
  if (method.endsWith('catalog.catalog.get')) {
    response.writeHead(200); response.end(JSON.stringify({ result: { catalog: { vatId: 2 } } })); return;
  }
  if (method.endsWith('catalog.vat.get')) {
    response.writeHead(200); response.end(JSON.stringify({ result: { vat: { rate: 20 } } })); return;
  }
  if (parsedPath.pathname.endsWith('/entity/product')) {
    const filter = parsedPath.searchParams.get('filter') ?? '';
    const name = filter.startsWith('name=') ? filter.slice('name='.length) : '';
    const rows = (moyskladCandidates.get(name) ?? []).map(({ id, created }) => ({ id, name, created, meta: { type: 'product' } }));
    response.writeHead(200); response.end(JSON.stringify({ rows, meta: { size: rows.length, limit: 26, offset: 0 } })); return;
  }
  if (pathname.includes('/entity/product/') || pathname.includes('/entity/service/')) {
    const id = pathname.split('/').at(-1)!;
    const record = sourceRecords.get(id);
    if (record && request.method === 'PUT') {
      const update = JSON.parse(body) as Record<string, unknown>;
      Object.assign(record, update);
      response.writeHead(200); response.end(JSON.stringify(record)); return;
    }
    if (record) { response.writeHead(200); response.end(JSON.stringify(record)); return; }
  }
  if (method.endsWith('catalog.product.getFieldsByFilter') || method.endsWith('catalog.product.service.getFieldsByFilter')) {
    const kind = method.includes('.service.') ? 'service' : 'product';
    const definitions = Object.fromEntries(['name', 'code', 'detailText', 'detailTextType'].map((key) => [key, { type: 'string', isReadOnly: false }]));
    Object.assign(definitions, { property108: { type: 'productproperty', propertyType: 'S', isMultiple: false, isReadOnly: false } });
    response.writeHead(200); response.end(JSON.stringify({ result: { [kind]: definitions } })); return;
  }
  if (method.endsWith('catalog.product.list') || method.endsWith('catalog.product.service.list')) {
    const kind = method.includes('.service.') ? 'service' : 'product';
    const payload = parseProviderBody(body) as { filter?: { xmlId?: string }; start?: number };
    const xmlId = payload.filter?.xmlId ?? new URLSearchParams(body).get('filter[xmlId]');
    const rows = [...createdCards.values()].filter((card) => card.type === (kind === 'service' ? 7 : 1) && card.xmlId === xmlId);
    if (finishImportOnList && xmlId === `MOYSKLAD_PRODUCT_${finishImportOnList.sourceId}`) {
      const own = finishImportOnList; finishImportOnList = null;
      await app!.get(DatabaseService).$transaction(async tx => {
        await tx.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: own.targetId, moyskladId: own.sourceId, moyskladType: 'product', active: true, source: 'AUTO' } });
        await tx.dealOrderReverseProductOperation.update({ where: { moyskladProductId: own.sourceId }, data: { status: 'SUCCEEDED', bitrix24ProductId: own.targetId } });
        await tx.inboundEvent.update({ where: { id: own.originId }, data: { status: 'SUCCEEDED' } });
      });
    }
    response.writeHead(200); response.end(JSON.stringify({ result: { [kind === 'service' ? 'services' : 'products']: rows.slice(payload.start ?? 0), total: rows.length } })); return;
  }
  if (method.endsWith('catalog.product.add') || method.endsWith('catalog.product.service.add')) {
    const kind = method.includes('.service.') ? 'service' : 'product';
    const payload = parseProviderBody(body) as { fields: Record<string, unknown> };
    const id = String(nextCardId++);
    const card = { id: Number(id), type: kind === 'service' ? 7 : 1, ...nativeTextFields(payload.fields) };
    createdCards.set(id, card);
    await deliverEarlyEcho(card, 'ADD');
    response.writeHead(200); response.end(JSON.stringify({ result: { [kind === 'service' ? 'service' : 'element']: card } })); return;
  }
  if (method.endsWith('catalog.product.update') || method.endsWith('catalog.product.service.update')) {
    const kind = method.includes('.service.') ? 'service' : 'product';
    const parameters = new URLSearchParams(body);
    const id = parameters.get('id');
    const fields = Object.fromEntries([...parameters.entries()].flatMap(([key, value]) => {
      const match = /^fields\[([^\]]+)\]$/.exec(key);
      if (!match) return [];
      const field = match[1]!;
      return [[field, field === 'measure' ? Number(value) : value]];
    }));
    const card = createdCards.get(String(id));
    if (!card || card.type !== (kind === 'service' ? 7 : 1)) { response.writeHead(404); response.end(JSON.stringify({ error: 'not found' })); return; }
    Object.assign(card, nativeTextFields(fields));
    response.writeHead(200); response.end(JSON.stringify({ result: true })); return;
  }
  if (method.endsWith('catalog.price.update')) {
    const parameters = new URLSearchParams(body);
    const id = parameters.get('id');
    const price = [...priceRows.values()].flat().find((row) => row.id === id);
    if (!price) { response.writeHead(404); response.end(JSON.stringify({ error: 'not found' })); return; }
    price.price = Number(parameters.get('fields[price]'));
    price.currency = parameters.get('fields[currency]') ?? price.currency;
    response.writeHead(200); response.end(JSON.stringify({ result: true })); return;
  }
  if (/crm\.deal|crm\.item\.productrow|customerorder|invoiceout|productrows\.set/i.test(path) && /\.(?:add|update|delete|set)(?:\.json)?$/i.test(path)) {
    documentWriteAttempts += 1;
    fakeDocumentRows[0]!.price = -999;
    response.writeHead(200); response.end(JSON.stringify({ result: true })); return;
  }
  if (method.endsWith('catalog.product.get') || method.endsWith('catalog.product.service.get')) {
    const kind = method.includes('.service.') ? 'service' : 'product';
    const payload = parseProviderBody(body) as { id: string };
    const card = createdCards.get(String(payload.id));
    if (!card) { response.writeHead(404); response.end(JSON.stringify({ error: 'not found' })); return; }
    response.writeHead(200); response.end(JSON.stringify({ result: { [kind]: card } })); return;
  }
  if (method.endsWith('catalog.price.list')) {
    const productId = new URLSearchParams(body).get('filter[productId]');
    const prices = priceRows.get(String(productId)) ?? [];
    response.writeHead(200); response.end(JSON.stringify({ result: { prices: structuredClone(prices), total: prices.length } })); return;
  }
  response.writeHead(404); response.end(JSON.stringify({ error: 'unexpected fake API call' }));
}

// Reproduces the actual portal: a raw supplementary character truncates the
// ordinary field. This runs on BOTH real CREATE and UPDATE adapter paths.
function nativeTextFields(fields: Record<string, unknown>) {
  if (typeof fields.detailText !== 'string') return fields;
  return { ...fields, detailText: fields.detailText.split(/[\u{10000}-\u{10ffff}]/u)[0] };
}

function parseProviderBody(body: string): Record<string, unknown> {
  try { return JSON.parse(body) as Record<string, unknown>; }
  catch { return Object.fromEntries(new URLSearchParams(body)); }
}
