import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ProductCardEventProcessor } from '../src/products/product-card-event.processor';
import { ProductCardRuntimeService } from '../src/products/product-card-runtime.service';
import { DatabaseService } from '../src/database.service';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { SyncModeService } from '../src/sync-mode.service';
import { ProductDuplicateAliasService } from '../src/products/product-duplicate-alias.service';

const databaseUrl = process.env.PRODUCT_CATALOG_TEST_DATABASE_URL;

function assertIsolatedTarget(value: string, enabled: string | undefined) {
  assert.equal(enabled, '1', 'PRODUCT_CATALOG_TEST_ISOLATED=1 is required');
  const url = new URL(value);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname), 'test DB must be loopback');
  assert.match(url.pathname, /^\/sync_issue79_integration_catalog_test$/i, 'test must use the dedicated issue-79 integration DB');
  assert.equal(url.searchParams.get('schema'), 'issue79_catalog_test', 'test must use the dedicated issue-79 schema');
}

test('product restore end-to-end harness rejects a non-isolated database target', () => {
  assert.throws(() => assertIsolatedTarget('postgresql://x@127.0.0.1:5432/production?schema=public', '1'), /dedicated issue-79 integration DB/);
  assert.throws(() => assertIsolatedTarget('postgresql://x@example.invalid:5432/sync_issue79_catalog_test?schema=issue79_catalog_test', '1'), /loopback/);
  assert.throws(() => assertIsolatedTarget('postgresql://x@127.0.0.1:5432/sync_issue79_integration_catalog_test?schema=public', '1'), /dedicated issue-79 schema/);
});

test('public form-urlencoded product signal restores only Bitrix24 from an active MySklad pair and is idempotent', { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  assertIsolatedTarget(databaseUrl, process.env.PRODUCT_CATALOG_TEST_ISOLATED);
  const old = { mode: process.env.SYNC_MODE, token: process.env.BITRIX24_EVENT_APPLICATION_TOKEN, url: process.env.DATABASE_URL };
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'issue79-test-token';
  process.env.DATABASE_URL = databaseUrl;
  const database = new DatabaseService();
  const pairId = randomUUID();
  const bitrixId = String(Date.now());
  const moyskladId = randomUUID();
  const bitrix = { name: 'edited in Bitrix24', detailText: null, unitId: null, prices: [], fields: {}, updatedAt: null, createdAt: null };
  const moysklad = { name: 'canonical MySklad name', detailText: null, unitId: null, prices: [], fields: {}, updatedAt: null, createdAt: '2026-10-01T00:00:00Z' };
  const writes: string[] = [];
  const provider = {
    readBitrix24: async () => structuredClone(bitrix),
    readMoysklad: async () => structuredClone(moysklad),
    updateBitrix24: async (_id: string, fields: Record<string, unknown>) => { writes.push('BITRIX24'); Object.assign(bitrix, fields); },
    updateBitrix24Price: async () => { writes.push('BITRIX24_PRICE'); },
    updateMoysklad: async () => { writes.push('MOYSKLAD'); throw new Error('MySklad catalog writes are forbidden on this signal path'); },
  };
  const config = { rules: [{ entity: 'catalog', sourceField: 'name', targetField: 'name',
    bitrix24ToMoysklad: { enabled: false, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } } }], references: { units: [], priceTypes: [] } };
  const settings = { eventConfig: async () => ({ version: 1, config }), version: async () => ({ version: 1, config }) };
  const mode = { read: async () => ({ mode: 'on' as const }), isDirectionEnabled: async (_entity: string, direction: string) => direction === 'moyskladToBitrix24' };
  const runtime = new ProductCardRuntimeService(database, provider as never, settings as never, mode as never);

  @Module({ controllers: [EventsController], providers: [
    EventIntakeService,
    { provide: DatabaseService, useValue: database },
    { provide: SyncModeService, useValue: mode },
  ] })
  class IntakeModule {}

  let app: INestApplication | undefined;
  try {
    await database.syncSetting.upsert({ where: { id: 'global' }, create: { serviceMode: 'on' }, update: { serviceMode: 'on' } });
    await database.syncDirectionSetting.upsert({ where: { entityKey: 'products-variations' },
      create: { entityKey: 'products-variations', bitrix24ToMoysklad: false, moyskladToBitrix24: true },
      update: { bitrix24ToMoysklad: false, moyskladToBitrix24: true } });
    await database.entityPair.create({ data: { id: pairId, entityType: 'PRODUCT', bitrix24Id: bitrixId, moyskladId, moyskladType: 'product', active: true, source: 'MANUAL' } });
    app = await NestFactory.create(IntakeModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/webhooks/bitrix24`;
    const postSignal = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ event: 'ONCRMPRODUCTUPDATE', 'auth[application_token]': 'issue79-test-token', 'data[FIELDS][ID]': bitrixId }) });
    const intake = await postSignal();
    assert.equal(intake.status, 200);
    const { eventId } = await intake.json() as { eventId: string };
    const duplicateAliases = new ProductDuplicateAliasService(database);
    const processor = new ProductCardEventProcessor(database, provider as never, settings as never, runtime,
      undefined, undefined, undefined, undefined, duplicateAliases);
    assert.equal((await processor.process(eventId))?.status, 'SYNCED');
    assert.equal(bitrix.name, 'canonical MySklad name');
    assert.deepEqual(writes, ['BITRIX24']);
    const stored = await database.inboundEvent.findUnique({ where: { id: eventId } });
    assert.equal(stored?.status, 'SUCCEEDED');
    assert.equal(JSON.stringify(stored?.payload).includes('issue79-test-token'), false, 'application token must not be persisted');

    const echo = await postSignal();
    const { eventId: echoId } = await echo.json() as { eventId: string };
    assert.equal((await processor.process(echoId))?.status, 'UNCHANGED');
    assert.deepEqual(writes, ['BITRIX24'], 'restored state must not echo another write');

    const aliases = duplicateAliases;
    const evidence = { nameExact: true as const, configuredPriceType: '2', priceEqual: true as const, currencyVerified: true as const,
      taxComparable: true as const, selectionReason: 'EARLIEST_CREATION_DATE' as const,
      duplicateCreatedAt: null, canonicalCreatedAt: null, selectionCandidateCreatedAt: null, selectionCandidateCreatedAtSource: 'unavailable' };
    const alias = await aliases.record({ duplicateBitrix24Id: '9001', canonicalPairId: pairId, moyskladType: 'product',
      reason: 'EXACT_NAME_CONFIGURED_PRICE_CURRENCY_AND_TAX_MATCH', evidence });
    assert.equal((await aliases.resolveBitrix24Product('9001')).status, 'ALIAS');
    const duplicateSignalResponse = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ event: 'ONCRMPRODUCTUPDATE', 'auth[application_token]': 'issue79-test-token', 'data[FIELDS][ID]': '9001' }) });
    assert.equal(duplicateSignalResponse.status, 200);
    const { eventId: duplicateEventId } = await duplicateSignalResponse.json() as { eventId: string };
    const duplicateResult = await processor.process(duplicateEventId);
    assert.equal(duplicateResult?.status, 'UNCHANGED', JSON.stringify(duplicateResult));
    assert.equal((await database.productDuplicateAlias.findUnique({ where: { id: alias.id } }))?.canonicalPairId, pairId);
    assert.deepEqual(writes, ['BITRIX24'], 'an alias signal must resolve to the canonical target without duplicate MySklad writes');
  } finally {
    await app?.close();
    await database.entityPairSyncState.deleteMany({ where: { pairId } }).catch(() => undefined);
    await database.productDuplicateAlias.deleteMany({ where: { canonicalPairId: pairId } }).catch(() => undefined);
    await database.entityPair.deleteMany({ where: { id: pairId } }).catch(() => undefined);
    await database.inboundEvent.deleteMany({ where: { externalEntityId: bitrixId, source: 'BITRIX24' } }).catch(() => undefined);
    await database.inboundEntityLock.deleteMany({ where: { entityKey: `PRODUCT_PAIR:${pairId}` } }).catch(() => undefined);
    await database.$disconnect();
    if (old.mode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = old.mode;
    if (old.token === undefined) delete process.env.BITRIX24_EVENT_APPLICATION_TOKEN; else process.env.BITRIX24_EVENT_APPLICATION_TOKEN = old.token;
    if (old.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = old.url;
  }
});
