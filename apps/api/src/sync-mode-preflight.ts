export type SyncModeDirection = 'bitrix24ToMoysklad' | 'moyskladToBitrix24';

export type PreflightFinding = {
  code: string;
  message: string;
  referenceId?: string;
};

export type EnablePreflightReport = {
  entityKey: string;
  direction: SyncModeDirection;
  settingsVersion: number | null;
  canEnable: boolean;
  blockers: PreflightFinding[];
  warnings: PreflightFinding[];
};

type PreflightSettings = {
  version: number;
  config: Record<string, unknown>;
};

export type EnablePreflightInput = {
  entityKey: string;
  direction: SyncModeDirection;
  settings: PreflightSettings | null;
  apiAccess: boolean;
  webhookAuthConfigured: boolean;
  applicableStages?: readonly string[];
  applicableCurrencies?: readonly string[];
  applicableUnits?: readonly string[];
  optionalReferenceWarnings?: readonly string[];
  optionalEndpointWarnings?: readonly string[];
  unverifiedRequiredReferences?: readonly string[];
  availableProductCatalogIds?: readonly string[];
};

const supportedDirections: Record<string, readonly SyncModeDirection[]> = {
  'contacts-companies': ['bitrix24ToMoysklad', 'moyskladToBitrix24'],
  'deals-orders': ['bitrix24ToMoysklad', 'moyskladToBitrix24'],
  invoices: ['bitrix24ToMoysklad', 'moyskladToBitrix24'],
  'products-variations': ['moyskladToBitrix24'],
};

/** Pure readiness policy shared by admin reports and the server-side enable gate. */
export function evaluateEnablePreflight(input: EnablePreflightInput): EnablePreflightReport {
  const blockers: PreflightFinding[] = [];
  const warnings: PreflightFinding[] = [];
  const version = input.settings?.version ?? null;
  const config = input.settings?.config;

  if (!supportedDirections[input.entityKey]?.includes(input.direction)) {
    blockers.push(finding('DIRECTION_NOT_IMPLEMENTED', 'Это направление для выбранной сущности не реализовано.'));
  }
  if (!input.settings || !config) blockers.push(finding('FIELD_SETTINGS_UNAVAILABLE', 'Активная версия настроек полей недоступна.'));
  if (!input.apiAccess) blockers.push(finding('API_ACCESS_UNAVAILABLE', 'Не удалось подтвердить доступ к API, необходимый для выбранного направления.'));
  if (!input.webhookAuthConfigured) blockers.push(finding('WEBHOOK_AUTH_NOT_CONFIGURED', 'Не настроена проверка подлинности входящих событий выбранного направления.'));

  if (config) {
    checkCriticalRules(config, input.entityKey, input.direction, blockers);
    const references = object(config.references);
    const namedPairs = array(references?.namedPairs);
    const confirmed = (kind: string, sourceId: string) => namedPairs.some((candidate) => {
      const pair = object(candidate);
      const sourceValue = input.direction === 'bitrix24ToMoysklad' ? pair?.bitrix24Id : pair?.moyskladId;
      return pair?.kind === kind && String(sourceValue) === sourceId && pair.status === 'confirmed' && nonEmpty(pair.moyskladId);
    });

    if (input.entityKey === 'deals-orders') {
      const runtime = object(config.dealOrderRuntime);
      if (!runtime) blockers.push(finding('DEAL_ORDER_RUNTIME_UNCONFIGURED', 'Настройки создания и сопоставления заказов не заполнены.'));
      else {
        if (input.direction === 'bitrix24ToMoysklad') {
          if (runtime.nativeOrderNumberingVerified !== true) blockers.push(finding('NATIVE_ORDER_NUMBERING_UNCONFIRMED', 'Не подтверждена схема нумерации заказов МойСклад.'));
          for (const [field, label] of [['defaultOrganizationId', 'организация'], ['defaultStoreId', 'склад'], ['defaultEmployeeId', 'сотрудник']] as const) {
            if (!nonEmpty(runtime[field])) blockers.push(finding(`DEAL_ORDER_${field.replace('default', '').toUpperCase()}_REQUIRED`, `Не выбрано значение «${label}», которое обработчик будет использовать при создании заказа.`));
          }
        }
      }
      if (input.direction === 'bitrix24ToMoysklad') {
        for (const reference of input.unverifiedRequiredReferences ?? []) {
          blockers.push(finding('REQUIRED_REFERENCE_UNAVAILABLE', `Выбранная ссылка «${reference}» для создаваемого заказа недоступна или не подтверждена.`));
        }
      }
      if (!input.applicableStages?.length) blockers.push(finding('DEAL_STAGES_UNAVAILABLE', 'API не вернул применимые стадии сделок для проверки подтверждённых пар.'));
      if (!input.applicableCurrencies?.length) blockers.push(finding('DEAL_CURRENCIES_UNAVAILABLE', 'API не вернул применимые валюты для проверки подтверждённых пар.'));
      for (const stageId of input.applicableStages ?? []) {
        const stages = array(object(config.dealOrderRuntime)?.stages).map(object);
        const runtimeMapped = stages.some((stage) => {
          const sourceValue = input.direction === 'bitrix24ToMoysklad' ? stage?.bitrix24StageId : stage?.moyskladId;
          return String(sourceValue) === stageId && nonEmpty(stage?.bitrix24StageId) && nonEmpty(stage?.moyskladId);
        });
        if (!confirmed('dealStages', stageId) || !runtimeMapped) blockers.push(finding('STAGE_MAPPING_UNCONFIRMED', 'Для стадии сделки нет подтверждённой пары в активной версии настроек МойСклад.', stageId));
      }
      for (const currencyId of input.applicableCurrencies ?? []) {
        const currencies = array(object(config.dealOrderRuntime)?.currencies).map(object);
        const runtimeMapped = currencies.some((currency) => {
          const sourceValue = input.direction === 'bitrix24ToMoysklad' ? currency?.bitrix24Code : currency?.moyskladId;
          return String(sourceValue) === currencyId && nonEmpty(currency?.bitrix24Code) && nonEmpty(currency?.moyskladId);
        });
        if (!confirmed('currencies', currencyId) || !runtimeMapped) blockers.push(finding('CURRENCY_MAPPING_UNCONFIRMED', 'Для валюты нет подтверждённой пары в активной версии настроек МойСклад.', currencyId));
      }
    }

    if (input.entityKey === 'products-variations') {
      const runtime = object(config.productCatalogRuntime);
      const selectedCatalog = nonEmpty(runtime?.bitrix24CatalogId) ? String(runtime!.bitrix24CatalogId) : '';
      if (!selectedCatalog) blockers.push(finding('PRODUCT_CATALOG_NOT_SELECTED', 'Не выбран каталог Bitrix24 для создаваемых карточек товаров.'));
      else if (input.availableProductCatalogIds && !input.availableProductCatalogIds.includes(selectedCatalog)) {
        blockers.push(finding('PRODUCT_CATALOG_UNAVAILABLE', 'Выбранный каталог Bitrix24 больше недоступен.', selectedCatalog));
      }
      const units = array(references?.units);
      for (const unitId of input.applicableUnits ?? []) {
        const row = units.map(object).find((candidate) => {
          const sourceValue = input.direction === 'bitrix24ToMoysklad' ? candidate?.bitrix24Id : candidate?.moyskladId;
          return String(sourceValue) === unitId;
        });
        if (!row || row.status !== 'configured' || !nonEmpty(row.moyskladId)) {
          blockers.push(finding('UNIT_MAPPING_UNCONFIRMED', 'Для единицы измерения нет подтверждённой пары.', String(unitId)));
        }
      }
    }

    for (const kind of input.optionalReferenceWarnings ?? []) {
      warnings.push(finding('OPTIONAL_REFERENCE_UNMAPPED', `Справочник «${kind}» не полностью сопоставлен; он не блокирует выбранное направление.`));
    }
    for (const kind of input.optionalEndpointWarnings ?? []) {
      warnings.push(finding('OPTIONAL_REFERENCE_UNAVAILABLE', `Не удалось проверить необязательный справочник «${kind}»; это не блокирует выбранное направление.`));
    }
  }

  return {
    entityKey: input.entityKey,
    direction: input.direction,
    settingsVersion: version,
    canEnable: blockers.length === 0,
    blockers,
    warnings,
  };
}

function checkCriticalRules(config: Record<string, unknown>, entityKey: string, direction: SyncModeDirection, blockers: PreflightFinding[]) {
  const rules = array(config.rules).map(object).filter((rule): rule is Record<string, unknown> => rule !== null);
  const entityNames: Record<string, readonly string[]> = {
    'contacts-companies': ['contacts', 'companies', 'contacts-companies'],
    'deals-orders': ['deals-orders', 'deals', 'orders'],
    invoices: ['invoices', 'smart-invoices'],
    'products-variations': ['catalog', 'products-variations'],
  };
  const enabledKey = direction;
  for (const rule of rules) {
    if (!entityNames[entityKey]?.includes(String(rule.entity)) || rule.criticality !== 'critical') continue;
    const directionRule = object(rule[enabledKey]);
    if (directionRule?.enabled !== true) continue;
    const transform = object(directionRule.transform);
    if (!nonEmpty(rule.sourceField) || !nonEmpty(rule.targetField) || transform?.kind === 'tbd') {
      blockers.push(finding('CRITICAL_FIELD_MAPPING_INCOMPLETE', 'Критичное поле не имеет проверенного соответствия для выбранного направления.', String(rule.id ?? '')));
    }
  }
}

function finding(code: string, message: string, referenceId?: string): PreflightFinding {
  return { code, message, ...(referenceId ? { referenceId } : {}) };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
