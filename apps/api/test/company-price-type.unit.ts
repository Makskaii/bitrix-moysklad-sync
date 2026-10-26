import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMPANY_PRICE_TYPE_FIELD, COMPANY_PRICE_TYPE_MARKER, assertCompanyPriceTypeSchema, companyPriceTypeOptions, selectedCompanyPriceType, normalizeMoyskladPriceType, encodeMoyskladPriceType } from '../src/clients/company-price-type';
import { CompanyPriceTypeDirectoryService, planCompanyPriceOptions } from '../src/clients/company-price-type-directory.service';
import { HttpClientSyncGateway } from '../src/clients/client-sync.gateway';
import { applyFieldTransform } from '../src/field-settings/field-transform';
import { DatabaseService } from '../src/database.service';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
const one = '02b04e92-d515-11e2-e753-7054d21a8d1e';
const two = 'f2ead8ce-de34-11e5-7a69-8f550015ae90';
const base = 'https://ms.invalid/api/remap/1.2/';
const option = { id: '626', uuid: one, name: 'Retail' };
const field = () => ({ ID: '1424', FIELD_NAME: COMPANY_PRICE_TYPE_FIELD, XML_ID: COMPANY_PRICE_TYPE_MARKER, USER_TYPE_ID: 'iblock_element', MULTIPLE: 'N', SETTINGS: { IBLOCK_ID: 108 } });
const elements = () => [{ ID: '626', IBLOCK_ID: '108', CODE: one, NAME: 'Retail' }];

test('typed option contract checks marker, multiplicity, unique IDs and UUIDs; names do not establish identity', () => {
  const metadata = field();
  assertCompanyPriceTypeSchema(metadata);
  const options = companyPriceTypeOptions(elements());
  assert.equal(selectedCompanyPriceType('626', options), one);
  assert.equal(selectedCompanyPriceType(['626'], options), one);
  assert.throws(() => selectedCompanyPriceType(['626', '628'], options), /SELECTION_INVALID/);
  assert.equal(selectedCompanyPriceType('', options), null);
  assert.throws(() => selectedCompanyPriceType('Retail', options), /UNMAPPED/);
  metadata.MULTIPLE = 'Y';
  assert.throws(() => assertCompanyPriceTypeSchema(metadata), /SCHEMA_INVALID/);
  const duplicate = elements(); duplicate.push({ ID: '628', IBLOCK_ID: '108', CODE: one, NAME: 'Other' });
  assert.throws(() => companyPriceTypeOptions(duplicate), /OPTIONS_INVALID/);
});

test('catalog updates retain option IDs/UUIDs and removed variants; new UUIDs receive new options', () => {
  const old = [option, { id: '628', uuid: two, name: 'Old removed' }];
  const three = '78a9ffa3-0712-11e6-7a69-8f5500119e54';
  const plan = planCompanyPriceOptions([{ id: one, name: 'Renamed' }, { id: three, name: 'New' }], old);
  assert.equal(plan.renamed, 1); assert.equal(plan.added, 1); assert.deepEqual(plan.missing, [two]);
  assert.equal(plan.list[0].ID, '626'); assert.equal(plan.list[0].CODE, one);
  assert.equal(plan.list[1].ID, '628'); assert.equal(plan.list[2].CODE, three);
  assert.equal(plan.list[2].ID, undefined);
  assert.throws(() => planCompanyPriceOptions([{ id: one, name: 'A' }, { id: one, name: 'B' }], []), /CATALOG_INVALID/);
});

test('native pricetype references use the exact configured origin/path and agree with any explicit ID', () => {
  const value = encodeMoyskladPriceType({ priceType: one }, base);
  assert.deepEqual(value, { priceType: { meta: { href: base + 'context/companysettings/pricetype/' + one, type: 'pricetype', mediaType: 'application/json' } } });
  assert.equal(normalizeMoyskladPriceType(value, base).priceType, one);
  assert.equal(normalizeMoyskladPriceType({ priceType: { id: one, name: 'Unused label' } }, base).priceType, one);
  assert.equal(normalizeMoyskladPriceType({}, base).priceType, null);
  assert.throws(() => normalizeMoyskladPriceType({ priceType: { id: two, ...(value.priceType as object) } }, base), /REFERENCE_INVALID/);
  assert.throws(() => normalizeMoyskladPriceType(value, 'https://foreign.invalid/'), /REFERENCE_INVALID/);
  assert.throws(() => encodeMoyskladPriceType({ priceType: 'Retail' }, base), /WRITE_INVALID/);
});

test('reserved transform accepts verified UUIDs only and leaves an empty selection unchanged', () => {
  assert.deepEqual(applyFieldTransform({ kind: 'price-type-uuid' }, one), { status: 'mapped', value: one, transform: 'price-type-uuid' });
  for (const blank of [null, undefined, '', false]) assert.equal(applyFieldTransform({ kind: 'price-type-uuid' }, blank).status, 'skip');
  for (const wrong of ['626', 'Retail', { id: one }]) assert.equal(applyFieldTransform({ kind: 'price-type-uuid' }, wrong).status, 'error');
});

test('actual client adapter resolves company reference CODE UUID, writes native reference, and normalizes readback', async () => {
  const original = { b: process.env.BITRIX24_REST_BASE_URL, m: process.env.MOYSKLAD_API_BASE_URL, t: process.env.MOYSKLAD_API_TOKEN };
  Object.assign(process.env, { BITRIX24_REST_BASE_URL: 'https://b24.invalid/rest/', MOYSKLAD_API_BASE_URL: base, MOYSKLAD_API_TOKEN: 'fake' });
  let selected: string = '626', native: Record<string, unknown> = {}, reads = 0, writes = 0;
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    let result: unknown;
    if (url.hostname === 'b24.invalid') {
      const method = url.pathname.split('/').at(-1);
      if (method === 'crm.company.get.json') result = { ID: '1', [COMPANY_PRICE_TYPE_FIELD]: selected };
      else if (method === 'crm.company.userfield.list.json') { reads++; result = [{ ID: '1424' }]; }
      else if (method === 'crm.company.userfield.get.json') result = field();
      else { assert.equal(method, 'lists.element.get.json'); result = elements(); }
      return new Response(JSON.stringify({ result }));
    }
    assert.equal(url.pathname, '/api/remap/1.2/entity/counterparty/owned');
    if (init?.method === 'PUT') { writes++; native = JSON.parse(String(init.body)); }
    return new Response(JSON.stringify({ id: 'owned', ...native }));
  }) as typeof fetch;
  try {
    const api = new HttpClientSyncGateway(fake);
    assert.equal((await api.readBitrix('COMPANY', '1'))[COMPANY_PRICE_TYPE_FIELD], one);
    await api.readBitrix('COMPANY', '1'); assert.equal(reads, 1);
    await api.updateMoysklad('counterparty', 'owned', null, { priceType: one });
    assert.equal((await api.readMoysklad('counterparty', 'owned', null)).priceType, one);
    assert.equal(writes, 1);
    selected = '999'; await assert.rejects(api.readBitrix('COMPANY', '1'), /UNMAPPED/);
    await assert.rejects(api.updateMoysklad('contactperson', 'owned', 'parent', { priceType: one }), /REQUIRES_COUNTERPARTY/);
    selected = ''; assert.equal((await api.readBitrix('COMPANY', '1'))[COMPANY_PRICE_TYPE_FIELD], '');
  } finally {
    for (const [key, value] of Object.entries({ BITRIX24_REST_BASE_URL: original.b, MOYSKLAD_API_BASE_URL: original.m, MOYSKLAD_API_TOKEN: original.t })) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('option worker respects OFF/dry/controlled gates before reading providers', async () => {
  const keys = ['SYNC_MODE', 'COMPANY_PRICE_TYPE_SYNC_ENABLED', 'CONTROLLED_LIVE_TEST_MODE'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let mode = 'off';
  const db = { syncSetting: { findUnique: async () => ({ serviceMode: mode }) } } as unknown as DatabaseService;
  try {
    process.env.SYNC_MODE = 'apply'; process.env.COMPANY_PRICE_TYPE_SYNC_ENABLED = 'enabled'; delete process.env.CONTROLLED_LIVE_TEST_MODE;
    const service = new CompanyPriceTypeDirectoryService(db);
    assert.equal(await service.runOnce(), null);
    mode = 'on'; process.env.SYNC_MODE = 'dry'; assert.equal(await service.runOnce(), null);
    process.env.SYNC_MODE = 'apply'; process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled'; assert.equal(await service.runOnce(), null);
  } finally { for (const key of keys) if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
});

test('settings reject the UUID transform on unrelated or incompatible fields', async () => {
  const source = { code: COMPANY_PRICE_TYPE_FIELD, type: 'iblock_element', writable: true, cardinality: 'single', shape: 'scalar', referenceKind: 'pricetype' };
  const target = { code: 'priceType', type: 'pricetype', writable: true, cardinality: 'single', shape: 'scalar', referenceKind: 'pricetype' };
  const provider = { fieldCatalogs: async () => ({ bitrix24: [source], moysklad: [target] }) };
  const settings = new FieldSettingsService({} as never, provider as never, {} as never);
  const rule = { id: 'price', entity: 'companies', sourceField: COMPANY_PRICE_TYPE_FIELD, targetField: 'priceType', criticality: 'optional', bitrix24ToMoysklad: { enabled: true, transform: { kind: 'price-type-uuid' } }, moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' } } };
  const config = { rules: [rule], groups: [] };
  await (settings as any).validateConfiguredFields(config, 'fake');
  source.referenceKind = 'string';
  await assert.rejects((settings as any).validateConfiguredFields(config, 'fake'), /reserved/);
  source.referenceKind = 'pricetype'; source.cardinality = 'multiple';
  await assert.rejects((settings as any).validateConfiguredFields(config, 'fake'), /reserved/);
});

test('actual option worker adds/renames by UUID and preserves original option IDs on repeated runs', async () => {
  const keys = ['SYNC_MODE', 'COMPANY_PRICE_TYPE_SYNC_ENABLED', 'CONTROLLED_LIVE_TEST_MODE', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { SYNC_MODE: 'apply', COMPANY_PRICE_TYPE_SYNC_ENABLED: 'enabled', CONTROLLED_LIVE_TEST_MODE: '', BITRIX24_REST_BASE_URL: 'https://b24.invalid/rest/', MOYSKLAD_API_BASE_URL: base, MOYSKLAD_API_TOKEN: 'fake' });
  const oldFetch = globalThis.fetch;
  const current = elements(); let writes = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'ms.invalid') return new Response(JSON.stringify([{ id: one, name: 'Renamed', meta: { type: 'pricetype' } }, { id: two, name: 'Wholesale', meta: { type: 'pricetype' } }]));
    const method = url.pathname.split('/').at(-1);
    let result: unknown;
    if (method === 'crm.company.userfield.list.json') result = [{ ID: '1424' }];
    else if (method === 'crm.company.userfield.get.json') result = field();
    else if (method === 'lists.field.get.json') result = { NAME: { FIELD_ID: 'NAME' } };
    else if (method === 'lists.element.get.json') result = current;
    else {
      const data = JSON.parse(String(init?.body)); assert.equal(data.IBLOCK_ID, '108'); assert.equal(data.IBLOCK_TYPE_ID, 'lists');
      if (method === 'lists.element.update.json') {
        assert.equal(data.ELEMENT_ID, '626'); assert.equal(data.ELEMENT_CODE, one);
        current[0].NAME = data.FIELDS.NAME; result = true;
      } else {
        assert.equal(method, 'lists.element.add.json'); assert.equal(data.ELEMENT_CODE, two);
        current.push({ ID: '628', IBLOCK_ID: '108', CODE: data.ELEMENT_CODE, NAME: data.FIELDS.NAME }); result = '628';
      }
      writes++;
    }
    return new Response(JSON.stringify({ result }));
  }) as typeof fetch;
  const tx = { $queryRaw: async () => [{ serviceMode: 'on' }] };
  const database = { syncSetting: { findUnique: async () => ({ serviceMode: 'on' }) }, $transaction: async (work: (v: unknown) => unknown) => work(tx) } as unknown as DatabaseService;
  try {
    const service = new CompanyPriceTypeDirectoryService(database);
    assert.deepEqual(await service.runOnce(), { added: 1, renamed: 1, deferred: 0, missing: 0, options: 2 });
    assert.deepEqual(await service.runOnce(), { added: 0, renamed: 0, deferred: 0, missing: 0, options: 2 });
    assert.equal(writes, 2); assert.equal(current[0].ID, '626');
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of keys) if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
  }
});
