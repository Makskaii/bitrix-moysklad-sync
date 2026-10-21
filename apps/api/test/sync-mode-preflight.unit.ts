import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { evaluateEnablePreflight } from '../src/sync-mode-preflight';

const baseInput = {
  entityKey: 'deals-orders',
  direction: 'bitrix24ToMoysklad' as const,
  settings: {
    version: 7,
    config: {
      rules: [],
      references: {
        namedPairs: [
          { kind: 'dealStages', bitrix24Id: '0:NEW', moyskladId: 'state-1', status: 'confirmed' },
          { kind: 'dealStages', bitrix24Id: '0:WON', moyskladId: null, status: 'suggested' },
          { kind: 'currencies', bitrix24Id: 'RUB', moyskladId: 'currency-1', status: 'confirmed' },
        ],
      },
      dealOrderRuntime: { nativeOrderNumberingVerified: true, defaultOrganizationId: 'org-1', defaultStoreId: 'store-1', defaultEmployeeId: 'employee-1', stages: [], currencies: [] },
    },
  },
  apiAccess: true,
  webhookAuthConfigured: true,
  applicableStages: ['0:NEW', '0:WON'],
  applicableCurrencies: ['RUB'],
} as const;

test('deal preflight blocks every applicable stage without a confirmed mapping and surfaces optional references as warnings', () => {
  const report = evaluateEnablePreflight({
    ...baseInput,
    optionalReferenceWarnings: ['employees', 'projects'],
  });
  assert.equal(report.canEnable, false);
  assert.ok(report.blockers.some((item) => item.code === 'STAGE_MAPPING_UNCONFIRMED' && item.referenceId === '0:WON'));
  assert.equal(report.warnings.length, 2);
  assert.equal(report.settingsVersion, 7);
});

test('deal preflight passes when all required stage, currency, and create-order values are ready', () => {
  const report = evaluateEnablePreflight({
    ...baseInput,
    settings: {
      version: 8,
      config: {
        ...baseInput.settings.config,
        dealOrderRuntime: {
          ...baseInput.settings.config.dealOrderRuntime,
          stages: [
            { bitrix24StageId: 'NEW', moyskladId: 'state-1' },
            { bitrix24StageId: 'WON', moyskladId: 'state-2' },
          ],
          currencies: [{ bitrix24Code: 'RUB', moyskladId: 'currency-1' }],
        },
        references: { namedPairs: [
          { kind: 'dealStages', bitrix24Id: '0:NEW', moyskladId: 'state-1', status: 'confirmed' },
          { kind: 'dealStages', bitrix24Id: '0:WON', moyskladId: 'state-2', status: 'confirmed' },
          { kind: 'currencies', bitrix24Id: 'RUB', moyskladId: 'currency-1', status: 'confirmed' },
        ] },
      },
    },
    applicableStages: ['0:NEW', '0:WON'],
    applicableCurrencies: ['RUB'],
  });
  assert.equal(report.canEnable, true);
  assert.deepEqual(report.blockers, []);
});

test('deal preflight accepts confirmed reverse mappings against MySklad source IDs', () => {
  const result = evaluateEnablePreflight({
    entityKey: 'deals-orders', direction: 'moyskladToBitrix24', settings: {
      version: 9,
      config: {
        rules: [],
        references: { namedPairs: [
          { kind: 'dealStages', bitrix24Id: '0:NEW', moyskladId: 'ms-stage-uuid', status: 'confirmed' },
          { kind: 'currencies', bitrix24Id: 'USD', moyskladId: 'ms-currency-uuid', status: 'confirmed' },
        ] },
        dealOrderRuntime: {
          nativeOrderNumberingVerified: true, defaultOrganizationId: 'org', defaultStoreId: 'store', defaultEmployeeId: 'employee',
          stages: [{ bitrix24StageId: '0:NEW', moyskladId: 'ms-stage-uuid' }],
          currencies: [{ bitrix24Code: 'USD', moyskladId: 'ms-currency-uuid' }],
        },
      },
    },
    apiAccess: true, webhookAuthConfigured: true,
    applicableStages: ['ms-stage-uuid'], applicableCurrencies: ['ms-currency-uuid'],
  });
  assert.equal(result.canEnable, true);
  assert.deepEqual(result.blockers, []);
});

test('product preflight rejects the unsupported reverse direction and requires a catalog and authenticated APIs', () => {
  const unsupported = evaluateEnablePreflight({
    ...baseInput,
    entityKey: 'products-variations',
    direction: 'bitrix24ToMoysklad',
    settings: { version: 2, config: { references: { namedPairs: [] }, productCatalogRuntime: { bitrix24CatalogId: '11' } } },
  });
  assert.equal(unsupported.canEnable, false);
  assert.ok(unsupported.blockers.some((item) => item.code === 'DIRECTION_NOT_IMPLEMENTED'));

  const unavailable = evaluateEnablePreflight({
    ...baseInput,
    entityKey: 'products-variations',
    direction: 'moyskladToBitrix24',
    settings: { version: 2, config: { references: { namedPairs: [] }, productCatalogRuntime: { bitrix24CatalogId: null } } },
    apiAccess: false,
    webhookAuthConfigured: false,
  });
  assert.ok(unavailable.blockers.some((item) => item.code === 'PRODUCT_CATALOG_NOT_SELECTED'));
  assert.ok(unavailable.blockers.some((item) => item.code === 'API_ACCESS_UNAVAILABLE'));
  assert.ok(unavailable.blockers.some((item) => item.code === 'WEBHOOK_AUTH_NOT_CONFIGURED'));
});

test('reverse product preflight requires only configured live UOM mappings and warns about unused catalog units', () => {
  const configured = Array.from({ length: 9 }, (_, index) => ({
    bitrix24Id: index + 1,
    bitrix24Code: String(index + 1),
    moyskladId: `ms-unit-${index + 1}`,
    moyskladCode: String(index + 1),
    status: 'configured',
  }));
  const explicitUnmapped = Array.from({ length: 3 }, (_, index) => ({
    bitrix24Id: index + 10,
    bitrix24Code: String(index + 10),
    moyskladId: null,
    moyskladCode: null,
    status: 'unmapped',
  }));
  const availableUnits = [...configured.map((unit) => unit.moyskladId!), ...Array.from({ length: 55 }, (_, index) => `unused-ms-unit-${index + 1}`)];
  const report = evaluateEnablePreflight({
    entityKey: 'products-variations',
    direction: 'moyskladToBitrix24',
    settings: { version: 2, config: {
      rules: [], references: { units: [...configured, ...explicitUnmapped], namedPairs: [] },
      productCatalogRuntime: { bitrix24CatalogId: '14' },
    } },
    apiAccess: true,
    webhookAuthConfigured: true,
    applicableUnits: availableUnits,
    availableProductCatalogIds: ['14'],
  });

  assert.equal(report.canEnable, true);
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.warnings.map((warning) => warning.code), ['UNUSED_PROVIDER_UNIT_UNMAPPED']);
  assert.match(report.warnings[0]!.message, /runtime-проверкой/i);
});

test('reverse product preflight blocks if there are no configured UOM mappings', () => {
  const report = evaluateEnablePreflight({
    entityKey: 'products-variations',
    direction: 'moyskladToBitrix24',
    settings: { version: 2, config: {
      rules: [], references: { units: [{ bitrix24Id: 1, moyskladId: null, status: 'unmapped' }], namedPairs: [] },
      productCatalogRuntime: { bitrix24CatalogId: '14' },
    } },
    apiAccess: true,
    webhookAuthConfigured: true,
    applicableUnits: ['ms-unit-1'],
    availableProductCatalogIds: ['14'],
  });
  assert.equal(report.canEnable, false);
  assert.ok(report.blockers.some((item) => item.code === 'UNIT_MAPPING_UNCONFIRMED'));
});

test('reverse product preflight blocks missing, duplicate-live, and duplicate-configured UOM targets', () => {
  const makeInput = (units: unknown[], applicableUnits: string[]) => ({
    entityKey: 'products-variations',
    direction: 'moyskladToBitrix24' as const,
    settings: { version: 2, config: {
      rules: [], references: { units, namedPairs: [] }, productCatalogRuntime: { bitrix24CatalogId: '14' },
    } },
    apiAccess: true,
    webhookAuthConfigured: true,
    applicableUnits,
    availableProductCatalogIds: ['14'],
  });
  const mapping = { bitrix24Id: 1, bitrix24Code: '796', moyskladId: 'ms-unit-1', moyskladCode: '796', status: 'configured' };

  const missing = evaluateEnablePreflight(makeInput([mapping], ['other-ms-unit']));
  assert.ok(missing.blockers.some((item) => item.code === 'UNIT_MAPPING_UNCONFIRMED' && item.referenceId === 'ms-unit-1'));

  const duplicateLive = evaluateEnablePreflight(makeInput([mapping], ['ms-unit-1', 'ms-unit-1']));
  assert.ok(duplicateLive.blockers.some((item) => item.code === 'UNIT_MAPPING_AMBIGUOUS' && item.referenceId === 'ms-unit-1'));

  const duplicateConfigured = evaluateEnablePreflight(makeInput([
    mapping,
    { ...mapping, bitrix24Id: 2, bitrix24Code: '797', moyskladCode: '797' },
  ], ['ms-unit-1']));
  assert.ok(duplicateConfigured.blockers.some((item) => item.code === 'UNIT_MAPPING_AMBIGUOUS' && item.referenceId === 'ms-unit-1'));
});
