import React, { useCallback, useEffect, useState } from 'react';

type MatchCategory = 'MATCH_READY' | 'UNMATCHED_BITRIX24' | 'UNMATCHED_MOYSKLAD' | 'INVALID_BITRIX24_KEY' | 'INVALID_MOYSKLAD_ID' | 'DUPLICATE_BITRIX24_KEY' | 'ALREADY_PAIRED' | 'PAIR_CONFLICT' | 'APPLIED';
type MatchResult = {
  id: string; sourceSystem: 'BITRIX24' | 'MOYSKLAD'; sourceEntityId: string; linkedEntityId: string | null;
  category: MatchCategory; keyValue: string | null; sourceLabel: string | null; linkedLabel: string | null;
  keyFieldCode: string; keyFieldTitle: string | null; applyStatus: string; pairId: string | null;
};
type MatchingStatus = {
  inventory: { status: string; phase: string; bitrixProcessed: number; bitrixTotal: number | null; moyskladProcessed: number; moyskladTotal: number | null; checkpointAt: string | null; complete: boolean };
  previewFresh: boolean;
  run: null | { id: string; status: string; phase: string; bitrixProcessed: number; bitrixTotal: number; moyskladProcessed: number; moyskladTotal: number; inventoryCheckpointAt: string; counts: Record<string, number>; applyStatus: string; appliedCount: number; error: string | null; applyError: string | null; leaseUntil: string | null };
};
type ResultPage = { runId: string; results: MatchResult[]; nextCursor: string | null };

const categoryLabels: Record<MatchCategory, string> = {
  MATCH_READY: 'Однозначный кандидат',
  UNMATCHED_BITRIX24: 'Сделка без заказа',
  UNMATCHED_MOYSKLAD: 'Заказ без сделки',
  INVALID_BITRIX24_KEY: 'Нет или неверный UUID сделки',
  INVALID_MOYSKLAD_ID: 'Неверный ID заказа',
  DUPLICATE_BITRIX24_KEY: 'Повтор UUID сделки',
  ALREADY_PAIRED: 'Пара уже сохранена',
  PAIR_CONFLICT: 'Сторона занята другой парой',
  APPLIED: 'Пара сохранена',
};
const categoryOptions: Array<{ value: MatchCategory | ''; label: string }> = [
  { value: '', label: 'Все результаты' },
  ...Object.entries(categoryLabels).map(([value, label]) => ({ value: value as MatchCategory, label })),
];

export function HistoricalDealOrderMatchingPage({ accessToken, onError, onForbidden }: { accessToken: string; onError: (message: string) => void; onForbidden: () => void }) {
  const [status, setStatus] = useState<MatchingStatus | null>(null);
  const [category, setCategory] = useState<MatchCategory | ''>('');
  const [results, setResults] = useState<MatchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, { ...init, headers: { authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) } });
    if (response.status === 403) { onForbidden(); throw new Error('Доступ только для администратора Bitrix24'); }
    if (!response.ok) throw new Error((await response.text().catch(() => '')) || 'Не удалось выполнить запрос сопоставления');
    return response.json() as Promise<any>;
  }, [accessToken, onForbidden]);

  const refresh = useCallback(async () => {
    const current = await request('/api/admin/historical-matching/status') as MatchingStatus;
    setStatus(current);
    if (!current.run || current.run.id !== status?.run?.id) {
      setResults([]); setNextCursor(null); setConfirmed(false);
    }
    return current;
  }, [request, status?.run?.id]);

  const loadResults = useCallback(async (cursor?: string, append = false) => {
    const runId = status?.run?.id;
    if (!runId) return;
    const query = new URLSearchParams({ runId, ...(category ? { category } : {}), ...(cursor ? { cursor } : {}) });
    const page = await request(`/api/admin/historical-matching/results?${query}`) as ResultPage;
    setResults((current) => append ? [...current, ...page.results] : page.results);
    setNextCursor(page.nextCursor);
  }, [category, request, status?.run?.id]);

  useEffect(() => { void refresh().catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause))); }, [refresh, onError]);
  useEffect(() => {
    if (status?.run?.status !== 'running' && status?.run?.applyStatus !== 'running') return;
    const timer = window.setInterval(() => { void refresh().catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause))); }, 1500);
    return () => window.clearInterval(timer);
  }, [status?.run?.status, status?.run?.applyStatus, refresh, onError]);
  useEffect(() => { setResults([]); setNextCursor(null); void loadResults().catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause))); }, [category, status?.run?.id, loadResults, onError]);

  async function startPreview() {
    setBusy(true); onError('');
    try { await request('/api/admin/historical-matching/preview', { method: 'POST' }); await refresh(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function applyMatches() {
    if (!status?.run) return;
    setBusy(true); onError('');
    try {
      await request('/api/admin/historical-matching/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: status.run.id, confirmed }) });
      setConfirmed(false); await refresh();
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  const run = status?.run;
  const counts = run?.counts ?? {};
  const matchCount = counts.MATCH_READY ?? 0;
  const leaseActive = !!run?.leaseUntil && new Date(run.leaseUntil).getTime() > Date.now();
  const applyInProgress = run?.applyStatus === 'running' && leaseActive;
  const previewInProgress = run?.status === 'running' && leaseActive;
  const applyAllowed = !!run && run.status === 'complete' && status?.previewFresh === true && (matchCount > 0 || run.applyStatus === 'running' || run.applyStatus === 'failed') && !applyInProgress && !['complete', 'stale'].includes(run.applyStatus);

  return <section className="panel historical-matching" aria-label="Сопоставление исторических сделок и заказов">
    <div className="panel-heading"><div><p className="eyebrow">ИСТОРИЧЕСКИЕ ПАРЫ · DEAL ↔ CUSTOMERORDER</p><h3>Сопоставление сделок и заказов</h3></div><button className="refresh-monitoring" type="button" onClick={() => void refresh().then(() => loadResults()).catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))}>Обновить</button></div>
    <p className="inventory-boundary">Ключ один: точное равенство UUID сделки <code>UF_CRM_1719836973</code> и ID заказа <code>id</code>. Название и номер заказа не подбирают пару. Preview только читает собранный каталог; сохранение пар запускается отдельно и не включает общий обмен.</p>
    <div className="inventory-status">
      <span>Инвентаризация: <strong>{status?.inventory.status ?? 'загрузка…'}</strong></span>
      <span>Сделки: {status?.inventory.bitrixProcessed ?? 0} / {status?.inventory.bitrixTotal ?? '—'}</span>
      <span>Заказы: {status?.inventory.moyskladProcessed ?? 0} / {status?.inventory.moyskladTotal ?? '—'}</span>
      <span>Контрольная точка: {status?.inventory.checkpointAt ? new Date(status.inventory.checkpointAt).toLocaleString('ru-RU') : 'ещё не создана'}</span>
      <button type="button" className="inventory-action" disabled={busy || !status?.inventory.complete || previewInProgress || applyInProgress} onClick={() => void startPreview()}>{previewInProgress ? 'Preview выполняется…' : run?.status === 'running' ? 'Возобновить preview' : 'Запустить preview'}</button>
    </div>
    {run && <>
      <div className="inventory-status" role="status">
        <span>Preview: <strong>{run.status}</strong></span><span>Этап: {run.phase}</span>
        <span>Сделки: {run.bitrixProcessed} / {run.bitrixTotal}</span><span>Заказы: {run.moyskladProcessed} / {run.moyskladTotal}</span>
        <span>Свежесть: {status?.previewFresh ? 'актуальный' : 'требует нового preview'}</span>
        <span>Применено пар: {run.appliedCount}</span>
        {run.error && <p role="alert" className="error">{run.error}</p>}
        {run.applyError && <p role="alert" className="error">{run.applyError}</p>}
      </div>
      <div className="inventory-stats"><h4>Результаты preview</h4><table><thead><tr><th>Категория</th><th>Записей</th></tr></thead><tbody>
        {categoryOptions.filter((option) => option.value).map((option) => <tr key={option.value}><td>{option.label}</td><td>{counts[option.value] ?? 0}</td></tr>)}
      </tbody></table></div>
      <div className="inventory-controls">
        <label>Результаты <select value={category} onChange={(event) => setCategory(event.target.value as MatchCategory | '')}>{categoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        {applyAllowed && <label className="pair-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Подтверждаю сохранение {matchCount} однозначных пар только в базе сервиса.</label>}
        {applyAllowed && <button type="button" className="inventory-action" disabled={!confirmed || busy} onClick={() => void applyMatches()}>{run.applyStatus === 'running' || run.applyStatus === 'failed' ? 'Продолжить сохранение пар' : 'Применить однозначные пары'}</button>}
        {applyInProgress && <span role="status">Сохранение пар выполняется…</span>}
        {run.applyStatus === 'complete' && <strong role="status">Сохранение завершено.</strong>}
      </div>
      <div className="inventory-sides"><section className="inventory-system"><h4>Постраничные результаты</h4>{results.length ? <div className="inventory-table-scroll"><table><thead><tr><th>Статус</th><th>Система</th><th>ID</th><th>Название</th><th>Вторая система · ID</th><th>Название</th><th>Поле и доказательство</th></tr></thead><tbody>{results.map((row) => <tr key={row.id}>
        <td>{categoryLabels[row.category]}</td><td>{row.sourceSystem}</td><td><code>{row.sourceEntityId}</code></td><td>{row.sourceLabel || 'недоступно'}</td>
        <td>{row.linkedEntityId ? <code>{row.linkedEntityId}</code> : '—'}</td><td>{row.linkedLabel || '—'}</td>
        <td><code>{row.keyFieldCode}</code> · {row.keyFieldTitle || 'недоступно в метаданных'}{row.keyValue ? <><br /><small>{row.keyValue}</small></> : null}</td>
      </tr>)}</tbody></table></div> : <p className="empty-state">Записей в этой категории нет.</p>}
        {nextCursor && <button type="button" className="load-more" disabled={loading} onClick={() => { setLoading(true); void loadResults(nextCursor, true).catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause))).finally(() => setLoading(false)); }}>{loading ? 'Загрузка…' : 'Загрузить следующие результаты'}</button>}
      </section></div>
    </>}
  </section>;
}
