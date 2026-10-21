import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ContactSyncProcessor } from '../src/contact-sync.service';
import { DatabaseService } from '../src/database.service';
import { EventDispatcherService, ADDITIONAL_EVENT_PROCESSORS } from '../src/event-dispatcher.service';
import { EventIntakeService, EventsController } from '../src/events.controller';
import { PairFirstEventProcessor } from '../src/pairs/pair-first-event.processor';
import { SyncModeService } from '../src/sync-mode.service';

const suffix = randomUUID();
const eventPrefix = `contact-mode-gate-${suffix}-`;
const contactPrefix = `contact-mode-gate-${suffix}-`;
let database: DatabaseService;
let mockServer: Server;
let mockUrl: string;
let oldSyncMode: string | undefined;
let oldBitrixToken: string | undefined;
let oldMoyskladSecret: string | undefined;
let oldMoyskladToken: string | undefined;
let oldBitrixBase: string | undefined;
let oldMoyskladBase: string | undefined;
let sourceReadsHeld = false;
let sourceReadArrivals = 0;
let sourceReadBarrier: Promise<void> = Promise.resolve();
let releaseSourceReadBarrier: () => void = () => {};
let sourceReadsReady: Promise<void> = Promise.resolve();
let resolveSourceReadsReady: () => void = () => {};
const providerOperations: string[] = [];
const openApps: INestApplication[] = [];
const contactEmails = new Map<string, string>();
let writes = 0;

@Module({
  controllers: [EventsController],
  providers: [
    DatabaseService,
    SyncModeService,
    EventIntakeService,
    ContactSyncProcessor,
    EventDispatcherService,
    { provide: PairFirstEventProcessor, useValue: { supports: () => false, enqueue: () => undefined } },
    { provide: ADDITIONAL_EVENT_PROCESSORS, useValue: [] },
  ],
})
class ContactModeGateTestModule {}

async function createApp(): Promise<{ app: INestApplication; apiUrl: string }> {
  const app = await NestFactory.create(ContactModeGateTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  assert.ok(address && typeof address === 'object');
  openApps.push(app);
  return { app, apiUrl: `http://127.0.0.1:${address.port}` };
}

function holdNextSourceReads() {
  sourceReadArrivals = 0;
  sourceReadsHeld = true;
  sourceReadBarrier = new Promise<void>((resolve) => { releaseSourceReadBarrier = resolve; });
  sourceReadsReady = new Promise<void>((resolve) => { resolveSourceReadsReady = resolve; });
}

function releaseSourceReads() {
  sourceReadsHeld = false;
  releaseSourceReadBarrier();
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

async function postContactUpdate(apiUrl: string, contactId: string) {
  return fetch(`${apiUrl}/webhooks/bitrix24`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'ONCRMCONTACTUPDATE', auth: { application_token: 'synthetic-contact-mode-gate-token' },
      data: { FIELDS: { ID: contactId } },
    }),
  });
}

async function createContactFixture(label: string) {
  const bitrix24ContactId = `${contactPrefix}${label}-b24`;
  const moyskladCounterpartyId = `${contactPrefix}${label}-ms`;
  const pair = await database.contactPair.create({
    data: { bitrix24ContactId, moyskladCounterpartyId, moyskladType: 'COUNTERPARTY' },
  });
  await database.contactSnapshot.create({ data: {
    pairId: pair.id, bitrix24Email: 'before@example.test', moyskladEmail: 'before@example.test',
    bitrix24UpdatedAt: new Date('2026-10-20T08:00:00.000Z'),
    moyskladUpdatedAt: new Date('2026-10-20T08:00:00.000Z'), revision: 1,
  } });
  contactEmails.set(moyskladCounterpartyId, 'before@example.test');
  return { pair, bitrix24ContactId, moyskladCounterpartyId };
}

before(async () => {
  assert.equal(process.env.CONTACT_SYNC_MODE_GATE_TEST_ISOLATED, '1', 'explicit disposable-schema opt-in required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.match(url.hostname, /^(localhost|127\.0\.0\.1)$/i, 'contact gate test database must be local');
  assert.equal(url.searchParams.get('schema'), 'issue79_contact_mode_gate_test');
  oldSyncMode = process.env.SYNC_MODE;
  oldBitrixToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
  oldMoyskladSecret = process.env.MOYSKLAD_WEBHOOK_SECRET;
  oldMoyskladToken = process.env.MOYSKLAD_API_TOKEN;
  oldBitrixBase = process.env.BITRIX24_REST_BASE_URL;
  oldMoyskladBase = process.env.MOYSKLAD_API_BASE_URL;
  process.env.SYNC_MODE = 'apply';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-contact-mode-gate-token';
  process.env.MOYSKLAD_WEBHOOK_SECRET = 'synthetic-contact-ms-secret';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-contact-ms-token';
  providerOperations.length = 0;
  writes = 0;
  mockServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const path = request.url ?? '/';
    providerOperations.push(`${request.method ?? 'GET'} ${path}`);
    if (request.method === 'POST' && path === '/rest/crm.contact.get.json') {
      const form = new URLSearchParams(bodyText);
      if (sourceReadsHeld) {
        sourceReadArrivals += 1;
        if (sourceReadArrivals === 2) resolveSourceReadsReady();
        await sourceReadBarrier;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: {
        ID: form.get('id'), DATE_MODIFY: '2026-10-20T12:00:00+03:00',
        EMAIL: [{ ID: 'synthetic-email-field-id', VALUE: 'after@example.test', VALUE_TYPE: 'WORK' }],
      } }));
      return;
    }
    if (path.startsWith('/api/entity/counterparty/')) {
      const id = decodeURIComponent(path.split('/').at(-1) ?? '');
      if (request.method === 'GET') {
        if (sourceReadsHeld) {
          sourceReadArrivals += 1;
          if (sourceReadArrivals === 2) resolveSourceReadsReady();
          await sourceReadBarrier;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id, email: contactEmails.get(id) ?? 'before@example.test', updated: '2026-10-20 08:00:00.000' }));
        return;
      }
      if (request.method === 'PUT') {
        writes += 1;
        const input = JSON.parse(bodyText) as { email: string };
        contactEmails.set(id, input.email);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id, email: input.email, updated: '2026-10-20 12:00:01.000' }));
        return;
      }
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });
  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const address = mockServer.address();
  assert.ok(address && typeof address !== 'string');
  mockUrl = `http://127.0.0.1:${address.port}`;
  process.env.BITRIX24_REST_BASE_URL = `${mockUrl}/rest/`;
  process.env.MOYSKLAD_API_BASE_URL = `${mockUrl}/api/`;
  database = new DatabaseService();
  await database.$connect();
});

after(async () => {
  for (const app of openApps.splice(0)) {
    app.getHttpServer().closeAllConnections();
    await app.close();
  }
  if (database) {
    await database.inboundEvent.deleteMany({ where: { OR: [
      { deliveryKey: { startsWith: eventPrefix } },
      { externalEntityId: { startsWith: contactPrefix } },
    ] } });
    await database.contactPair.deleteMany({ where: { bitrix24ContactId: { startsWith: contactPrefix } } });
    await database.$disconnect();
  }
  if (mockServer) {
    mockServer.closeAllConnections();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  }
  if (oldSyncMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = oldSyncMode;
  if (oldBitrixToken === undefined) delete process.env.BITRIX24_EVENT_APPLICATION_TOKEN; else process.env.BITRIX24_EVENT_APPLICATION_TOKEN = oldBitrixToken;
  if (oldMoyskladSecret === undefined) delete process.env.MOYSKLAD_WEBHOOK_SECRET; else process.env.MOYSKLAD_WEBHOOK_SECRET = oldMoyskladSecret;
  if (oldMoyskladToken === undefined) delete process.env.MOYSKLAD_API_TOKEN; else process.env.MOYSKLAD_API_TOKEN = oldMoyskladToken;
  if (oldBitrixBase === undefined) delete process.env.BITRIX24_REST_BASE_URL; else process.env.BITRIX24_REST_BASE_URL = oldBitrixBase;
  if (oldMoyskladBase === undefined) delete process.env.MOYSKLAD_API_BASE_URL; else process.env.MOYSKLAD_API_BASE_URL = oldMoyskladBase;
});

test('OFF and PAUSE startup recovery leave queued contact work untouched and make no provider reads', async () => {
  for (const mode of ['off', 'pause'] as const) {
    await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: mode }, update: { serviceMode: mode } });
    const event = await database.inboundEvent.create({ data: {
      source: 'BITRIX24', deliveryKey: `${eventPrefix}startup-${mode}`, eventType: 'ONCRMCONTACTUPDATE',
      externalEntityType: 'contact', externalEntityId: `${contactPrefix}startup-${mode}`, payload: {}, status: 'RECEIVED',
    } });
    const opsBefore = providerOperations.length;
    const { app, apiUrl } = await createApp();
    try {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const afterRecovery = await database.inboundEvent.findUniqueOrThrow({ where: { id: event.id } });
      assert.equal(afterRecovery.status, 'RECEIVED', `${mode} recovery must not change queued status`);
      assert.equal(afterRecovery.attempts, 0, `${mode} recovery must not claim the event`);
      assert.equal(providerOperations.length, opsBefore, `${mode} recovery must not read either provider`);
      const response = await postContactUpdate(apiUrl, `${contactPrefix}new-${mode}`);
      if (mode === 'off') {
        assert.equal(response.status, 410, 'OFF intake is rejected before creating another queue item');
        assert.equal(await database.inboundEvent.count({ where: { deliveryKey: { startsWith: eventPrefix } } }), 1);
      } else {
        assert.equal(response.status, 200, 'PAUSE may durably accept an event without processing it');
        const ack = await response.json() as { eventId: string };
        await new Promise((resolve) => setTimeout(resolve, 350));
        const received = await database.inboundEvent.findUniqueOrThrow({ where: { id: ack.eventId } });
        assert.equal(received.status, 'RECEIVED');
        assert.equal(received.attempts, 0);
      }
      assert.equal(providerOperations.length, opsBefore, `${mode} must make no provider reads after webhook acknowledgment`);
      assert.equal((await database.inboundEvent.findUniqueOrThrow({ where: { id: event.id } })).status, 'RECEIVED');
    } finally {
      app.getHttpServer().closeAllConnections();
      await app.close();
      const index = openApps.indexOf(app);
      if (index >= 0) openApps.splice(index, 1);
      await database.inboundEvent.deleteMany({ where: { deliveryKey: { startsWith: `${eventPrefix}startup-${mode}` } } });
    }
  }
});

test('OFF acknowledgment waits for in-flight bounded reads and no new provider operation starts until ON recovery', async () => {
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  const fixture = await createContactFixture('off-race');
  const { app, apiUrl } = await createApp();
  holdNextSourceReads();
  const opsBefore = providerOperations.length;
  try {
    const response = await postContactUpdate(apiUrl, fixture.bitrix24ContactId);
    assert.equal(response.status, 200);
    const ack = await response.json() as { eventId: string; accepted: boolean };
    assert.equal(ack.accepted, true);
    await sourceReadsReady;
    const offPromise = app.get(SyncModeService).setMode('off').then(() => undefined);
    const deadline = Date.now() + 3_000;
    let modeOff = (await database.syncSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { serviceMode: true } })).serviceMode === 'off';
    let offWriterWaiting = false;
    while (!modeOff && !offWriterWaiting && Date.now() < deadline) {
      const waiters = await database.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SyncSetting%'
      `;
      offWriterWaiting = Number(waiters[0]?.count ?? 0) > 0;
      modeOff = (await database.syncSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { serviceMode: true } })).serviceMode === 'off';
      if (!modeOff && !offWriterWaiting) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(modeOff || offWriterWaiting, true, 'OFF transition must commit or queue behind active provider locks');
    releaseSourceReads();
    await offPromise;
    const offAckOperationCount = providerOperations.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterOff = await database.inboundEvent.findUniqueOrThrow({ where: { id: ack.eventId } });
    const snapshotAfterOff = await database.contactSnapshot.findUniqueOrThrow({ where: { pairId: fixture.pair.id } });
    assert.equal(afterOff.status, 'PROCESSING', 'OFF retains the in-flight event claim for observability and recovery');
    assert.equal(afterOff.attempts, 1);
    assert.equal(providerOperations.length, offAckOperationCount, 'no new provider request may start after OFF acknowledgment');
    assert.equal(providerOperations.length, opsBefore + 2, 'only the two reads already active before OFF may have started');
    assert.equal(writes, 0, 'destination update must not start after OFF acknowledgment');
    assert.equal(snapshotAfterOff.revision, 1, 'in-flight stale snapshot must not be committed after OFF');
    const modeService = app.get(SyncModeService);
    await modeService.setMode('on');
    await database.inboundEvent.update({ where: { id: ack.eventId }, data: { processingStartedAt: new Date(Date.now() - 120_000) } });
    const recovered = await waitFor(() => database.inboundEvent.findUniqueOrThrow({ where: { id: ack.eventId } }), (row) => row.status === 'SUCCEEDED');
    const finalSnapshot = await database.contactSnapshot.findUniqueOrThrow({ where: { pairId: fixture.pair.id } });
    assert.equal(recovered.status, 'SUCCEEDED');
    assert.equal(finalSnapshot.revision, 2);
    assert.equal(contactEmails.get(fixture.moyskladCounterpartyId), 'after@example.test');
    assert.equal(writes, 1, 'ON retry performs exactly one provider update');
    assert.equal(providerOperations.length, offAckOperationCount + 3, 'ON retry performs two exact source reads and one destination update');
  } finally {
    releaseSourceReads();
    app.getHttpServer().closeAllConnections();
    await app.close();
    const index = openApps.indexOf(app);
    if (index >= 0) openApps.splice(index, 1);
  }
});

test('durable mode read failure fails closed without claiming the queued contact event', async () => {
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  let app: INestApplication | undefined;
  const event = await database.inboundEvent.create({ data: {
    source: 'BITRIX24', deliveryKey: `${eventPrefix}mode-read-failure`, eventType: 'ONCRMCONTACTUPDATE',
    externalEntityType: 'contact', externalEntityId: `${contactPrefix}mode-read-failure`, payload: {}, status: 'RECEIVED',
  } });
  const opsBefore = providerOperations.length;
  let renamed = false;
  try {
    await database.$executeRawUnsafe('ALTER TABLE "SyncSetting" RENAME TO "SyncSetting_contact_gate_hold"');
    renamed = true;
    app = (await createApp()).app;
    await app.get(ContactSyncProcessor).process(event.id);
    const unchanged = await database.inboundEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(unchanged.status, 'RECEIVED');
    assert.equal(unchanged.attempts, 0);
    assert.equal(providerOperations.length, opsBefore);
  } finally {
    if (renamed) await database.$executeRawUnsafe('ALTER TABLE "SyncSetting_contact_gate_hold" RENAME TO "SyncSetting"');
    if (app) {
      app.getHttpServer().closeAllConnections();
      await app.close();
      const index = openApps.indexOf(app);
      if (index >= 0) openApps.splice(index, 1);
    }
    await database.inboundEvent.deleteMany({ where: { id: event.id } });
  }
});
