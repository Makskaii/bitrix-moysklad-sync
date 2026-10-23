import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { createServer, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseService } from '../src/database.service';
import { DealOrderFieldRuntimeService, readConfiguredStage } from '../src/deals-orders/deal-order-field-runtime.service';
import { SyncModeService } from '../src/sync-mode.service';
import { DealOrderBaselineService } from '../src/deals-orders/deal-order-baseline.service';
import { configuredStagePairs } from '../src/deals-orders/deal-order-stage-mappings';

type MapPair = { bitrix24StageId: string; moyskladId: string; moyskladToBitrix24?: boolean };
const map = JSON.parse(readFileSync('docs/deal-stage-map-2026-10-21.json', 'utf8')) as { pairs: MapPair[]; reverseAliases: MapPair[] };
process.env.SYNC_MODE ??= 'apply';
const database = new DatabaseService();
let pair: any;
let server: Server;
let base = '';
let b24Stage = 'PREPARATION';
let msStage = map.pairs[1].moyskladId;
let writes = 0;
const toPair = (x: MapPair) => ({ bitrix24StageId: x.bitrix24StageId, moyskladId: x.moyskladId });
const config: any = { version: 1, config: { rules: [], groups: [], references: { units: [], priceTypes: [], dictionaries: [] }, dealOrderRuntime: {
  stages: [{ ...toPair(map.pairs[1]), creationEnabled: true }],
  stageTransitions: { bitrix24ToMoysklad: map.pairs.map(toPair), moyskladToBitrix24: [...map.pairs.filter(x => x.moyskladToBitrix24 !== false), ...map.reverseAliases].map(toPair) },
} } };
const reader: any = { readBitrix24DealForBaseline: async () => ({ STAGE_ID: b24Stage }), readMoySkladCustomerOrderForBaseline: async () => ({ state: { meta: { href: `${base}entity/customerorder/metadata/states/${msStage}`, type: 'state' } } }) };
let service: DealOrderFieldRuntimeService;

before(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, '127.0.0.1'); assert.match(url.pathname, /side_stage.*test/);
  assert.equal(process.env.DEAL_ORDER_STAGE_TEST_ISOLATED, '1');
  process.env.SYNC_MODE = 'apply';
  await database.syncSetting.upsert({ where: { id: 'global' }, create: { id: 'global', serviceMode: 'on' }, update: { serviceMode: 'on' } });
  await database.syncDirectionSetting.upsert({ where: { entityKey: 'deals-orders' }, create: { entityKey: 'deals-orders', bitrix24ToMoysklad: true, moyskladToBitrix24: true }, update: { bitrix24ToMoysklad: true, moyskladToBitrix24: true } });
  pair = await database.entityPair.create({ data: { entityType: 'DEAL', bitrix24Id: '99000001', moyskladId: randomUUID(), source: 'MANUAL' } });
  await database.entityPairBaseline.create({ data: { pairId: pair.id, eventId: 'synthetic-stage-baseline', settingsVersion: 1, bitrix24Values: { 'native:stage': b24Stage }, moyskladValues: { 'native:stage': msStage } } });
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    if (req.url === `/entity/customerorder/${pair.moyskladId}` && req.method === 'PUT') {
      assert.equal(req.headers.accept, 'application/json;charset=utf-8');
      assert.equal(req.headers['accept-encoding'], 'gzip');
      const body = JSON.parse(text); msStage = body.state.meta.href.split('/').pop(); writes++;
      res.end(JSON.stringify({ id: pair.moyskladId })); return;
    }
    if (req.url === '/rest/crm.deal.update.json' && req.method === 'POST') {
      const body = new URLSearchParams(text); assert.equal(body.get('id'), pair.bitrix24Id);
      b24Stage = body.get('fields[STAGE_ID]')!; writes++; res.end(JSON.stringify({ result: true })); return;
    }
    res.statusCode = 500; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}/`;
  process.env.BITRIX24_REST_BASE_URL = base + 'rest/'; process.env.MOYSKLAD_API_BASE_URL = base; process.env.MOYSKLAD_API_TOKEN = 'synthetic-only';
  service = new DealOrderFieldRuntimeService(database, reader, new SyncModeService(database));
});
after(async () => { if (pair) await database.entityPair.delete({ where: { id: pair.id } }); await database.$disconnect(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

async function reset() {
  b24Stage = 'PREPARATION'; msStage = map.pairs[1].moyskladId; writes = 0;
  await database.entityPairSyncState.upsert({ where: { pairId: pair.id }, create: { pairId: pair.id, settingsVersion: 1, bitrix24Values: { 'native:stage': b24Stage }, moyskladValues: { 'native:stage': msStage } }, update: { bitrix24Values: { 'native:stage': b24Stage }, moyskladValues: { 'native:stage': msStage } } });
}
test('public field runtime synchronizes native MS stage IDs with no unrelated scalar rules', async () => {
  await reset(); b24Stage = 'UC_7QBU06';
  assert.deepEqual(await service.process({ pair, eventId: 'stage-first', eventConfig: config }), { status: 'SYNCED', heldRules: 0 });
  assert.equal(msStage, map.pairs[2].moyskladId); assert.equal(writes, 1);
});
test('every prepared stage roundtrips in both directions, repeats do not write', async () => {
  for (const target of map.pairs.filter(x => x.bitrix24StageId !== 'PREPARATION' && x.moyskladToBitrix24 !== false)) {
    await reset(); b24Stage = target.bitrix24StageId;
    assert.deepEqual(await service.process({ pair, eventId: randomUUID(), eventConfig: config }), { status: 'SYNCED', heldRules: 0 }, target.bitrix24StageId);
    assert.equal(msStage, target.moyskladId); assert.equal(writes, 1);
    await service.process({ pair, eventId: randomUUID(), eventConfig: config }); assert.equal(writes, 1);
    await reset(); msStage = target.moyskladId;
    assert.deepEqual(await service.process({ pair, eventId: randomUUID(), eventConfig: config }), { status: 'SYNCED', heldRules: 0 });
    assert.equal(b24Stage, target.bitrix24StageId); assert.equal(writes, 1);
  }
});
test('new normal baseline captures both native stages without any scalar rules', async () => {
  await reset();
  await database.entityPairSyncState.delete({ where: { pairId: pair.id } });
  await database.entityPairBaseline.delete({ where: { pairId: pair.id } });
  const baseline = new DealOrderBaselineService(database, reader);
  assert.equal((await baseline.ensureForConfirmedPair({ pair, eventId: 'new-baseline', eventConfig: config })).status, 'READY');
  const saved = await database.entityPairBaseline.findUniqueOrThrow({ where: { pairId: pair.id } });
  assert.equal((saved.bitrix24Values as any)['native:stage'], b24Stage);
  assert.equal((saved.moyskladValues as any)['native:stage'], msStage);
  b24Stage = 'UC_7QBU06';
  assert.deepEqual(await service.process({ pair, eventId: 'after-baseline', eventConfig: config }), { status: 'SYNCED', heldRules: 0 });
  assert.equal(msStage, map.pairs[2].moyskladId); assert.equal(writes, 1);
});
test('legacy stage snapshot bootstrap only accepts already aligned providers', async () => {
  await reset();
  await database.entityPairSyncState.update({ where: { pairId: pair.id }, data: { bitrix24Values: { keep: 'b24' }, moyskladValues: { keep: 'ms' } } });
  assert.deepEqual(await service.process({ pair, eventId: 'legacy-aligned', eventConfig: config }), { status: 'SYNCED', heldRules: 0 });
  assert.equal(writes, 0);
  const saved = await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId: pair.id } });
  assert.equal((saved.bitrix24Values as any).keep, 'b24');
  assert.equal((saved.bitrix24Values as any)['native:stage'], 'PREPARATION');
  await database.entityPairSyncState.update({ where: { pairId: pair.id }, data: { bitrix24Values: {}, moyskladValues: {} } });
  b24Stage = 'UC_7QBU06';
  assert.deepEqual(await service.process({ pair, eventId: 'legacy-disagrees', eventConfig: config }), { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_STAGE_BASELINE_UNAVAILABLE' });
  assert.equal(writes, 0);
});
test('unknown or duplicate stages hold without writes', async () => {
  await reset(); b24Stage = 'UNKNOWN';
  assert.deepEqual(await service.process({ pair, eventId: 'unknown-stage', eventConfig: config }), { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_STAGE_UNMAPPED' });
  assert.equal(writes, 0);
  await reset(); b24Stage = 'UC_7QBU06';
  const duplicate = structuredClone(config); duplicate.config.dealOrderRuntime.stageTransitions.bitrix24ToMoysklad.push(config.config.dealOrderRuntime.stageTransitions.bitrix24ToMoysklad[2]);
  assert.deepEqual(await service.process({ pair, eventId: 'duplicate-stage', eventConfig: duplicate }), { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_STAGE_UNMAPPED' });
  assert.equal(writes, 0);
});

test('explicit preserve-and-warn continues existing-document processing without writing or baselining unknown stages', async () => {
  await reset();
  const configured = structuredClone(config);
  configured.config.dealOrderRuntime.unmappedStagePolicy = 'preserve-and-warn';
  const unknown = '0cb61f8b-b504-11ee-0a80-0ff500135272';
  msStage = unknown;
  const before = await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId: pair.id } });
  const result = await service.process({ pair, eventId: 'stage-preserved-warning', eventConfig: configured });
  assert.deepEqual(result, { status: 'SYNCED', heldRules: 0 });
  assert.equal(msStage, unknown); assert.equal(b24Stage, 'PREPARATION'); assert.equal(writes, 0);
  const after = await database.entityPairSyncState.findUniqueOrThrow({ where: { pairId: pair.id } });
  assert.deepEqual(after.bitrix24Values, before.bitrix24Values);
  assert.deepEqual(after.moyskladValues, before.moyskladValues);
  assert.ok(await database.operationalLog.count({ where: { referenceId: 'stage-preserved-warning', message: { contains: 'DEAL_ORDER_STAGE_PRESERVED_UNMAPPED' } } }));
});

test('preserve-and-warn still rejects foreign stage references and duplicate directional mappings', async () => {
  await reset();
  const configured = structuredClone(config);
  configured.config.dealOrderRuntime.unmappedStagePolicy = 'preserve-and-warn';
  const read = reader.readMoySkladCustomerOrderForBaseline;
  reader.readMoySkladCustomerOrderForBaseline = async () => ({ state: { meta: { type: 'state', href: 'https://foreign.invalid/entity/customerorder/metadata/states/0cb61f8b-b504-11ee-0a80-0ff500135272' } } });
  try {
    assert.deepEqual(await service.process({ pair, eventId: 'stage-foreign-warning', eventConfig: configured }), { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_STAGE_UNMAPPED' });
    assert.equal(writes, 0);
  } finally { reader.readMoySkladCustomerOrderForBaseline = read; }
  await reset(); b24Stage = 'UC_7QBU06';
  configured.config.dealOrderRuntime.stageTransitions.bitrix24ToMoysklad.push(configured.config.dealOrderRuntime.stageTransitions.bitrix24ToMoysklad[2]);
  assert.deepEqual(await service.process({ pair, eventId: 'stage-duplicate-warning', eventConfig: configured }), { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_STAGE_UNMAPPED' });
  assert.equal(writes, 0);
});
test('stage reference parser rejects foreign, query, malformed and type-conflicting references', () => {
  const stages = configuredStagePairs(config.config);
  const exact = `${base}entity/customerorder/metadata/states/${map.pairs[2].moyskladId}`;
  for (const href of [exact.replace(base, 'https://foreign.invalid/'), exact + '?x=1', exact + '#x', exact + '/extra', exact.replace('/states/', '/products/')]) {
    assert.equal(readConfiguredStage({ state: { meta: { href, type: 'state' } } }, stages, 'MOYSKLAD'), null);
  }
  assert.equal(readConfiguredStage({ state: { meta: { href: exact, type: 'product' } } }, stages, 'MOYSKLAD'), null);
  assert.equal(readConfiguredStage({ state: { meta: { href: exact, type: 'state' } } }, stages, 'MOYSKLAD'), map.pairs[2].moyskladId);
});
test('user cancellation rules are directional: LOSE never becomes the reverse target', async () => {
  const cancelled = map.pairs.find(x => x.bitrix24StageId === 'UC_BBJSFZ')!;
  for (const stage of ['UC_BBJSFZ', 'LOSE']) {
    await reset(); b24Stage = stage;
    assert.deepEqual(await service.process({ pair, eventId: randomUUID(), eventConfig: config }), { status: 'SYNCED', heldRules: 0 });
    assert.equal(msStage, cancelled.moyskladId); assert.equal(b24Stage, stage); assert.equal(writes, 1);
    await service.process({ pair, eventId: randomUUID(), eventConfig: config });
    assert.equal(writes, 1, 'source cancellation echo does not reclassify LOSE');
  }
  for (const msCancelled of [cancelled.moyskladId, map.reverseAliases[0].moyskladId]) {
    await reset(); msStage = msCancelled;
    assert.deepEqual(await service.process({ pair, eventId: randomUUID(), eventConfig: config }), { status: 'SYNCED', heldRules: 0 });
    assert.equal(b24Stage, 'UC_BBJSFZ'); assert.notEqual(b24Stage, 'LOSE'); assert.equal(writes, 1);
    await service.process({ pair, eventId: randomUUID(), eventConfig: config }); assert.equal(writes, 1);
  }
});
test('simultaneous stage changes retain MySklad priority', async () => {
  await reset(); b24Stage = 'UC_7QBU06'; msStage = map.pairs[3].moyskladId;
  assert.deepEqual(await service.process({ pair, eventId: 'conflicting-stage', eventConfig: config }), { status: 'SYNCED', heldRules: 0 });
  assert.equal(b24Stage, map.pairs[3].bitrix24StageId); assert.equal(msStage, map.pairs[3].moyskladId); assert.equal(writes, 1);
});
test('legacy bilateral stage config remains supported when directional transitions are absent', async () => {
  await reset(); b24Stage = 'UC_7QBU06';
  const legacy = structuredClone(config);
  delete legacy.config.dealOrderRuntime.stageTransitions;
  legacy.config.dealOrderRuntime.stages = map.pairs.slice(0, 15).map(x => ({ ...toPair(x), creationEnabled: x.bitrix24StageId === 'PREPARATION' }));
  assert.deepEqual(await service.process({ pair, eventId: 'legacy-map', eventConfig: legacy }), { status: 'SYNCED', heldRules: 0 });
  assert.equal(msStage, map.pairs[2].moyskladId); assert.equal(writes, 1);
});
test('disabled directions and PAUSE/OFF fence stage writes', async () => {
  for (const mode of ['pause', 'off']) {
    await reset(); b24Stage = 'UC_7QBU06';
    await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: mode } });
    const result = await service.process({ pair, eventId: randomUUID(), eventConfig: config });
    assert.equal(result.status, 'RETRY'); assert.equal(writes, 0);
  }
  await database.syncSetting.update({ where: { id: 'global' }, data: { serviceMode: 'on' } });
  await reset(); b24Stage = 'UC_7QBU06';
  await database.syncDirectionSetting.update({ where: { entityKey: 'deals-orders' }, data: { bitrix24ToMoysklad: false } });
  assert.deepEqual(await service.process({ pair, eventId: 'direction-off', eventConfig: config }), { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_STAGE_DIRECTION_DISABLED' });
  assert.equal(writes, 0);
  await database.syncDirectionSetting.update({ where: { entityKey: 'deals-orders' }, data: { bitrix24ToMoysklad: true } });
});
