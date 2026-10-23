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
    const hasConfirmedPair = (kind: string, sourceId: string, targetId: string) => namedPairs.some((candidate) => {
      const pair = object(candidate);
      const pairSource = input.direction === 'bitrix24ToMoysklad' ? pair?.bitrix24Id : pair?.moyskladId;
      const pairTarget = input.direction === 'bitrix24ToMoysklad' ? pair?.moyskladId : pair?.bitrix24Id;
      const canonicalStageId = kind === 'dealStages' && input.direction === 'bitrix24ToMoysklad'
        ? bitrixStageCatalogId(sourceId)
        : kind === 'dealStages' && input.direction === 'moyskladToBitrix24'
          ? bitrixStageCatalogId(targetId)
          : null;
      const sourceMatches = pairSource === sourceId || (kind === 'dealStages' && input.direction === 'bitrix24ToMoysklad' && pairSource === canonicalStageId);
      const targetMatches = pairTarget === targetId || (kind === 'dealStages' && input.direction === 'moyskladToBitrix24' && pairTarget === canonicalStageId);
      return pair?.kind === kind && sourceMatches && targetMatches && pair.status === 'confirmed';
    });

    if (input.entityKey === 'deals-orders') {
      const runtime = object(config.dealOrderRuntime);
      const usesConfirmedDefaults = runtime?.unmappedReferencePolicy === 'confirmed-defaults';
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
      const availableStages = input.applicableStages ?? [];
      const availableCurrencies = input.applicableCurrencies ?? [];
      if (!availableStages.length) blockers.push(finding('DEAL_STAGES_UNAVAILABLE', 'API не вернул применимые стадии сделок для проверки подтверждённых пар.'));
      if (!availableCurrencies.length) blockers.push(finding('DEAL_CURRENCIES_UNAVAILABLE', 'API не вернул применимые валюты для проверки подтверждённых пар.'));

      if (input.direction === 'moyskladToBitrix24') {
        // Enable the configured scope; unused catalog entries remain guarded per record.
        const selectedStages = array(object(runtime)?.stages).map(object);
        const selectedCurrencies = array(object(runtime)?.currencies).map(object);
        if (!selectedStages.length) blockers.push(finding('STAGE_MAPPING_UNCONFIRMED', 'Не выбрана ни одна подтверждённая стадия заказа.'));
        if (!selectedCurrencies.length) blockers.push(finding('CURRENCY_MAPPING_UNCONFIRMED', 'Не выбрана ни одна подтверждённая валюта заказа.'));
        if (usesConfirmedDefaults) {
          const defaults = selectedStages.filter((stage) =>
            stage && isMainPreparationStage(String(stage.bitrix24StageId ?? '')) && stage.creationEnabled === true &&
            nonEmpty(stage.moyskladId) && hasConfirmedPair('dealStages', String(stage.moyskladId), String(stage.bitrix24StageId)));
          if (defaults.length !== 1) blockers.push(finding('DEAL_STAGE_DEFAULT_UNAVAILABLE', 'Нужна ровно одна подтверждённая стадия PREPARATION для значения по умолчанию.'));
        }
        const seenStages = new Set<string>();
        for (const stage of selectedStages) {
          const sourceId = nonEmpty(stage?.moyskladId) ? String(stage!.moyskladId) : '';
          const targetId = nonEmpty(stage?.bitrix24StageId) ? bitrixStageCatalogId(String(stage!.bitrix24StageId)) : '';
          const matches = namedPairs.map(object).filter((pair) => pair?.kind === 'dealStages' && pair.moyskladId === sourceId);
          if (!sourceId || !targetId || availableStages.filter(id => id === sourceId).length !== 1 || seenStages.has(sourceId) ||
              matches.length !== 1 || matches[0]?.status !== 'confirmed' || matches[0]?.bitrix24Id !== targetId) {
            blockers.push(finding('STAGE_MAPPING_UNCONFIRMED', 'Выбранная стадия заказа отсутствует, неоднозначна или не подтверждена.', sourceId || undefined));
          }
          seenStages.add(sourceId);
        }
        const seenCurrencies = new Set<string>();
        for (const currency of selectedCurrencies) {
          const sourceId = nonEmpty(currency?.moyskladId) ? String(currency!.moyskladId) : '';
          const targetId = nonEmpty(currency?.bitrix24Code) ? String(currency!.bitrix24Code) : '';
          const matches = namedPairs.map(object).filter((pair) => pair?.kind === 'currencies' && pair.moyskladId === sourceId);
          if (!sourceId || !targetId || availableCurrencies.filter(id => id === sourceId).length !== 1 || seenCurrencies.has(sourceId) ||
              matches.length !== 1 || matches[0]?.status !== 'confirmed' || matches[0]?.bitrix24Id !== targetId) {
            blockers.push(finding('CURRENCY_MAPPING_UNCONFIRMED', 'Выбранная валюта заказа отсутствует, неоднозначна или не подтверждена.', sourceId || undefined));
          }
          seenCurrencies.add(sourceId);
        }
        if (availableStages.some(id => !seenStages.has(id))) warnings.push(finding('UNUSED_PROVIDER_DEAL_STAGE_UNMAPPED', 'Ненастроенные стадии проверяются отдельно при обработке заказа.'));
        if (availableCurrencies.some(id => !seenCurrencies.has(id))) warnings.push(finding('UNUSED_PROVIDER_CURRENCY_UNMAPPED', 'Ненастроенные валюты проверяются отдельно при обработке заказа.'));
      } else {
      const runtimeStages = array(object(runtime)?.stages);
      const stageChecks = runtimeStages.length
        ? runtimeStages.map((value) => {
          const stage = object(value);
          const bitrix24Id = nonEmpty(stage?.bitrix24StageId) ? stage!.bitrix24StageId as string : '';
          const moyskladId = nonEmpty(stage?.moyskladId) ? stage!.moyskladId as string : '';
          const catalogId = input.direction === 'bitrix24ToMoysklad' ? bitrixStageCatalogId(bitrix24Id) : moyskladId;
          return { catalogId, bitrix24Id, moyskladId };
        })
        : availableStages.map((catalogId) => ({ catalogId, bitrix24Id: '', moyskladId: '' }));
      const seenStageIds = new Set<string>();
      for (const stage of stageChecks) {
        const { catalogId, bitrix24Id, moyskladId } = stage;
        const sourceId = input.direction === 'bitrix24ToMoysklad' ? catalogId : moyskladId;
        const targetId = input.direction === 'bitrix24ToMoysklad' ? moyskladId : bitrix24Id;
        const duplicate = !!catalogId && seenStageIds.has(catalogId);
        if (catalogId) seenStageIds.add(catalogId);
        const configured = nonEmpty(sourceId) && nonEmpty(targetId) && availableStages.includes(catalogId) && !duplicate;
        if (!configured || !hasConfirmedPair('dealStages', sourceId, targetId)) {
          blockers.push(finding('STAGE_MAPPING_UNCONFIRMED', 'Для выбранной стадии сделки нет подтверждённой пары в активной версии настроек и каталоге провайдера.', catalogId || undefined));
        }
      }
      if (usesConfirmedDefaults) {
        if (runtimeStages.length) {
          const configuredCatalogStages = new Set(runtimeStages.map((value) => {
            const stage = object(value);
            return bitrixStageCatalogId(String(stage?.bitrix24StageId ?? ''));
          }));
          if (availableStages.some((id) => !configuredCatalogStages.has(id))) {
            warnings.push(finding('UNUSED_PROVIDER_DEAL_STAGE_UNMAPPED', 'Стадия сделки без настроенной пары не разрешает создание заказа; направление остаётся готовым для явно разрешённых стадий.'));
          }
        }
      }

      const runtimeCurrencies = array(object(runtime)?.currencies);
      const currencyChecks = runtimeCurrencies.length
        ? runtimeCurrencies.map((value) => {
          const currency = object(value);
          const bitrix24Code = nonEmpty(currency?.bitrix24Code) ? currency!.bitrix24Code as string : '';
          const moyskladId = nonEmpty(currency?.moyskladId) ? currency!.moyskladId as string : '';
          const catalogId = input.direction === 'bitrix24ToMoysklad' ? bitrix24Code : moyskladId;
          return { catalogId, bitrix24Code, moyskladId };
        })
        : availableCurrencies.map((catalogId) => ({ catalogId, bitrix24Code: '', moyskladId: '' }));
      const seenCurrencyIds = new Set<string>();
      for (const currency of currencyChecks) {
        const { catalogId, bitrix24Code, moyskladId } = currency;
        const sourceId = input.direction === 'bitrix24ToMoysklad' ? bitrix24Code : moyskladId;
        const targetId = input.direction === 'bitrix24ToMoysklad' ? moyskladId : bitrix24Code;
        const duplicate = !!catalogId && seenCurrencyIds.has(catalogId);
        if (catalogId) seenCurrencyIds.add(catalogId);
        const configured = nonEmpty(sourceId) && nonEmpty(targetId) && availableCurrencies.includes(catalogId) && !duplicate;
        if (!configured || !hasConfirmedPair('currencies', sourceId, targetId)) {
          blockers.push(finding('CURRENCY_MAPPING_UNCONFIRMED', 'Для выбранной валюты нет подтверждённой пары в активной версии настроек и каталоге провайдера.', catalogId || undefined));
        }
      }
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
      const availableUnitIds = input.applicableUnits ?? [];
      const configuredMappings = units.map(object).filter((candidate): candidate is Record<string, unknown> => candidate?.status === 'configured');
      if (!configuredMappings.length) {
        blockers.push(finding('UNIT_MAPPING_UNCONFIRMED', 'Для направления из МойСклад в Bitrix24 нужна хотя бы одна настроенная пара единиц измерения.'));
      }

      const configuredTargets = new Set<string>();
      const duplicateConfiguredTargets = new Set<string>();
      for (const mapping of configuredMappings) {
        const targetUnitId = nonEmpty(mapping?.moyskladId) ? String(mapping.moyskladId) : '';
        if (!targetUnitId) {
          blockers.push(finding('UNIT_MAPPING_UNCONFIRMED', 'У настроенной пары единиц измерения отсутствует единица МойСклад.'));
          continue;
        }
        if (configuredTargets.has(targetUnitId)) duplicateConfiguredTargets.add(targetUnitId);
        configuredTargets.add(targetUnitId);
        const liveMatches = availableUnitIds.filter((unitId) => unitId === targetUnitId).length;
        if (liveMatches === 0) {
          blockers.push(finding('UNIT_MAPPING_UNCONFIRMED', 'Настроенная единица измерения МойСклад отсутствует в текущем каталоге.', targetUnitId));
        } else if (liveMatches > 1) {
          blockers.push(finding('UNIT_MAPPING_AMBIGUOUS', 'Настроенная единица измерения повторяется в текущем каталоге МойСклад.', targetUnitId));
        }
      }
      for (const targetUnitId of duplicateConfiguredTargets) {
        blockers.push(finding('UNIT_MAPPING_AMBIGUOUS', 'Единица МойСклад назначена более чем одной настроенной паре.', targetUnitId));
      }

      const unusedProviderUnits = new Set(availableUnitIds.filter((unitId) => !configuredTargets.has(unitId)));
      if (unusedProviderUnits.size) {
        warnings.push(finding('UNUSED_PROVIDER_UNIT_UNMAPPED', 'В каталоге МойСклад есть единицы без настроенной пары; готовность их не требует, а запись товара с такой единицей останется заблокированной runtime-проверкой.'));
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

function bitrixStageCatalogId(runtimeStageId: string): string {
  if (/^\d+:.+$/.test(runtimeStageId)) return runtimeStageId;
  const customPipeline = runtimeStageId.match(/^C(\d+):/);
  return `${customPipeline?.[1] ?? '0'}:${runtimeStageId}`;
}

function isMainPreparationStage(stageId: string): boolean {
  return stageId === 'PREPARATION' || stageId === '0:PREPARATION';
}
