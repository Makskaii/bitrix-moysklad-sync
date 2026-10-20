import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { FieldSettingsService } from '../src/field-settings/field-settings.service';
import { ReadOnlyFieldDataProvider } from '../src/field-settings/read-only-field-data.provider';
import { SyncModeService } from '../src/sync-mode.service';

const stateId = '7c9a6305-32b3-4c79-959d-888888888888';
const currencyId = '7c9a6305-32b3-4c79-959d-999999999999';
const stageCatalog = ['0:PREPARATION', '2:C2:PREPARATION', '2:C2:WON'];

function serviceFor(input: {
  stages?: string[];
  currencies?: string[];
  providerError?: boolean;
  runtimeStageId?: string | null;
  catalogStageId?: string;
  stageStatus?: string;
  runtimeCurrency?: string | null;
  currencyStatus?: string;
}) {
  const catalogStageId = input.catalogStageId ?? '0:PREPARATION';
  const runtimeStageId = input.runtimeStageId === undefined ? 'PREPARATION' : input.runtimeStageId;
  const runtimeCurrency = input.runtimeCurrency === undefined ? 'RUB' : input.runtimeCurrency;
  const settings = {
    version: 12,
    config: {
      rules: [],
      references: { namedPairs: [
        { kind: 'dealStages', bitrix24Id: catalogStageId, moyskladId: stateId, status: input.stageStatus ?? 'confirmed' },
        { kind: 'currencies', bitrix24Id: runtimeCurrency ?? 'RUB', moyskladId: currencyId, status: input.currencyStatus ?? 'confirmed' },
      ] },
      dealOrderRuntime: {
        nativeOrderNumberingVerified: true,
        defaultOrganizationId: 'org-1', defaultStoreId: 'store-1', defaultEmployeeId: 'employee-1',
        stages: runtimeStageId ? [{ bitrix24StageId: runtimeStageId, moyskladId: stateId, creationEnabled: true }] : [],
        currencies: runtimeCurrency ? [{ bitrix24Code: runtimeCurrency, moyskladId: currencyId }] : [],
      },
    },
  };
  const fieldData = {
    dealOrderCatalogs: async () => {
      if (input.providerError) throw new Error('synthetic provider failure');
      return { stages: input.stages ?? stageCatalog, currencies: input.currencies ?? ['RUB'] };
    },
    optionalDealOrderReferenceWarnings: async () => [],
    verifyRequiredDealOrderReferences: async () => [],
  };
  return new SyncModeService(
    {} as DatabaseService,
    undefined,
    undefined,
    { active: async () => settings } as unknown as FieldSettingsService,
    fieldData as unknown as ReadOnlyFieldDataProvider,
  );
}

test('forward preflight scopes stage checks to the selected mapped stage despite unrelated provider stages', async () => {
  const previousToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-test-token';
  try {
    const report = await serviceFor({}).preflightEntityDirection('deals-orders', 'bitrix24ToMoysklad', 'synthetic-admin-token');
    assert.equal(report.canEnable, true, JSON.stringify(report.blockers));
    assert.deepEqual(report.blockers, []);
  } finally {
    if (previousToken === undefined) delete process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
    else process.env.BITRIX24_EVENT_APPLICATION_TOKEN = previousToken;
  }
});

test('forward preflight resolves the selected primary-stage catalog ID to the runtime stage ID', async () => {
  const previousToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-test-token';
  try {
    const report = await serviceFor({ stages: ['0:PREPARATION'] }).preflightEntityDirection(
      'deals-orders', 'bitrix24ToMoysklad', 'synthetic-admin-token',
    );
    assert.equal(report.canEnable, true, JSON.stringify(report.blockers));
    assert.deepEqual(report.blockers, []);
  } finally {
    if (previousToken === undefined) delete process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
    else process.env.BITRIX24_EVENT_APPLICATION_TOKEN = previousToken;
  }
});

test('forward preflight blocks when the selected stage is missing from the live catalog or its pair is unconfirmed', async () => {
  const previousToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-test-token';
  try {
    const missing = await serviceFor({ stages: ['0:NEW'] }).preflightEntityDirection(
      'deals-orders', 'bitrix24ToMoysklad', 'synthetic-admin-token',
    );
    assert.equal(missing.canEnable, false);
    assert.ok(missing.blockers.some((item) => item.code === 'STAGE_MAPPING_UNCONFIRMED'));

    const unconfirmed = await serviceFor({ stages: ['0:PREPARATION'], stageStatus: 'suggested' }).preflightEntityDirection(
      'deals-orders', 'bitrix24ToMoysklad', 'synthetic-admin-token',
    );
    assert.equal(unconfirmed.canEnable, false);
    assert.ok(unconfirmed.blockers.some((item) => item.code === 'STAGE_MAPPING_UNCONFIRMED'));

    const notSelected = await serviceFor({ stages: ['0:PREPARATION'], runtimeStageId: null }).preflightEntityDirection(
      'deals-orders', 'bitrix24ToMoysklad', 'synthetic-admin-token',
    );
    assert.equal(notSelected.canEnable, false);
    assert.ok(notSelected.blockers.some((item) => item.code === 'STAGE_MAPPING_UNCONFIRMED'));
  } finally {
    if (previousToken === undefined) delete process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
    else process.env.BITRIX24_EVENT_APPLICATION_TOKEN = previousToken;
  }
});

test('forward preflight keeps compound pipeline identity exact', async () => {
  const previousToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-test-token';
  try {
    const report = await serviceFor({
      stages: ['0:PREPARATION', '2:C2:PREPARATION', '2:C2:WON'],
      runtimeStageId: 'C2:PREPARATION',
      catalogStageId: '2:C2:PREPARATION',
    }).preflightEntityDirection('deals-orders', 'bitrix24ToMoysklad', 'synthetic-admin-token');
    assert.equal(report.canEnable, true, JSON.stringify(report.blockers));
    assert.deepEqual(report.blockers, []);
  } finally {
    if (previousToken === undefined) delete process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
    else process.env.BITRIX24_EVENT_APPLICATION_TOKEN = previousToken;
  }
});

test('forward preflight blocks an unconfirmed or unavailable selected currency', async () => {
  const previousToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-test-token';
  try {
    const missing = await serviceFor({ currencies: ['EUR'] }).preflightEntityDirection(
      'deals-orders', 'bitrix24ToMoysklad', 'synthetic-admin-token',
    );
    assert.equal(missing.canEnable, false);
    assert.ok(missing.blockers.some((item) => item.code === 'CURRENCY_MAPPING_UNCONFIRMED'));

    const unconfirmed = await serviceFor({ currencies: ['RUB'], currencyStatus: 'suggested' }).preflightEntityDirection(
      'deals-orders', 'bitrix24ToMoysklad', 'synthetic-admin-token',
    );
    assert.equal(unconfirmed.canEnable, false);
    assert.ok(unconfirmed.blockers.some((item) => item.code === 'CURRENCY_MAPPING_UNCONFIRMED'));

    const notSelected = await serviceFor({ currencies: ['RUB'], runtimeCurrency: null }).preflightEntityDirection(
      'deals-orders', 'bitrix24ToMoysklad', 'synthetic-admin-token',
    );
    assert.equal(notSelected.canEnable, false);
    assert.ok(notSelected.blockers.some((item) => item.code === 'CURRENCY_MAPPING_UNCONFIRMED'));
  } finally {
    if (previousToken === undefined) delete process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
    else process.env.BITRIX24_EVENT_APPLICATION_TOKEN = previousToken;
  }
});

test('forward preflight remains fail-closed when required provider catalogs fail', async () => {
  const previousToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
  process.env.BITRIX24_EVENT_APPLICATION_TOKEN = 'synthetic-test-token';
  try {
    const report = await serviceFor({ providerError: true }).preflightEntityDirection(
      'deals-orders', 'bitrix24ToMoysklad', 'synthetic-admin-token',
    );
    assert.equal(report.canEnable, false);
    assert.ok(report.blockers.some((item) => item.code === 'API_ACCESS_UNAVAILABLE'));
    assert.ok(report.blockers.some((item) => item.code === 'DEAL_STAGES_UNAVAILABLE'));
    assert.ok(report.blockers.some((item) => item.code === 'DEAL_CURRENCIES_UNAVAILABLE'));
  } finally {
    if (previousToken === undefined) delete process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
    else process.env.BITRIX24_EVENT_APPLICATION_TOKEN = previousToken;
  }
});

test('reverse deal preflight reads states from MoySklad order metadata', async () => {
  const originalFetch = globalThis.fetch;
  const previousBase = process.env.MOYSKLAD_API_BASE_URL;
  const previousToken = process.env.MOYSKLAD_API_TOKEN;
  process.env.MOYSKLAD_API_BASE_URL = 'https://ms-fake.invalid/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-test-token';
  const requestedPaths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    if (url.pathname === '/api/remap/1.2/entity/currency') {
      return Response.json({ rows: [{ id: currencyId }], meta: {} });
    }
    if (url.pathname === '/api/remap/1.2/entity/customerorder/metadata') {
      return Response.json({ states: [{ id: stateId, name: 'Обработан' }] });
    }
    if (url.pathname === '/api/remap/1.2/entity/customerorder/metadata/states') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    }
    return Response.json({ error: 'unexpected_path' }, { status: 404 });
  }) as typeof fetch;
  try {
    const catalog = await new ReadOnlyFieldDataProvider().dealOrderCatalogs('synthetic-token', 'moyskladToBitrix24');
    assert.deepEqual(catalog, { stages: [stateId], currencies: [currencyId] });
    assert.ok(requestedPaths.includes('/api/remap/1.2/entity/customerorder/metadata'));
    assert.ok(!requestedPaths.includes('/api/remap/1.2/entity/customerorder/metadata/states'));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBase === undefined) delete process.env.MOYSKLAD_API_BASE_URL;
    else process.env.MOYSKLAD_API_BASE_URL = previousBase;
    if (previousToken === undefined) delete process.env.MOYSKLAD_API_TOKEN;
    else process.env.MOYSKLAD_API_TOKEN = previousToken;
  }
});
