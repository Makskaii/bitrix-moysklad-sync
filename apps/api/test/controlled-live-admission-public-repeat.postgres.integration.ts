import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DatabaseService } from '../src/database.service';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { EventDispatcherService } from '../src/event-dispatcher.service';
import { ClientSyncProcessor, CLIENT_SYNC_GATEWAY } from '../src/clients/client-sync.processor';
import { HttpClientSyncGateway } from '../src/clients/client-sync.gateway';
import { HttpClientCandidateGateway, CLIENT_CANDIDATE_GATEWAY } from '../src/clients/client-candidate.gateway';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { EntityPairService } from '../src/pairs/entity-pair.service';
import { SyncModeService } from '../src/sync-mode.service';
import { ControlledLiveTestAdmissionService } from '../src/controlled-live-test-admission.service';
import { createControlledLiveTestPolicy } from '../src/controlled-live-test-policy';
import { installControlledLiveFetchGuard, setControlledLiveTestWriteCheck, setDatabaseRecoveryReady } from '../src/external-write-guard';
import { setVerifiedControlledLiveProviderNamespace } from '../src/controlled-live-test-namespace';

const databaseName = 'sync_issue79_client_admission_public_repeat_test';
const schemaName = 'issue79_client_admission_public_repeat_test';
const sourceId = `b24-${randomUUID()}`;
const targetId = randomUUID();
const providerNamespaceBase = {
  bitrix24UserId: '3664',
  moyskladAccountId: 'b0b309ee-13e3-11e9-9109-f8fc0001f188',
};
const deliveryIds: string[] = [];
let database: DatabaseService;
let settings: FieldSettingsService;
let mode: SyncModeService;
let admission: ControlledLiveTestAdmissionService;
let clientProcessor: ClientSyncProcessor;
let dispatcher: EventDispatcherService;
let intake: EventIntakeService;
let app: INestApplication;
let apiUrl: string;
let provider: Server;
let providerUrl: string;
let runId: string;
let sourceName: string;
let sourceCreatedAt: Date;
let targetName: string;
let externalRequests: string[] = [];
let controlledGuardFailures: string[] = [];
let providerOutcomes: string[] = [];
let clientBoundaries: string[] = [];
let fetchBoundaries: string[] = [];
let previousEnvironment: Record<string, string | undefined> = {};
let originalFetch: typeof fetch;
let manifestDirectory: string;

@Module({
  controllers: [EventsController],
  providers: [
    { provide: EventIntakeService, useFactory: () => intake },
    { provide: EventDispatcherService, useFactory: () => dispatcher },
  ],
})
class PublicControlledClientSyncModule {}

before(async () => {
  assert.equal(process.env.CONTROLLED_LIVE_ADMISSION_PUBLIC_REPEAT_POSTGRES_ISOLATED, '1', 'explicit disposable-DB opt-in required');
  const connectionString = process.env.CONTROLLED_LIVE_ADMISSION_PUBLIC_REPEAT_DATABASE_URL;
  assert.ok(connectionString, 'set CONTROLLED_LIVE_ADMISSION_PUBLIC_REPEAT_DATABASE_URL to the dedicated local test DB');
  const connection = new URL(connectionString);
  assert.match(connection.hostname, /^(127\.0\.0\.1|localhost)$/i, 'refusing non-loopback PostgreSQL');
  assert.equal(decodeURIComponent(connection.pathname.slice(1)), databaseName, 'refusing any other database');
  assert.equal(connection.searchParams.get('schema'), schemaName, 'refusing any other schema');

  for (const name of [
    'DATABASE_URL', 'SYNC_MODE', 'CONTROLLED_LIVE_TEST_MODE', 'CONTROLLED_LIVE_TEST_INSTANCE',
    'CONTROLLED_LIVE_TEST_FAKE_PROVIDER_HTTP', 'CONTROLLED_LIVE_TEST_MANIFEST',
    'BITRIX24_EVENT_APPLICATION_TOKEN', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN',
  ]) previousEnvironment[name] = process.env[name];
  process.env.DATABASE_URL = connectionString;
  process.env.SYNC_MODE = 'apply';
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
  process.env.CONTROLLED_LIVE_TEST_INSTANCE = 'isolated';
  process.env.CONTROLLED_LIVE_TEST_FAKE_PROVIDER_HTTP = 'enabled';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-public-ingress-token';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-public-test-only-token';

  runId = `LIVE-TEST-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
  sourceName = `тест ${runId} repeated public update company`;
  targetName = sourceName;
  sourceCreatedAt = new Date(Date.now() - 60_000);

  provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const method = request.method ?? 'GET';
    const path = request.url ?? '/';
    externalRequests.push(`${method} ${path}`);
    if (method === 'POST' && path.endsWith('/crm.company.get.json')) {
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const exactId = params.get('id') === sourceId;
      providerOutcomes.push(`company-read-exact-id:${exactId}`);
      if (!exactId) { response.writeHead(404).end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: {
        ID: sourceId, TITLE: sourceName, DATE_CREATE: sourceCreatedAt.toISOString(),
        DATE_MODIFY: new Date().toISOString(), COMMENTS: 'first delivery',
      } }));
      return;
    }
    if (method === 'POST' && path.endsWith('/crm.requisite.list')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: [] }));
      return;
    }
    if (method === 'GET' && path.endsWith(`/entity/counterparty/${targetId}`)) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: targetId, name: targetName, companyType: 'legal', created: sourceCreatedAt.toISOString(), updated: new Date().toISOString(),
      }));
      return;
    }
    response.writeHead(405, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address() as AddressInfo;
  providerUrl = `http://127.0.0.1:${address.port}`;
  const providerNamespace = { ...providerNamespaceBase, bitrix24PortalOrigin: providerUrl };
  process.env.BITRIX24_REST_BASE_URL = `${providerUrl}/rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${providerUrl}/api/remap/1.2/`;
  setVerifiedControlledLiveProviderNamespace(providerNamespace);

  const manifest = {
    runId, testDatabaseName: databaseName, testSchemaName: schemaName, providerNamespace,
    records: [{ entity: 'client:COMPANY', direction: 'BITRIX24_TO_MOYSKLAD', name: sourceName, syntheticOnly: true,
      sourceSystem: 'BITRIX24', sourceNativeId: sourceId, targetSystem: 'MOYSKLAD', targetNativeId: targetId,
      createdAfterUtc: new Date(sourceCreatedAt.getTime() - 1_000).toISOString(), allowedActions: ['UPDATE'] }],
  };
  manifestDirectory = await mkdtemp(join(tmpdir(), 'issue79-public-repeat-'));
  const manifestPath = join(manifestDirectory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  process.env.CONTROLLED_LIVE_TEST_MANIFEST = manifestPath;

  originalFetch = globalThis.fetch;
  const controlledPolicy = createControlledLiveTestPolicy(manifest, connectionString);
  setControlledLiveTestWriteCheck((provider, operation, nativeId, entity) => {
    try { controlledPolicy(provider, operation, nativeId, entity); }
    catch (error) {
      controlledGuardFailures.push(error instanceof Error ? error.message : 'UNKNOWN_GUARD_FAILURE');
      throw error;
    }
  });
  installControlledLiveFetchGuard(providerNamespace);
  setDatabaseRecoveryReady(true);

  database = new DatabaseService();
  await database.$connect();
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  await database.syncDirectionSetting.upsert({ where: { entityKey: 'contacts-companies' }, create: {
    entityKey: 'contacts-companies', bitrix24ToMoysklad: true, moyskladToBitrix24: false,
  }, update: { bitrix24ToMoysklad: true, moyskladToBitrix24: false } });
  settings = new FieldSettingsService(database, {} as never, new EntityPairService(database));
  await settings.active();
  const version = await database.fieldSettingsVersion.findFirstOrThrow({ orderBy: { version: 'desc' } });
  const config = version.config as Record<string, unknown>;
  await database.fieldSettingsVersion.update({ where: { version: version.version }, data: {
    config: { ...config, rules: [], groups: [], childResourceBindings: [] } as any,
  } });
  await database.entityPair.create({ data: {
    entityType: 'COMPANY', bitrix24Id: sourceId, moyskladId: targetId,
    moyskladType: 'counterparty', active: true, source: 'MANUAL',
  } });

  mode = new SyncModeService(database);
  admission = new ControlledLiveTestAdmissionService(database);
  const guardedFetch = globalThis.fetch;
  const tracedFetch: typeof fetch = async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    let provider = 'unknown';
    try {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.startsWith('/rest/')) provider = 'BITRIX24';
      else if (url.pathname.startsWith('/api/remap/1.2/')) provider = 'MOYSKLAD';
    } catch { /* safe class-only trace below */ }
    try {
      const response = await guardedFetch(input, init);
      fetchBoundaries.push(`${provider}:${method.toUpperCase()}:HTTP_${response.status}`);
      return response;
    } catch (error) {
      const code = error instanceof Error && /^CONTROLLED_LIVE_TEST_[A-Z0-9_]+$/.test(error.message)
        ? error.message : error instanceof TypeError ? 'TYPE_ERROR' : 'FETCH_ERROR';
      fetchBoundaries.push(`${provider}:${method.toUpperCase()}:THREW_${error instanceof Error ? error.constructor.name : 'NON_ERROR'}:${code}`);
      throw error;
    }
  };
  clientProcessor = new ClientSyncProcessor(database, settings, mode,
    traceClientGateway(new HttpClientSyncGateway(tracedFetch)),
    traceClientGateway(new HttpClientCandidateGateway(database, tracedFetch)),
    undefined, undefined, admission);
  dispatcher = new EventDispatcherService(database,
    { enqueue: () => undefined } as any,
    { enqueue: () => undefined } as any,
    [clientProcessor]);
  intake = new EventIntakeService(database, mode, undefined, settings, undefined, admission);
  app = await NestFactory.create(PublicControlledClientSyncModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
});

after(async () => {
  app?.getHttpServer().closeAllConnections();
  await app?.close();
  if (database) {
    await database.inboundEvent.deleteMany({ where: { id: { in: deliveryIds } } });
    if (runId) await database.controlledTestSourceBinding.deleteMany({ where: { runId } });
    await database.$disconnect();
  }
  if (provider) {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
  if (originalFetch) globalThis.fetch = originalFetch;
  setControlledLiveTestWriteCheck(null);
  setDatabaseRecoveryReady(true);
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  if (manifestDirectory) await rm(manifestDirectory, { recursive: true, force: true });
});

test('public repeated company UPDATEs stay in event scope and reuse one exclusive pair', async (t) => {
  assert.equal(await database.entityPair.count({ where: { bitrix24Id: sourceId, moyskladId: targetId, active: true } }), 1);
  const postUpdate = async (label: string) => {
    const response = await originalFetch(`${apiUrl}/webhooks/bitrix24`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'ONCRMCOMPANYUPDATE', auth: { application_token: 'synthetic-public-ingress-token' },
        data: { FIELDS: { ID: sourceId } }, updateMarker: label }),
    });
    assert.equal(response.status, 200);
    const ack = await response.json() as { accepted: boolean; eventId: string };
    assert.equal(ack.accepted, true);
    assert.ok(ack.eventId);
    deliveryIds.push(ack.eventId);
    const terminal = await waitForTerminalEvent(ack.eventId);
    const logs = await database.operationalLog.findMany({ where: { referenceId: ack.eventId }, select: { category: true, message: true } });
    const admissions = await database.controlledTestAdmission.count({ where: { eventId: ack.eventId } });
    const pairs = await database.entityPair.count({ where: { bitrix24Id: sourceId, moyskladId: targetId, active: true } });
    return { eventId: ack.eventId, terminal, logs, admissions, pairs };
  };

  const first = await postUpdate('one');
  const second = await postUpdate('two');
  assert.notEqual(first.eventId, second.eventId, 'independent Bitrix deliveries retain separate durable event IDs');
  assert.ok(['SUCCEEDED', 'UNCHANGED'].includes(first.terminal.status), JSON.stringify({ status: first.terminal.status, lastErrorCategory: first.terminal.lastErrorCategory, logs: first.logs, admissions: first.admissions, pairs: first.pairs, externalRequests, controlledGuardFailures, providerOutcomes, clientBoundaries, fetchBoundaries }));
  assert.ok(['SUCCEEDED', 'UNCHANGED'].includes(second.terminal.status), JSON.stringify({ status: second.terminal.status, lastErrorCategory: second.terminal.lastErrorCategory, logs: second.logs, admissions: second.admissions, pairs: second.pairs, externalRequests, controlledGuardFailures, providerOutcomes, clientBoundaries, fetchBoundaries }));
  assert.equal(first.admissions, 1, 'first public delivery persisted its event admission before any downstream sync outcome');
  assert.equal(second.admissions, 1, 'repeated public delivery persisted a distinct event admission');
  t.diagnostic(JSON.stringify({
    scope: 'public intake, real dispatcher and processor, isolated PostgreSQL; no field writes configured',
    outcomes: [first, second].map(({ terminal, admissions: eventAdmissions }) => ({ status: terminal.status, lastErrorCategory: terminal.lastErrorCategory, eventAdmissions })),
    clientBoundaries, fetchBoundaries, providerOutcomes,
  }));
  assert.equal(first.terminal.attempts, 1);
  assert.equal(second.terminal.attempts, 1);

  const admissions = await database.controlledTestAdmission.findMany({ where: { eventId: { in: [first.eventId, second.eventId] } } });
  assert.equal(admissions.length, 2, 'each independently delivered public event has its own admission row');
  assert.equal(admissions[0]!.bindingId, admissions[1]!.bindingId, 'event-specific rows share the one immutable source-target binding');
  assert.equal(await database.controlledTestSourceBinding.count({ where: { runId, entity: 'client:COMPANY', bitrix24NativeId: sourceId, moyskladNativeId: targetId } }), 1);
  assert.equal(await database.entityPair.count({ where: { bitrix24Id: sourceId, moyskladId: targetId, active: true } }), 1, 'repeated updates never create a duplicate EntityPair');
  assert.ok(externalRequests.length > 0);
  assert.ok(externalRequests.every((request) => request.startsWith('GET ') || request.endsWith('/crm.company.get.json') || request.endsWith('/crm.requisite.list')),
    `unexpected external operation: ${externalRequests.map((request) => request.split(' ')[0]).join(',')}`);
});

async function waitForTerminalEvent(eventId: string) {
  const terminal = new Set(['SUCCEEDED', 'UNCHANGED', 'MANUAL_REVIEW', 'RETRYABLE_FAILURE', 'SKIPPED_DIRECTION_DISABLED']);
  const deadline = Date.now() + 10_000;
  let event = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
  while (!terminal.has(event.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    event = await database.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
  }
  assert.ok(terminal.has(event.status), 'publicly dispatched client event reached a terminal state');
  return event;
}

function traceClientGateway<T extends object>(gateway: T): T {
  return new Proxy(gateway, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || !String(property).startsWith('read')) return value;
      return async (...args: unknown[]) => {
        const operation = String(property);
        clientBoundaries.push(`${operation}:start`);
        try {
          const result = await value.apply(target, args);
          clientBoundaries.push(`${operation}:ok`);
          return result;
        } catch (error) {
          const provider = error && typeof error === 'object' && 'provider' in error ? String((error as any).provider) : 'unknown';
          const status = error && typeof error === 'object' && 'status' in error ? String((error as any).status) : 'unknown';
          clientBoundaries.push(`${operation}:error:${error instanceof Error ? error.constructor.name : 'non-error'}:${provider}:${status}`);
          throw error;
        }
      };
    },
  });
}
