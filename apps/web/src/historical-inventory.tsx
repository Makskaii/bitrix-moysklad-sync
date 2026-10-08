import React, { useCallback, useEffect, useRef, useState } from 'react';

type Candidate = { code: string; title: string; value: string | number | boolean | null; verification: 'UNVERIFIED' | 'DISPLAY ONLY' | null };
type Entry = { source: 'BITRIX24' | 'MOYSKLAD'; externalId: string; label: string | null; fields: Candidate[]; observedAt: string };
type Page = { entries: Entry[]; nextCursor: string | null };
type Status = {
  runId: string | null; status: string; phase: string; bitrixStart: number; moyskladOffset: number;
  bitrixProcessed: number; moyskladProcessed: number; bitrixTotal: number | null; moyskladTotal: number | null;
  bitrixPageSize: number; moyskladPageSize: number; requestIntervalMs: number;
  error: string | null; retryAfter: string | null; checkpointAt: string | null; leaseUntil: string | null; pauseRequested: boolean;
  stats: Array<{ source: string; code: string; empty: number; unique: number; multiple: number }>;
};

export function HistoricalInventoryPage({ accessToken, onError, onForbidden }: { accessToken: string; onError: (message: string) => void; onForbidden: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [b24, setB24] = useState<Entry[]>([]);
  const [moysklad, setMoysklad] = useState<Entry[]>([]);
  const [b24Cursor, setB24Cursor] = useState<string | null>(null);
  const [moyskladCursor, setMoyskladCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<{ BITRIX24: boolean; MOYSKLAD: boolean }>({ BITRIX24: false, MOYSKLAD: false });
  const [pageSize, setPageSize] = useState(500);
  const [intervalMs, setIntervalMs] = useState(1000);
  const [busy, setBusy] = useState(false);
  const forbiddenRef = useRef(onForbidden);
  const statusRequestId = useRef(0);
  const entryRequestId = useRef({ BITRIX24: 0, MOYSKLAD: 0 });
  const appliedRunId = useRef<string | null | undefined>(undefined);
  forbiddenRef.current = onForbidden;

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, {
      ...init,
      headers: { ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...(init?.headers ?? {}) },
    });
    if (response.status === 403) { forbiddenRef.current(); throw new Error('Доступ только для администратора Bitrix24'); }
    if (!response.ok) throw new Error(await response.text().catch(() => 'Ошибка запроса каталога'));
    return response.json() as Promise<any>;
  }, [accessToken]);

  const loadEntries = useCallback(async (source: Entry['source'], cursor: string | null, replace: boolean) => {
    const requestId = ++entryRequestId.current[source];
    const query = new URLSearchParams({ source, ...(cursor ? { cursor } : {}) });
    const page = await request(`/api/admin/historical-inventory/entries?${query}`) as Page;
    if (requestId !== entryRequestId.current[source]) return;
    const updateRows = (current: Entry[]) => {
      if (replace) return page.entries;
      const seen = new Set(current.map((entry) => entry.externalId));
      return [...current, ...page.entries.filter((entry) => !seen.has(entry.externalId))];
    };
    if (source === 'BITRIX24') { setB24(updateRows); setB24Cursor(page.nextCursor); }
    else { setMoysklad(updateRows); setMoyskladCursor(page.nextCursor); }
  }, [request]);

  const refresh = useCallback(async (reloadEntries = false) => {
    const requestId = ++statusRequestId.current;
    const nextStatus = await request('/api/admin/historical-inventory') as Status;
    if (requestId !== statusRequestId.current) return;
    setStatus(nextStatus);
    const runChanged = appliedRunId.current !== nextStatus.runId;
    if (runChanged) {
      appliedRunId.current = nextStatus.runId;
      setB24([]); setMoysklad([]); setB24Cursor(null); setMoyskladCursor(null);
    }
    if (reloadEntries || runChanged) {
      await Promise.all([loadEntries('BITRIX24', null, true), loadEntries('MOYSKLAD', null, true)]);
    }
  }, [loadEntries, request]);

  useEffect(() => {
    void refresh().catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)));
    return () => { statusRequestId.current++; entryRequestId.current.BITRIX24++; entryRequestId.current.MOYSKLAD++; };
  }, [refresh, onError]);
  useEffect(() => {
    if (status?.status !== 'running') return;
    const timer = window.setInterval(() => { void refresh().catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause))); }, 1500);
    return () => window.clearInterval(timer);
  }, [status?.status, refresh, onError]);

  async function start() {
    setBusy(true); onError('');
    try {
      await request('/api/admin/historical-inventory/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken, moyskladPageSize: pageSize, requestIntervalMs: intervalMs }),
      });
      await refresh(true);
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function pause() {
    setBusy(true); onError('');
    try { await request('/api/admin/historical-inventory/pause', { method: 'POST' }); await refresh(true); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function loadMore(source: Entry['source']) {
    const cursor = source === 'BITRIX24' ? b24Cursor : moyskladCursor;
    if (!cursor || loadingMore[source]) return;
    setLoadingMore((current) => ({ ...current, [source]: true }));
    try { await loadEntries(source, cursor, false); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoadingMore((current) => ({ ...current, [source]: false })); }
  }

  const phase = status?.phase === 'BITRIX24' ? 'Bitrix24' : status?.phase === 'MOYSKLAD' ? 'МойСклад' : status?.phase === 'COMPLETE' ? 'завершён' : 'ожидает запуска';
  const leaseActive = status?.status === 'running' && !!status.leaseUntil && new Date(status.leaseUntil).getTime() > Date.now();
  return <section className="panel historical-inventory" aria-label="Исторический каталог">
    <div className="panel-heading"><div><p className="eyebrow">ИСТОРИЧЕСКИЕ ID И CANDIDATE FIELDS</p><h3>Фоновый каталог</h3></div><button className="refresh-monitoring" type="button" onClick={() => void refresh(true).catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))}>Обновить</button></div>
    <p className="inventory-boundary">Каталог собирает ID и ограниченные поля для анализа. Он не создаёт пары или записи, не выбирает кандидатов и не влияет на готовность обмена. Внешние идентификаторы помечены UNVERIFIED и не используются для автоматического сопоставления.</p>
    <div className="inventory-controls">
      <label>Размер страницы МойСклад <input type="number" min={1} max={1000} value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))} disabled={status?.status === 'running'} /></label>
      <label>Интервал запросов, мс <input type="number" min={500} max={60000} step={500} value={intervalMs} onChange={(event) => setIntervalMs(Number(event.target.value))} disabled={status?.status === 'running'} /></label>
      <span>Bitrix24: фиксированно {status?.bitrixPageSize ?? 50} записей на страницу</span>
      {leaseActive
        ? <button type="button" className="inventory-action secondary" disabled={busy} onClick={() => void pause()}>{status?.pauseRequested ? 'Пауза запрошена' : 'Пауза'}</button>
        : <button type="button" className="inventory-action" disabled={busy || status?.status === 'complete'} onClick={() => void start()}>{status?.status === 'complete' ? 'Каталог собран' : status?.status === 'failed' ? 'Продолжить после ошибки' : status?.status === 'paused' ? 'Продолжить' : status?.status === 'running' ? 'Продолжить с checkpoint' : 'Запустить сбор'}</button>}
    </div>
    {status && <div className="inventory-status" role="status">
      <span>Состояние: <strong>{status.status}</strong></span><span>Этап: <strong>{phase}</strong></span>
      <span>Bitrix24: {status.bitrixProcessed}{status.bitrixTotal === null ? '' : ` / ${status.bitrixTotal}`}</span>
      <span>МойСклад: {status.moyskladProcessed}{status.moyskladTotal === null ? '' : ` / ${status.moyskladTotal}`}</span>
      <span>Checkpoint: {status.checkpointAt ? new Date(status.checkpointAt).toLocaleString('ru-RU') : 'ещё не создан'}</span>
      {(status.phase === 'BITRIX24' && status.bitrixStart > 0) && <span>Курсор: Bitrix24 start={status.bitrixStart}</span>}
      {(status.phase === 'MOYSKLAD' && status.moyskladOffset > 0) && <span>Курсор: МойСклад offset={status.moyskladOffset}</span>}
      {status.retryAfter && <span>Повтор после: {new Date(status.retryAfter).toLocaleString('ru-RU')}</span>}
      {status.status === 'running' && !leaseActive && status.leaseUntil && <span>Задача остановлена; checkpoint можно возобновить после {new Date(status.leaseUntil).toLocaleString('ru-RU')}</span>}
      {status.error && <p role="alert" className="error">{status.error}</p>}
    </div>}
    {status?.stats.length ? <div className="inventory-stats"><h4>Покрытие candidate keys</h4><table><thead><tr><th>Поле</th><th>Пустые</th><th>Уникальные</th><th>В повторяющихся группах</th></tr></thead><tbody>{status.stats.map((row) => <tr key={`${row.source}:${row.code}`}><td>{row.source} · <code>{row.code}</code></td><td>{row.empty}</td><td>{row.unique}</td><td>{row.multiple}</td></tr>)}</tbody></table></div> : null}
    <div className="inventory-sides">
      <InventoryTable title="Сделки Bitrix24" entries={b24} hasMore={!!b24Cursor} loading={loadingMore.BITRIX24} onLoadMore={() => void loadMore('BITRIX24')} />
      <InventoryTable title="Заказы покупателей МойСклад" entries={moysklad} hasMore={!!moyskladCursor} loading={loadingMore.MOYSKLAD} onLoadMore={() => void loadMore('MOYSKLAD')} />
    </div>
    <p className="inventory-footnote">Названия полей берутся из метаданных. Если API их не предоставляет, интерфейс явно показывает «недоступно в метаданных». Значения отображаются только в этом административном каталоге и не попадают в журналы.</p>
  </section>;
}

function InventoryTable({ title, entries, hasMore, loading, onLoadMore }: { title: string; entries: Entry[]; hasMore: boolean; loading: boolean; onLoadMore: () => void }) {
  return <section className="inventory-system"><h4>{title}</h4>{entries.length ? entries.map((entry) => <article className="inventory-record" key={entry.externalId}>
    <header><strong>{entry.label || 'Метка записи недоступна'}</strong><small>ID {entry.externalId} · {new Date(entry.observedAt).toLocaleString('ru-RU')}</small></header>
    <div className="inventory-table-scroll"><table><thead><tr><th>Код</th><th>Название из метаданных</th><th>Значение</th><th>Статус</th></tr></thead><tbody>{entry.fields.map((field) => <tr key={field.code}><td><code>{field.code}</code></td><td>{field.title}</td><td className="inventory-value">{field.value === null ? '—' : String(field.value)}</td><td>{field.verification && <span className={`inventory-badge ${field.verification === 'UNVERIFIED' ? 'is-unverified' : 'is-display'}`}>{field.verification}</span>}</td></tr>)}</tbody></table></div>
  </article>) : <p className="empty-state">Записи ещё не собраны.</p>}{hasMore && <button className="load-more" type="button" disabled={loading} onClick={onLoadMore}>{loading ? 'Загрузка…' : `Загрузить следующие: ${title.toLowerCase()}`}</button>}</section>;
}
