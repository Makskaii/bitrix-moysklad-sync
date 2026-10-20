import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../src/database.service';
import { ClientLifecycleService } from '../src/clients/client-lifecycle.service';

const suffix = randomUUID();
const companyPairId = `lifecycle-company-${suffix}`;
const contactPairId = `lifecycle-contact-${suffix}`;
const dealPairId = `lifecycle-deal-${suffix}`;
const productPairId = `lifecycle-product-${suffix}`;
const sameUuidProductPairId = `lifecycle-same-uuid-product-${suffix}`;
const sameUuidServicePairId = `lifecycle-same-uuid-service-${suffix}`;
const msId = randomUUID();
const msOrderId = randomUUID();
const msProductId = randomUUID();
const sameUuidMsId = randomUUID();
const b24CompanyId = `58${Date.now()}`;
const b24ContactId = `59${Date.now()}`;
const b24DealId = `60${Date.now()}`;
const b24ProductId = `61${Date.now()}`;
const b24SameUuidProductId = `63${Date.now()}`;
const b24SameUuidServiceId = `64${Date.now()}`;
let database: DatabaseService;
let service: ClientLifecycleService;
let oldFetch: typeof fetch;
let oldMode: string | undefined;
let oldMsBase: string | undefined;
let oldMsToken: string | undefined;
let oldB24Base: string | undefined;

function makeGateway() {
  return {
    readBitrix: async (_entity: string, id: string) => ({ ID: id }),
    readMoysklad: async (_type: string, id: string) => ({ id }),
  };
}

async function createDeleteEvent(
  id: string,
  status = 'RECEIVED',
  source = 'MOYSKLAD',
  externalEntityType = 'counterparty',
  externalEntityId: string = msId,
  eventType: string = 'DELETE',
) {
  return database.inboundEvent.create({ data: {
    source, deliveryKey: `lifecycle-${suffix}-${id}`, eventType,
    externalEntityId, externalEntityType, payload: {} as Prisma.InputJsonValue, status,
  } });
}

before(async () => {
  assert.equal(process.env.CLIENT_LIFECYCLE_TEST_ISOLATED, '1', 'set CLIENT_LIFECYCLE_TEST_ISOLATED=1 only for the disposable local PostgreSQL schema');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.match(url.hostname, /^(localhost|127\.0\.0\.1)$/i);
  assert.match(url.searchParams.get('schema') ?? '', /^client58_lifecycle_test$/);
  oldFetch = globalThis.fetch;
  oldMode = process.env.SYNC_MODE;
  oldMsBase = process.env.MOYSKLAD_API_BASE_URL;
  oldMsToken = process.env.MOYSKLAD_API_TOKEN;
  oldB24Base = process.env.BITRIX24_REST_BASE_URL;
  process.env.SYNC_MODE = 'apply';
  process.env.MOYSKLAD_API_BASE_URL = 'https://fixture.invalid/api/remap/1.2';
  process.env.MOYSKLAD_API_TOKEN = 'fixture-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://bitrix-fixture.invalid/rest/test/';
  database = new DatabaseService();
  await database.$connect();
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  service = new ClientLifecycleService(database, makeGateway() as never);
  await database.entityPair.create({ data: {
    id: companyPairId, entityType: 'COMPANY', bitrix24Id: b24CompanyId, moyskladId: msId,
    moyskladType: 'counterparty', active: true,
  } });
  await database.entityPair.create({ data: {
    id: dealPairId, entityType: 'DEAL', bitrix24Id: b24DealId, moyskladId: msOrderId,
    moyskladType: 'customerorder', active: true,
  } });
  await database.entityPair.create({ data: {
    id: productPairId, entityType: 'PRODUCT', bitrix24Id: b24ProductId, moyskladId: msProductId,
    moyskladType: 'product', active: true,
  } });
  await database.entityPair.create({ data: {
    id: contactPairId, entityType: 'CONTACT', bitrix24Id: b24ContactId, moyskladId: msId,
    moyskladType: 'counterparty', active: true,
  } });
});

after(async () => {
  if (database) {
    await database.inboundEvent.deleteMany({ where: { deliveryKey: { startsWith: `lifecycle-${suffix}-` } } });
    await database.inboundEntityLock.deleteMany({ where: { eventId: { startsWith: 'lifecycle:' } } });
    await database.entityPair.deleteMany({ where: { id: { in: [companyPairId, contactPairId, dealPairId, productPairId, sameUuidProductPairId, sameUuidServicePairId] } } });
    await database.$disconnect();
  }
  globalThis.fetch = oldFetch;
  if (oldMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = oldMode;
  if (oldMsBase === undefined) delete process.env.MOYSKLAD_API_BASE_URL; else process.env.MOYSKLAD_API_BASE_URL = oldMsBase;
  if (oldMsToken === undefined) delete process.env.MOYSKLAD_API_TOKEN; else process.env.MOYSKLAD_API_TOKEN = oldMsToken;
  if (oldB24Base === undefined) delete process.env.BITRIX24_REST_BASE_URL; else process.env.BITRIX24_REST_BASE_URL = oldB24Base;
});

test('PostgreSQL tombstone is idempotent, entity-type scoped, retryable on outage, and restores the same pair', async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/entity/counterparty/')) return new Response(null, { status: 404 });
    if (url.includes('crm.company.get.json')) return Response.json({ result: { ID: b24CompanyId } });
    if (url.includes('crm.timeline.comment.list.json')) return Response.json({ result: [{ COMMENT: `[sync-tombstone:${companyPairId}]` }] });
    throw new Error('Unexpected provider request in fake-provider test');
  };
  const first = await createDeleteEvent('first');
  await (service as unknown as { processDeleteEvent(id: string): Promise<void> }).processDeleteEvent(first.id);
  const deletedCompany = await database.entityPair.findUniqueOrThrow({ where: { id: companyPairId } });
  const unaffectedContact = await database.entityPair.findUniqueOrThrow({ where: { id: contactPairId } });
  assert.equal(deletedCompany.lifecycleStatus, 'TOMBSTONED');
  assert.equal(deletedCompany.active, false);
  assert.equal(unaffectedContact.lifecycleStatus, 'ACTIVE');
  assert.equal(unaffectedContact.active, true);
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: first.id } })).status, 'SUCCEEDED');

  const repeated = await createDeleteEvent('repeated');
  await (service as unknown as { processDeleteEvent(id: string): Promise<void> }).processDeleteEvent(repeated.id);
  assert.equal((await database.entityPair.findUniqueOrThrow({ where: { id: companyPairId } })).lifecycleStatus, 'TOMBSTONED');

  const restored = await service.restore(companyPairId, true, 'BITRIX24_USER:42');
  assert.deepEqual(restored, { status: 'RESTORED', pairId: companyPairId });
  const restoredPair = await database.entityPair.findUniqueOrThrow({ where: { id: companyPairId } });
  assert.equal(restoredPair.lifecycleStatus, 'ACTIVE');
  assert.equal(restoredPair.active, true);
  assert.equal(restoredPair.bitrix24Id, b24CompanyId);
  assert.equal(restoredPair.moyskladId, msId);

  globalThis.fetch = async () => new Response(null, { status: 503 });
  const outage = await createDeleteEvent('outage');
  await (service as unknown as { processDeleteEvent(id: string): Promise<void> }).processDeleteEvent(outage.id);
  assert.equal((await database.entityPair.findUniqueOrThrow({ where: { id: companyPairId } })).lifecycleStatus, 'ACTIVE');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: outage.id } })).status, 'RETRYABLE_FAILURE');
});

test('PostgreSQL applies provider-confirmed lifecycle to deal/order and product pairs, then manually restores exact product identity', async () => {
  let productReads = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes(`/entity/customerorder/${msOrderId}`)) return new Response(null, { status: 404 });
    if (url.includes('crm.deal.get.json')) return Response.json({ result: { ID: b24DealId } });
    if (url.includes('crm.timeline.comment.list.json')) return Response.json({ result: [{ COMMENT: `[sync-tombstone:${dealPairId}]` }] });
    if (url.includes('catalog.product.get.json') && url.includes('/rest/test/')) {
      productReads += 1;
      if (productReads === 1) return Response.json({ error: '0', error_description: 'The product does not exist' });
      return Response.json({ result: { product: { id: b24ProductId } } });
    }
    if (url.includes(`/entity/product/${msProductId}`)) return Response.json({ id: msProductId, meta: { type: 'product' } });
    throw new Error('Unexpected provider request in fake-provider test');
  };
  const dealDelete = await createDeleteEvent('deal-delete', 'RECEIVED', 'MOYSKLAD', 'customerorder', msOrderId);
  await (service as unknown as { processDeleteEvent(id: string): Promise<void> }).processDeleteEvent(dealDelete.id);
  assert.equal((await database.entityPair.findUniqueOrThrow({ where: { id: dealPairId } })).lifecycleStatus, 'TOMBSTONED');
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: dealDelete.id } })).status, 'SUCCEEDED');

  const productDelete = await createDeleteEvent('product-delete', 'RECEIVED', 'BITRIX24', 'product', b24ProductId, 'CATALOG.PRODUCT.ON.DELETE');
  await (service as unknown as { processDeleteEvent(id: string): Promise<void> }).processDeleteEvent(productDelete.id);
  const deletedProduct = await database.entityPair.findUniqueOrThrow({ where: { id: productPairId } });
  assert.equal(deletedProduct.lifecycleStatus, 'TOMBSTONED');
  assert.equal(deletedProduct.moyskladId, msProductId);
  assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: productDelete.id } })).status, 'SUCCEEDED');

  const restored = await service.restore(productPairId, true, 'BITRIX24_USER:42');
  assert.deepEqual(restored, { status: 'RESTORED', pairId: productPairId });
  const activeProduct = await database.entityPair.findUniqueOrThrow({ where: { id: productPairId } });
  assert.equal(activeProduct.lifecycleStatus, 'ACTIVE');
  assert.equal(activeProduct.bitrix24Id, b24ProductId);
  assert.equal(activeProduct.moyskladId, msProductId);
  assert.deepEqual(await service.restore(productPairId, true, 'BITRIX24_USER:42'), { status: 'ALREADY_ACTIVE', pairId: productPairId });
  assert.equal(await database.adminAuditEntry.count({ where: { action: 'CLIENT_LIFECYCLE_RESTORED', targetId: productPairId } }), 1);

  await database.entityPair.update({ where: { id: productPairId }, data: {
    active: false, lifecycleStatus: 'TOMBSTONED', tombstonedAt: new Date(), tombstoneSource: 'BITRIX24', tombstoneReason: 'TEST_ROLLBACK',
  } });
  await database.$executeRawUnsafe(`CREATE FUNCTION reject_lifecycle_restore_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."action" = 'CLIENT_LIFECYCLE_RESTORED' THEN RAISE EXCEPTION 'forced lifecycle audit failure'; END IF; RETURN NEW; END; $$`);
  await database.$executeRawUnsafe(`CREATE TRIGGER reject_lifecycle_restore_audit BEFORE INSERT ON "AdminAuditEntry" FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_restore_audit()`);
  try {
    await assert.rejects(() => service.restore(productPairId, true, 'BITRIX24_USER:42'), /forced lifecycle audit failure/);
    const rolledBack = await database.entityPair.findUniqueOrThrow({ where: { id: productPairId } });
    assert.equal(rolledBack.lifecycleStatus, 'TOMBSTONED');
    assert.equal(rolledBack.active, false);
  } finally {
    await database.$executeRawUnsafe('DROP TRIGGER reject_lifecycle_restore_audit ON "AdminAuditEntry"');
    await database.$executeRawUnsafe('DROP FUNCTION reject_lifecycle_restore_audit()');
  }
});

test('MoySklad service DELETE selects the native-kind pair when product and service share one UUID', async () => {
  await database.entityPair.create({ data: {
    id: sameUuidProductPairId, entityType: 'PRODUCT', bitrix24Id: b24SameUuidProductId, moyskladId: sameUuidMsId,
    moyskladType: 'product', active: false, lifecycleStatus: 'TOMBSTONED', tombstonedAt: new Date('2026-10-01T00:00:00.000Z'),
    tombstoneSource: 'BITRIX24', tombstoneReason: 'HISTORICAL_PRODUCT',
  } });
  await database.entityPair.create({ data: {
    id: sameUuidServicePairId, entityType: 'PRODUCT', bitrix24Id: b24SameUuidServiceId, moyskladId: sameUuidMsId,
    moyskladType: 'service', active: true,
  } });
  const providerPaths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    providerPaths.push(new URL(url).pathname);
    if (url.includes(`/entity/service/${sameUuidMsId}`)) return new Response(null, { status: 404 });
    throw new Error(`Unexpected provider request for the same-UUID service deletion: ${new URL(url).pathname}`);
  };
  const event = await createDeleteEvent('same-uuid-service-delete', 'RECEIVED', 'MOYSKLAD', 'service', sameUuidMsId);
  await (service as unknown as { processDeleteEvent(id: string): Promise<void> }).processDeleteEvent(event.id);

  const deletedService = await database.entityPair.findUniqueOrThrow({ where: { id: sameUuidServicePairId } });
  const preservedProduct = await database.entityPair.findUniqueOrThrow({ where: { id: sameUuidProductPairId } });
  assert.equal(deletedService.lifecycleStatus, 'TOMBSTONED');
  assert.equal(deletedService.active, false);
  assert.equal(preservedProduct.lifecycleStatus, 'TOMBSTONED');
  assert.equal(preservedProduct.active, false);
  assert.equal(preservedProduct.tombstoneSource, 'BITRIX24');
  assert.equal(preservedProduct.tombstoneReason, 'HISTORICAL_PRODUCT');
  assert.deepEqual(providerPaths, [`/api/remap/1.2/entity/service/${sameUuidMsId}`], 'the provider read uses the service endpoint and does not probe/tombstone the product counterpart');
  const terminal = await database.inboundEvent.findUniqueOrThrow({ where: { id: event.id } });
  assert.equal(terminal.status, 'SUCCEEDED');
});
