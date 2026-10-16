import React, { useCallback, useEffect, useState } from 'react';

type MappingStatus = {
  status: string;
  phase: string;
  bitrix24CompanyProcessed: number;
  bitrix24ContactProcessed: number;
  moyskladCounterpartyProcessed: number;
  moyskladContactpersonProcessed: number;
  attempts: number;
  error: string | null;
  checkpointAt: string | null;
};
type InventorySystem = 'BITRIX24' | 'MOYSKLAD';
type UnmatchedRow = { system: InventorySystem; entityType: 'COMPANY' | 'CONTACT'; nativeType: string; externalId: string; matchValue: string | null; displayLabel: string | null; parentId: string | null; reason: string | null; observedAt: string };

const reasons: Record<string, string> = {
  UUID_MISSING: 'В поле UUID нет значения',
  UUID_REPEATED: 'UUID повторяется в Bitrix24',
  NO_CANDIDATE: 'Запись с таким UUID в МойСклад не найдена',
  MULTIPLE_CANDIDATES: 'Найдено несколько типов записи с таким ID',
  CONFLICTING_ACTIVE_PAIR: 'Запись уже связана с другой активной парой',
  INCOMPLETE_VERIFICATION: 'Проверка инвентаризации не завершена',
  NO_SOURCE_UUID_MATCH: 'Ни один UUID Bitrix24 не указывает на этот ID МойСклад',
  SOURCE_ALREADY_PAIRED: 'Источник уже связан с другой подтверждённой парой',
  ENTITY_TYPE_MISMATCH: 'Тип контрагента не соответствует сущности: компания или физическое лицо',
};

export function ClientMappingPage({ accessToken, onError, onForbidden }: {
  accessToken: string;
  onError: (message: string) => void;
  onForbidden: () => void;
}) {
  const [status, setStatus] = useState<MappingStatus | null>(null);
  const [rows, setRows] = useState<UnmatchedRow[]>([]);
  const [systemFilter, setSystemFilter] = useState<InventorySystem | 'ALL'>('ALL');
  const [entityFilter, setEntityFilter] = useState<'COMPANY' | 'CONTACT' | 'ALL'>('ALL');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (reset = true, cursor?: string | null) => {
    const headers = { authorization: `Bearer ${accessToken}` };
    const query = new URLSearchParams();
    if (systemFilter !== 'ALL') query.set('system', systemFilter);
    if (entityFilter !== 'ALL') query.set('entityType', entityFilter);
    if (!reset && cursor) query.set('cursor', cursor);
    const [statusResponse, rowsResponse] = await Promise.all([
      fetch('/api/admin/client-mapping', { headers }),
      fetch(`/api/admin/client-mapping/unmatched?${query}`, { headers }),
    ]);
    if (statusResponse.status === 403 || rowsResponse.status === 403) { onForbidden(); return; }
    if (!statusResponse.ok || !rowsResponse.ok) throw new Error('Не удалось загрузить карту клиентов');
    setStatus(await statusResponse.json() as MappingStatus);
    const page = await rowsResponse.json() as { entries: UnmatchedRow[]; nextCursor: string | null };
    setRows((current) => reset ? page.entries : [...current, ...page.entries]);
    setNextCursor(page.nextCursor);
  }, [accessToken, entityFilter, onForbidden, systemFilter]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try { if (!cancelled) await load(); } catch (error) { if (!cancelled) onError(error instanceof Error ? error.message : 'Не удалось загрузить карту клиентов'); }
    };
    void refresh();
    const timer = window.setInterval(() => { if (status?.status === 'running') void refresh(); }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [load, onError, status?.status]);

  async function action(kind: 'start' | 'pause') {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/client-mapping/${kind}`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: '{}' });
      if (response.status === 403) { onForbidden(); return; }
      if (!response.ok) throw new Error('Не удалось выполнить операцию с картой клиентов');
      await load();
    } catch (error) { onError(error instanceof Error ? error.message : 'Не удалось выполнить операцию'); }
    finally { setBusy(false); }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try { await load(false, nextCursor); }
    catch (error) { onError(error instanceof Error ? error.message : 'Не удалось загрузить следующую страницу'); }
    finally { setLoadingMore(false); }
  }

  const progress = status ? status.bitrix24CompanyProcessed + status.bitrix24ContactProcessed + status.moyskladCounterpartyProcessed + status.moyskladContactpersonProcessed : 0;
  return <>
    <header className="page-heading"><p className="eyebrow">КОМПАНИИ И КОНТАКТЫ</p><h2>Первичная карта клиентов</h2><p>Инвентаризация читает ID, UUID и доступные названия записей любого возраста. Она не изменяет карточки в Bitrix24 или МойСклад и не запускает перенос исторических документов.</p></header>
    <section className="panel">
      <div className="panel-heading"><div><p className="eyebrow">ВОЗОБНОВЛЯЕМЫЙ ПРОЦЕСС</p><h3>Состояние карты</h3></div><span className="availability-tag">{status?.status ?? 'Загрузка'}</span></div>
      <p className="panel-description">Этап: {phaseLabel(status?.phase)} · записей проверено: {progress.toLocaleString('ru-RU')}</p>
      {status?.error && <p className="inline-error">Последняя ошибка: {status.error}. Чекпойнт сохранён; запуск продолжит с него.</p>}
      <div className="trial-input-row" style={{ marginTop: 14 }}>
        <button disabled={busy || status?.status === 'running' || status?.status === 'complete'} onClick={() => void action('start')}>Продолжить инвентаризацию</button>
        <button disabled={busy || status?.status !== 'running'} onClick={() => void action('pause')}>Приостановить</button>
      </div>
      {status?.checkpointAt && <p className="muted-empty">Последний чекпойнт: {new Date(status.checkpointAt).toLocaleString('ru-RU')}</p>}
    </section>
    <section className="panel">
      <div className="panel-heading"><div><p className="eyebrow">ТРЕБУЮТ РАЗБОРА</p><h3>Несопоставленные записи</h3></div><span className="availability-tag">Показано: {rows.length}</span></div>
      <div className="trial-input-row">
        <label>Система<select value={systemFilter} onChange={(event) => setSystemFilter(event.target.value as InventorySystem | 'ALL')}><option value="ALL">Обе системы</option><option value="BITRIX24">Bitrix24</option><option value="MOYSKLAD">МойСклад</option></select></label>
        <label>Запись<select value={entityFilter} onChange={(event) => setEntityFilter(event.target.value as 'COMPANY' | 'CONTACT' | 'ALL')}><option value="ALL">Все типы</option><option value="COMPANY">Компании</option><option value="CONTACT">Контакты</option></select></label>
      </div>
      {!rows.length ? <p className="muted-empty">После завершения инвентаризации здесь появятся записи с причиной.</p> : <div className="pair-list">{rows.map((row) => <article className="pair-card" key={`${row.system}:${row.entityType}:${row.externalId}`}>
        <div><strong>{row.displayLabel ?? 'Название не получено из проверенного источника'}</strong><p className="panel-description">{row.system === 'BITRIX24' ? 'Bitrix24' : 'МойСклад'} · {row.entityType === 'COMPANY' ? 'Компания' : 'Контакт'} · {nativeTypeLabel(row.nativeType)} · ID {row.externalId}</p>{row.parentId && <p className="panel-description">Родительский контрагент · ID {row.parentId}</p>}<p className="panel-description">{reasons[row.reason ?? ''] ?? row.reason ?? 'Причина не указана'}{row.matchValue ? ` · UUID: ${row.matchValue}` : ''}</p></div>
        <span className="availability-tag">Несопоставлено</span>
      </article>)}</div>}
      {nextCursor && <button type="button" className="refresh-monitoring" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Загрузка…' : 'Загрузить ещё'}</button>}
    </section>
  </>;
}

function nativeTypeLabel(value: string) {
  switch (value) {
    case 'company': return 'компания';
    case 'contact': return 'контакт';
    case 'counterparty': return 'контрагент';
    case 'contactperson': return 'контактное лицо';
    default: return value;
  }
}

function phaseLabel(value?: string) {
  switch (value) {
    case 'BITRIX24_COMPANIES': return 'Компании Bitrix24';
    case 'BITRIX24_CONTACTS': return 'Контакты Bitrix24';
    case 'MOYSKLAD_COUNTERPARTIES': return 'Контрагенты МойСклад';
    case 'MOYSKLAD_CONTACTPERSONS': return 'Контактные лица МойСклад';
    case 'RECONCILE': return 'Построение пар';
    case 'COMPLETE': return 'Завершено';
    default: return 'Неизвестно';
  }
}
