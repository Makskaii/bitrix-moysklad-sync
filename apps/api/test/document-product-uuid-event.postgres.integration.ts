import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DatabaseService } from '../src/database.service';
import { EventsController, EventIntakeService } from '../src/events.controller';
import { SyncModeService } from '../src/sync-mode.service';
import { DatabaseRecoveryService } from '../src/database-recovery.service';
import { DryRunDocumentReader } from '../src/dry-run-document-reader';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { EventWorkerLeaseService } from '../src/event-worker-lease.service';
import { DealOrderCreationPreparer } from '../src/deals-orders/deal-order-creation-preparer.service';
import { DealOrderCreateOperationService } from '../src/deals-orders/deal-order-create-operation.service';
import { CLIENT_DEPENDENCY_RESOLVER } from '../src/clients/client-dependency-resolver';
import { PairResolutionProvider } from '../src/pairs/pair-resolution.provider';
import { PAIR_RESOLVER } from '../src/pairs/pair-resolver';
import { PairFirstEventProcessor } from '../src/pairs/pair-first-event.processor';
import { setDatabaseRecoveryReady } from '../src/external-write-guard';

type Mode = 'valid' | 'missing' | 'empty' | 'source-missing' | 'malformed' | 'archived' | 'occupied' | '429' | '503' | 'network' | 'bad-json' | '403' | 'assortment-missing';
type Source = { id: string; cardId: string; uuid: string; mode: Mode; number: string | null };
const sources = new Map<string, Source>();
const orders = new Map<string, Record<string, any>>();
const refs = { company: randomUUID(), organization: randomUUID(), store: randomUUID(), employee: randomUUID(), currency: randomUUID(), state: randomUUID(), unit: randomUUID() };
const nativeFetch = globalThis.fetch;
let app: INestApplication, apiUrl = '', companyPair: any, creates = 0, reads = 0, sequence = 0;
const msBase = 'https://uuid6-ms.invalid/api/remap/1.2/';
const reference = (type: string, id: string) => ({ meta: { type, href: `${msBase}entity/${type}/${id}` } });
const config: any = { version: 1, createdAt: new Date(), config: {
  schemaVersion: 1, rules: [], groups: [], references: { units: [{ bitrix24Id: 9, bitrix24Code: '796', moyskladId: refs.unit, status: 'configured' }], priceTypes: [], dictionaries: [] },
  productCatalogRuntime: { bitrix24CatalogId: '14' },
  dealOrderRuntime: { nativeOrderNumberingVerified: true, defaultOrganizationId: refs.organization, defaultStoreId: refs.store, defaultEmployeeId: refs.employee,
    currencies: [{ bitrix24Code: 'RUB', moyskladId: refs.currency }], stages: [{ bitrix24StageId: 'PREPARATION', moyskladId: refs.state, creationEnabled: true }], organizations: [], stores: [], employees: [] },
} };
const settings = {
  async saveAcceptedEvent(input: any) { return app.get(DatabaseService).inboundEvent.create({ data: {
    source: input.source, deliveryKey: input.deliveryKey, eventType: input.eventType, externalEntityId: input.externalEntityId,
    externalEntityType: input.externalEntityType, payload: input.payload, status: 'RECEIVED',
  }, select: { id: true } }); },
  async eventConfig() { return config; },
};
const dependencies = { async resolveForDocument() { return { status: 'RESOLVED', pair: companyPair, companyPair }; } };
@Module({ controllers: [EventsController], providers: [
  DatabaseService, EventIntakeService, SyncModeService, EventWorkerLeaseService, PairResolutionProvider,
  { provide: PAIR_RESOLVER, useExisting: PairResolutionProvider }, PairFirstEventProcessor, DealOrderCreationPreparer, DealOrderCreateOperationService,
  { provide: FieldSettingsService, useValue: settings }, { provide: CLIENT_DEPENDENCY_RESOLVER, useValue: dependencies },
  { provide: DatabaseRecoveryService, useValue: { assertReady: async () => true, launchBoundary: async () => new Date('2026-10-20T14:00:00Z') } },
  { provide: DryRunDocumentReader, useValue: { readDealOrderCreationTimestamp: async () => new Date() } },
] })
class UuidEventModule {}

before(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, '127.0.0.1'); assert.match(url.pathname, /root_product_identity_uuid6.*_test$/);
  process.env.SYNC_MODE = 'apply'; process.env.SYNC_STATE = 'on';
  delete process.env.CONTROLLED_LIVE_TEST_MODE;
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-uuid6';
  process.env.BITRIX24_REST_BASE_URL = 'https://uuid6-bitrix.invalid/rest/';
  process.env.MOYSKLAD_API_BASE_URL = msBase; process.env.MOYSKLAD_API_TOKEN = 'synthetic-only';
  setDatabaseRecoveryReady(true);
  globalThis.fetch = providerFetch;
  app = await NestFactory.create(UuidEventModule, { logger: false });
  const db = app.get(DatabaseService);
  await db.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on', offSince: null } });
  await db.syncDirectionSetting.upsert({ where: { entityKey: 'deals-orders' }, create: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: false }, update: { bitrix24ToMoysklad: true, moyskladToBitrix24: false } });
  companyPair = await db.entityPair.findFirst({ where: { entityType: 'COMPANY', bitrix24Id: '960001' } }) ?? await db.entityPair.create({ data: { entityType: 'COMPANY', bitrix24Id: '960001', moyskladId: refs.company, moyskladType: 'counterparty' } });
  refs.company = companyPair.moyskladId;
  await app.listen(0, '127.0.0.1'); apiUrl = await app.getUrl();
  // Public intake still enqueues the actual worker; scheduled recovery is
  // stopped only to control failure/deadline interleavings in these postchecks.
  await app.get(PairFirstEventProcessor).onModuleDestroy();
});
after(async () => {
  if (app) { (app.getHttpServer() as import('node:http').Server).closeAllConnections(); await app.close(); }
  globalThis.fetch = nativeFetch; setDatabaseRecoveryReady(false);
});

for (const [mode, reason] of [
  ['missing', 'PRODUCT_UUID_TARGET_NOT_FOUND'], ['malformed', 'PRODUCT_UUID_INVALID'],
  ['empty', 'PRODUCT_UUID_MISSING'], ['source-missing', 'PRODUCT_UUID_SOURCE_NOT_FOUND'],
  ['archived', 'PRODUCT_UUID_TARGET_INVALID'], ['occupied', 'PRODUCT_UUID_PAIR_CONFLICT'],
] as const) test(`actual public callback + preparer: ${mode} UUID is actionable, terminal and cannot create an empty order`, async () => {
  const source = fixture(mode), db = app.get(DatabaseService), before = creates;
  if (mode === 'occupied') await db.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: `${source.cardId}9`, moyskladId: source.uuid, moyskladType: 'product' } });
  const id = await callback(source.id), event = await completed(id, 'MANUAL_REVIEW');
  assert.equal(event.lastErrorCategory, reason); assert.equal(event.retryAfter, null); assert.equal(event.attempts, 1);
  const incident = await db.manualReviewCase.findUniqueOrThrow({ where: { eventId: id } });
  assert.match(JSON.stringify(incident.diagnostic), /сохраните сделку ещё раз/);
  const operation = await db.dealOrderCreateOperation.findUniqueOrThrow({ where: { bitrix24DealId: source.id } });
  assert.equal(operation.status, 'WAITING'); assert.equal(operation.attemptedAt, null); assert.equal(operation.moyskladOrderId, null);
  assert.equal(await db.entityPair.count({ where: { entityType: 'DEAL', bitrix24Id: source.id } }), 0);
  assert.equal(await db.entityPair.count({ where: { entityType: 'PRODUCT', bitrix24Id: source.cardId } }), 0);
  assert.equal(await db.pairReviewCase.count({ where: { sourceEntityId: source.id } }), 0);
  const beforeReads = reads;
  await app.get(PairFirstEventProcessor).process(id);
  assert.equal(reads, beforeReads); assert.deepEqual(await db.inboundEvent.findUniqueOrThrow({ where: { id } }), event);
  assert.equal(creates, before);
});

test('corrected source NEW public event creates one nonempty order; old event/incident stay unchanged, repeat cannot duplicate', async () => {
  const source = fixture('missing'), db = app.get(DatabaseService), before = creates;
  const oldId = await callback(source.id), old = await completed(oldId, 'MANUAL_REVIEW');
  const oldIncident = await db.manualReviewCase.findUniqueOrThrow({ where: { eventId: oldId } });
  source.uuid = randomUUID(); source.mode = 'valid';
  const fixedId = await callback(source.id); await completed(fixedId, 'SUCCEEDED');
  const operation = await db.dealOrderCreateOperation.findUniqueOrThrow({ where: { bitrix24DealId: source.id } });
  assert.equal(operation.status, 'SUCCEEDED'); assert.equal(creates, before + 1);
  const target = orders.get(operation.moyskladOrderId!)!;
  assert.equal(target.positions.rows.length, 1); assert.equal(target.positions.rows[0].quantity, 2); assert.equal(target.positions.rows[0].price, 1234);
  assert.equal(target.positions.rows[0].assortment.meta.href, reference('product', source.uuid).meta.href);
  const pair = await db.entityPair.findFirstOrThrow({ where: { entityType: 'DEAL', bitrix24Id: source.id } });
  assert.equal(pair.moyskladId, operation.moyskladOrderId);
  assert.equal(await db.dealOrderPositionPair.count({ where: { pairId: pair.id } }), 1);
  await completed(await callback(source.id), 'SUCCEEDED');
  assert.equal(creates, before + 1);
  assert.deepEqual(await db.inboundEvent.findUniqueOrThrow({ where: { id: oldId } }), old);
  assert.deepEqual(await db.manualReviewCase.findUniqueOrThrow({ where: { eventId: oldId } }), oldIncident);
});

test('actual 429 honors both retry headers, future due gate makes no reads, eighth genuine read failure reaches managed review', async () => {
  const source = fixture('429'), db = app.get(DatabaseService), before = creates, start = Date.now();
  const id = await callback(source.id), event = await completed(id, 'RETRYABLE_FAILURE');
  assert.equal(event.lastErrorCategory, 'PRODUCT_UUID_PROVIDER_READ_FAILED'); assert.equal(event.attempts, 1);
  assert.ok(event.retryAfter!.getTime() >= start + 180_000); assert.ok(event.retryAfter!.getTime() < Date.now() + 181_000);
  const beforeReads = reads; await app.get(PairFirstEventProcessor).process(id); assert.equal(reads, beforeReads);
  assert.equal((await db.inboundEvent.findUniqueOrThrow({ where: { id } })).attempts, 1);
  // Local owned failure-budget fixture only; no source/live event mutation.
  await db.inboundEvent.update({ where: { id }, data: { attempts: 7, retryAfter: null } });
  await app.get(PairFirstEventProcessor).process(id);
  const exhausted = await completed(id, 'MANUAL_REVIEW'); assert.equal(exhausted.attempts, 8); assert.equal(exhausted.retryAfter, null);
  assert.equal(exhausted.lastErrorCategory, 'PRODUCT_UUID_READ_RETRY_LIMIT_EXCEEDED'); assert.equal(creates, before);
});

for (const mode of ['503', 'network', 'bad-json'] as const) test(`${mode} target response stays retryable, not a false missing UUID`, async () => {
  const source = fixture(mode), before = creates;
  const event = await completed(await callback(source.id), 'RETRYABLE_FAILURE');
  assert.equal(event.lastErrorCategory, 'PRODUCT_UUID_PROVIDER_READ_FAILED'); assert.ok(event.retryAfter); assert.equal(creates, before);
});

test('403 access rejection is actionable but not misreported as missing product', async () => {
  const event = await completed(await callback(fixture('403').id), 'MANUAL_REVIEW');
  assert.equal(event.lastErrorCategory, 'PRODUCT_UUID_PROVIDER_READ_REJECTED'); assert.equal(event.retryAfter, null);
});

test('saved product pair with native assortment missing stops the entire create, never silently drops its row', async () => {
  const source = fixture('assortment-missing'), db = app.get(DatabaseService), before = creates;
  await db.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: source.cardId, moyskladId: source.uuid, moyskladType: 'product' } });
  const event = await completed(await callback(source.id), 'MANUAL_REVIEW');
  assert.equal(event.lastErrorCategory, 'PRODUCT_UUID_TARGET_NOT_FOUND'); assert.equal(creates, before);
  assert.equal(await db.entityPair.count({ where: { entityType: 'DEAL', bitrix24Id: source.id } }), 0);
});

test('new preflight classification never rewrites or terminalizes an existing uncertain order CREATE', async () => {
  const source = fixture('missing'), db = app.get(DatabaseService), before = creates;
  const operation = await db.dealOrderCreateOperation.create({ data: { bitrix24DealId: source.id, syncId: randomUUID(),
    status: 'PENDING', attemptedAt: new Date(), payload: { immutable: 'unknown-provider-outcome' }, settingsVersion: 1, lastErrorCategory: 'CREATE_RETRYABLE' } });
  const event = await completed(await callback(source.id), 'RETRYABLE_FAILURE');
  assert.equal(event.lastErrorCategory, 'PRODUCT_UUID_TARGET_NOT_FOUND'); assert.ok(event.retryAfter);
  assert.deepEqual(await db.dealOrderCreateOperation.findUniqueOrThrow({ where: { bitrix24DealId: source.id } }), operation);
  assert.equal(await db.manualReviewCase.count({ where: { eventId: event.id } }), 0); assert.equal(creates, before);
});

test('OFF prevents actual preparer provider reads and all new links', async () => {
  const source = fixture('valid'), db = app.get(DatabaseService), before = reads;
  await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'off' } });
  try {
    await assert.rejects(app.get(DealOrderCreationPreparer).prepare({ bitrix24DealId: source.id, eventId: 'off', eventConfig: config }), /SERVICE_MODE_NOT_ON/);
    assert.equal(reads, before); assert.equal(await db.entityPair.count({ where: { bitrix24Id: source.cardId } }), 0);
  } finally { await db.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } }); }
});

function fixture(mode: Mode): Source {
  const source = { id: `96${Date.now()}${++sequence}`, cardId: `97${Date.now()}${sequence}`, uuid: randomUUID(), mode, number: null };
  sources.set(source.id, source); return source;
}
async function callback(id: string): Promise<string> {
  const response = await nativeFetch(`${apiUrl}/webhooks/bitrix24`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ event: 'ONCRMDEALUPDATE', 'auth[application_token]': 'synthetic-uuid6', 'data[FIELDS][ID]': id }) });
  assert.equal(response.status, 200, await response.clone().text()); return (await response.json() as any).eventId;
}
async function completed(id: string, status: string) {
  const db = app.get(DatabaseService), deadline = Date.now() + 5000;
  let event = await db.inboundEvent.findUniqueOrThrow({ where: { id } });
  while (event.status !== status && Date.now() < deadline) { await new Promise(r => setTimeout(r, 20)); event = await db.inboundEvent.findUniqueOrThrow({ where: { id } }); }
  assert.equal(event.status, status, JSON.stringify({ id, status: event.status, reason: event.lastErrorCategory })); return event;
}
async function providerFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.ok(['uuid6-bitrix.invalid', 'uuid6-ms.invalid'].includes(url.hostname), 'provider sandbox forbids real network');
  reads++; const form = new URLSearchParams(String(init?.body ?? ''));
  if (url.hostname === 'uuid6-bitrix.invalid') {
    if (url.pathname.endsWith('/catalog.product.get.json')) {
      const source = [...sources.values()].find(s => s.cardId === form.get('id'))!;
      if (source.mode === 'source-missing') return Response.json({}, { status: 404 });
      return Response.json({ result: { product: { id: source.cardId, iblockId: 14, active: 'Y', type: 1, property108: { value: source.mode === 'malformed' ? 'invalid-uuid' : source.mode === 'empty' ? '' : source.uuid } } } });
    }
    const dealId = form.get('id') ?? form.get('filter[=ownerId]'), source = sources.get(dealId!)!;
    if (url.pathname.endsWith('/crm.deal.get.json')) return Response.json({ result: { ID: source.id, COMPANY_ID: '960001', CURRENCY_ID: 'RUB', STAGE_ID: 'PREPARATION', UF_CRM_1729757435964: source.number } });
    if (url.pathname.endsWith('/crm.deal.update.json')) { source.number = form.get('fields[UF_CRM_1729757435964]'); return Response.json({ result: true }); }
    if (url.pathname.endsWith('/crm.item.productrow.list')) return Response.json({ result: { productRows: [{ id: '301', productId: source.cardId, measureCode: 796, quantity: 2, price: 12.34, discountTypeId: 2, discountRate: 0, discountSum: 0, taxRate: null, taxIncluded: 'N' }] }, total: 1 });
    throw new Error(`Unexpected synthetic Bitrix operation ${url.pathname.split('/').pop()}`);
  }
  const source = [...sources.values()].find(s => url.pathname.endsWith('/' + s.uuid) || url.searchParams.get('filter') === `id=${s.uuid}`);
  if (source) {
    assert.equal(new Headers(init?.headers).get('accept'), 'application/json;charset=utf-8');
    if (source.mode === 'network') throw new TypeError('synthetic connection loss');
    if (source.mode === 'bad-json') return new Response('broken json');
    if (source.mode === '429') return new Response('rate limited', { status: 429, headers: { 'Retry-After': '120', 'X-Lognex-Retry-After': '180000' } });
    if (source.mode === '503' || source.mode === '403') return new Response('provider unavailable', { status: Number(source.mode) });
    if (source.mode === 'missing') return Response.json({ errors: [{ code: 1021 }] }, { status: 404 });
    const product = { id: source.uuid, ...reference('product', source.uuid), archived: source.mode === 'archived', uom: reference('uom', refs.unit) };
    return url.pathname.endsWith('/assortment') ? Response.json({ rows: source.mode === 'assortment-missing' ? [] : [product] }) : Response.json(product);
  }
  if (url.pathname.endsWith('/entity/customerorder') && init?.method === 'POST') {
    const payload = JSON.parse(String(init.body)), id = randomUUID(); creates++;
    const order = { ...payload, id, name: `TEST-${creates}`, ...reference('customerorder', id), positions: { rows: payload.positions.map((p: any) => ({ ...p, id: randomUUID() })) } };
    orders.set(id, order); return Response.json(order);
  }
  const target = orders.get(url.pathname.split('/').pop()!); if (target) return Response.json(target);
  const state = url.pathname.match(/\/metadata\/states\/([0-9a-f-]{36})$/); if (state) return Response.json({ id: state[1], meta: { type: 'state' } });
  const ref = url.pathname.match(/\/entity\/(counterparty|organization|store|employee|currency)\/([0-9a-f-]{36})$/);
  if (ref) return Response.json({ id: ref[2], ...reference(ref[1], ref[2]) });
  throw new Error('Unexpected synthetic MS operation');
}
