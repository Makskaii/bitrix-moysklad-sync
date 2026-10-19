import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ControlledLiveTestAdmissionService } from '../src/controlled-live-test-admission.service';
import { createControlledLiveTestPolicy } from '../src/controlled-live-test-policy';
import { installControlledLiveFetchGuard, setControlledLiveTestWriteCheck } from '../src/external-write-guard';
import { InvoiceHttpApi } from '../src/invoices/invoice-http-api';

test('controlled invoice adapter creates a run-marked target, binds current readback, then permits its exact BOTH echo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue60-invoice-adapter-'));
  const manifestPath = join(directory, 'manifest.json');
  const runId = 'LIVE-TEST-20261019T120000Z-invoice01';
  const name = `тест ${runId} invoice`;
  const targetId = '10000000-0000-4000-8000-000000000031';
  const previous = Object.fromEntries(['CONTROLLED_LIVE_TEST_MODE', 'CONTROLLED_LIVE_TEST_INSTANCE', 'CONTROLLED_LIVE_TEST_MANIFEST', 'DATABASE_URL', 'SYNC_MODE', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN', 'BITRIX24_REST_BASE_URL'].map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const admissions = new Map<string, any>();
  const calls: Array<{ method: string; path: string; body: string }> = [];
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
  process.env.CONTROLLED_LIVE_TEST_INSTANCE = 'isolated';
  process.env.CONTROLLED_LIVE_TEST_MANIFEST = manifestPath;
  process.env.DATABASE_URL = 'postgresql://postgres@127.0.0.1:58341/sync_issue60_test?schema=issue60_harness_test';
  process.env.SYNC_MODE = 'apply';
  process.env.MOYSKLAD_API_BASE_URL = 'https://controlled-ms-invoice.invalid/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'fake-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://controlled-b24-invoice.invalid/rest/';
  await writeFile(manifestPath, JSON.stringify({ runId, testDatabaseName: 'sync_issue60_test', testSchemaName: 'issue60_harness_test', records: [{
    entity: 'invoice', direction: 'BOTH', name, syntheticOnly: true, sourceSystem: 'BITRIX24', sourceNativeId: '31',
    targetSystem: 'MOYSKLAD', targetNativeId: null, createdAfterUtc: '2026-10-19T00:00:00.000Z',
  }] }), 'utf8');
  const database: any = { controlledTestAdmission: {
    findMany: async ({ where }: any) => [...admissions.values()].filter((row) => row.runId === where.runId && row.entity === where.entity),
    findUnique: async ({ where }: any) => admissions.get(where.eventId) ?? null,
    findFirst: async ({ where }: any) => [...admissions.values()].find((row) => row.runId === where.runId && row.targetSystem === where.targetSystem && row.targetNativeId === where.targetNativeId && row.eventId !== where.NOT.eventId) ?? null,
    upsert: async ({ where, create }: any) => { if (!admissions.has(where.eventId)) admissions.set(where.eventId, { ...create }); return admissions.get(where.eventId); },
    updateMany: async ({ where, data }: any) => { const row = admissions.get(where.eventId); if (!row || row.targetNativeId !== where.targetNativeId) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
  } };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method;
    const body = await request.clone().text();
    calls.push({ method, path: url.pathname + url.search, body });
    if (method === 'POST' && url.pathname.endsWith('/entity/invoiceout')) return new Response(JSON.stringify({ id: targetId }), { status: 200 });
    if (method === 'GET' && url.pathname.endsWith(`/entity/invoiceout/${targetId}`)) {
      return new Response(JSON.stringify({ id: targetId, name, created: '2026-10-19T02:00:00Z', meta: { type: 'invoiceout' } }), { status: 200 });
    }
    if (method === 'POST' && url.pathname.endsWith('/crm.item.update.json')) return new Response(JSON.stringify({ result: { item: { id: '31' } } }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  try {
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));
    setControlledLiveTestWriteCheck(createControlledLiveTestPolicy(manifest, process.env.DATABASE_URL));
    installControlledLiveFetchGuard();
    const admission = new ControlledLiveTestAdmissionService(database);
    const api = new InvoiceHttpApi();
    await admission.withCurrentSourceRead('invoice-create-event', 'BITRIX24', '31', 'invoice', async () => {
      await admission.admit('invoice-create-event', { entity: 'invoice', sourceSystem: 'BITRIX24', sourceNativeId: '31', currentNativeId: '31', currentName: name, sourceCreatedAt: new Date('2026-10-19T01:00:00Z') });
    });
    const created = await admission.runForEvent('invoice-create-event', async () => {
      const id = await api.createMoysklad('31', '20000000-0000-4000-8000-000000000031', { name });
      admission.allowTargetReadback('MOYSKLAD', id);
      const readback = await api.readMoysklad(id);
      await admission.bindCreatedTarget('invoice-create-event', id, String(readback.id), String(readback.name), new Date(String(readback.created)));
      return id;
    });
    assert.equal(created, targetId);
    assert.equal(admissions.get('invoice-create-event')?.targetNativeId, targetId);

    const restarted = new ControlledLiveTestAdmissionService(database);
    await restarted.withCurrentSourceRead('invoice-echo-event', 'MOYSKLAD', targetId, 'invoice', async () => {
      await restarted.admit('invoice-echo-event', { entity: 'invoice', sourceSystem: 'MOYSKLAD', sourceNativeId: targetId,
        currentNativeId: targetId, currentName: name, sourceCreatedAt: new Date('2026-10-19T02:00:00Z') });
    });
    await restarted.runForEvent('invoice-echo-event', () => api.updateBitrix24('31', { title: 'synthetic echo' }));
    assert.equal(calls.filter((call) => call.method === 'POST' && call.path.endsWith('/entity/invoiceout')).length, 1);
    const targetCreate = calls.find((call) => call.method === 'POST' && call.path.endsWith('/entity/invoiceout'));
    assert.equal(JSON.parse(targetCreate!.body).name, name);
    assert.equal(calls.at(-1)?.path, '/rest/crm.item.update.json');
  } finally {
    globalThis.fetch = originalFetch;
    setControlledLiveTestWriteCheck(null);
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});
