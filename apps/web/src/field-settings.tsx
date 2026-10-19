import React, { useEffect, useRef, useState } from 'react';

type Transform = { kind: 'tbd' | 'copy' };
type RuleDirection = { enabled: boolean; transform: Transform };
type FieldRule = {
  id: string;
  entity: string;
  sourceField: string;
  targetField: string;
  criticality: 'critical' | 'optional' | 'tbd';
  bitrix24ToMoysklad: RuleDirection;
  moyskladToBitrix24: RuleDirection;
};
type FieldGroup = {
  id: string;
  entity: string;
  direction: 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24';
  targetField: string;
  sourceFields: string[];
  criticality: 'critical' | 'optional' | 'tbd';
  transform: { kind: 'join-non-empty'; separator: string } | { kind: 'split-non-empty'; separator: string; valueType: string };
};
type UnitPair = { bitrix24Id: number; bitrix24Code: string; moyskladId: string | null; moyskladCode: string | null; status: string };
type PriceTypePair = { bitrix24Id: number; bitrix24Code: string; moyskladId: string | null; moyskladLabel: string | null; status: string };
type DictionaryMap = {
  key: string;
  bitrix24Field: string;
  bitrix24ListId: string;
  moyskladAttributeId: string;
  moyskladDirectoryId: string;
  pairs: Array<{ bitrix24Id: number; moyskladId: string }>;
};
type ReferenceKind = 'employees' | 'currencies' | 'organizations' | 'warehouses' | 'projects' | 'dealStages';
type NamedReferencePair = { kind: ReferenceKind; bitrix24Id: string; bitrix24Label: string; moyskladId: string | null; moyskladLabel: string | null; status: 'suggested' | 'confirmed' | 'unmapped' };
type DealOrderRuntime = {
  nativeOrderNumberingVerified: boolean;
  bitrix24ProductCatalogId?: string | null;
  moyskladProductFields?: Array<'name' | 'code' | 'description'>;
  defaultOrganizationId: string | null;
  defaultStoreId: string | null;
  defaultEmployeeId: string | null;
  currencies: Array<{ bitrix24Code: string; moyskladId: string }>;
  stages: Array<{ bitrix24StageId: string; moyskladId: string; creationEnabled: boolean }>;
  organizations: Array<{ bitrix24Id: string; moyskladId: string }>;
  stores: Array<{ bitrix24Id: string; moyskladId: string }>;
  employees: Array<{ bitrix24Id: string; moyskladId: string }>;
};
type DictionaryOption = { id: string; title: string; code: string };
type FieldCandidate = { code: string; title: string; type: string; writable: boolean | null; category?: 'standard' | 'custom' };
type FieldMetadata = { entity: string; bitrix24: FieldCandidate[]; moysklad: FieldCandidate[] };
type ChildFieldPair = { bitrix24Field: string; moyskladField: string };
type ChildResourceBinding = {
  id: string; entity: 'companies'; bitrix24CompanyId: string; bitrix24RequisiteId: string;
  moyskladCounterpartyId: string; legalFields: ChildFieldPair[];
  bankDetail?: { bitrix24Id: string; moyskladAccountId: string; fields: ChildFieldPair[] };
};
type ActiveEntityPair = { id: string; entityType: 'CONTACT' | 'COMPANY' | 'DEAL' | 'PRODUCT' | 'INVOICE'; bitrix24Id: string; moyskladId: string; active: true; source: string; reason: string | null; createdAt: string };
type SettingsConfig = { rules: FieldRule[]; groups: FieldGroup[]; childResourceBindings?: ChildResourceBinding[]; serviceCounterpartyId?: string | null; dealOrderRuntime?: DealOrderRuntime; references: { units: UnitPair[]; priceTypes: PriceTypePair[]; dictionaries: DictionaryMap[]; namedPairs?: NamedReferencePair[] } };
type SettingsDocument = { version: number; createdAt: string; config: SettingsConfig };
type Catalogs = {
  units: { bitrix24: Array<{ id: string; code: string; label: string }>; moysklad: Array<{ id: string; code: string; label: string }> };
  priceTypes: { bitrix24: Array<{ id: string; code: string; label: string }>; moysklad: Array<{ id: string; code: string; label: string }> };
  dictionaries: Array<{ key: string; bitrix24Field: string; bitrix24ListId: string; moyskladAttributeId: string; moyskladDirectoryId: string; values?: { bitrix24: DictionaryOption[]; moysklad: DictionaryOption[] } }>;
  namedReferences: Partial<Record<ReferenceKind, { sources: Array<{ source: { id: string; code: string; label: string; group?: string }; targetId: string | null; targetLabel: string | null; status: string; suggestion: { id: string; code: string; label: string } | null; ambiguousSuggestions: Array<{ id: string; code: string; label: string }> }>; targets: Array<{ id: string; code: string; label: string }> }>>;
  productCatalogs: Array<{ id: string; code: string; label: string }>;
};
const emptyCatalogs: Catalogs = { units: { bitrix24: [], moysklad: [] }, priceTypes: { bitrix24: [], moysklad: [] }, dictionaries: [], namedReferences: {}, productCatalogs: [] };
const referenceKinds: Array<[ReferenceKind, string]> = [
  ['employees', 'Сотрудники'], ['currencies', 'Валюты'], ['organizations', 'Организации'], ['warehouses', 'Склады'], ['projects', 'Проекты'], ['dealStages', 'Стадии сделок ↔ статусы заказов'],
];
type PreviewResult = { pairId: string; sourceLabel: string; sourceValues: Record<string, unknown>; transformed: Record<string, { value: unknown; error?: string; transform: string }>; targetCurrent: Record<string, unknown>; errors: string[]; version: number; writes: number };
type AutoMatch = { source: FieldCandidate; target: FieldCandidate; canBitrix24ToMoysklad: boolean; canMoyskladToBitrix24: boolean };
type AutoMatchBlock = { matches: AutoMatch[]; unmatched: number; conflicts: number };
type AutoMatchSummary = { standard: AutoMatchBlock; custom: AutoMatchBlock };

const endpoint = '/api/admin/field-settings';
const entityOptions = [
  ['contacts', 'Контакты'],
  ['companies', 'Компании'],
  ['deals-orders', 'Сделки и заказы покупателей'],
  ['smart-invoices', 'Смарт-счета ↔ счета покупателям'],
  ['catalog', 'Товары и услуги каталога'],
] as const;

const deferredEntities = new Set<string>();
const groupUnsupportedEntities = new Set(['smart-invoices']);
const requisiteFields: Array<[string, string]> = [
  ['RQ_COMPANY_NAME', 'Краткое наименование'], ['RQ_COMPANY_FULL_NAME', 'Полное наименование'], ['RQ_INN', 'ИНН'],
  ['RQ_KPP', 'КПП'], ['RQ_OGRN', 'ОГРН'], ['RQ_OGRNIP', 'ОГРНИП'], ['RQ_OKPO', 'ОКПО'],
];
const counterpartyFields: Array<[string, string]> = [
  ['legalTitle', 'Полное наименование'], ['inn', 'ИНН'], ['kpp', 'КПП'], ['ogrn', 'ОГРН'], ['ogrnip', 'ОГРНИП'], ['okpo', 'ОКПО'],
];
const bankDetailFields: Array<[string, string]> = [
  ['RQ_BANK_NAME', 'Название банка'], ['RQ_BANK_ADDR', 'Адрес банка'], ['RQ_BIK', 'БИК'], ['RQ_BIC', 'BIC'],
  ['RQ_ACC_NUM', 'Расчётный счёт'], ['RQ_COR_ACC_NUM', 'Корреспондентский счёт'],
];
const accountFields: Array<[string, string]> = [
  ['bankName', 'Название банка'], ['bankLocation', 'Адрес банка'], ['bic', 'BIC'], ['accountNumber', 'Номер счёта'], ['correspondentAccount', 'Корреспондентский счёт'],
];

function entityTypeForUI(entity: string): ActiveEntityPair['entityType'] | null {
  switch (entity) {
    case 'contacts': return 'CONTACT';
    case 'companies': return 'COMPANY';
    case 'deals-orders': return 'DEAL';
    case 'smart-invoices': return 'INVOICE';
    case 'catalog': return 'PRODUCT';
    default: return null;
  }
}

function normalizedFieldName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isGenericFieldTitle(field: FieldCandidate) {
  const title = normalizedFieldName(field.title);
  return !title || field.title.trim() === field.code.trim() || /^(пользовательское поле|custom field)(?:\s*\([^)]*\))?$/.test(title);
}

function fieldCategory(field: FieldCandidate, system: 'bitrix24' | 'moysklad', entity: string): 'standard' | 'custom' {
  if (field.category) return field.category;
  if (system === 'moysklad' && field.code.startsWith('attributes.')) return 'custom';
  if (system === 'bitrix24' && (/^UF_CRM/i.test(field.code) || (entity === 'catalog' && /^property\d+$/i.test(field.code)))) return 'custom';
  return 'standard';
}

function compatibleFieldTypes(left: string, right: string) {
  const typeClass = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (['integer', 'int', 'double', 'float', 'number', 'decimal'].includes(normalized)) return 'number';
    return normalized;
  };
  return typeClass(left) === typeClass(right) && typeClass(left) !== '' && typeClass(left) !== 'unknown';
}

function suggestFieldMatches(metadata: FieldMetadata, entity: string, existingRules: FieldRule[]): AutoMatchSummary {
  const summary: AutoMatchSummary = {
    standard: { matches: [], unmatched: 0, conflicts: 0 },
    custom: { matches: [], unmatched: 0, conflicts: 0 },
  };
  for (const category of ['standard', 'custom'] as const) {
    const sources = metadata.bitrix24.filter((field) => fieldCategory(field, 'bitrix24', entity) === category);
    const targets = metadata.moysklad.filter((field) => fieldCategory(field, 'moysklad', entity) === category);
    const byName = (fields: FieldCandidate[]) => {
      const result = new Map<string, FieldCandidate[]>();
      for (const field of fields) {
        if (isGenericFieldTitle(field)) continue;
        const name = normalizedFieldName(field.title);
        if (!name) continue;
        result.set(name, [...(result.get(name) ?? []), field]);
      }
      return result;
    };
    const sourceNames = byName(sources);
    const targetNames = byName(targets);
    const blocked = new Set<string>();
    const matched = new Set<string>();
    const usedFields = new Set(existingRules.filter((rule) => rule.entity === entity).flatMap((rule) => [rule.sourceField, rule.targetField]).filter(Boolean));
    for (const name of new Set([...sourceNames.keys(), ...targetNames.keys()])) {
      const sourceMatches = sourceNames.get(name) ?? [];
      const targetMatches = targetNames.get(name) ?? [];
      if (!sourceMatches.length || !targetMatches.length) continue;
      if (sourceMatches.length !== 1 || targetMatches.length !== 1) {
        summary[category].conflicts += 1;
        [...sourceMatches, ...targetMatches].forEach((field) => blocked.add(`${field.code}`));
        continue;
      }
      const source = sourceMatches[0]!;
      const target = targetMatches[0]!;
      if (usedFields.has(source.code) || usedFields.has(target.code) || !compatibleFieldTypes(source.type, target.type)) {
        summary[category].conflicts += 1;
        blocked.add(source.code);
        blocked.add(target.code);
        continue;
      }
      const bitrix24ToMoysklad = target.writable !== false;
      const moyskladToBitrix24 = source.writable === true;
      if (!bitrix24ToMoysklad && !moyskladToBitrix24) {
        summary[category].conflicts += 1;
        blocked.add(source.code);
        blocked.add(target.code);
        continue;
      }
      summary[category].matches.push({ source, target, canBitrix24ToMoysklad: bitrix24ToMoysklad, canMoyskladToBitrix24: moyskladToBitrix24 });
      matched.add(source.code);
      matched.add(target.code);
    }
    summary[category].unmatched = [...sources, ...targets].filter((field) => !matched.has(field.code) && !blocked.has(field.code)).length;
  }
  return summary;
}

export function FieldSettingsPage({ accessToken, onForbidden, onError }: {
  accessToken: string;
  onForbidden: () => void;
  onError: (message: string) => void;
}) {
  const [document, setDocument] = useState<SettingsDocument | null>(null);
  const [draft, setDraft] = useState<SettingsConfig | null>(null);
  const [catalogs, setCatalogs] = useState<Catalogs>(emptyCatalogs);
  const [catalogError, setCatalogError] = useState('');
  const [activePairs, setActivePairs] = useState<ActiveEntityPair[]>([]);
  const [pairError, setPairError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSaveWarning, setShowSaveWarning] = useState(false);
  const [previewPairIds, setPreviewPairIds] = useState<string[]>([]);
  const [previewEntity, setPreviewEntity] = useState('contacts');
  const [previewDirection, setPreviewDirection] = useState<'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24'>('BITRIX24_TO_MOYSKLAD');
  const [previewResults, setPreviewResults] = useState<PreviewResult[]>([]);
  const [previewError, setPreviewError] = useState('');
  const [fieldMetadata, setFieldMetadata] = useState<FieldMetadata | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState('');
  const [autoMatchSummary, setAutoMatchSummary] = useState<AutoMatchSummary | null>(null);
  const [mappingEntity, setMappingEntity] = useState('deals-orders');
  const metadataRequest = useRef(0);
  const [saveValidationError, setSaveValidationError] = useState('');
  const [groupForm, setGroupForm] = useState({ entity: 'contacts', direction: 'BITRIX24_TO_MOYSKLAD' as FieldGroup['direction'], targetField: '', sourceFields: '', separator: ' ', transformKind: 'join-non-empty' as FieldGroup['transform']['kind'], valueType: '' });

  const headers: Record<string, string> = {
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const settingsResponse = await fetch(endpoint, { headers });
        if (settingsResponse.status === 403) {
          onForbidden();
          throw new Error('Доступ только для администратора Bitrix24');
        }
        if (!settingsResponse.ok) throw new Error('Не удалось загрузить настройки полей');
        const nextDocument = await settingsResponse.json() as SettingsDocument;
        if (cancelled) return;
        setDocument(nextDocument);
        setDraft(structuredClone(nextDocument.config));
        setCatalogs(emptyCatalogs);
        setActivePairs([]);
        void fetch('/api/admin/pairs', { headers }).then(async (pairsResponse) => {
          if (pairsResponse.status === 403) { onForbidden(); throw new Error('Доступ только для администратора Bitrix24'); }
          if (!pairsResponse.ok) throw new Error('Не удалось загрузить сохранённые пары записей');
          return pairsResponse.json() as Promise<ActiveEntityPair[]>;
        }).then((nextPairs) => {
          if (!cancelled) { setActivePairs(nextPairs.filter((pair) => pair.active)); setPairError(''); }
        }).catch((cause) => {
          if (!cancelled) setPairError(cause instanceof Error ? cause.message : 'Не удалось загрузить пары записей');
        });
        void loadCatalogPages(headers, (response) => { if (response.status === 403) onForbidden(); }).then((nextCatalogs) => {
          if (cancelled) return;
          setCatalogs(nextCatalogs);
          setDraft((current) => current ? includeCurrentNamedSources(includeCurrentCatalogSources(current, nextCatalogs), nextCatalogs) : current);
          setCatalogError('');
        }).catch((cause) => {
          if (!cancelled) setCatalogError(cause instanceof Error ? cause.message : 'Не удалось загрузить справочники');
        });
      } catch (cause) {
        if (!cancelled) onError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  function changeDraft(update: (current: SettingsConfig) => SettingsConfig) {
    setDraft((current) => current ? update(current) : current);
  }

  function changeUnit(bitrix24Id: number, moyskladId: string) {
    changeDraft((current) => ({
      ...current,
      references: { ...current.references, units: current.references.units.map((row) => row.bitrix24Id === bitrix24Id ? { ...row, moyskladId: moyskladId || null, moyskladCode: catalogs?.units.moysklad.find((candidate) => candidate.id === moyskladId)?.code ?? null, status: moyskladId ? 'configured' : 'unmapped' } : row) },
    }));
  }

  function suggestExactUnits() {
    if (!draft || !catalogs) return;
    changeDraft((current) => ({
      ...current,
      references: { ...current.references, units: current.references.units.map((row) => {
        if (row.moyskladId) return row;
        const match = catalogs.units.moysklad.find((candidate) => candidate.code === row.bitrix24Code && !current.references.units.some((other) => other.moyskladId === candidate.id));
        return match ? { ...row, moyskladId: match.id, moyskladCode: match.code, status: 'configured' } : row;
      }) },
    }));
  }

  function changePriceType(bitrix24Id: number, moyskladId: string) {
    changeDraft((current) => ({
      ...current,
      references: { ...current.references, priceTypes: current.references.priceTypes.map((row) => row.bitrix24Id === bitrix24Id ? { ...row, moyskladId: moyskladId || null, moyskladLabel: catalogs?.priceTypes.moysklad.find((candidate) => candidate.id === moyskladId)?.label ?? null, status: moyskladId ? 'configured' : 'unmapped' } : row) },
    }));
  }

  function changeDictionaryPair(key: string, bitrix24Id: number, moyskladId: string) {
    changeDraft((current) => ({
      ...current,
      references: {
        ...current.references,
        dictionaries: current.references.dictionaries.map((dictionary) => dictionary.key !== key ? dictionary : {
          ...dictionary,
          pairs: [
            ...dictionary.pairs.filter((pair) => pair.bitrix24Id !== bitrix24Id),
            ...(moyskladId ? [{ bitrix24Id, moyskladId }] : []),
          ],
        }),
      },
    }));
  }

  function updateNamedPair(kind: ReferenceKind, source: { id: string; label: string }, targetId: string, status: NamedReferencePair['status']) {
    changeDraft((current) => {
      const pairs = current.references.namedPairs ?? [];
      const target = catalogs.namedReferences[kind]?.targets.find((item) => item.id === targetId);
      const next: NamedReferencePair = { kind, bitrix24Id: source.id, bitrix24Label: source.label, moyskladId: targetId || null, moyskladLabel: target?.label ?? null, status: targetId ? status : 'unmapped' };
      const updated = { ...current, references: { ...current.references, namedPairs: [...pairs.filter((pair) => pair.kind !== kind || pair.bitrix24Id !== source.id), next] } };
      return updated.dealOrderRuntime ? { ...updated, dealOrderRuntime: runtimeFromConfirmedPairs(updated, updated.dealOrderRuntime) } : updated;
    });
  }

  async function loadFieldMetadata(entity = mappingEntity) {
    const requestId = ++metadataRequest.current;
    setMetadataLoading(true);
    setMetadataError('');
    try {
      const query = new URLSearchParams({ entity });
      const response = await fetch(`${endpoint}/fields?${query}`, { headers });
      if (response.status === 403) { onForbidden(); throw new Error('Доступ только для администратора Bitrix24'); }
      const body = await response.text();
      if (!response.ok) throw new Error(body || 'Не удалось загрузить метаданные полей');
      const catalog = JSON.parse(body) as FieldMetadata;
      if (requestId !== metadataRequest.current) return;
      setFieldMetadata(catalog);
      setGroupForm((current) => ({ ...current, sourceFields: '', targetField: '' }));
    } catch (cause) {
      if (requestId !== metadataRequest.current) return;
      setFieldMetadata(null);
      setMetadataError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestId === metadataRequest.current) setMetadataLoading(false);
    }
  }

  useEffect(() => { void loadFieldMetadata(mappingEntity); }, [mappingEntity]);

  function addRule() {
    if (!draft) return;
    setAutoMatchSummary(null);
    setSaveValidationError('');
    changeDraft((current) => ({ ...current, rules: [...current.rules, {
      id: newLocalId(), entity: mappingEntity, sourceField: '', targetField: '',
      criticality: 'tbd',
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' } },
    }] }));
  }

  function addGroup(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || !groupForm.targetField.trim() || !groupForm.sourceFields.trim() || groupForm.transformKind === 'split-non-empty' && (!groupForm.valueType || groupForm.sourceFields.split(',').filter(Boolean).length !== 1)) return;
    const group: FieldGroup = {
      id: newLocalId(), entity: groupForm.entity, direction: groupForm.direction,
      targetField: groupForm.targetField.trim(), sourceFields: groupForm.sourceFields.split(',').map((field) => field.trim()).filter(Boolean),
      criticality: 'tbd',
      transform: groupForm.transformKind === 'split-non-empty'
        ? { kind: 'split-non-empty', separator: groupForm.separator, valueType: groupForm.valueType }
        : { kind: 'join-non-empty', separator: groupForm.separator },
    };
    changeDraft((current) => ({ ...current, groups: [...current.groups, group] }));
    setGroupForm((current) => ({ ...current, targetField: '', sourceFields: '' }));
  }

  function updateRule(ruleId: string, update: (rule: FieldRule) => FieldRule) {
    setAutoMatchSummary(null);
    changeDraft((current) => ({ ...current, rules: current.rules.map((rule) => rule.id === ruleId ? update(rule) : rule) }));
    setSaveValidationError('');
  }

  function autoMatchFields() {
    if (!draft || !fieldMetadata || fieldMetadata.entity !== mappingEntity) return;
    const summary = suggestFieldMatches(fieldMetadata, mappingEntity, draft.rules);
    const suggestions = [...summary.standard.matches, ...summary.custom.matches];
    if (suggestions.length) {
      changeDraft((current) => ({
        ...current,
        rules: [...current.rules, ...suggestions.map(({ source, target }) => ({
          id: newLocalId(), entity: mappingEntity, sourceField: source.code, targetField: target.code,
          criticality: 'tbd' as const,
          // Matching proposes field identity only. Direction and transformation need explicit review.
          bitrix24ToMoysklad: { enabled: false, transform: { kind: 'tbd' as const } },
          moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' as const } },
        }))],
      }));
    }
    setAutoMatchSummary(summary);
    setSaveValidationError('');
  }

  function isRuleSaved(rule: FieldRule) {
    const saved = document?.config.rules.find((candidate) => candidate.id === rule.id);
    return Boolean(saved && saved.entity === rule.entity && saved.sourceField === rule.sourceField && saved.targetField === rule.targetField &&
      saved.bitrix24ToMoysklad.enabled === rule.bitrix24ToMoysklad.enabled && saved.bitrix24ToMoysklad.transform.kind === rule.bitrix24ToMoysklad.transform.kind &&
      saved.moyskladToBitrix24.enabled === rule.moyskladToBitrix24.enabled && saved.moyskladToBitrix24.transform.kind === rule.moyskladToBitrix24.transform.kind &&
      (saved.criticality ?? 'tbd') === rule.criticality);
  }

  async function preview() {
    if (!draft) return;
    setPreviewError('');
    try {
      const pairs = previewPairIds.filter((pairId) => activePairs.some((pair) => pair.id === pairId && pair.entityType === entityTypeForUI(previewEntity)));
      if (pairs.length === 0 || pairs.length > 10) throw new Error('Выберите от 1 до 10 активных сохранённых пар записей');
      const response = await fetch(`${endpoint}/preview`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ entity: previewEntity, direction: previewDirection, pairIds: pairs, config: draft }),
      });
      if (response.status === 403) { onForbidden(); throw new Error('Доступ только для администратора Bitrix24'); }
      const body = await response.text();
      if (!response.ok) throw new Error(body || 'Не удалось выполнить предпросмотр');
      setPreviewResults((JSON.parse(body) as { results: PreviewResult[] }).results);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setPreviewError(message);
      setPreviewResults([]);
    }
  }

  async function save() {
    if (!draft) return;
    const childErrors = childBindingErrors(draft.childResourceBindings ?? [], activePairs.filter((pair) => pair.entityType === 'COMPANY'));
    if (childErrors.length) {
      setSaveValidationError(`Настройки реквизитов: ${childErrors.join('; ')}`);
      setShowSaveWarning(false);
      return;
    }
    if (draft.rules.some((rule) => !rule.sourceField.trim() || !rule.targetField.trim())) {
      setSaveValidationError('Выберите оба поля или удалите незавершённую строку.');
      setShowSaveWarning(false);
      return;
    }
    setSaveValidationError('');
    setSaving(true);
    try {
      const response = await fetch(endpoint, {
        method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ config: draft }),
      });
      if (response.status === 403) { onForbidden(); throw new Error('Доступ только для администратора Bitrix24'); }
      const body = await response.text();
      if (!response.ok) throw new Error(body || 'Не удалось сохранить новую версию настроек');
      const nextDocument = JSON.parse(body) as SettingsDocument;
      setDocument(nextDocument);
      setDraft(catalogs ? includeCurrentNamedSources(includeCurrentCatalogSources(nextDocument.config, catalogs), catalogs) : structuredClone(nextDocument.config));
      setShowSaveWarning(false);
      setPreviewResults([]);
      setAutoMatchSummary(null);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section className="panel field-settings-panel" aria-label="Соответствия полей"><p role="status">Загружаем версию настроек и справочники…</p></section>;
  if (!document || !draft) return <section className="panel field-settings-panel" aria-label="Соответствия полей"><p role="alert">Настройки полей пока недоступны.</p></section>;

  const visibleRules = draft.rules.filter((rule) => rule.entity === mappingEntity);
  const autoMatchBlock = (category: 'standard' | 'custom', label: string) => {
    const block = autoMatchSummary?.[category];
    if (!block) return null;
    return <section className="auto-match-block" aria-label={label} key={category}>
      <strong>{label}</strong>
      <span className="auto-match-counts">Найдено: {block.matches.length} · Без пары: {block.unmatched} · Конфликты: {block.conflicts}</span>
      {block.matches.length > 0 && <ul>{block.matches.map((match) => <li key={`${match.source.code}:${match.target.code}`}>
        <span>{match.source.title || match.source.code} <code>{match.source.code}</code></span><span aria-hidden="true">→</span><span>{match.target.title || match.target.code} <code>{match.target.code}</code></span><em>Черновик · {[
          ...(match.canBitrix24ToMoysklad ? ['Bitrix24 → МойСклад'] : []),
          ...(match.canMoyskladToBitrix24 ? ['МойСклад → Bitrix24'] : []),
        ].join(', ')}</em>
      </li>)}</ul>}
    </section>;
  };
  const confirmedReferences = (kind: ReferenceKind) => (draft.references.namedPairs ?? []).filter((pair) => pair.kind === kind && pair.status === 'confirmed' && pair.moyskladId);
  const changeRuntime = (update: (current: DealOrderRuntime) => DealOrderRuntime) => changeDraft((current) => {
    const base = current.dealOrderRuntime ?? runtimeFromConfirmedPairs(current);
    return { ...current, dealOrderRuntime: update(base) };
  });

  return <>
    <div className="page-heading"><p className="eyebrow">ПРАВИЛА ПЕРЕНОСА</p><h2>Соответствия полей</h2></div>
    <section className="panel field-settings-panel" aria-label="Редактор соответствий полей">
      <div className="field-version-line"><strong>Версия {document.version}</strong><span>Активна для новых событий</span></div>

      <section className="field-editor-section" aria-label="Служебный контрагент">
        <div className="panel-heading"><div><p className="eyebrow">ЗАКАЗ БЕЗ КЛИЕНТА</p><h3>Служебный контрагент МойСклад</h3></div></div>
        <p className="panel-description">Используется только при создании заказа покупателя по сделке без компании и контакта. Вставьте UUID контрагента МойСклад; пустое значение блокирует только такое создание.</p>
        <label>UUID контрагента<input aria-label="UUID служебного контрагента МойСклад" value={draft.serviceCounterpartyId ?? ''} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" onChange={(event) => setDraft((current) => current ? { ...current, serviceCounterpartyId: event.currentTarget.value.trim() || null } : current)} /></label>
      </section>

      <section className="field-editor-section child-resource-editor" aria-label="Реквизиты компаний">
        <div className="panel-heading"><div><p className="eyebrow">ДОЧЕРНИЕ РЕСУРСЫ КОМПАНИИ</p><h3>Юридические и банковские реквизиты</h3></div>
          <button type="button" className="button-secondary" onClick={() => changeDraft((current) => ({ ...current, childResourceBindings: [...(current.childResourceBindings ?? []), { id: newLocalId(), entity: 'companies', bitrix24CompanyId: '', bitrix24RequisiteId: '', moyskladCounterpartyId: '', legalFields: [] }] }))}>＋ Добавить связь реквизитов</button>
        </div>
        <p className="panel-description">Связь применяется только к выбранной паре компании. ID реквизита Bitrix24, банковской строки и счёта МойСклад вводятся явно; поиск и выбор по умолчанию не выполняются. Настроенные поля передаются в обоих направлениях.</p>
        {(draft.childResourceBindings ?? []).length === 0 && <p className="child-binding-empty">Связи не настроены. Юридические и банковские дочерние ресурсы не синхронизируются.</p>}
        {(draft.childResourceBindings ?? []).map((binding, index) => {
          const errorMessages = childBindingErrors(draft.childResourceBindings ?? [], activePairs.filter((pair) => pair.entityType === 'COMPANY'))
            .filter((message) => message.startsWith(`Связь ${index + 1}:`));
          const companyPair = activePairs.find((pair) => pair.entityType === 'COMPANY' && pair.bitrix24Id === binding.bitrix24CompanyId && pair.moyskladId === binding.moyskladCounterpartyId);
          const updateBinding = (update: (current: ChildResourceBinding) => ChildResourceBinding) => changeDraft((current) => ({
            ...current, childResourceBindings: (current.childResourceBindings ?? []).map((candidate) => candidate.id === binding.id ? update(candidate) : candidate),
          }));
          const fieldRows = (kind: 'legalFields' | 'bankDetail.fields', rows: ChildFieldPair[], leftFields: Array<[string, string]>, rightFields: Array<[string, string]>) => <div className="child-binding-field-list" aria-label={kind === 'legalFields' ? 'Юридические поля' : 'Банковские поля'}>
            {rows.map((row, rowIndex) => <div className="child-binding-field-row" key={`${kind}-${rowIndex}`}>
              <label>{kind === 'legalFields' ? 'Реквизит Bitrix24' : 'Банковское поле Bitrix24'}<select aria-label={`${kind === 'legalFields' ? 'Юридическое поле Bitrix24' : 'Банковское поле Bitrix24'} ${index + 1} ${rowIndex + 1}`} value={row.bitrix24Field} onChange={(event) => updateBinding((current) => kind === 'legalFields'
                ? { ...current, legalFields: current.legalFields.map((item, i) => i === rowIndex ? { ...item, bitrix24Field: event.target.value } : item) }
                : { ...current, bankDetail: current.bankDetail ? { ...current.bankDetail, fields: current.bankDetail.fields.map((item, i) => i === rowIndex ? { ...item, bitrix24Field: event.target.value } : item) } : undefined })}>
                <option value="">Выберите поле</option>{leftFields.map(([code, title]) => <option key={code} value={code} disabled={kind === 'legalFields' && Boolean(row.moyskladField) && !isSupportedChildFieldPair(code, row.moyskladField)}>{title} · {code}</option>)}
              </select></label>
              <span aria-hidden="true">→</span>
              <label>Поле МойСклад<select aria-label={`${kind === 'legalFields' ? 'Юридическое поле МойСклад' : 'Банковское поле МойСклад'} ${index + 1} ${rowIndex + 1}`} value={row.moyskladField} onChange={(event) => updateBinding((current) => kind === 'legalFields'
                ? { ...current, legalFields: current.legalFields.map((item, i) => i === rowIndex ? { ...item, moyskladField: event.target.value } : item) }
                : { ...current, bankDetail: current.bankDetail ? { ...current.bankDetail, fields: current.bankDetail.fields.map((item, i) => i === rowIndex ? { ...item, moyskladField: event.target.value } : item) } : undefined })}>
                <option value="">Выберите поле</option>{rightFields.map(([code, title]) => <option key={code} value={code} disabled={kind === 'legalFields' && Boolean(row.bitrix24Field) && !isSupportedChildFieldPair(row.bitrix24Field, code)}>{title} · {code}</option>)}
              </select></label>
              <button type="button" className="mapping-remove" aria-label={`Удалить поле ${rowIndex + 1} связи ${index + 1}`} onClick={() => updateBinding((current) => kind === 'legalFields'
                ? { ...current, legalFields: current.legalFields.filter((_, i) => i !== rowIndex) }
                : { ...current, bankDetail: current.bankDetail ? { ...current.bankDetail, fields: current.bankDetail.fields.filter((_, i) => i !== rowIndex) } : undefined })}>⊖</button>
            </div>)}
            <button type="button" className="button-secondary" onClick={() => updateBinding((current) => kind === 'legalFields'
              ? { ...current, legalFields: [...current.legalFields, { bitrix24Field: '', moyskladField: '' }] }
              : { ...current, bankDetail: current.bankDetail ? { ...current.bankDetail, fields: [...current.bankDetail.fields, { bitrix24Field: '', moyskladField: '' }] } : undefined })}>＋ Добавить пару полей</button>
          </div>;
          return <article className="child-binding-card" key={binding.id} aria-label={`Связь реквизитов ${index + 1}`}>
            <div className="child-binding-card-heading"><strong>Связь {index + 1}</strong><button type="button" className="mapping-remove" aria-label={`Удалить связь реквизитов ${index + 1}`} onClick={() => changeDraft((current) => ({ ...current, childResourceBindings: (current.childResourceBindings ?? []).filter((item) => item.id !== binding.id) }))}>Удалить</button></div>
            <div className="child-binding-identities">
              <label>Пара компании<select aria-label={`Пара компании ${index + 1}`} value={companyPair?.id ?? ''} onChange={(event) => {
                const pair = activePairs.find((item) => item.id === event.target.value && item.entityType === 'COMPANY');
                updateBinding((current) => ({ ...current, bitrix24CompanyId: pair?.bitrix24Id ?? '', moyskladCounterpartyId: pair?.moyskladId ?? '' }));
              }}><option value="">Выберите активную пару</option>{activePairs.filter((pair) => pair.entityType === 'COMPANY').map((pair) => <option key={pair.id} value={pair.id}>Bitrix24 {pair.bitrix24Id} ↔ МойСклад {pair.moyskladId}</option>)}</select></label>
              <label>ID реквизита Bitrix24<input aria-label={`ID реквизита Bitrix24 ${index + 1}`} inputMode="numeric" value={binding.bitrix24RequisiteId} onChange={(event) => updateBinding((current) => ({ ...current, bitrix24RequisiteId: event.target.value.trim() }))} /></label>
            </div>
            {(!activePairs.some((pair) => pair.entityType === 'COMPANY' && pair.active)) && <p role="alert" className="inline-error">Нет активных пар компаний. Сначала создайте и подтвердите пару компании.</p>}
            <div className="child-binding-preview"><strong>Предпросмотр связи</strong><span>{companyPair ? `Bitrix24 компания ${binding.bitrix24CompanyId} ↔ контрагент МойСклад ${binding.moyskladCounterpartyId}` : 'Пара компании не выбрана'}</span><span>Реквизит Bitrix24: {binding.bitrix24RequisiteId || 'не задан'}</span><span>Юридических полей: {binding.legalFields.filter((field) => field.bitrix24Field && field.moyskladField).length}</span></div>
            {fieldRows('legalFields', binding.legalFields, requisiteFields, counterpartyFields)}
            <label className="child-binding-toggle"><input type="checkbox" aria-label={`Включить банковские реквизиты ${index + 1}`} checked={Boolean(binding.bankDetail)} onChange={(event) => updateBinding((current) => ({ ...current, bankDetail: event.target.checked ? { bitrix24Id: '', moyskladAccountId: '', fields: [] } : undefined }))} /> Настроить банковские реквизиты</label>
            {binding.bankDetail && <>
              <div className="child-binding-identities bank-identities">
                <label>ID банковских реквизитов Bitrix24<input aria-label={`ID банковских реквизитов Bitrix24 ${index + 1}`} inputMode="numeric" value={binding.bankDetail.bitrix24Id} onChange={(event) => updateBinding((current) => ({ ...current, bankDetail: current.bankDetail ? { ...current.bankDetail, bitrix24Id: event.target.value.trim() } : undefined }))} /></label>
                <label>UUID счёта МойСклад<input aria-label={`UUID счёта МойСклад ${index + 1}`} value={binding.bankDetail.moyskladAccountId} onChange={(event) => updateBinding((current) => ({ ...current, bankDetail: current.bankDetail ? { ...current.bankDetail, moyskladAccountId: event.target.value.trim() } : undefined }))} /></label>
              </div>{fieldRows('bankDetail.fields', binding.bankDetail.fields, bankDetailFields, accountFields)}
            </>}
            <div className="child-binding-validation" role={errorMessages.length ? 'alert' : 'status'}>{errorMessages.length ? `Требуется исправить: ${errorMessages.join('; ')}` : 'Связь заполнена. При сохранении будет создана новая версия настроек.'}</div>
          </article>;
        })}
      </section>

      <section className="field-editor-section" aria-label="Правила полей">
        <div className="field-mapping-context">
          <label>Сущность<select aria-label="Сущность соответствий" value={mappingEntity} onChange={(event) => {
            const nextEntity = event.target.value;
            setMappingEntity(nextEntity);
            setFieldMetadata(null);
            setMetadataError('');
            setAutoMatchSummary(null);
          }}>{entityOptions.map(([value, label]) => <option key={value} value={value} disabled={deferredEntities.has(value)}>{label}</option>)}</select></label>
          <span className="mapping-meta-status" role="status">{metadataLoading ? 'Загрузка полей…' : fieldMetadata?.entity === mappingEntity ? 'Поля загружены' : ''}</span>
          <button type="button" className="button-secondary" disabled={metadataLoading} onClick={() => void loadFieldMetadata()}>{metadataLoading ? 'Загрузка…' : 'Повторить загрузку'}</button>
        </div>
        {metadataError && <p role="alert" className="inline-error">{metadataError}</p>}
        <button type="button" className="button-secondary auto-match-button" disabled={metadataLoading || !fieldMetadata || fieldMetadata.entity !== mappingEntity} onClick={autoMatchFields}>Сопоставить автоматически</button>
        {autoMatchSummary && <div className="auto-match-results" aria-label="Несохранённые предложения">
          <p>Совпадения предложены только по точному совпадению названий и совместимым типам. Направления отключены, преобразование оставлено как TBD до вашей настройки. Сохранение выполняется только кнопкой «Сохранить новую версию».</p>
          {autoMatchBlock('standard', 'Стандартные поля')}
          {autoMatchBlock('custom', 'Пользовательские поля')}
        </div>}
        <div className="field-mapping-table" role="table" aria-label="Соответствия полей">
          <div className="field-mapping-header" role="row"><strong role="columnheader">Bitrix24</strong><span aria-hidden="true">→</span><strong role="columnheader">МойСклад</strong><span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true">Статус</span></div>
          {visibleRules.map((rule) => {
            const sourceFields = fieldMetadata?.entity === rule.entity ? fieldMetadata.bitrix24 : [];
            const targetFields = fieldMetadata?.entity === rule.entity ? fieldMetadata.moysklad : [];
            const saved = isRuleSaved(rule);
            const source = sourceFields.find((field) => field.code === rule.sourceField);
            const target = targetFields.find((field) => field.code === rule.targetField);
            return <article className="field-mapping-row" role="row" key={rule.id}>
              <select aria-label="Поле Bitrix24" title={source ? `${source.code} · ${source.type}` : rule.sourceField} value={rule.sourceField} disabled={!sourceFields.length} onChange={(event) => updateRule(rule.id, (current) => ({ ...current, sourceField: event.target.value }))}>
                <option value="">Выберите поле</option>{rule.sourceField && !source && <option value={rule.sourceField}>{rule.sourceField}</option>}{sourceFields.map((field) => <option key={field.code} value={field.code} title={`${field.code} · ${field.type}`}>{field.title || field.code} · {field.code}</option>)}
              </select>
              <span className="mapping-direction" role="cell" aria-label="Направление">→</span>
              <select aria-label="Поле МойСклад" title={target ? `${target.code} · ${target.type}` : rule.targetField} value={rule.targetField} disabled={!targetFields.length} onChange={(event) => updateRule(rule.id, (current) => ({ ...current, targetField: event.target.value }))}>
                <option value="">Выберите поле</option>{rule.targetField && !target && <option value={rule.targetField}>{rule.targetField}</option>}{targetFields.map((field) => <option key={field.code} value={field.code} title={`${field.code} · ${field.type}`}>{field.title || field.code} · {field.code}</option>)}
              </select>
              <span className="mapping-equals" role="cell">=</span>
              <button type="button" className="mapping-remove" aria-label={`Удалить соответствие ${rule.sourceField || 'без поля'} → ${rule.targetField || 'без поля'}`} onClick={() => { setAutoMatchSummary(null); changeDraft((current) => ({ ...current, rules: current.rules.filter((item) => item.id !== rule.id) })); }}>⊖</button>
              <span className={saved ? 'mapping-status is-saved' : 'mapping-status is-unsaved'} role="cell" aria-label={saved ? 'Сохранено' : 'Не сохранено'} title={saved ? 'Сохранено в активную версию' : 'Есть несохранённые изменения'}>{saved ? '✓ Сохранено' : '• Не сохранено'}</span>
              <details className="mapping-row-advanced"><summary>Направления и коды</summary>
                <div className="mapping-advanced-content">
                  <label>Критичность<select aria-label={`Критичность ${rule.sourceField || 'поля'} → ${rule.targetField || 'поля'}`} value={rule.criticality ?? 'tbd'} onChange={(event) => updateRule(rule.id, (current) => ({ ...current, criticality: event.target.value as FieldRule['criticality'] }))}><option value="tbd">Не определена</option><option value="critical">Критичное</option><option value="optional">Необязательное</option></select></label>
                  <fieldset><legend>Bitrix24 → МойСклад</legend><label><input type="checkbox" checked={rule.bitrix24ToMoysklad.enabled} onChange={(event) => updateRule(rule.id, (current) => ({ ...current, bitrix24ToMoysklad: { ...current.bitrix24ToMoysklad, enabled: event.target.checked } }))} /> Включено</label><label>Преобразование<select aria-label="Преобразование Bitrix24 в МойСклад" value={rule.bitrix24ToMoysklad.transform.kind} onChange={(event) => updateRule(rule.id, (current) => ({ ...current, bitrix24ToMoysklad: { enabled: current.bitrix24ToMoysklad.enabled, transform: { kind: event.target.value as Transform['kind'] } } }))}><option value="tbd">Не задано (TBD)</option><option value="copy">Копировать значение</option></select></label></fieldset>
                  <fieldset><legend>МойСклад → Bitrix24</legend><label><input type="checkbox" checked={rule.moyskladToBitrix24.enabled} onChange={(event) => updateRule(rule.id, (current) => ({ ...current, moyskladToBitrix24: { ...current.moyskladToBitrix24, enabled: event.target.checked } }))} /> Включено</label><label>Преобразование<select aria-label="Преобразование МойСклад в Bitrix24" value={rule.moyskladToBitrix24.transform.kind} onChange={(event) => updateRule(rule.id, (current) => ({ ...current, moyskladToBitrix24: { enabled: current.moyskladToBitrix24.enabled, transform: { kind: event.target.value as Transform['kind'] } } }))}><option value="tbd">Не задано (TBD)</option><option value="copy">Копировать значение</option></select></label></fieldset>
                  <details className="mapping-codes"><summary>Технические коды</summary><code>{rule.sourceField || '—'} → {rule.targetField || '—'}</code><small>{source?.type ?? 'тип недоступен'} → {target?.type ?? 'тип недоступен'}</small></details>
                </div>
              </details>
            </article>;
          })}
          {!visibleRules.length && <p className="muted-empty">Пока нет соответствий для этой сущности.</p>}
        </div>
        <button type="button" className="mapping-add" onClick={addRule}>＋ Добавить соответствие</button>
        {saveValidationError && <p role="alert" className="inline-error">{saveValidationError}</p>}
      </section>

      <details className="field-advanced-settings"><summary>Дополнительные настройки: группы, предпросмотр и справочники</summary>
      {catalogError && <p role="alert" className="inline-error">Справочники пока недоступны: {catalogError}. Соответствия полей можно редактировать отдельно.</p>}
      {pairError && <p role="alert" className="inline-error">Пары записей для предпросмотра недоступны: {pairError}. Список полей от этого не зависит.</p>}
      <section className="field-editor-section" aria-label="Составные правила">
        <div className="panel-heading"><div><p className="eyebrow">ГРУППЫ ПОЛЕЙ</p><h3>Составное преобразование</h3></div></div>
        <p className="panel-description">Собирайте одно значение из нескольких полей отдельным правилом; пустые части пропускаются.</p>
        <form className="field-rule-form" onSubmit={addGroup}>
          <label>Пара сущностей<select aria-label="Пара сущностей группы" value={groupForm.entity} onChange={(event) => setGroupForm({ ...groupForm, entity: event.target.value })}>{entityOptions.map(([value, label]) => <option key={value} value={value} disabled={deferredEntities.has(value) || groupUnsupportedEntities.has(value)}>{label}</option>)}</select></label>
          <label>Направление<select aria-label="Направление группы" value={groupForm.direction} onChange={(event) => setGroupForm({ ...groupForm, direction: event.target.value as FieldGroup['direction'] })}><option value="BITRIX24_TO_MOYSKLAD" disabled={groupForm.transformKind === 'split-non-empty'}>Bitrix24 → МойСклад</option><option value="MOYSKLAD_TO_BITRIX24">МойСклад → Bitrix24</option></select></label>
          <label>Преобразование<select aria-label="Преобразование группы" value={groupForm.transformKind} onChange={(event) => {
            const transformKind = event.target.value as FieldGroup['transform']['kind'];
            setGroupForm({ ...groupForm, transformKind, ...(transformKind === 'split-non-empty' ? { direction: 'MOYSKLAD_TO_BITRIX24' as const } : {}) });
          }}><option value="join-non-empty">Соединить значения</option><option value="split-non-empty" disabled={groupForm.direction !== 'MOYSKLAD_TO_BITRIX24' && groupForm.transformKind !== 'split-non-empty'}>Разделить значение для Bitrix24</option></select></label>
          <label>Поля-источники<select aria-label="Поля источники группы" multiple value={groupForm.sourceFields.split(',').filter(Boolean)} onChange={(event) => {
            const selected = [...event.currentTarget.selectedOptions].map((option) => option.value);
            setGroupForm({ ...groupForm, sourceFields: (groupForm.transformKind === 'split-non-empty' ? selected.slice(0, 1) : selected).join(',') });
          }} disabled={!fieldMetadata || fieldMetadata.entity !== groupForm.entity}>{(groupForm.direction === 'BITRIX24_TO_MOYSKLAD' ? fieldMetadata?.bitrix24 : fieldMetadata?.moysklad)?.map((field) => <option key={field.code} value={field.code}>{field.title || 'Название отсутствует'} · {field.code} · {field.type}</option>)}</select></label>
          <label>Поле-результат<select aria-label="Поле результат группы" value={groupForm.targetField} onChange={(event) => setGroupForm({ ...groupForm, targetField: event.target.value })} disabled={!fieldMetadata || fieldMetadata.entity !== groupForm.entity}><option value="">Выберите поле</option>{(groupForm.direction === 'BITRIX24_TO_MOYSKLAD' ? fieldMetadata?.moysklad : fieldMetadata?.bitrix24)?.map((field) => <option key={field.code} value={field.code}>{field.title || 'Название отсутствует'} · {field.code} · {field.type}</option>)}</select></label>
          <label>Разделитель<input aria-label="Разделитель группы" value={groupForm.separator} onChange={(event) => setGroupForm({ ...groupForm, separator: event.target.value })} /></label>
          {groupForm.transformKind === 'split-non-empty' && <label>Тип значения Bitrix24<select aria-label="Тип значения Bitrix24" value={groupForm.valueType} onChange={(event) => setGroupForm({ ...groupForm, valueType: event.target.value })}><option value="">Выберите тип</option>{['WORK', 'HOME', 'MOBILE', 'MAILING', 'OTHER', 'FAX', 'PAGER'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
          <button type="submit" className="button-secondary">Добавить составное правило</button>
        </form>
        {draft.groups.length ? <div className="field-rule-list">{draft.groups.map((group) => <article key={group.id} className="field-rule-row"><div><strong>{group.sourceFields.join(' + ')} → {group.targetField}</strong><small>{group.direction === 'BITRIX24_TO_MOYSKLAD' ? 'Bitrix24 → МойСклад' : 'МойСклад → Bitrix24'} · пропуск пустых частей</small><label>Критичность<select aria-label={`Критичность группы ${group.targetField}`} value={group.criticality ?? 'tbd'} onChange={(event) => changeDraft((current) => ({ ...current, groups: current.groups.map((item) => item.id === group.id ? { ...item, criticality: event.target.value as FieldGroup['criticality'] } : item) }))}><option value="tbd">Не определена</option><option value="critical">Критичное</option><option value="optional">Необязательное</option></select></label></div><button type="button" className="button-secondary" aria-label={`Удалить группу ${group.targetField}`} onClick={() => changeDraft((current) => ({ ...current, groups: current.groups.filter((item) => item.id !== group.id) }))}>Удалить</button></article>)}</div> : <p className="muted-empty">Составные группы ещё не настроены.</p>}
      </section>

      <section className="field-editor-section" aria-label="Предпросмотр настройки">
        <div className="panel-heading"><div><p className="eyebrow">БЕЗ ЗАПИСИ В СИСТЕМЫ</p><h3>Предпросмотр преобразования</h3></div></div>
        <p className="panel-description">Для каждой выбранной пары сервер читает свежие данные обеих систем и показывает результат и ошибки. Выполняются только GET-чтения; записи и вебхуки не вызываются. Максимум 10 пар за запрос.</p>
        <div className="field-rule-form">
          <label>Пара сущностей<select aria-label="Пара сущностей предпросмотра" value={previewEntity} onChange={(event) => { setPreviewEntity(event.target.value); setPreviewPairIds([]); setPreviewResults([]); }}>{entityOptions.map(([value, label]) => <option key={value} value={value} disabled={deferredEntities.has(value)}>{label}</option>)}</select></label>
          <label>Направление<select aria-label="Направление предпросмотра" value={previewDirection} onChange={(event) => setPreviewDirection(event.target.value as typeof previewDirection)}><option value="BITRIX24_TO_MOYSKLAD">Bitrix24 → МойСклад</option><option value="MOYSKLAD_TO_BITRIX24">МойСклад → Bitrix24</option></select></label>
        </div>
        <label className="field-preview-input">Активные пары записей<select aria-label="Активные пары предпросмотра" multiple size={Math.min(6, Math.max(2, activePairs.filter((pair) => pair.entityType === entityTypeForUI(previewEntity)).length))} value={previewPairIds} onChange={(event) => {
          const selected = [...event.currentTarget.selectedOptions].map((option) => option.value);
          if (selected.length > 10) { setPreviewError('За один запрос можно выбрать не более 10 пар.'); return; }
          setPreviewError(''); setPreviewPairIds(selected);
        }}>
          {activePairs.filter((pair) => pair.entityType === entityTypeForUI(previewEntity)).map((pair) => <option key={pair.id} value={pair.id}>Bitrix24 {pair.bitrix24Id} ↔ МойСклад {pair.moyskladId}</option>)}
        </select></label>
        <button type="button" className="button-secondary" onClick={() => void preview()}>Прочитать пары и выполнить предпросмотр</button>
        {previewError && <p role="alert" className="inline-error">{previewError}</p>}
        {previewResults.length > 0 && <div className="field-preview-results" aria-label="Результат предпросмотра">{previewResults.map((result, index) => <article key={`${result.sourceLabel}-${index}`}><strong>{result.sourceLabel}</strong><small>Источник: {JSON.stringify(result.sourceValues)}</small><small>Сейчас в другой системе: {JSON.stringify(result.targetCurrent)}</small><small>Преобразовано: {JSON.stringify(result.transformed)}</small><small>{result.errors.length ? `Ошибки: ${result.errors.join('; ')}` : 'Ошибок преобразования нет'} · версия {result.version} · записей: {result.writes}</small></article>)}</div>}
      </section>

      <section className="field-editor-section" aria-label="Единицы измерения">
        <div className="panel-heading"><div><p className="eyebrow">ЕДИНИЦЫ КАТАЛОГА</p><h3>Bitrix24 ↔ МойСклад</h3></div><span className="event-status status-succeeded">{draft.references.units.filter((unit) => unit.moyskladId).length} пар</span></div>
        <p className="panel-description">Предложение создаётся только при точном совпадении кода. Стартовые 9 пар утверждены; ID 14, 16 и 20 намеренно не сопоставлены, пока администратор явно не назначит пару.</p>
        <button type="button" className="button-secondary" onClick={suggestExactUnits}>Предложить пары с одинаковым кодом</button>
        <div className="reference-map-list">{draft.references.units.map((unit) => {
          const suggestion = catalogs.units.moysklad.find((candidate) => candidate.code === unit.bitrix24Code);
          return <article key={unit.bitrix24Id} className="reference-map-row">
            <div><strong>Bitrix24 ID {unit.bitrix24Id} · код {unit.bitrix24Code}</strong><small>{unit.moyskladId ? `Сохранённая пара · код ${unit.moyskladCode ?? '—'}` : [14, 16, 20].includes(unit.bitrix24Id) ? 'Намеренно без пары' : 'Без пары'}</small></div>
            <label>МойСклад<select aria-label={`Единица МойСклад для ${unit.bitrix24Id}`} value={unit.moyskladId ?? ''} onChange={(event) => changeUnit(unit.bitrix24Id, event.target.value)}><option value="">Без пары</option>{catalogs.units.moysklad.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.code} · {candidate.id}</option>)}</select></label>
            {suggestion && <span className="exact-match-note">Точный код: {suggestion.code}</span>}
          </article>;
        })}</div>
      </section>

      <section className="field-editor-section" aria-label="Типы цен каталога">
        <div className="panel-heading"><div><p className="eyebrow">ЦЕНЫ КАРТОЧКИ КАТАЛОГА</p><h3>Типы цен</h3></div><span className="event-status status-succeeded">{draft.references.priceTypes.filter((priceType) => priceType.moyskladId).length} пар</span></div>
        <p className="panel-description">Исключённые типы остаются без пары; имеющиеся значения в системах не изменяются. Цена строки заказа — отдельная настройка.</p>
        <div className="reference-map-list">{draft.references.priceTypes.map((priceType) => <article key={priceType.bitrix24Id} className="reference-map-row">
          <div><strong>Bitrix24 ID {priceType.bitrix24Id} · {priceType.bitrix24Code}</strong><small>{priceType.moyskladId ? `Сохранённая пара · ${priceType.moyskladLabel ?? ''}` : [10, 18, 20, 22].includes(priceType.bitrix24Id) ? 'Исключён до отдельного решения' : 'Без пары'}</small></div>
          <label>МойСклад<select aria-label={`Тип цены МойСклад для ${priceType.bitrix24Id}`} value={priceType.moyskladId ?? ''} onChange={(event) => changePriceType(priceType.bitrix24Id, event.target.value)}><option value="">Не сопоставлять</option>{catalogs.priceTypes.moysklad.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label} · {candidate.id}</option>)}</select></label>
        </article>)}</div>
      </section>

      <section className="field-editor-section" aria-label="Справочники услуг и способов оплаты">
        <div className="panel-heading"><div><p className="eyebrow">ССЫЛОЧНЫЕ ПОЛЯ ЗАКАЗА</p><h3>Услуги и способы оплаты</h3></div></div>
        {draft.references.dictionaries.map((dictionary) => {
          const liveValues = catalogs.dictionaries.find((candidate) => candidate.key === dictionary.key)?.values;
          return <article key={dictionary.key} className="dictionary-map-card">
          <div><strong>{dictionary.key === 'service' ? 'Услуга' : 'Способ оплаты'}</strong><small>Bitrix24 {dictionary.bitrix24Field} · список {dictionary.bitrix24ListId}</small><small>МойСклад атрибут {dictionary.moyskladAttributeId} · справочник {dictionary.moyskladDirectoryId}</small></div>
          <p>{dictionary.pairs.length} сопоставленных значений. Пустое значение не передаётся как новая пара.</p>
          {!liveValues ? <p role="alert">Живой каталог значений недоступен.</p> : <div className="reference-map-list">{liveValues.bitrix24.map((source) => {
            const currentTarget = dictionary.pairs.find((pair) => pair.bitrix24Id === Number(source.id))?.moyskladId ?? '';
            const assignedElsewhere = new Set(dictionary.pairs.filter((pair) => pair.bitrix24Id !== Number(source.id)).map((pair) => pair.moyskladId));
            return <article key={source.id} className="reference-map-row"><div><strong>{source.title || source.code || `Bitrix24 ${source.id}`}</strong><small>Bitrix24 ID {source.id}{source.code ? ` · код ${source.code}` : ''}</small></div><label>Значение МойСклад<select aria-label={`${dictionary.key}: значение МойСклад для ${source.id}`} value={currentTarget} onChange={(event) => changeDictionaryPair(dictionary.key, Number(source.id), event.target.value)}><option value="">Не сопоставлять</option>{liveValues.moysklad.map((candidate) => <option key={candidate.id} value={candidate.id} disabled={assignedElsewhere.has(candidate.id)}>{candidate.title || candidate.code || candidate.id} · {candidate.id}</option>)}</select></label></article>;
          })}</div>}
        </article>;
        })}
      </section>
      <section className="field-editor-section" aria-label="Сотрудники, стадии и справочные значения">
        <div className="panel-heading"><div><p className="eyebrow">СВЯЗИ И СТАТУСЫ</p><h3>Сотрудники, организации и справочники</h3></div></div>
        <p className="panel-description">Автопоиск предлагает совпадения по названию, но не подтверждает их автоматически. Выберите значение МойСклад и подтвердите каждую пару отдельно.</p>
        {(() => {
          const employees = draft.references.namedPairs ?? [];
          const duplicateEmployees = new Map<string, NamedReferencePair[]>();
          for (const pair of employees.filter((candidate) => candidate.kind === 'employees' && candidate.status === 'confirmed' && candidate.moyskladId)) {
            duplicateEmployees.set(pair.moyskladId!, [...(duplicateEmployees.get(pair.moyskladId!) ?? []), pair]);
          }
          const conflicts = [...duplicateEmployees.entries()].filter(([, pairs]) => pairs.length > 1);
          return conflicts.length ? <p role="alert" className="inline-error">Один сотрудник МойСклад сопоставлен с несколькими сотрудниками Bitrix24 ({conflicts.length} конфликтов). Проверьте назначения перед включением обмена.</p> : null;
        })()}
        {referenceKinds.map(([kind, title]) => {
          const catalog = catalogs.namedReferences[kind];
          const savedPairs = draft.references.namedPairs ?? [];
          return <details key={kind} className="field-reference-group">
            <summary>{title} · {savedPairs.filter((pair) => pair.kind === kind && pair.status === 'confirmed').length} подтверждено</summary>
            {!catalog ? <p role="alert">Каталог недоступен.</p> : <div className="reference-map-list">{catalog.sources.map(({ source, targetId, targetLabel, status, suggestion, ambiguousSuggestions }) => {
              const saved = savedPairs.find((pair) => pair.kind === kind && pair.bitrix24Id === source.id);
              const selectedId = saved?.moyskladId ?? targetId ?? '';
              return <article key={source.id} className="reference-map-row">
                <div><strong>{source.label || source.id}</strong><small>Bitrix24{source.group ? ` · Воронка: ${source.group}` : ''} · {source.code || source.id} · {saved?.status ?? status}</small>
                  {suggestion && <small>Предложение: {suggestion.label}</small>}
                  {ambiguousSuggestions.length > 0 && <small role="alert">Несколько кандидатов: {ambiguousSuggestions.map((item) => item.label).join(', ')}</small>}
                  {saved?.status === 'confirmed' && targetLabel && <small>Подтверждено: {targetLabel}</small>}
                </div>
                <label>МойСклад<select aria-label={`${title}: значение МойСклад для ${source.label}`} value={selectedId} onChange={(event) => updateNamedPair(kind, source, event.target.value, 'suggested')}>
                  <option value="">Не сопоставлять</option>
                  {selectedId && !catalog.targets.some((target) => target.id === selectedId) && <option value={selectedId}>{targetLabel ?? 'Сохранённое, отсутствующее в каталоге'} · {selectedId}</option>}
                  {catalog.targets.map((target) => <option key={target.id} value={target.id}>{target.label} · {target.code || target.id}</option>)}
                </select></label>
                {suggestion && !selectedId && <button type="button" className="button-secondary" onClick={() => updateNamedPair(kind, source, suggestion.id, 'suggested')}>Использовать предложение</button>}
                {selectedId && saved?.status !== 'confirmed' && <button type="button" className="button-secondary" onClick={() => updateNamedPair(kind, source, selectedId, 'confirmed')}>Подтвердить пару</button>}
                {saved?.status === 'confirmed' && <button type="button" className="button-secondary" onClick={() => updateNamedPair(kind, source, '', 'unmapped')}>Снять пару</button>}
              </article>;
            })}</div>}
          </details>;
        })}
      </section>
      </details>

      <section className="field-editor-section" aria-label="Настройки обмена сделок и заказов">
        <div className="panel-heading"><div><p className="eyebrow">ОБМЕН СДЕЛОК И ЗАКАЗОВ</p><h3>Новые заказы и продуктовые пары</h3></div></div>
        <p className="panel-description">Настройки применяются к новым событиям после явного сохранения версии. Для MyСклад → Bitrix24 отсутствующий товар сначала создаётся в выбранном каталоге Bitrix24 и связывается с товаром MyСклад; товар MyСклад не изменяется. Стадия, валюта, единицы и каталог должны быть подтверждены вручную.</p>
        {!draft.dealOrderRuntime ? <button type="button" className="button-secondary" onClick={() => changeDraft((current) => ({ ...current, dealOrderRuntime: runtimeFromConfirmedPairs(current) }))}>Настроить обмен заказами</button> : (() => {
          const runtime = draft.dealOrderRuntime!;
          const organizationOptions = confirmedReferences('organizations');
          const storeOptions = confirmedReferences('warehouses');
          const employeeOptions = confirmedReferences('employees');
          const productFields = runtime.moyskladProductFields ?? ['name'];
          const setProductField = (field: 'code' | 'description', enabled: boolean) => changeRuntime((current) => ({ ...current, moyskladProductFields: [...new Set(['name', ...(current.moyskladProductFields ?? ['name']).filter((value) => value !== field), ...(enabled ? [field] : [])])] as Array<'name' | 'code' | 'description'> }));
          return <div className="reference-map-list">
            <label>Каталог товаров Bitrix24<select aria-label="Каталог товаров Bitrix24 для создания" value={runtime.bitrix24ProductCatalogId ?? ''} onChange={(event) => changeRuntime((current) => ({ ...current, bitrix24ProductCatalogId: event.currentTarget.value || null }))}>
              <option value="">Выберите каталог вручную</option>{catalogs.productCatalogs.map((catalog) => <option key={catalog.id} value={catalog.id}>{catalog.label} · {catalog.id}</option>)}
            </select></label>
            <fieldset><legend>Разрешённые поля из карточки товара MyСклад</legend>
              <label><input type="checkbox" checked disabled />Наименование (обязательное)</label>
              <label><input type="checkbox" checked={productFields.includes('code')} onChange={(event) => setProductField('code', event.currentTarget.checked)} />Код</label>
              <label><input type="checkbox" checked={productFields.includes('description')} onChange={(event) => setProductField('description', event.currentTarget.checked)} />Описание</label>
            </fieldset>
            <label><input type="checkbox" checked={runtime.nativeOrderNumberingVerified} onChange={(event) => changeRuntime((current) => ({ ...current, nativeOrderNumberingVerified: event.currentTarget.checked }))} />Проверена нумерация заказов MyСклад (номер записывается в отдельное поле Bitrix24)</label>
            <label>Организация MyСклад по умолчанию<select aria-label="Организация MyСклад по умолчанию" value={runtime.defaultOrganizationId ?? ''} onChange={(event) => changeRuntime((current) => ({ ...current, defaultOrganizationId: event.currentTarget.value || null }))}><option value="">Выберите подтверждённую пару</option>{organizationOptions.map((pair) => <option key={pair.bitrix24Id} value={pair.moyskladId!}>{pair.bitrix24Label} · {pair.moyskladId}</option>)}</select></label>
            <label>Склад MyСклад по умолчанию<select aria-label="Склад MyСклад по умолчанию" value={runtime.defaultStoreId ?? ''} onChange={(event) => changeRuntime((current) => ({ ...current, defaultStoreId: event.currentTarget.value || null }))}><option value="">Выберите подтверждённую пару</option>{storeOptions.map((pair) => <option key={pair.bitrix24Id} value={pair.moyskladId!}>{pair.bitrix24Label} · {pair.moyskladId}</option>)}</select></label>
            <label>Ответственный MyСклад по умолчанию<select aria-label="Ответственный MyСклад по умолчанию" value={runtime.defaultEmployeeId ?? ''} onChange={(event) => changeRuntime((current) => ({ ...current, defaultEmployeeId: event.currentTarget.value || null }))}><option value="">Выберите подтверждённую пару</option>{employeeOptions.map((pair) => <option key={pair.bitrix24Id} value={pair.moyskladId!}>{pair.bitrix24Label} · {pair.moyskladId}</option>)}</select></label>
            <fieldset><legend>Стадии, при входе в которые создаётся заказ MyСклад</legend>{runtime.stages.map((stage) => {
              const ref = confirmedReferences('dealStages').find((pair) => pair.bitrix24Id === stage.bitrix24StageId);
              return <label key={stage.bitrix24StageId}><input type="checkbox" checked={stage.creationEnabled} onChange={(event) => changeRuntime((current) => ({ ...current, stages: current.stages.map((candidate) => candidate.bitrix24StageId === stage.bitrix24StageId ? { ...candidate, creationEnabled: event.currentTarget.checked } : candidate) }))} />{ref?.bitrix24Label ?? stage.bitrix24StageId} · {stage.bitrix24StageId}</label>;
            })}</fieldset>
            <p>Валюты и пары организации, склада, ответственного и стадий берутся только из подтверждённых связей выше. Единицы для карточек и строк должны быть сопоставлены в разделе «Единицы каталога».</p>
          </div>;
        })()}
      </section>

      <div className="field-save-bar"><p>Сохранение создаёт версию {document.version + 1} и сразу применяется к новым событиям.</p><button type="button" onClick={() => setShowSaveWarning(true)} disabled={saving}>Сохранить новую версию</button></div>
      {showSaveWarning && <div className="field-save-warning" role="alertdialog" aria-label="Предупреждение о настройках">
        <h3>Подтвердите изменение настроек</h3>
        <p>Новая версия начнёт действовать для новых событий. Уже принятые события сохранят прежние правила; обычный повтор не переключает версию. Массового пересчёта не будет.</p>
        {document && draft && fieldRuleRiskChanges(document.config, draft).length > 0 && <div role="alert"><strong>Изменения правил и дочерних реквизитов:</strong><ul>{fieldRuleRiskChanges(document.config, draft).map((change) => <li key={change}>{change}</li>)}</ul><p>После подтверждения эти изменения будут записаны в журнал администрирования.</p></div>}
        <button type="button" onClick={() => void save()} disabled={saving}>{saving ? 'Сохраняем…' : 'Подтвердить и сохранить'}</button>
        <button type="button" className="button-secondary" onClick={() => setShowSaveWarning(false)} disabled={saving}>Отмена</button>
      </div>}
    </section>
  </>;
}

function newLocalId() {
  return globalThis.crypto?.randomUUID?.() ?? `field-rule-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fieldRuleRiskChanges(previous: SettingsConfig, next: SettingsConfig): string[] {
  const oldRules = new Map(previous.rules.map((rule) => [rule.id, rule]));
  const newRules = new Map(next.rules.map((rule) => [rule.id, rule]));
  const changes: string[] = [];
  for (const [id, oldRule] of oldRules) {
    const newRule = newRules.get(id);
    if (!newRule) {
      changes.push(`Удалено: ${oldRule.entity} ${oldRule.sourceField} → ${oldRule.targetField}`);
      continue;
    }
    if (oldRule.entity !== newRule.entity || oldRule.sourceField !== newRule.sourceField || oldRule.targetField !== newRule.targetField) {
      changes.push(`Изменён ключ: ${oldRule.entity} ${oldRule.sourceField} → ${oldRule.targetField}`);
    }
    if (oldRule.bitrix24ToMoysklad.enabled !== newRule.bitrix24ToMoysklad.enabled || oldRule.moyskladToBitrix24.enabled !== newRule.moyskladToBitrix24.enabled) {
      changes.push(`Изменено направление: ${newRule.entity} ${newRule.sourceField} → ${newRule.targetField}`);
    }
  }
  for (const [id, newRule] of newRules) if (!oldRules.has(id)) changes.push(`Добавлен ключ: ${newRule.entity} ${newRule.sourceField} → ${newRule.targetField}`);
  const oldGroups = new Map(previous.groups.map((group) => [group.id, group]));
  const newGroups = new Map(next.groups.map((group) => [group.id, group]));
  for (const [id, oldGroup] of oldGroups) {
    const newGroup = newGroups.get(id);
    if (!newGroup) {
      changes.push(`Удалена группа: ${oldGroup.entity} ${oldGroup.sourceFields.join(' + ')} → ${oldGroup.targetField}`);
      continue;
    }
    if (oldGroup.entity !== newGroup.entity || oldGroup.targetField !== newGroup.targetField || oldGroup.sourceFields.join('\0') !== newGroup.sourceFields.join('\0')) {
      changes.push(`Изменён ключ группы: ${oldGroup.entity} ${oldGroup.sourceFields.join(' + ')} → ${oldGroup.targetField}`);
    }
    if (oldGroup.direction !== newGroup.direction) changes.push(`Изменено направление группы: ${newGroup.entity} ${newGroup.sourceFields.join(' + ')} → ${newGroup.targetField}`);
  }
  for (const [id, newGroup] of newGroups) if (!oldGroups.has(id)) changes.push(`Добавлена группа: ${newGroup.entity} ${newGroup.sourceFields.join(' + ')} → ${newGroup.targetField}`);
  const oldBindings = new Map((previous.childResourceBindings ?? []).map((binding) => [binding.id, binding]));
  const newBindings = new Map((next.childResourceBindings ?? []).map((binding) => [binding.id, binding]));
  for (const [id, oldBinding] of oldBindings) {
    const newBinding = newBindings.get(id);
    if (!newBinding) changes.push(`Удалена связь юридических/банковских реквизитов компании ${oldBinding.bitrix24CompanyId || '(без выбранной пары)'}`);
    else if (JSON.stringify(oldBinding) !== JSON.stringify(newBinding)) changes.push(`Изменена связь юридических/банковских реквизитов компании ${newBinding.bitrix24CompanyId || '(без выбранной пары)'}`);
  }
  for (const [id, binding] of newBindings) if (!oldBindings.has(id)) changes.push(`Добавлена связь юридических/банковских реквизитов компании ${binding.bitrix24CompanyId || '(без выбранной пары)'}`);
  return changes;
}

function childBindingErrors(bindings: ChildResourceBinding[], companyPairs: ActiveEntityPair[]): string[] {
  const errors: string[] = [];
  const assignedCompanies = new Set<string>();
  const validPairs = new Set(companyPairs.filter((pair) => pair.active).map((pair) => `${pair.bitrix24Id}:${pair.moyskladId}`));
  for (const [index, binding] of bindings.entries()) {
    const prefix = `Связь ${index + 1}`;
    if (!binding.bitrix24CompanyId || !binding.moyskladCounterpartyId || !validPairs.has(`${binding.bitrix24CompanyId}:${binding.moyskladCounterpartyId}`)) errors.push(`${prefix}: выберите существующую активную пару компании`);
    if (binding.bitrix24CompanyId && assignedCompanies.has(binding.bitrix24CompanyId)) errors.push(`${prefix}: для компании уже настроена другая связь`);
    if (binding.bitrix24CompanyId) assignedCompanies.add(binding.bitrix24CompanyId);
    if (!/^\d+$/.test(binding.bitrix24RequisiteId)) errors.push(`${prefix}: укажите ID реквизита Bitrix24`);
    const legal = validateChildFieldPairs(binding.legalFields, requisiteFields, counterpartyFields, `${prefix}: юридические поля`);
    errors.push(...legal.errors);
    const bank = binding.bankDetail ? validateChildFieldPairs(binding.bankDetail.fields, bankDetailFields, accountFields, `${prefix}: банковские поля`) : { errors: [], count: 0 };
    errors.push(...bank.errors);
    if (binding.bankDetail) {
      if (!/^\d+$/.test(binding.bankDetail.bitrix24Id)) errors.push(`${prefix}: укажите ID банковских реквизитов Bitrix24`);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.bankDetail.moyskladAccountId)) errors.push(`${prefix}: укажите UUID счёта МойСклад`);
    }
    if (!legal.count && !bank.count) errors.push(`${prefix}: добавьте хотя бы одну пару полей`);
  }
  return errors;
}

function validateChildFieldPairs(rows: ChildFieldPair[], allowedSources: Array<[string, string]>, allowedTargets: Array<[string, string]>, label: string) {
  const errors: string[] = [];
  const sources = new Set<string>();
  const targets = new Set<string>();
  let count = 0;
  for (const [index, row] of rows.entries()) {
    if (!row.bitrix24Field || !row.moyskladField) { errors.push(`${label}, строка ${index + 1}: выберите оба поля`); continue; }
    if (!allowedSources.some(([code]) => code === row.bitrix24Field) || !allowedTargets.some(([code]) => code === row.moyskladField)) { errors.push(`${label}, строка ${index + 1}: поле не поддерживается`); continue; }
    if (!isSupportedChildFieldPair(row.bitrix24Field, row.moyskladField)) { errors.push(`${label}, строка ${index + 1}: неподдерживаемая пара ${row.bitrix24Field} → ${row.moyskladField}`); continue; }
    if (sources.has(row.bitrix24Field) || targets.has(row.moyskladField)) errors.push(`${label}: поля должны использоваться только один раз`);
    sources.add(row.bitrix24Field);
    targets.add(row.moyskladField);
    count += 1;
  }
  return { errors, count };
}

function isSupportedChildFieldPair(bitrix24Field: string, moyskladField: string) {
  if ((bitrix24Field === 'RQ_OGRNIP') !== (moyskladField === 'ogrnip')) return false;
  if (bitrix24Field === 'RQ_COMPANY_NAME' && moyskladField === 'legalTitle') return false;
  return true;
}

function runtimeFromConfirmedPairs(config: SettingsConfig, previous?: DealOrderRuntime): DealOrderRuntime {
  const pairs = config.references.namedPairs ?? [];
  const confirmed = (kind: ReferenceKind) => pairs.filter((pair) => pair.kind === kind && pair.status === 'confirmed' && pair.moyskladId);
  const preserveOrChoose = (previousId: string | null | undefined, kind: ReferenceKind) => {
    const options = confirmed(kind);
    return options.some((pair) => pair.moyskladId === previousId) ? previousId! : options[0]?.moyskladId ?? null;
  };
  const currencies = confirmed('currencies').map((pair) => ({ bitrix24Code: pair.bitrix24Id, moyskladId: pair.moyskladId! }));
  const stages = confirmed('dealStages').map((pair) => ({
    bitrix24StageId: pair.bitrix24Id,
    moyskladId: pair.moyskladId!,
    creationEnabled: previous?.stages.find((stage) => stage.bitrix24StageId === pair.bitrix24Id)?.creationEnabled ?? false,
  }));
  const mappings = (kind: ReferenceKind) => confirmed(kind).map((pair) => ({ bitrix24Id: pair.bitrix24Id, moyskladId: pair.moyskladId! }));
  return {
    nativeOrderNumberingVerified: previous?.nativeOrderNumberingVerified ?? false,
    bitrix24ProductCatalogId: previous?.bitrix24ProductCatalogId ?? null,
    moyskladProductFields: previous?.moyskladProductFields ?? ['name'],
    defaultOrganizationId: preserveOrChoose(previous?.defaultOrganizationId, 'organizations'),
    defaultStoreId: preserveOrChoose(previous?.defaultStoreId, 'warehouses'),
    defaultEmployeeId: preserveOrChoose(previous?.defaultEmployeeId, 'employees'),
    currencies,
    stages,
    organizations: mappings('organizations'),
    stores: mappings('warehouses'),
    employees: mappings('employees'),
  };
}

function includeCurrentCatalogSources(config: SettingsConfig, catalogs: Catalogs): SettingsConfig {
  const next = structuredClone(config);
  const unitIds = new Set(next.references.units.map((row) => String(row.bitrix24Id)));
  const priceIds = new Set(next.references.priceTypes.map((row) => String(row.bitrix24Id)));
  for (const source of catalogs.units.bitrix24) {
    const id = Number(source.id);
    if (!Number.isInteger(id) || unitIds.has(String(id))) continue;
    next.references.units.push({ bitrix24Id: id, bitrix24Code: source.code || source.label, moyskladId: null, moyskladCode: null, status: 'unmapped' });
  }
  for (const source of catalogs.priceTypes.bitrix24) {
    const id = Number(source.id);
    if (!Number.isInteger(id) || priceIds.has(String(id))) continue;
    next.references.priceTypes.push({ bitrix24Id: id, bitrix24Code: source.code || source.label, moyskladId: null, moyskladLabel: null, status: 'unmapped' });
  }
  return next;
}

function includeCurrentNamedSources(config: SettingsConfig, catalogs: Catalogs): SettingsConfig {
  const next = structuredClone(config);
  const pairs = next.references.namedPairs ?? [];
  const result = [...pairs];
  for (const [kind] of referenceKinds) {
    for (const item of catalogs.namedReferences[kind]?.sources ?? []) {
      if (result.some((pair) => pair.kind === kind && pair.bitrix24Id === item.source.id)) continue;
      result.push({
        kind,
        bitrix24Id: item.source.id,
        bitrix24Label: item.source.label,
        moyskladId: item.suggestion?.id ?? null,
        moyskladLabel: item.suggestion?.label ?? null,
        status: item.suggestion ? 'suggested' : 'unmapped',
      });
    }
  }
  next.references.namedPairs = result;
  return next;
}

async function loadCatalogPages(headers: Record<string, string>, inspect: (response: Response) => void): Promise<Catalogs> {
  const result: Catalogs = { units: { bitrix24: [], moysklad: [] }, priceTypes: { bitrix24: [], moysklad: [] }, dictionaries: [], namedReferences: {}, productCatalogs: [] };
  for (const kind of ['units', 'priceTypes'] as const) {
    for (const system of ['bitrix24', 'moysklad'] as const) {
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ kind, system, ...(cursor ? { cursor } : {}) });
        const response = await fetch(`${endpoint}/catalogs?${query.toString()}`, { headers });
        inspect(response);
        if (!response.ok) throw new Error('Не удалось загрузить полный каталог справочника');
        const page = await response.json() as { items: Catalogs[typeof kind][typeof system]; nextCursor: string | null };
        result[kind][system].push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
    }
  }
  const metaResponse = await fetch(`${endpoint}/catalogs`, { headers });
  inspect(metaResponse);
  if (!metaResponse.ok) throw new Error('Не удалось загрузить метаданные справочников');
  const metadata = await metaResponse.json() as Catalogs;
  result.dictionaries = metadata.dictionaries;
  result.namedReferences = metadata.namedReferences;
  result.productCatalogs = metadata.productCatalogs ?? [];
  return result;
}
