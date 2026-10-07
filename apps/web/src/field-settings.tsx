import React, { useEffect, useState } from 'react';

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
type SettingsConfig = { rules: FieldRule[]; groups: FieldGroup[]; references: { units: UnitPair[]; priceTypes: PriceTypePair[]; dictionaries: DictionaryMap[] } };
type SettingsDocument = { version: number; createdAt: string; config: SettingsConfig };
type Catalogs = {
  units: { bitrix24: Array<{ id: string; code: string; label: string }>; moysklad: Array<{ id: string; code: string; label: string }> };
  priceTypes: { bitrix24: Array<{ id: string; code: string; label: string }>; moysklad: Array<{ id: string; code: string; label: string }> };
  dictionaries: Array<{ key: string; bitrix24Field: string; bitrix24ListId: string; moyskladAttributeId: string; moyskladDirectoryId: string }>;
};
type PreviewResult = { sourceLabel: string; sourceValues: Record<string, unknown>; transformed: Record<string, { value: unknown; error?: string; transform: string }>; targetCurrent: Record<string, unknown>; errors: string[]; version: number; writes: number };

const endpoint = '/api/admin/field-settings';
const entityOptions = [
  ['contacts-companies', 'Контакты и компании'],
  ['deals-orders', 'Сделки и заказы покупателей'],
  ['smart-invoices', 'Смарт-счета и счета покупателям'],
  ['catalog', 'Товары и услуги каталога'],
] as const;

export function FieldSettingsPage({ accessToken, onForbidden, onError }: {
  accessToken: string;
  onForbidden: () => void;
  onError: (message: string) => void;
}) {
  const [document, setDocument] = useState<SettingsDocument | null>(null);
  const [draft, setDraft] = useState<SettingsConfig | null>(null);
  const [catalogs, setCatalogs] = useState<Catalogs | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSaveWarning, setShowSaveWarning] = useState(false);
  const [previewPairs, setPreviewPairs] = useState('');
  const [previewEntity, setPreviewEntity] = useState('contacts-companies');
  const [previewDirection, setPreviewDirection] = useState<'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24'>('BITRIX24_TO_MOYSKLAD');
  const [previewResults, setPreviewResults] = useState<PreviewResult[]>([]);
  const [previewError, setPreviewError] = useState('');
  const [ruleForm, setRuleForm] = useState({ entity: 'deals-orders', sourceField: '', targetField: '', bitrix24ToMoysklad: false, moyskladToBitrix24: false, forwardTransform: 'tbd', reverseTransform: 'tbd' });
  const [groupForm, setGroupForm] = useState({ entity: 'contacts-companies', direction: 'BITRIX24_TO_MOYSKLAD' as FieldGroup['direction'], targetField: '', sourceFields: '', separator: ' ' });

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
        const [nextDocument, nextCatalogs] = await Promise.all([
          settingsResponse.json() as Promise<SettingsDocument>,
          loadCatalogPages(headers, (response) => { if (response.status === 403) onForbidden(); }),
        ]);
        if (cancelled) return;
        setDocument(nextDocument);
        setDraft(includeCurrentCatalogSources(nextDocument.config, nextCatalogs));
        setCatalogs(nextCatalogs);
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

  function addRule(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || !ruleForm.sourceField.trim() || !ruleForm.targetField.trim() || (!ruleForm.bitrix24ToMoysklad && !ruleForm.moyskladToBitrix24)) return;
    const rule: FieldRule = {
      id: crypto.randomUUID(), entity: ruleForm.entity, sourceField: ruleForm.sourceField.trim(), targetField: ruleForm.targetField.trim(),
      bitrix24ToMoysklad: { enabled: ruleForm.bitrix24ToMoysklad, transform: { kind: ruleForm.bitrix24ToMoysklad ? ruleForm.forwardTransform as Transform['kind'] : 'tbd' } },
      moyskladToBitrix24: { enabled: ruleForm.moyskladToBitrix24, transform: { kind: ruleForm.moyskladToBitrix24 ? ruleForm.reverseTransform as Transform['kind'] : 'tbd' } },
    };
    changeDraft((current) => ({ ...current, rules: [...current.rules, rule] }));
    setRuleForm((current) => ({ ...current, sourceField: '', targetField: '' }));
  }

  function addGroup(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || !groupForm.targetField.trim() || !groupForm.sourceFields.trim()) return;
    const group: FieldGroup = {
      id: crypto.randomUUID(), entity: groupForm.entity, direction: groupForm.direction,
      targetField: groupForm.targetField.trim(), sourceFields: groupForm.sourceFields.split(',').map((field) => field.trim()).filter(Boolean),
      transform: { kind: 'join-non-empty', separator: groupForm.separator },
    };
    changeDraft((current) => ({ ...current, groups: [...current.groups, group] }));
    setGroupForm((current) => ({ ...current, targetField: '', sourceFields: '' }));
  }

  async function preview() {
    if (!draft) return;
    setPreviewError('');
    try {
      const pairs = previewPairs.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const [sourceId, targetId, ...rest] = line.split(',').map((value) => value.trim());
        if (!sourceId || !targetId || rest.length) throw new Error('В каждой строке укажите ID пары: ID Bitrix24, ID МойСклад');
        return { sourceId, targetId };
      });
      if (pairs.length === 0 || pairs.length > 10) throw new Error('Добавьте от 1 до 10 реальных пар записей');
      const response = await fetch(`${endpoint}/preview`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ entity: previewEntity, direction: previewDirection, pairs, config: draft }),
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
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section className="panel field-settings-panel" aria-label="Соответствия полей"><p role="status">Загружаем версию настроек и справочники…</p></section>;
  if (!document || !draft || !catalogs) return <section className="panel field-settings-panel" aria-label="Соответствия полей"><p role="alert">Настройки полей пока недоступны.</p></section>;

  return <>
    <div className="page-heading"><p className="eyebrow">ПРАВИЛА ПЕРЕНОСА</p><h2>Соответствия полей</h2><p>Независимые направления, преобразования и справочные значения хранятся в версиях.</p></div>
    <section className="panel field-settings-panel" aria-label="Редактор соответствий полей">
      <div className="panel-heading"><div><p className="eyebrow">АКТИВНАЯ КОНФИГУРАЦИЯ</p><h3>Версия {document.version}</h3></div><span className="event-status status-succeeded">Новые события используют эту версию</span></div>
      <p className="panel-description">Обычный повтор события использует закреплённую версию. Старые события не пересчитываются автоматически. Для пересчёта нужно отдельно выбрать одно событие в очереди.</p>

      <section className="field-editor-section" aria-label="Правила полей">
        <div className="panel-heading"><div><p className="eyebrow">ПОЛЯ И НАПРАВЛЕНИЯ</p><h3>Правила переноса</h3></div></div>
        <form className="field-rule-form" onSubmit={addRule}>
          <label>Пара сущностей<select aria-label="Пара сущностей поля" value={ruleForm.entity} onChange={(event) => setRuleForm({ ...ruleForm, entity: event.target.value })}>{entityOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Поле Bitrix24<input aria-label="Поле Bitrix24" value={ruleForm.sourceField} onChange={(event) => setRuleForm({ ...ruleForm, sourceField: event.target.value })} /></label>
          <label>Поле МойСклад<input aria-label="Поле МойСклад" value={ruleForm.targetField} onChange={(event) => setRuleForm({ ...ruleForm, targetField: event.target.value })} /></label>
          <fieldset><legend>Bitrix24 → МойСклад</legend><label><input type="checkbox" checked={ruleForm.bitrix24ToMoysklad} onChange={(event) => setRuleForm({ ...ruleForm, bitrix24ToMoysklad: event.target.checked })} /> Включено</label><select aria-label="Преобразование Bitrix24 в МойСклад" value={ruleForm.forwardTransform} onChange={(event) => setRuleForm({ ...ruleForm, forwardTransform: event.target.value })}><option value="tbd">Не задано (TBD)</option><option value="copy">Копировать значение</option></select></fieldset>
          <fieldset><legend>МойСклад → Bitrix24</legend><label><input type="checkbox" checked={ruleForm.moyskladToBitrix24} onChange={(event) => setRuleForm({ ...ruleForm, moyskladToBitrix24: event.target.checked })} /> Включено</label><select aria-label="Преобразование МойСклад в Bitrix24" value={ruleForm.reverseTransform} onChange={(event) => setRuleForm({ ...ruleForm, reverseTransform: event.target.value })}><option value="tbd">Не задано (TBD)</option><option value="copy">Копировать значение</option></select></fieldset>
          <button type="submit" className="button-secondary">Добавить правило</button>
        </form>
        {draft.rules.length ? <div className="field-rule-list">{draft.rules.map((rule) => <article key={rule.id} className="field-rule-row"><div><strong>{rule.sourceField} ↔ {rule.targetField}</strong><small>{entityOptions.find(([key]) => key === rule.entity)?.[1] ?? rule.entity}</small></div><span>{rule.bitrix24ToMoysklad.enabled ? `B24 → МС: ${rule.bitrix24ToMoysklad.transform.kind}` : 'B24 → МС: выключено'}</span><span>{rule.moyskladToBitrix24.enabled ? `МС → B24: ${rule.moyskladToBitrix24.transform.kind}` : 'МС → B24: выключено'}</span><button type="button" className="button-secondary" aria-label={`Удалить правило ${rule.sourceField}`} onClick={() => changeDraft((current) => ({ ...current, rules: current.rules.filter((item) => item.id !== rule.id) }))}>Удалить</button></article>)}</div> : <p className="muted-empty">Пары полей ещё не добавлены. Для неизвестных преобразований оставляйте «Не задано (TBD)».</p>}
      </section>

      <section className="field-editor-section" aria-label="Составные правила">
        <div className="panel-heading"><div><p className="eyebrow">ГРУППЫ ПОЛЕЙ</p><h3>Составное преобразование</h3></div></div>
        <p className="panel-description">Собирайте одно значение из нескольких полей отдельным правилом; пустые части пропускаются.</p>
        <form className="field-rule-form" onSubmit={addGroup}>
          <label>Пара сущностей<select aria-label="Пара сущностей группы" value={groupForm.entity} onChange={(event) => setGroupForm({ ...groupForm, entity: event.target.value })}>{entityOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Направление<select aria-label="Направление группы" value={groupForm.direction} onChange={(event) => setGroupForm({ ...groupForm, direction: event.target.value as FieldGroup['direction'] })}><option value="BITRIX24_TO_MOYSKLAD">Bitrix24 → МойСклад</option><option value="MOYSKLAD_TO_BITRIX24">МойСклад → Bitrix24</option></select></label>
          <label>Поля-источники через запятую<input aria-label="Поля источники группы" value={groupForm.sourceFields} onChange={(event) => setGroupForm({ ...groupForm, sourceFields: event.target.value })} placeholder="LAST_NAME, NAME, SECOND_NAME" /></label>
          <label>Поле-результат<input aria-label="Поле результат группы" value={groupForm.targetField} onChange={(event) => setGroupForm({ ...groupForm, targetField: event.target.value })} /></label>
          <label>Разделитель<input aria-label="Разделитель группы" value={groupForm.separator} onChange={(event) => setGroupForm({ ...groupForm, separator: event.target.value })} /></label>
          <button type="submit" className="button-secondary">Добавить составное правило</button>
        </form>
        {draft.groups.length ? <div className="field-rule-list">{draft.groups.map((group) => <article key={group.id} className="field-rule-row"><div><strong>{group.sourceFields.join(' + ')} → {group.targetField}</strong><small>{group.direction === 'BITRIX24_TO_MOYSKLAD' ? 'Bitrix24 → МойСклад' : 'МойСклад → Bitrix24'} · пропуск пустых частей</small></div><button type="button" className="button-secondary" aria-label={`Удалить группу ${group.targetField}`} onClick={() => changeDraft((current) => ({ ...current, groups: current.groups.filter((item) => item.id !== group.id) }))}>Удалить</button></article>)}</div> : <p className="muted-empty">Составные группы ещё не настроены.</p>}
      </section>

      <section className="field-editor-section" aria-label="Предпросмотр настройки">
        <div className="panel-heading"><div><p className="eyebrow">БЕЗ ЗАПИСИ В СИСТЕМЫ</p><h3>Предпросмотр преобразования</h3></div></div>
        <p className="panel-description">Для каждой выбранной пары сервер читает свежие данные обеих систем и показывает результат и ошибки. Выполняются только GET-чтения; записи и вебхуки не вызываются. Максимум 10 пар за запрос.</p>
        <div className="field-rule-form">
          <label>Пара сущностей<select aria-label="Пара сущностей предпросмотра" value={previewEntity} onChange={(event) => setPreviewEntity(event.target.value)}>{entityOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Направление<select aria-label="Направление предпросмотра" value={previewDirection} onChange={(event) => setPreviewDirection(event.target.value as typeof previewDirection)}><option value="BITRIX24_TO_MOYSKLAD">Bitrix24 → МойСклад</option><option value="MOYSKLAD_TO_BITRIX24">МойСклад → Bitrix24</option></select></label>
        </div>
        <label className="field-preview-input">Пары записей, одна пара на строку<textarea aria-label="Пары записей" rows={3} value={previewPairs} onChange={(event) => setPreviewPairs(event.target.value)} placeholder="ID Bitrix24, ID МойСклад" /></label>
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
        {draft.references.dictionaries.map((dictionary) => <article key={dictionary.key} className="dictionary-map-card">
          <div><strong>{dictionary.key === 'service' ? 'Услуга' : 'Способ оплаты'}</strong><small>Bitrix24 {dictionary.bitrix24Field} · список {dictionary.bitrix24ListId}</small><small>МойСклад атрибут {dictionary.moyskladAttributeId} · справочник {dictionary.moyskladDirectoryId}</small></div>
          <p>{dictionary.pairs.length} сохранённых пар значений · редактируются отдельно от единиц и типов цен</p>
          <div className="dictionary-pairs">{dictionary.pairs.slice(0, 5).map((pair) => <small key={pair.bitrix24Id}>B24 {pair.bitrix24Id} ↔ MS {pair.moyskladId}</small>)}{dictionary.pairs.length > 5 && <small>и ещё {dictionary.pairs.length - 5} пар</small>}</div>
        </article>)}
      </section>

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
