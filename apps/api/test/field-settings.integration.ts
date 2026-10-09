import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LocalAdminPreviewModule } from '../src/admin/local-preview.module';
import { DatabaseService } from '../src/database.service';
import { APPROVED_DICTIONARY_PAIRS } from '../src/field-settings/approved-mappings';

const nativeFetch = globalThis.fetch;
const originalEnv = new Map<string, string | undefined>();
let app: INestApplication;
let apiUrl: string;
const pairsByKey: Record<string, string> = {};
const createdPairIds: string[] = [];
const fakeUpstreamMethods: string[] = [];
const fakeB24UnitIds = [1, 3, 5, 7, 9, 10, 12, 14, 16, 18, 20, 22];
const fakeB24PriceIds = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
const fakeMsUnitIds = ['250d5161-f815-4524-85b6-fd6afebc1ad6', '8e2eb543-99e9-4077-bc31-93b1359de9c4', '2ec1170c-3f69-4409-87bb-c68e0011b275', '19f1edc0-fc42-4001-94cb-c9ec9c62ec10', '605a1781-b652-11e3-feb0-002590a28eca', 'f5611dc2-1acd-11e7-7a31-d0fd001085d2', '647775b2-3b57-409b-910e-8b17940b279f', 'dfe54549-ec98-4fd7-ad1b-215162a9199a', '7cfd013f-33d0-448a-a4aa-1c8bb2e05417', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
const fakeMsPriceIds = ['02b04e92-d515-11e2-e753-7054d21a8d1e', 'f2ead8ce-de34-11e5-7a69-8f550015ae90', '78a9ffa3-0712-11e6-7a69-8f5500119e54', '1b4623d2-2857-11eb-0a80-044e00021305', '181fccd0-7736-11ed-0a80-080900027768', '47e91e27-ad13-11f1-0a80-144700177791', '5c8a8396-b503-11ee-0a80-0d3e00059f64', '7c45db73-7b9e-11f1-0a80-182500121f3e', 'e4a858d7-e190-11f0-0a80-1059000f9c17', '61161db9-7f0b-11ee-0a80-0b350015853e', '138eeb4d-82c0-11ed-0a80-0ffb0028e290', 'a88d2683-3e1f-11f1-0a80-185000073e51'];

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to an isolated PostgreSQL test schema');
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema') ?? '';
  assert.match(schema, /^issue10_test$/i, 'refusing to run field-settings tests outside the issue10_test schema');
  for (const key of ['ADMIN_PREVIEW', 'SYNC_MODE', 'SYNC_STATE', 'BITRIX24_EVENT_APPLICATION_TOKEN', 'BITRIX24_REST_BASE_URL', 'MOYSKLAD_API_BASE_URL', 'MOYSKLAD_API_TOKEN']) originalEnv.set(key, process.env[key]);
  process.env.ADMIN_PREVIEW = '1';
  process.env.SYNC_MODE = 'apply';
  process.env.SYNC_STATE = 'pause';
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-issue10-event-token';
  process.env.BITRIX24_REST_BASE_URL = 'https://fake-bitrix.test/rest/';
  process.env.MOYSKLAD_API_BASE_URL = 'https://fake-moysklad.test/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-issue10-read-token';
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return nativeFetch(input, init);
    fakeUpstreamMethods.push(url.pathname.split('/').at(-1) ?? '');
    if (url.origin === 'https://fake-bitrix.test') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      const method = url.pathname.split('/').at(-1);
      const result = method === 'catalog.measure.list.json'
        ? fakeB24UnitIds.map((id) => ({ id, code: `u${id}`, name: `Unit ${id}` }))
        : method === 'catalog.priceType.list.json'
          ? fakeB24PriceIds.map((id) => ({ id, code: `p${id}`, name: `Price ${id}` }))
          : method === 'crm.contact.fields.json'
            ? { NAME: { type: 'string', title: 'First name', isReadOnly: false }, LAST_NAME: { type: 'string', title: 'Last name', isReadOnly: false }, EMAIL: { type: 'crm_multifield', title: 'Email', isReadOnly: false }, UF_CRM_CUSTOM: { type: 'string', title: 'Custom contact field', isReadOnly: false }, READ_ONLY: { type: 'string', title: 'System field', isReadOnly: true } }
            : method === 'crm.deal.fields.json'
              ? { TITLE: { type: 'string', title: 'Deal title', isReadOnly: false }, NAME: { type: 'string', title: 'Deal name', isReadOnly: false }, UNKNOWN_WRITABILITY: { type: 'string', title: 'Unknown writability' } }
            : method === 'catalog.product.getFieldsByFilter.json'
              ? form.get('filter[iblockId]') === '11'
                ? { product: { NAME: { type: 'string', name: 'Product name', isReadOnly: false }, property108: { type: 'string', name: 'Inventory key', isReadOnly: false }, USER_LABEL: { type: 'string', formLabel: 'Пользовательская подпись' }, NO_TITLE: { type: 'string', isReadOnly: false } } }
                : { product: {} }
            : method === 'catalog.catalog.list.json'
              ? { catalogs: [{ id: 11, name: 'Товары' }] }
            : method === 'catalog.product.get.json'
              ? { product: { id: form.get('id'), iblockId: 11, name: 'Sample product', code: 'SKU-1' } }
            : method === 'lists.element.get.json'
              ? (form.get('IBLOCK_ID') === '42' ? APPROVED_DICTIONARY_PAIRS.service : APPROVED_DICTIONARY_PAIRS.paymentMethod).map(([ID]) => ({ ID, CODE: `code-${ID}`, NAME: `Value ${ID}` }))
          : method === 'crm.company.get.json'
            ? { ID: form.get('id'), TITLE: 'Example Company' }
          : { ID: form.get('id'), NAME: 'Ada', LAST_NAME: 'Lovelace', TITLE: 'Sample', EMAIL: [{ VALUE: 'source@example.test', VALUE_TYPE: 'WORK' }] };
      return new Response(JSON.stringify({ result }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.origin === 'https://fake-moysklad.test') {
      const isUnitList = url.pathname.endsWith('/entity/uom');
      const isPriceList = url.pathname.endsWith('/companysettings/pricetype');
      const serviceDirectory = url.pathname.endsWith('/entity/customentity/f0177126-8e74-11e3-b761-002590a28eca');
      const paymentDirectory = url.pathname.endsWith('/entity/customentity/0ecffb86-d8a3-11eb-0a80-0dbc000256e5');
      const ids = isUnitList ? fakeMsUnitIds : fakeMsPriceIds;
      const rows = ids.map((id, index) => ({ id, code: `m${index + 1}`, name: `MS ${index + 1}`, externalCode: `m${index + 1}` }));
      const dictionaryRows = serviceDirectory
        ? APPROVED_DICTIONARY_PAIRS.service.map(([, id]) => ({ id, name: `MS service ${id}` }))
        : paymentDirectory ? APPROVED_DICTIONARY_PAIRS.paymentMethod.map(([, id]) => ({ id, name: `MS payment ${id}` })) : [];
      const body = isUnitList || isPriceList ? { rows, meta: { size: rows.length } }
        : serviceDirectory || paymentDirectory ? { rows: dictionaryRows, meta: { size: dictionaryRows.length } }
        : url.pathname.endsWith('/metadata/attributes') ? { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Preferred contact', type: 'string' }] }
        : url.pathname.endsWith('/00000000-0000-4000-8000-000000000005')
          ? { id: '00000000-0000-4000-8000-000000000005', email: 'target@example.test' }
        : { id: url.pathname.split('/').at(-1), name: 'Sample target', updated: '2026-10-07 10:00:00.000', email: 'target@example.test', opaqueField: 'opaque' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected test HTTP request: ${url.origin}${url.pathname}`);
  };
  app = await NestFactory.create(LocalAdminPreviewModule.register(), { logger: false });
  await app.listen(0, '127.0.0.1');
  apiUrl = await app.getUrl();
  await app.get(DatabaseService).$executeRawUnsafe('TRUNCATE TABLE "InboundEventSettings", "FieldSettingsState", "FieldSettingsVersion", "InboundEvent" CASCADE');
  await app.get(DatabaseService).syncSetting.upsert({
    where: { id: 'global' },
    create: { serviceMode: 'pause' },
    update: { serviceMode: 'pause' },
  });
  const pairFixtures = [
    ['contact-42', 'CONTACT', '42', '00000000-0000-4000-8000-000000000001'],
    ['contact-1', 'CONTACT', 'contact-1', '00000000-0000-4000-8000-000000000002'],
    ['contact-no-name', 'CONTACT', 'contact-no-name', '00000000-0000-4000-8000-000000000005'],
    ['company-1', 'COMPANY', 'company-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['deal-1', 'DEAL', 'deal-1', '00000000-0000-4000-8000-000000000004'],
    ['product-1', 'PRODUCT', 'product-1', '00000000-0000-4000-8000-000000000003'],
  ] as const;
  for (const [key, entityType, bitrix24Id, moyskladId] of pairFixtures) {
    const pair = await app.get(DatabaseService).entityPair.create({ data: { entityType, bitrix24Id, moyskladId, source: 'MANUAL' } });
    pairsByKey[key] = pair.id;
    createdPairIds.push(pair.id);
  }
});

after(async () => {
  if (app) {
    await app.get(DatabaseService).entityPair.deleteMany({ where: { id: { in: createdPairIds } } });
    (app.getHttpServer() as import('node:http').Server).closeAllConnections();
    await app.close();
  }
  globalThis.fetch = nativeFetch;
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('field settings expose only the approved unit and price pairs and mark exclusions without mapping them', async () => {
  const response = await fetch(`${apiUrl}/api/admin/field-settings`);
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const settings = JSON.parse(body) as {
    version: number;
    references: {
      units: Array<{ bitrix24Id: number; moyskladId: string | null; status: string }>;
      priceTypes: Array<{ bitrix24Id: number; moyskladId: string | null; status: string }>;
      dictionaries: Array<{ key: string; bitrix24Field: string; moyskladAttributeId: string; pairs: Array<unknown> }>;
    };
  };
  assert.equal(settings.version, 1);
  assert.equal(settings.references.units.filter((pair) => pair.status === 'configured').length, 9);
  assert.deepEqual(settings.references.units.filter((pair) => pair.status === 'unmapped').map((pair) => pair.bitrix24Id), [14, 16, 20]);
  assert.equal(settings.references.priceTypes.filter((pair) => pair.status === 'configured').length, 7);
  assert.deepEqual(settings.references.priceTypes.filter((pair) => pair.status === 'excluded').map((pair) => pair.bitrix24Id), [10, 18, 20, 22]);
  assert.equal(settings.references.dictionaries.find((dictionary) => dictionary.key === 'service')?.pairs.length, 46);
  assert.equal(settings.references.dictionaries.find((dictionary) => dictionary.key === 'payment-method')?.pairs.length, 5);
});

test('preview reads only an active saved pair, applies the draft transform, and never writes', async () => {
  const response = await fetch(`${apiUrl}/api/admin/field-settings/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-admin-token' },
    body: JSON.stringify({
      entity: 'contacts-companies', direction: 'BITRIX24_TO_MOYSKLAD',
      pairIds: [pairsByKey['contact-42'], pairsByKey['contact-1']],
      config: { rules: [{
        id: 'deal-title', entity: 'deals-orders', sourceField: 'NAME', targetField: 'attributes.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
        moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' } },
      }], groups: [{
        id: 'person-name', entity: 'contacts-companies', direction: 'BITRIX24_TO_MOYSKLAD', targetField: 'name',
        sourceFields: ['NAME', 'LAST_NAME'], transform: { kind: 'join-non-empty', separator: ' ' },
      }] },
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  const result = JSON.parse(body) as { writes: number; results: Array<{ transformed: Record<string, { value: string }>; sourceLabel: string; targetCurrent: Record<string, unknown>; errors: string[]; version: number }> };
  assert.equal(result.writes, 0);
  assert.equal(result.results.length, 2);
  assert.equal('attributes.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' in result.results[0]!.transformed, false, 'preview ignores mappings configured for another entity');
  assert.equal(result.results[0]?.transformed.name?.value, 'Ada Lovelace');
  assert.equal(result.results[0]?.sourceLabel, 'Ada Lovelace');
  assert.equal(result.results[0]?.targetCurrent.name, 'Sample target');
  assert.deepEqual(result.results[0]?.errors, []);
  assert.equal(result.results[0]?.version, 1);
  const arbitrary = await fetch(`${apiUrl}/api/admin/field-settings/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-admin-token' },
    body: JSON.stringify({ entity: 'contacts', direction: 'BITRIX24_TO_MOYSKLAD', pairIds: [pairsByKey['contact-1']], config: {
      rules: [{ id: 'unsafe', entity: 'contacts', sourceField: 'UNLISTED', targetField: 'name', bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } }, moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' } } }], groups: [], references: (await (await fetch(`${apiUrl}/api/admin/field-settings`)).json() as { config: { references: unknown } }).config.references,
    } }),
  });
  assert.equal(arbitrary.status, 400, `preview must reject fields outside live metadata: ${await arbitrary.text()}`);
  const active = await fetch(`${apiUrl}/api/admin/field-settings`);
  assert.equal((await active.json() as { version: number }).version, 1);
});

test('preview rejects arbitrary IDs and applies reverse-direction rules for saved pairs', async () => {
  const rejected = await fetch(`${apiUrl}/api/admin/field-settings/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-admin-token' },
    body: JSON.stringify({ entity: 'contacts', direction: 'MOYSKLAD_TO_BITRIX24', pairIds: ['not-a-saved-pair'] }),
  });
  assert.equal(rejected.status, 400);
  const response = await fetch(`${apiUrl}/api/admin/field-settings/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-admin-token' },
    body: JSON.stringify({
      entity: 'contacts', direction: 'MOYSKLAD_TO_BITRIX24',
      pairIds: [pairsByKey['contact-1']],
      config: { rules: [{
        id: 'reverse-email', entity: 'contacts', sourceField: 'EMAIL', targetField: 'email',
        bitrix24ToMoysklad: { enabled: false, transform: { kind: 'tbd' } },
        moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } },
      }], groups: [] },
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  const preview = JSON.parse(body) as { writes: number; results: Array<{ transformed: Record<string, { value: unknown }>; version: number }> };
  assert.equal(preview.writes, 0);
  assert.equal(preview.results[0]?.transformed.EMAIL?.value, 'target@example.test');
  assert.equal(preview.results[0]?.version, 1);
});

test('preview reads company pairs separately from contacts', async () => {
  const response = await fetch(`${apiUrl}/api/admin/field-settings/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-admin-token' },
    body: JSON.stringify({ entity: 'companies', direction: 'BITRIX24_TO_MOYSKLAD', pairIds: [pairsByKey['company-1']] }),
  });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  const preview = JSON.parse(body) as { results: Array<{ sourceLabel: string; writes: number }> };
  assert.equal(preview.results[0].sourceLabel, 'Example Company');
  assert.equal(preview.results[0].writes, 0);
});

test('entity field metadata loads without a saved pair or reading record values', async () => {
  fakeUpstreamMethods.length = 0;
  const response = await fetch(`${apiUrl}/api/admin/field-settings/fields?entity=contacts`, {
    headers: { authorization: 'Bearer synthetic-admin-token' },
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const catalog = JSON.parse(body) as { bitrix24: Array<Record<string, unknown>>; moysklad: Array<Record<string, unknown>> };
  assert.ok(catalog.bitrix24.some((field) => field.code === 'NAME' && field.title === 'First name' && field.type === 'string'));
  assert.ok(catalog.bitrix24.some((field) => field.code === 'NAME' && field.category === 'standard'));
  assert.ok(catalog.bitrix24.some((field) => field.code === 'UF_CRM_CUSTOM' && field.category === 'custom'));
  assert.ok(catalog.moysklad.some((field) => field.code === 'email' && field.title === 'Электронная почта' && field.type === 'string'));
  assert.ok(catalog.moysklad.some((field) => field.code === 'name' && field.title === 'Наименование'));
  assert.ok(catalog.moysklad.some((field) => field.code === 'name' && field.category === 'standard'));
  assert.ok(!catalog.moysklad.some((field) => field.code === 'opaqueField'), 'standard field catalog must not be inferred from a record');
  assert.ok(catalog.moysklad.some((field) => field.code === 'attributes.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' && field.title === 'Preferred contact'));
  assert.ok(catalog.moysklad.some((field) => field.code === 'attributes.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' && field.category === 'custom'));
  assert.ok([...catalog.bitrix24, ...catalog.moysklad].every((field) => !('value' in field)));
  assert.ok(fakeUpstreamMethods.includes('crm.contact.fields.json'));
  assert.ok(!fakeUpstreamMethods.includes('crm.contact.get.json'));
});

test('field metadata ignores pair IDs and loads by selected entity', async () => {
  const response = await fetch(`${apiUrl}/api/admin/field-settings/fields?entity=companies`, {
    headers: { authorization: 'Bearer synthetic-admin-token' },
  });
  assert.equal(response.status, 200, await response.text());
});

test('catalog field metadata uses the product information block and API field names', async () => {
  fakeUpstreamMethods.length = 0;
  const response = await fetch(`${apiUrl}/api/admin/field-settings/fields?entity=catalog`, {
    headers: { authorization: 'Bearer synthetic-admin-token' },
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const catalog = JSON.parse(body) as {
    bitrix24: Array<{ code: string; title: string; type: string; category: string }>;
    moysklad: Array<{ code: string; title: string; type: string; category: string }>;
  };
  assert.ok(catalog.bitrix24.some((field) => field.code === 'property108' && field.title === 'Inventory key' && field.type === 'string'));
  assert.ok(catalog.bitrix24.some((field) => field.code === 'property108' && field.category === 'custom'));
  assert.ok(catalog.bitrix24.some((field) => field.code === 'NO_TITLE' && field.title === '' && field.type === 'string'));
  assert.ok(catalog.bitrix24.some((field) => field.code === 'USER_LABEL' && field.title === 'Пользовательская подпись'));
  assert.ok(catalog.bitrix24.some((field) => field.code === 'USER_LABEL' && field.category === 'standard'), 'unknown field codes are not assumed to be user-defined');
  assert.ok(catalog.moysklad.some((field) => field.code === 'name' && field.title === 'Наименование товара'));
  assert.ok(catalog.moysklad.some((field) => field.code === 'name' && field.category === 'standard'));
  assert.ok(fakeUpstreamMethods.includes('catalog.catalog.list.json'));
  assert.ok(!fakeUpstreamMethods.includes('catalog.product.get.json'), 'field metadata must not read a product record');
});

test('live service and payment catalogs expose current choices and preserve editable dictionary pairs', async () => {
  const response = await fetch(`${apiUrl}/api/admin/field-settings/catalogs`, { headers: { authorization: 'Bearer synthetic-admin-token' } });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const catalogs = JSON.parse(body) as { dictionaries: Array<{ key: string; values: { bitrix24: Array<{ id: string; title: string }>; moysklad: Array<{ id: string; title: string }> } }> };
  const service = catalogs.dictionaries.find((dictionary) => dictionary.key === 'service')!;
  const payment = catalogs.dictionaries.find((dictionary) => dictionary.key === 'payment-method')!;
  assert.equal(service.values.bitrix24.length, 46);
  assert.equal(service.values.moysklad.length, 46);
  assert.equal(payment.values.bitrix24.length, 5);
  assert.equal(payment.values.moysklad.length, 5);
  assert.equal(service.values.bitrix24[0].title, `Value ${service.values.bitrix24[0].id}`);
});

test('catalog paging exposes live candidates and allows manual reassignment to an existing unapproved ID', async () => {
  const pageResponse = await fetch(`${apiUrl}/api/admin/field-settings/catalogs?kind=units&system=moysklad`, { headers: { authorization: 'Bearer synthetic-admin-token' } });
  const page = await pageResponse.json() as { items: Array<{ id: string; code: string; label: string }>; nextCursor: string | null };
  assert.equal(pageResponse.status, 200);
  assert.equal(page.nextCursor, null);
  assert.ok(page.items.some((item) => item.id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));

  const activeResponse = await fetch(`${apiUrl}/api/admin/field-settings`);
  const active = await activeResponse.json() as { config: { references: { units: Array<{ bitrix24Id: number; moyskladId: string | null; status: string }> } } };
  const config = structuredClone(active.config) as { references: { units: Array<{ bitrix24Id: number; moyskladId: string | null; status: string }> }; [key: string]: unknown };
  config.references.units = config.references.units.map((unit) => unit.bitrix24Id === 14
    ? { ...unit, moyskladId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'configured' }
    : unit);
  const saveResponse = await fetch(`${apiUrl}/api/admin/field-settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-admin-token' },
    body: JSON.stringify({ config }),
  });
  const saved = await saveResponse.json() as { config: { references: { units: Array<{ bitrix24Id: number; moyskladId: string | null }> } } };
  assert.equal(saveResponse.status, 200);
  assert.equal(saved.config.references.units.find((unit) => unit.bitrix24Id === 14)?.moyskladId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});

test('saving creates an immutable version and activates it for future events only', async () => {
  const originalResponse = await fetch(`${apiUrl}/api/admin/field-settings`);
  assert.equal(originalResponse.status, 200);
  const original = await originalResponse.json() as { version: number; config: Record<string, unknown> };
  const config = structuredClone(original.config) as Record<string, unknown>;
  config.rules = [{
    id: 'title-copy', entity: 'deals-orders', sourceField: 'TITLE', targetField: 'name',
    bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' } },
  }];
  const savedResponse = await fetch(`${apiUrl}/api/admin/field-settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-admin-token' }, body: JSON.stringify({ config }),
  });
  const body = await savedResponse.text();
  assert.equal(savedResponse.status, 200, body);
  const saved = JSON.parse(body) as { version: number; config: Record<string, unknown> };
  assert.equal(saved.version, original.version + 1);
  const previousResponse = await fetch(`${apiUrl}/api/admin/field-settings/versions/${original.version}`);
  const previous = await previousResponse.json() as { config: Record<string, unknown> };
  assert.deepEqual(previous.config.rules, []);
  const activeResponse = await fetch(`${apiUrl}/api/admin/field-settings`);
  const reloaded = await activeResponse.json() as { version: number; config: Record<string, unknown> };
  assert.equal(reloaded.version, saved.version);
  assert.deepEqual(reloaded.config.rules, saved.config.rules);
});

test('settings reject unknown field codes and read-only Bitrix24 targets', async () => {
  const current = await (await fetch(`${apiUrl}/api/admin/field-settings`)).json() as { config: Record<string, unknown> };
  const references = current.config.references;
  const invalid = { ...current.config, references, rules: [{
    id: 'arbitrary', entity: 'contacts', sourceField: 'DOES_NOT_EXIST', targetField: 'name',
    bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' } },
  }] };
  const response = await fetch(`${apiUrl}/api/admin/field-settings`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-admin-token' }, body: JSON.stringify({ config: invalid }) });
  assert.equal(response.status, 400, await response.text());
  const readOnly = { ...current.config, references, rules: [{
    id: 'readonly-target', entity: 'contacts', sourceField: 'READ_ONLY', targetField: 'name',
    bitrix24ToMoysklad: { enabled: false, transform: { kind: 'tbd' } },
    moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } },
  }] };
  const readOnlyResponse = await fetch(`${apiUrl}/api/admin/field-settings`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-admin-token' }, body: JSON.stringify({ config: readOnly }) });
  assert.equal(readOnlyResponse.status, 400, await readOnlyResponse.text());
  const protectedTarget = { ...current.config, references, rules: [{
    id: 'protected-target', entity: 'contacts', sourceField: 'NAME', targetField: 'id',
    bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
    moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' } },
  }] };
  const protectedResponse = await fetch(`${apiUrl}/api/admin/field-settings`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-admin-token' }, body: JSON.stringify({ config: protectedTarget }) });
  assert.equal(protectedResponse.status, 400, await protectedResponse.text());
  const unknownWritable = { ...current.config, references, rules: [{
    id: 'unknown-writable', entity: 'deals-orders', sourceField: 'UNKNOWN_WRITABILITY', targetField: 'name',
    bitrix24ToMoysklad: { enabled: false, transform: { kind: 'tbd' } },
    moyskladToBitrix24: { enabled: true, transform: { kind: 'copy' } },
  }] };
  const unknownWritableResponse = await fetch(`${apiUrl}/api/admin/field-settings`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-admin-token' }, body: JSON.stringify({ config: unknownWritable }) });
  assert.equal(unknownWritableResponse.status, 400, await unknownWritableResponse.text());
  const pairSpecific = await fetch(`${apiUrl}/api/admin/field-settings/preview`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-admin-token' }, body: JSON.stringify({
    entity: 'contacts', direction: 'BITRIX24_TO_MOYSKLAD', pairIds: [pairsByKey['contact-no-name']], config: { rules: [{
      id: 'missing-for-this-pair', entity: 'contacts', sourceField: 'NAME', targetField: 'name',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' } },
    }], groups: [] },
  }) });
  assert.equal(pairSpecific.status, 201, `entity-wide field mappings must not depend on the selected preview pair: ${await pairSpecific.text()}`);
});

test('accepted events stay pinned across activation and only an explicit one-event recompute changes the pin', async () => {
  const database = app.get(DatabaseService);
  const accepted = await app.get((await import('../src/field-settings/field-settings.service')).FieldSettingsService).saveAcceptedEvent({
    source: 'BITRIX24', deliveryKey: 'issue10-pinned-event', eventType: 'ONCRMCONTACTUPDATE', externalEntityId: '42',
    externalEntityType: 'contact', payload: { event: 'ONCRMCONTACTUPDATE' }, directionDisabled: false,
  });
  const settings = app.get((await import('../src/field-settings/field-settings.service')).FieldSettingsService);
  const originalPin = await settings.eventConfig(accepted.id);
  const next = await settings.save({ ...(originalPin.config as Record<string, unknown>), rules: [] }, 'synthetic-admin-token');
  assert.equal(next.version, originalPin.version + 1);
  assert.equal((await settings.eventConfig(accepted.id)).version, originalPin.version);
  await database.inboundEvent.update({ where: { id: accepted.id }, data: { status: 'SUCCEEDED' } });
  const recomputedVersion = await settings.repinEvent(accepted.id);
  assert.equal(recomputedVersion, next.version);
  assert.equal((await settings.eventConfig(accepted.id)).version, next.version);
});
