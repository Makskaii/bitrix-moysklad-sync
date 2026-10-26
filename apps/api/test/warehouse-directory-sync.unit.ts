import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { planWarehouseDirectory, WarehouseElement, WarehouseStore } from '../src/warehouses/warehouse-directory-plan';
import { WarehouseDirectorySyncService } from '../src/warehouses/warehouse-directory-sync.service';
import { DatabaseService } from '../src/database.service';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const store = (n: number, name = `Warehouse ${n}`): WarehouseStore => ({ id: uuid(n), name, archived: false });

test('UUID controls renames; missing, archived, duplicate and explicitly held references are preserved', () => {
  const stores = [store(1, 'Renamed'), store(2), { ...store(3), archived: true }, store(4)];
  const rows = [
    { id: '1', code: uuid(1).toUpperCase(), name: 'Old' },
    { id: '2', code: uuid(2), name: 'Old held' },
    { id: '3', code: uuid(3), name: 'Archived' },
    { id: '4', code: uuid(4), name: 'Duplicate A' }, { id: '5', code: uuid(4), name: 'Duplicate B' },
    { id: '6', code: uuid(9), name: 'Missing source' },
  ];
  const result = planWarehouseDirectory(stores, rows, new Set(['2']));
  assert.deepEqual(result.actions, [{ kind: 'RENAME', moyskladId: uuid(1), bitrix24Id: '1', name: 'Renamed' }]);
  assert.deepEqual(new Set(result.issues.map(x => x.code)), new Set(['WAREHOUSE_ELEMENT_HELD', 'WAREHOUSE_SOURCE_ARCHIVED', 'WAREHOUSE_CODE_DUPLICATE', 'WAREHOUSE_SOURCE_MISSING']));
});

test('an unlinked legacy name is a warning, never evidence for assigning a UUID', () => {
  const result = planWarehouseDirectory([store(1)], [{ id: '1', code: '', name: 'Warehouse 1' }], new Set());
  assert.equal(result.actions.length, 0);
  assert.ok(result.issues.some(x => x.code === 'WAREHOUSE_LEGACY_COLLISION'));
  assert.throws(() => planWarehouseDirectory([store(1), store(1)], [], new Set()), /WAREHOUSE_SOURCE_INVALID/);
});

async function fixture(run: (f: {
  service: WarehouseDirectorySyncService; rows: WarehouseElement[]; stores: WarehouseStore[];
  state: { mode: string; writes: number; calls: number; schemaProperty: boolean; loseAddAck: boolean; competingCreate: boolean; stopBeforeWrite: boolean; fieldsCalls: number; incomplete: boolean; badReadback: boolean };
}) => Promise<void>) {
  const keys = ['WAREHOUSE_DIRECTORY_SYNC_ENABLED', 'WAREHOUSE_DIRECTORY_SYNC_HELD_IDS', 'SYNC_MODE', 'CONTROLLED_LIVE_TEST_MODE', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { WAREHOUSE_DIRECTORY_SYNC_ENABLED: 'enabled', WAREHOUSE_DIRECTORY_SYNC_HELD_IDS: '', SYNC_MODE: 'apply', CONTROLLED_LIVE_TEST_MODE: '',
    BITRIX24_REST_BASE_URL: 'https://bitrix.invalid/rest/', MOYSKLAD_API_BASE_URL: 'https://ms.invalid/api/', MOYSKLAD_API_TOKEN: 'fake-test-token' });
  const oldFetch = globalThis.fetch;
  const rows: WarehouseElement[] = [];
  const stores: WarehouseStore[] = [store(1)];
  const state = { mode: 'on', writes: 0, calls: 0, schemaProperty: false, loseAddAck: false, competingCreate: false, stopBeforeWrite: false, fieldsCalls: 0, incomplete: false, badReadback: false };
  const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    state.calls += 1;
    const url = new URL(String(input));
    if (url.hostname === 'ms.invalid') {
      assert.equal(init?.method, 'GET');
      assert.equal((init?.headers as Record<string, string>).accept, 'application/json;charset=utf-8');
      assert.equal((init?.headers as Record<string, string>)['accept-encoding'], 'gzip');
      const asNative = (s: WarehouseStore) => ({ ...s, meta: { type: 'store' } });
      if (url.pathname === '/api/entity/store') {
        if (state.incomplete) return url.searchParams.get('offset') === '0'
          ? response({ meta: { size: 2 }, rows: stores.map(asNative) }) : response({ meta: { size: 2 }, rows: [] });
        return response({ meta: { size: stores.length }, rows: stores.map(asNative) });
      }
      const row = stores.find(s => url.pathname === `/api/entity/store/${s.id}`);
      assert.ok(row);
      return response(asNative(row));
    }
    assert.equal(url.hostname, 'bitrix.invalid');
    const method = url.pathname.split('/').at(-1)!.replace('.json', '');
    const form = new URLSearchParams(init?.body as URLSearchParams);
    assert.equal(form.get('IBLOCK_ID'), '38');
    if (method === 'lists.get.iblock.type.id') return response({ result: 'rest_entity' });
    if (method === 'lists.field.get') {
      state.fieldsCalls += 1;
      if (state.stopBeforeWrite && state.fieldsCalls === 2) state.mode = 'off';
      return response({ result: { NAME: { FIELD_ID: 'NAME', TYPE: 'NAME' }, ...(state.schemaProperty ? { PROPERTY_1: { FIELD_ID: 'PROPERTY_1', TYPE: 'S' } } : {}) } });
    }
    if (method === 'lists.element.get') {
      const selected = rows.filter(row => (!form.has('ELEMENT_ID') || row.id === form.get('ELEMENT_ID')) && (!form.has('ELEMENT_CODE') || row.code === form.get('ELEMENT_CODE')));
      return response({ result: selected.map(row => ({ ID: row.id, CODE: row.code, NAME: state.badReadback && state.writes ? 'Unexpected' : row.name, IBLOCK_ID: '38' })) });
    }
    assert.equal(state.mode, 'on');
    state.writes += 1;
    if (method === 'lists.element.add') {
      assert.ok(stores.some(s => s.id === form.get('ELEMENT_CODE')));
      const id = String(100 + rows.length);
      rows.push({ id, code: form.get('ELEMENT_CODE')!, name: form.get('FIELDS[NAME]')! });
      if (state.loseAddAck) { state.loseAddAck = false; throw new Error('Simulated connection lost after accepted creation'); }
      if (state.competingCreate) return response({ error: 'ERROR_ELEMENT_ALREADY_EXISTS' });
      return response({ result: Number(id) });
    }
    assert.equal(method, 'lists.element.update');
    assert.deepEqual([...form.keys()].sort(), ['IBLOCK_ID', 'IBLOCK_TYPE_ID', 'ELEMENT_ID', 'ELEMENT_CODE', 'FIELDS[NAME]'].sort());
    const row = rows.find(r => r.id === form.get('ELEMENT_ID'))!;
    assert.equal(form.get('ELEMENT_CODE'), row.code);
    row.name = form.get('FIELDS[NAME]')!;
    return response({ result: true });
  }) as typeof fetch;
  const tx = { $queryRaw: async () => [{ serviceMode: state.mode }] };
  const database = { syncSetting: { findUnique: async () => ({ serviceMode: state.mode }) }, $transaction: async (work: (value: unknown) => unknown) => work(tx) } as unknown as DatabaseService;
  try { await run({ service: new WarehouseDirectorySyncService(database), rows, stores, state }); }
  finally {
    globalThis.fetch = oldFetch;
    for (const key of keys) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
}

test('creation uses unique CODE, repeats do not write, and rename retains the original Bitrix ID', async () => fixture(async ({ service, rows, stores, state }) => {
  assert.equal((await service.runOnce()).added, 1);
  assert.equal((await service.runOnce()).unchanged, 1);
  stores[0].name = 'New MS name';
  assert.equal((await service.runOnce()).renamed, 1);
  assert.deepEqual(rows, [{ id: '100', code: uuid(1), name: 'New MS name' }]);
  assert.equal(state.writes, 2);
}));

test('accepted CREATE with lost response is recovered on the next run without another CREATE', async () => fixture(async ({ service, state, rows }) => {
  state.loseAddAck = true;
  await assert.rejects(service.runOnce(), /Simulated connection lost/);
  assert.equal((await service.runOnce()).unchanged, 1);
  assert.equal(rows.length, 1);
  assert.equal(state.writes, 1);
}));

test('a competing CREATE is read back by CODE and does not create a second item', async () => fixture(async ({ service, state, rows }) => {
  state.competingCreate = true;
  assert.equal((await service.runOnce()).added, 1);
  assert.equal(rows.length, 1);
  assert.equal(state.writes, 1);
}));

test('OFF, dry mode, disabled feature and controlled test mode make no provider calls', async () => fixture(async ({ service, state }) => {
  state.mode = 'off';
  assert.equal((await service.runOnce()).status, 'SKIPPED');
  state.mode = 'on';
  for (const [key, value] of [['SYNC_MODE', 'dry'], ['WAREHOUSE_DIRECTORY_SYNC_ENABLED', 'disabled'], ['CONTROLLED_LIVE_TEST_MODE', 'enabled']]) {
    const previous = process.env[key]; process.env[key] = value;
    assert.equal((await service.runOnce()).status, 'SKIPPED');
    process.env[key] = previous;
  }
  assert.equal(state.calls, 0);
}));

test('an OFF transition between preparation and write prevents the mutation', async () => fixture(async ({ service, state }) => {
  state.stopBeforeWrite = true;
  await assert.rejects(service.runOnce(), /SERVICE_MODE_NOT_ON/);
  assert.equal(state.writes, 0);
}));

test('new list properties or an incomplete MS feed stop before any writes', async () => fixture(async ({ service, state }) => {
  state.schemaProperty = true;
  await assert.rejects(service.runOnce(), /WAREHOUSE_SCHEMA_UNSUPPORTED/);
  state.schemaProperty = false; state.incomplete = true;
  await assert.rejects(service.runOnce(), /WAREHOUSE_SOURCE_PAGE_INVALID/);
  assert.equal(state.writes, 0);
}));

test('a successful acknowledgement is insufficient when native readback differs', async () => fixture(async ({ service, state }) => {
  state.badReadback = true;
  await assert.rejects(service.runOnce(), /WAREHOUSE_READBACK_MISMATCH/);
}));

test('duplicate target CODE and a configured hold never mutate the affected records', async () => fixture(async ({ service, state, rows }) => {
  rows.push({ id: '1', code: uuid(1), name: 'A' }, { id: '2', code: uuid(1), name: 'B' });
  assert.ok((await service.runOnce()).issues.some(issue => issue.code === 'WAREHOUSE_CODE_DUPLICATE'));
  rows.pop(); process.env.WAREHOUSE_DIRECTORY_SYNC_HELD_IDS = '1';
  assert.ok((await service.runOnce()).issues.some(issue => issue.code === 'WAREHOUSE_ELEMENT_HELD'));
  assert.equal(state.writes, 0);
}));

test('a run limits writes to five and requires an explicitly configured hold list', async () => fixture(async ({ service, stores, state, rows }) => {
  delete process.env.WAREHOUSE_DIRECTORY_SYNC_HELD_IDS;
  await assert.rejects(service.runOnce(), /WAREHOUSE_HOLDS_UNCONFIRMED/);
  assert.equal(state.calls, 0);
  process.env.WAREHOUSE_DIRECTORY_SYNC_HELD_IDS = '';
  stores.push(...Array.from({ length: 5 }, (_, i) => store(i + 2)));
  const result = await service.runOnce();
  assert.equal(result.added, 5);
  assert.equal(result.deferred, 1);
  assert.equal(rows.length, 5);
  assert.equal((await service.runOnce()).added, 1);
  assert.equal(rows.length, 6);
}));
