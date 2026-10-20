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

function assertIsolatedTarget(value: string) {
  const target = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(target.hostname), 'refusing to run product-create event integration against a non-local database');
  assert.ok(['/aerosystems_offline_acceptance_test', '/sync_issue79_integration_create_event_test', '/sync_issue79_date_codex_test'].includes(target.pathname), 'requires an explicitly allowlisted disposable database');
  const schema = target.searchParams.get('schema') ?? '';
  assert.ok(/^issue61_create_event_[a-z0-9_]+$/.test(schema) || target.pathname === '/sync_issue79_date_codex_test' && schema === 'issue79_date_codex', 'requires a dedicated fresh test schema');
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
  fakeApi = createServer((request, response) => { void reply(request, response); });
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
});

test('product-create event harness accepts only its dedicated loopback databases and fresh schemas', () => {
  assert.doesNotThrow(() => assertIsolatedTarget('postgresql://x@127.0.0.1:58341/sync_issue79_integration_create_event_test?schema=issue61_create_event_issue79'));
  assert.doesNotThrow(() => assertIsolatedTarget('postgresql://x@127.0.0.1:58341/sync_issue79_date_codex_test?schema=issue79_date_codex'));
  assert.throws(() => assertIsolatedTarget('postgresql://x@127.0.0.1:58341/sync_issue79_date_codex_test?schema=public'), /dedicated fresh test schema/);
  assert.throws(() => assertIsolatedTarget('postgresql://x@127.0.0.1:58341/production?schema=issue61_create_event_issue79'), /allowlisted disposable database/);
  assert.throws(() => assertIsolatedTarget('postgresql://x@example.invalid:58341/sync_issue79_integration_create_event_test?schema=issue61_create_event_issue79'), /non-local/);
  assert.throws(() => assertIsolatedTarget('postgresql://x@127.0.0.1:58341/sync_issue79_integration_create_event_test?schema=public'), /dedicated fresh test schema/);
});

test('post-boundary product and service CREATE intake creates/readbacks one card and durable native-kind pair; repeats and pre-boundary events do not duplicate', { skip: !databaseUrl }, async () => {
  assert.ok(app);
  requests.length = 0;
  const database = app.get(DatabaseService);
  const settingsVersion = 910_000 + Math.floor(Math.random() * 80_000);
  const config = {
    schemaVersion: 1,
    productCatalogRuntime: { bitrix24CatalogId: '77', moyskladFields: ['name', 'code', 'description'] },
    rules: [{ id: 'catalog-name', entity: 'catalog', sourceField: 'name', targetField: 'name',
      bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }],
    groups: [], references: { units: [], priceTypes: [], dictionaries: [], namedPairs: [] }, serviceCounterpartyId: null,
  };
  await database.fieldSettingsVersion.create({ data: { version: settingsVersion, config } });
  await database.fieldSettingsState.upsert({ where: { id: 'global' }, create: { id: 'global', version: settingsVersion }, update: { version: settingsVersion } });

  for (const kind of ['product', 'service'] as const) {
    const id = randomUUID();
    sourceRecords.set(id, { id, meta: { type: kind }, name: `${kind}-after-boundary`, code: `${kind}-code`, description: `${kind} description`, created: '2026-02-01T00:00:00.000Z', updated: '2026-10-18T00:00:00.000Z' });
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
      salePrices: [{ value: 25, currency: { isoCode: 'RUB', meta: { href: `${fakeBase}ms/api/remap/1.2/entity/currency/12345678-1234-1234-1234-123456789abc` } }, priceType: { meta: { href: `${fakeBase}ms/api/remap/1.2/context/companysettings/pricetype/${priceType}` } } }],
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
      { value: 10, currency: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/currency/${currencyId}` }, isoCode: 'RUB' }, priceType: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/context/companysettings/pricetype/${configuredPriceType}` } } },
      { value: 777, currency: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/currency/${currencyId}` }, isoCode: 'RUB' }, priceType: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/context/companysettings/pricetype/${unconfiguredPriceType}` } } },
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
      { value: 18.25, currency: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/currency/${currencyId}` }, isoCode: 'RUB' }, priceType: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/context/companysettings/pricetype/${configuredPriceType}` } } },
      { value: 777, currency: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/currency/${currencyId}` }, isoCode: 'RUB' }, priceType: { meta: { href: `https://api.moysklad.ru/api/remap/1.2/context/companysettings/pricetype/${unconfiguredPriceType}` } } },
    ];
    const updateResponse = await sendUpdate('product', productId, 'catalog-price-uom-update');
    assert.equal(updateResponse.status, 200);
    const updateEventId = oneEventId(await updateResponse.json());
    await waitForStatus(database, updateEventId, 'SUCCEEDED');

    assert.equal(productCard.measure, 4, 'configured MySklad UOM mapping is written to the existing B24 catalog card');
    assert.equal(priceRows.get(bitrix24Id)?.find((row) => row.id === b24PriceId)?.price, 18.25, 'configured sale price updates the exact existing B24 catalog price row');
    assert.equal(priceRows.get(bitrix24Id)?.find((row) => row.id === unrelatedPrice.id)?.price, 777, 'unconfigured price type remains untouched');
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
  if (method.endsWith('catalog.product.get')) {
    const id = new URLSearchParams(body).get('id') ?? '';
    const record = bitrixCatalogRecords.get(id);
    if (record) { response.writeHead(200); response.end(JSON.stringify({ result: { product: record } })); return; }
  }
  if (method.endsWith('catalog.price.list')) {
    const id = new URLSearchParams(body).get('filter[productId]') ?? '';
    const prices = priceRows.get(id) ?? [];
    response.writeHead(200); response.end(JSON.stringify({ result: { prices, total: prices.length } })); return;
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
    const definitions = Object.fromEntries(['name', 'code', 'detailText'].map((key) => [key, { type: 'string', isReadOnly: false }]));
    response.writeHead(200); response.end(JSON.stringify({ result: { [kind]: definitions } })); return;
  }
  if (method.endsWith('catalog.product.list') || method.endsWith('catalog.product.service.list')) {
    const kind = method.includes('.service.') ? 'service' : 'product';
    const payload = parseProviderBody(body) as { filter?: { xmlId?: string }; start?: number };
    const rows = [...createdCards.values()].filter((card) => card.type === (kind === 'service' ? 7 : 1) && card.xmlId === payload.filter?.xmlId);
    response.writeHead(200); response.end(JSON.stringify({ result: { [kind === 'service' ? 'services' : 'products']: rows.slice(payload.start ?? 0), total: rows.length } })); return;
  }
  if (method.endsWith('catalog.product.add') || method.endsWith('catalog.product.service.add')) {
    const kind = method.includes('.service.') ? 'service' : 'product';
    const payload = parseProviderBody(body) as { fields: Record<string, unknown> };
    const id = String(nextCardId++);
    const card = { id: Number(id), type: kind === 'service' ? 7 : 1, ...payload.fields };
    createdCards.set(id, card);
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
    Object.assign(card, fields);
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

function parseProviderBody(body: string): Record<string, unknown> {
  try { return JSON.parse(body) as Record<string, unknown>; }
  catch { return Object.fromEntries(new URLSearchParams(body)); }
}
