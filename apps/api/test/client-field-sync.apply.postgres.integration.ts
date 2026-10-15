import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/database.service';
import { ClientSyncProcessor } from '../src/clients/client-sync.processor';
import { HttpClientSyncGateway } from '../src/clients/client-sync.gateway';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { EntityPairService } from '../src/pairs/entity-pair.service';

const suffix = randomUUID();
const sourceId = `client-apply-${suffix}`;
const targetId = randomUUID();
const pairId = `client-apply-pair-${suffix}`;
const eventIds: string[] = [];
let database: DatabaseService;
let server: Server;
let address: string;
let bitrix: Record<string, unknown>;
let moysklad: Record<string, unknown>;
const writes: Array<{ method: string; path: string; body: string }> = [];

before(async () => {
  assert.equal(process.env.CLIENT_FIELD_SYNC_APPLY_TEST_ISOLATED, '1', 'set CLIENT_FIELD_SYNC_APPLY_TEST_ISOLATED=1 only for the disposable loopback test schema');
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  const dryDatabaseUrl = new URL(process.env.DRY_DATABASE_URL ?? '');
  assert.match(databaseUrl.hostname, /^(localhost|127\.0\.0\.1)$/i);
  assert.match(databaseUrl.searchParams.get('schema') ?? '', /client53_field_sync_apply_test/i);
  assert.notEqual(databaseUrl.searchParams.get('schema'), dryDatabaseUrl.searchParams.get('schema'));
  process.env.SYNC_MODE = 'apply';
  database = new DatabaseService();
  const settings = new FieldSettingsService(database, {
    async fieldCatalogs() {
      return {
        bitrix24: [{ code: 'TITLE', writable: true }],
        moysklad: [{ code: 'name', writable: true }],
      };
    },
  } as never, {} as EntityPairService);
  await settings.active();
  await database.entityPair.deleteMany({ where: { id: pairId } });
  await database.inboundEvent.deleteMany({ where: { deliveryKey: { startsWith: `client-apply-${suffix}-` } } });

  bitrix = { ID: sourceId, TITLE: 'Initial Company' };
  moysklad = { id: targetId, name: 'Initial Company' };
  server = createServer(async (request, response) => {
    assert.equal(request.socket.remoteAddress, '127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const path = request.url ?? '';
    const method = request.method ?? 'GET';
    writes.push({ method, path, body });
    response.setHeader('content-type', 'application/json');

    if (path.endsWith('/crm.company.get.json')) {
      response.end(JSON.stringify({ result: bitrix }));
      return;
    }
    if (path.endsWith('/crm.company.update.json')) {
      const form = new URLSearchParams(body);
      const title = form.get('fields[TITLE]');
      if (title !== null) bitrix = { ...bitrix, TITLE: title };
      response.end(JSON.stringify({ result: true }));
      return;
    }
    if (path.endsWith(`/entity/counterparty/${targetId}`) && method === 'GET') {
      response.end(JSON.stringify(moysklad));
      return;
    }
    if (path.endsWith(`/entity/counterparty/${targetId}`) && method === 'PUT') {
      const fields = JSON.parse(body) as Record<string, unknown>;
      moysklad = { ...moysklad, ...fields };
      response.end(JSON.stringify(moysklad));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: `Unexpected fake request: ${method} ${path}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  address = `http://127.0.0.1:${port}`;
  process.env.BITRIX24_REST_BASE_URL = `${address}/rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${address}/api/remap/1.2/`;
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-loopback-token';

  const config = {
    ...((await settings.active()).config),
    rules: [{ id: 'company-title-name-apply', entity: 'companies', sourceField: 'TITLE', targetField: 'name', criticality: 'optional',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } },
    }],
    groups: [],
  };
  await settings.save(config, 'synthetic-loopback-token');
  await database.entityPair.create({ data: { id: pairId, entityType: 'COMPANY', bitrix24Id: sourceId, moyskladId: targetId, moyskladType: 'counterparty', active: true, source: 'MANUAL' } });
});

after(async () => {
  if (database) {
    await database.entityPairSyncState.deleteMany({ where: { pairId } });
    await database.entityPairBaseline.deleteMany({ where: { pairId } });
    await database.entityPair.deleteMany({ where: { id: pairId } });
    await database.inboundEvent.deleteMany({ where: { id: { in: eventIds } } });
    await database.$disconnect();
  }
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('APPLY client field writes use only fake loopback providers and persist confirmed readbacks', async () => {
  const settings = new FieldSettingsService(database, {} as never, {} as EntityPairService);
  const gateway = new HttpClientSyncGateway();
  const processor = new ClientSyncProcessor(database, settings, { read: async () => ({ mode: 'on' }) } as never, gateway, { readCompanyInn: async () => null } as never);
  const accept = async (key: string, source: 'BITRIX24' | 'MOYSKLAD') => {
    const event = await settings.saveAcceptedEvent({
      source, deliveryKey: `client-apply-${suffix}-${key}`, eventType: source === 'BITRIX24' ? 'ONCRMCOMPANYUPDATE' : 'UPDATE',
      externalEntityId: source === 'BITRIX24' ? sourceId : targetId,
      externalEntityType: source === 'BITRIX24' ? 'company' : 'counterparty', payload: { event: key }, directionDisabled: false,
    });
    eventIds.push(event.id);
    return event.id;
  };

  assert.equal(await processor.process(await accept('baseline', 'BITRIX24')), 'BASELINE');
  bitrix = { ...bitrix, TITLE: 'Updated in B24' };
  assert.equal(await processor.process(await accept('forward', 'BITRIX24')), 'SYNCED');
  assert.equal(moysklad.name, 'Updated in B24', 'the loopback MySklad PUT was read back before state advanced');
  assert.equal((await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId } }).then((state) => (state.moyskladValues as Record<string, unknown>).name)), 'Updated in B24');

  moysklad = { ...moysklad, name: 'Updated in MySklad' };
  assert.equal(await processor.process(await accept('reverse', 'MOYSKLAD')), 'SYNCED');
  assert.equal(bitrix.TITLE, 'Updated in MySklad', 'the loopback Bitrix update was read back before state advanced');
  assert.ok(writes.some((request) => request.method === 'PUT' && request.path.includes('/entity/counterparty/')));
  assert.ok(writes.some((request) => request.method === 'POST' && request.path.endsWith('/crm.company.update.json')));
  assert.ok(writes.every((request) => new URL(request.path, address).origin === address), 'all requests remained inside the loopback fake provider');
});
