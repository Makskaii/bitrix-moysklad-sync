import React, { useEffect, useState } from 'react';

type Overview = { mode: string; queue: Record<string, number>; openManualReviews: number; openPairReviews: number; activePairs: number };
type AuditEntry = { id: string; actorId: string; action: string; targetType: string; targetId: string | null; reason: string | null; before: unknown; after: unknown; occurredAt: string };
type Page = { entries: AuditEntry[]; nextCursor: string | null };

export function AdminAuditPage({ accessToken, onForbidden, onError }: { accessToken: string; onForbidden: () => void; onError: (message: string) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [page, setPage] = useState<Page>({ entries: [], nextCursor: null });
  const [actorFilter, setActorFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [targetFilter, setTargetFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  async function load(cursor?: string, append = false) {
    setBusy(true);
    try {
      const headers: Record<string, string> = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
      const params = new URLSearchParams({ limit: '50' });
      if (actorFilter.trim()) params.set('actorId', actorFilter.trim());
      if (actionFilter.trim()) params.set('action', actionFilter.trim());
      if (targetFilter.trim()) params.set('targetType', targetFilter.trim());
      if (cursor) params.set('cursor', cursor);
      const [overviewResponse, auditResponse] = await Promise.all([
        fetch('/api/admin/overview', { headers }),
        fetch(`/api/admin/audit?${params}`, { headers }),
      ]);
      if (overviewResponse.status === 403 || auditResponse.status === 403) {
        onForbidden();
        return;
      }
      if (!overviewResponse.ok || !auditResponse.ok) throw new Error('Не удалось загрузить обзор и журнал действий');
      setOverview(await overviewResponse.json() as Overview);
      const next = await auditResponse.json() as Page;
      setPage((current) => append ? { entries: [...current.entries, ...next.entries], nextCursor: next.nextCursor } : next);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return <>
    <header className="page-heading"><p className="eyebrow">СОСТОЯНИЕ И АУДИТ</p><h2>Журнал действий</h2><p>Состояние очереди и история административных решений.</p></header>
    <section className="admin-audit-metrics" aria-label="Сводка сервиса">
      <Metric label="Режим" value={loading ? '…' : modeLabel(overview?.mode)} />
      <Metric label="Открытые ручные проверки" value={loading ? '…' : String(overview?.openManualReviews ?? 0)} />
      <Metric label="Несопоставленные пары" value={loading ? '…' : String(overview?.openPairReviews ?? 0)} />
      <Metric label="Активные пары" value={loading ? '…' : String(overview?.activePairs ?? 0)} />
    </section>
    <section className="panel admin-audit-panel" aria-label="Журнал административных изменений">
      <div className="panel-heading"><div><p className="eyebrow">АУДИТ · БЕЗ СЕКРЕТОВ</p><h3>Изменения и решения</h3></div><button type="button" className="refresh-monitoring" disabled={busy} onClick={() => void load()}>Обновить</button></div>
      <form className="audit-filters" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <label>ID администратора<input value={actorFilter} onChange={(event) => setActorFilter(event.target.value)} maxLength={100} /></label>
        <label>Действие<input value={actionFilter} onChange={(event) => setActionFilter(event.target.value)} maxLength={160} /></label>
        <label>Тип записи<input value={targetFilter} onChange={(event) => setTargetFilter(event.target.value)} maxLength={100} /></label>
        <button type="submit" disabled={busy}>Найти</button>
      </form>
      {page.entries.length ? <div className="admin-audit-list">{page.entries.map((entry) => <article key={entry.id}>
        <div className="admin-audit-heading"><div><strong>{actionLabel(entry.action)}</strong><small>{entry.targetType}{entry.targetId ? ` · ID ${entry.targetId}` : ''}</small></div><time>{new Date(entry.occurredAt).toLocaleString('ru-RU')}</time></div>
        <p className="admin-audit-actor">Администратор: {entry.actorId === 'LOCAL_PREVIEW' ? 'локальный предпросмотр' : entry.actorId}</p>
        {entry.reason && <p className="admin-audit-reason">Причина: {entry.reason}</p>}
        {(entry.before !== null || entry.after !== null) && <div className="admin-audit-values">
          {entry.before !== null && <ValueBlock label="Было" value={entry.before} />}
          {entry.after !== null && <ValueBlock label="Стало" value={entry.after} />}
        </div>}
      </article>)}</div> : <p className="muted-empty">Записей по выбранному фильтру нет.</p>}
      {page.nextCursor && <button type="button" className="load-more" disabled={busy} onClick={() => void load(page.nextCursor ?? undefined, true)}>Загрузить следующие записи</button>}
    </section>
  </>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <article className="status-card"><span className="card-label">{label}</span><strong>{value}</strong></article>;
}

function ValueBlock({ label, value }: { label: string; value: unknown }) {
  return <div><span>{label}</span><pre>{formatValue(value)}</pre></div>;
}

function formatValue(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? '—'; } catch { return String(value); }
}

function modeLabel(mode?: string): string {
  return mode === 'on' ? 'Включён' : mode === 'pause' ? 'Пауза' : mode === 'off' ? 'Выключен' : 'Неизвестно';
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    MANUAL_REVIEW_RESOLVED: 'Проверка отмечена решённой',
    MANUAL_REVIEW_RETRY: 'Событие отправлено на повтор',
    EVENT_RECOMPUTE_REQUESTED: 'Запрошен повторный расчёт события',
    ENTITY_PAIR_ASSIGNED: 'Создана пара записей',
    ENTITY_PAIR_REASSIGNED: 'Изменена пара записей',
    SERVICE_MODE_CHANGED: 'Изменён режим сервиса',
    ENTITY_DIRECTIONS_CHANGED: 'Изменено направление обмена',
  };
  return labels[action] ?? action;
}
