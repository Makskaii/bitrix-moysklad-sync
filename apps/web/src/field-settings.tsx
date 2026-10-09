import React, { useEffect, useRef, useState } from 'react';

type Transform = { kind: 'tbd' | 'copy' };
type RuleDirection = { enabled: boolean; transform: Transform };
type FieldRule = {
  id: string;
  entity: string;
  sourceField: string;
  targetField: string;
  bitrix24ToMoysklad: RuleDirection;
  moyskladToBitrix24: RuleDirection;
};
type FieldGroup = {
  id: string;
  entity: string;
  direction: 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24';
  targetField: string;
  sourceFields: string[];
  transform: { kind: 'join-non-empty'; separator: string };
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
type DictionaryOption = { id: string; title: string; code: string };
type FieldCandidate = { code: string; title: string; type: string; writable: boolean | null; category?: 'standard' | 'custom' };
type FieldMetadata = { entity: string; bitrix24: FieldCandidate[]; moysklad: FieldCandidate[] };
type ActiveEntityPair = { id: string; entityType: 'CONTACT' | 'COMPANY' | 'DEAL' | 'PRODUCT'; bitrix24Id: string; moyskladId: string; active: true; source: string; reason: string | null; createdAt: string };
type SettingsConfig = { rules: FieldRule[]; groups: FieldGroup[]; references: { units: UnitPair[]; priceTypes: PriceTypePair[]; dictionaries: DictionaryMap[] } };
type SettingsDocument = { version: number; createdAt: string; config: SettingsConfig };
type Catalogs = {
  units: { bitrix24: Array<{ id: string; code: string; label: string }>; moysklad: Array<{ id: string; code: string; label: string }> };
  priceTypes: { bitrix24: Array<{ id: string; code: string; label: string }>; moysklad: Array<{ id: string; code: string; label: string }> };
  dictionaries: Array<{ key: string; bitrix24Field: string; bitrix24ListId: string; moyskladAttributeId: string; moyskladDirectoryId: string; values?: { bitrix24: DictionaryOption[]; moysklad: DictionaryOption[] } }>;
};
const emptyCatalogs: Catalogs = { units: { bitrix24: [], moysklad: [] }, priceTypes: { bitrix24: [], moysklad: [] }, dictionaries: [] };
type PreviewResult = { pairId: string; sourceLabel: string; sourceValues: Record<string, unknown>; transformed: Record<string, { value: unknown; error?: string; transform: string }>; targetCurrent: Record<string, unknown>; errors: string[]; version: number; writes: number };
type AutoMatch = { source: FieldCandidate; target: FieldCandidate; canBitrix24ToMoysklad: boolean; canMoyskladToBitrix24: boolean };
type AutoMatchBlock = { matches: AutoMatch[]; unmatched: number; conflicts: number };
type AutoMatchSummary = { standard: AutoMatchBlock; custom: AutoMatchBlock };

const endpoint = '/api/admin/field-settings';
const entityOptions = [
  ['contacts', 'Контакты'],
  ['companies', 'Компании'],
  ['deals-orders', 'Сделки и заказы покупателей'],
  ['smart-invoices', 'Смарт-счета (отложено)'],
  ['catalog', 'Товары и услуги каталога'],
] as const;

const deferredEntities = new Set(['smart-invoices']);

function entityTypeForUI(entity: string): ActiveEntityPair['entityType'] | null {
  switch (entity) {
    case 'contacts': return 'CONTACT';
    case 'companies': return 'COMPANY';
    case 'deals-orders': return 'DEAL';
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
  const [groupForm, setGroupForm] = useState({ entity: 'contacts', direction: 'BITRIX24_TO_MOYSKLAD' as FieldGroup['direction'], targetField: '', sourceFields: '', separator: ' ' });

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
          setDraft((current) => current ? includeCurrentCatalogSources(current, nextCatalogs) : current);
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
      bitrix24ToMoysklad: { enabled: true, transform: { kind: 'copy' } },
      moyskladToBitrix24: { enabled: false, transform: { kind: 'tbd' } },
    }] }));
  }

  function addGroup(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || !groupForm.targetField.trim() || !groupForm.sourceFields.trim()) return;
    const group: FieldGroup = {
      id: newLocalId(), entity: groupForm.entity, direction: groupForm.direction,
      targetField: groupForm.targetField.trim(), sourceFields: groupForm.sourceFields.split(',').map((field) => field.trim()).filter(Boolean),
      transform: { kind: 'join-non-empty', separator: groupForm.separator },
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
      saved.moyskladToBitrix24.enabled === rule.moyskladToBitrix24.enabled && saved.moyskladToBitrix24.transform.kind === rule.moyskladToBitrix24.transform.kind);
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
      setDraft(catalogs ? includeCurrentCatalogSources(nextDocument.config, catalogs) : structuredClone(nextDocument.config));
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

  return <>
    <div className="page-heading"><p className="eyebrow">ПРАВИЛА ПЕРЕНОСА</p><h2>Соответствия полей</h2></div>
    <section className="panel field-settings-panel" aria-label="Редактор соответствий полей">
      <div className="field-version-line"><strong>Версия {document.version}</strong><span>Активна для новых событий</span></div>

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
          <label>Пара сущностей<select aria-label="Пара сущностей группы" value={groupForm.entity} onChange={(event) => setGroupForm({ ...groupForm, entity: event.target.value })}>{entityOptions.map(([value, label]) => <option key={value} value={value} disabled={deferredEntities.has(value)}>{label}</option>)}</select></label>
          <label>Направление<select aria-label="Направление группы" value={groupForm.direction} onChange={(event) => setGroupForm({ ...groupForm, direction: event.target.value as FieldGroup['direction'] })}><option value="BITRIX24_TO_MOYSKLAD">Bitrix24 → МойСклад</option><option value="MOYSKLAD_TO_BITRIX24">МойСклад → Bitrix24</option></select></label>
          <label>Поля-источники<select aria-label="Поля источники группы" multiple value={groupForm.sourceFields.split(',').filter(Boolean)} onChange={(event) => setGroupForm({ ...groupForm, sourceFields: [...event.currentTarget.selectedOptions].map((option) => option.value).join(',') })} disabled={!fieldMetadata || fieldMetadata.entity !== groupForm.entity}>{(groupForm.direction === 'BITRIX24_TO_MOYSKLAD' ? fieldMetadata?.bitrix24 : fieldMetadata?.moysklad)?.map((field) => <option key={field.code} value={field.code}>{field.title || 'Название отсутствует'} · {field.code} · {field.type}</option>)}</select></label>
          <label>Поле-результат<select aria-label="Поле результат группы" value={groupForm.targetField} onChange={(event) => setGroupForm({ ...groupForm, targetField: event.target.value })} disabled={!fieldMetadata || fieldMetadata.entity !== groupForm.entity}><option value="">Выберите поле</option>{(groupForm.direction === 'BITRIX24_TO_MOYSKLAD' ? fieldMetadata?.moysklad : fieldMetadata?.bitrix24)?.map((field) => <option key={field.code} value={field.code}>{field.title || 'Название отсутствует'} · {field.code} · {field.type}</option>)}</select></label>
          <label>Разделитель<input aria-label="Разделитель группы" value={groupForm.separator} onChange={(event) => setGroupForm({ ...groupForm, separator: event.target.value })} /></label>
          <button type="submit" className="button-secondary">Добавить составное правило</button>
        </form>
        {draft.groups.length ? <div className="field-rule-list">{draft.groups.map((group) => <article key={group.id} className="field-rule-row"><div><strong>{group.sourceFields.join(' + ')} → {group.targetField}</strong><small>{group.direction === 'BITRIX24_TO_MOYSKLAD' ? 'Bitrix24 → МойСклад' : 'МойСклад → Bitrix24'} · пропуск пустых частей</small></div><button type="button" className="button-secondary" aria-label={`Удалить группу ${group.targetField}`} onClick={() => changeDraft((current) => ({ ...current, groups: current.groups.filter((item) => item.id !== group.id) }))}>Удалить</button></article>)}</div> : <p className="muted-empty">Составные группы ещё не настроены.</p>}
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
      </details>

      <div className="field-save-bar"><p>Сохранение создаёт версию {document.version + 1} и сразу применяется к новым событиям.</p><button type="button" onClick={() => setShowSaveWarning(true)} disabled={saving}>Сохранить новую версию</button></div>
      {showSaveWarning && <div className="field-save-warning" role="alertdialog" aria-label="Предупреждение о настройках">
        <h3>Подтвердите изменение настроек</h3>
        <p>Новая версия начнёт действовать для новых событий. Уже принятые события сохранят прежние правила; обычный повтор не переключает версию. Массового пересчёта не будет.</p>
        <button type="button" onClick={() => void save()} disabled={saving}>{saving ? 'Сохраняем…' : 'Подтвердить и сохранить'}</button>
        <button type="button" className="button-secondary" onClick={() => setShowSaveWarning(false)} disabled={saving}>Отмена</button>
      </div>}
    </section>
  </>;
}

function newLocalId() {
  return globalThis.crypto?.randomUUID?.() ?? `field-rule-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

async function loadCatalogPages(headers: Record<string, string>, inspect: (response: Response) => void): Promise<Catalogs> {
  const result: Catalogs = { units: { bitrix24: [], moysklad: [] }, priceTypes: { bitrix24: [], moysklad: [] }, dictionaries: [] };
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
  result.dictionaries = (await metaResponse.json() as Catalogs).dictionaries;
  return result;
}
