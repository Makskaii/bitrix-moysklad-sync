import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type TrialAction = { id: string; message: string; createdAt: string };
type ServiceMode = 'on' | 'pause' | 'off';
type EntityControl = { key: string; label: string; ready: boolean; availability: string; bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean };
type RecoveryStatus = { status: string; provider: string; bitrixStart: number; moyskladOffset: number; error: string | null };
type BitrixAuth = { access_token: string };
type BitrixSdk = { init(callback: () => void): void; getAuth(): BitrixAuth | false };
type QueueEvent = { id: string; source: string; eventType: string | null; externalEntityId: string | null; status: string; receivedAt: string; attempts: number; direction: string | null; lastErrorCategory: string | null };
type QueueSnapshot = { counts: Record<string, number>; events: QueueEvent[]; nextCursor: string | null };
type ReviewCase = { id: string; eventId: string; source: string; externalEntityId: string | null; reason: string; diagnostic: Record<string, string | number | boolean> | null; status: string; openedAt: string };
type OperationalLog = { id: string; category: string; message: string; referenceId: string | null; occurredAt: string };
type ApiAttempt = { id: string; eventId: string | null; provider: string; operation: string; method: string; statusCode: number | null; succeeded: boolean; occurredAt: string };
declare global { interface Window { BX24?: BitrixSdk } }
const trialActionsEndpoint = '/api/admin/trial-actions';
const logCategories = ['EVENT', 'SCHEDULED', 'ERROR', 'ADMIN'] as const;

function App() {
  const [actions, setActions] = useState<TrialAction[]>([]);
  const [message, setMessage] = useState('Проверка контура');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [serviceStatus, setServiceStatus] = useState('Проверяем сервис…');
  const [accessToken, setAccessToken] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [mode, setMode] = useState<ServiceMode>('off');
  const [entities, setEntities] = useState<EntityControl[]>([]);
  const [confirmMode, setConfirmMode] = useState<ServiceMode | null>(null);
  const [confirmDirections, setConfirmDirections] = useState<{ entity: EntityControl; bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean } | null>(null);
  const [recovery, setRecovery] = useState<RecoveryStatus>({ status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null });
  const [monitorView, setMonitorView] = useState<'queue' | 'incidents' | 'logs' | 'api'>('queue');
  const [logCategory, setLogCategory] = useState<typeof logCategories[number]>('EVENT');
  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot>({ counts: {}, events: [], nextCursor: null });
  const [incidents, setIncidents] = useState<ReviewCase[]>([]);
  const [incidentNextCursor, setIncidentNextCursor] = useState<string | null>(null);
  const [logs, setLogs] = useState<OperationalLog[]>([]);
  const [logNextCursor, setLogNextCursor] = useState<string | null>(null);
  const [apiAttempts, setApiAttempts] = useState<ApiAttempt[]>([]);
  const [attemptNextCursor, setAttemptNextCursor] = useState<string | null>(null);

  async function refresh(token = accessToken) {
    const response = await fetch(trialActionsEndpoint, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (response.status === 403) throw new Error('Доступ только для администратора Bitrix24');
    if (!response.ok) throw new Error('Не удалось загрузить пробные действия');
    setActions(await response.json() as TrialAction[]);
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const [modeResponse, entitiesResponse, recoveryResponse] = await Promise.all([
      fetch('/api/admin/sync-mode', { headers }),
      fetch('/api/admin/sync-mode/entities', { headers }),
      fetch('/api/admin/sync-mode/recovery', { headers }),
    ]);
    if (!modeResponse.ok || !entitiesResponse.ok || !recoveryResponse) throw new Error('Не удалось загрузить настройки обмена');
    setMode((await modeResponse.json() as { mode: ServiceMode }).mode);
    setEntities(await entitiesResponse.json() as EntityControl[]);
    setRecovery(await recoveryResponse.json() as RecoveryStatus);
    const [queueResponse, incidentResponse, logsResponse, attemptsResponse] = await Promise.all([
      fetch('/api/admin/monitoring/queue', { headers }),
      fetch('/api/admin/monitoring/incidents?status=OPEN', { headers }),
      fetch(`/api/admin/monitoring/logs?category=${logCategory}`, { headers }),
      fetch('/api/admin/monitoring/api-attempts', { headers }),
    ]);
    if ([queueResponse, incidentResponse, logsResponse, attemptsResponse].some((item) => !item.ok)) throw new Error('Не удалось загрузить мониторинг обмена');
    setQueueSnapshot(await queueResponse.json() as QueueSnapshot);
    const incidentPage = await incidentResponse.json() as { cases: ReviewCase[]; nextCursor: string | null };
    const logPage = await logsResponse.json() as { entries: OperationalLog[]; nextCursor: string | null };
    const attemptPage = await attemptsResponse.json() as { attempts: ApiAttempt[]; nextCursor: string | null };
    setIncidents(incidentPage.cases);
    setIncidentNextCursor(incidentPage.nextCursor);
    setLogs(logPage.entries);
    setLogNextCursor(logPage.nextCursor);
    setApiAttempts(attemptPage.attempts);
    setAttemptNextCursor(attemptPage.nextCursor);
    try {
      const healthResponse = await fetch('/health');
      if (!healthResponse.ok) throw new Error('Сервис недоступен');
      const health = await healthResponse.json() as { status: string; database: string };
      setServiceStatus(health.database === 'ok' ? 'Сервис и база доступны' : 'База недоступна');
    } catch {
      setServiceStatus('Сервис недоступен');
    }
    setAuthorized(true);
  }

  useEffect(() => {
    async function initialize() {
      let localPreview = false;
      try {
        const response = await fetch('/api/admin/preview-mode');
        if (response.ok) {
          const mode = await response.json() as { enabled?: unknown };
          localPreview = mode.enabled === true;
        }
      } catch {
        // If the API is unavailable, continue through normal Bitrix24 initialization.
      }
      if (localPreview) {
        setPreviewMode(true);
        await refresh('');
        return;
      }

      const sdk = window.BX24;
      if (!sdk) {
        setError('Откройте приложение внутри Bitrix24');
        setLoading(false);
        return;
      }
      try {
        sdk.init(() => {
          const auth = sdk.getAuth();
          if (!auth || typeof auth.access_token !== 'string' || !auth.access_token) {
            setError('Не удалось получить авторизацию Bitrix24');
            setLoading(false);
            return;
          }
          setAccessToken(auth.access_token);
          refresh(auth.access_token)
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Проверка доступа не пройдена'))
            .finally(() => setLoading(false));
        });
      } catch {
        setError('Откройте приложение внутри Bitrix24');
        setLoading(false);
      }
    }

    initialize()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Проверка доступа не пройдена'))
      .finally(() => setLoading(false));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const response = await fetch(trialActionsEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ message }),
      });
      if (response.status === 403) {
        setAuthorized(false);
        setAccessToken('');
        setActions([]);
        throw new Error('Доступ только для администратора Bitrix24');
      }
      if (!response.ok) throw new Error('Не удалось сохранить действие');
      setMessage('');
      await refresh(accessToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function saveMode(nextMode: ServiceMode) {
    const response = await fetch('/api/admin/sync-mode', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ mode: nextMode, confirmed: true }),
    });
    if (!response.ok) throw new Error('Не удалось изменить режим обмена');
    setMode((await response.json() as { mode: ServiceMode }).mode);
    setConfirmMode(null);
  }

  async function saveDirections(entity: EntityControl, bitrix24ToMoysklad: boolean, moyskladToBitrix24: boolean) {
    const response = await fetch(`/api/admin/sync-mode/entities/${entity.key}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ bitrix24ToMoysklad, moyskladToBitrix24, confirmed: true }),
    });
    if (!response.ok) throw new Error('Не удалось сохранить направления обмена');
    setEntities((current) => current.map((item) => item.key === entity.key ? { ...item, bitrix24ToMoysklad, moyskladToBitrix24 } : item));
  }

  async function resolveIncident(incidentId: string) {
    const response = await fetch(`/api/admin/monitoring/incidents/${encodeURIComponent(incidentId)}/resolve`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ confirmed: true }),
    });
    if (!response.ok) throw new Error('Не удалось закрыть случай ручной проверки');
    setIncidents((current) => current.filter((incident) => incident.id !== incidentId));
  }

  async function retryIncident(incidentId: string) {
    const response = await fetch(`/api/admin/monitoring/incidents/${encodeURIComponent(incidentId)}/retry`, {
      method: 'POST',
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
    if (!response.ok) throw new Error(response.status === 409 ? 'История события уже недоступна для повтора' : 'Не удалось поставить событие на повтор');
    await refresh();
  }

  async function showLogCategory(category: typeof logCategories[number]) {
    setLogCategory(category);
    const response = await fetch(`/api/admin/monitoring/logs?category=${category}`, {
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
    if (response.ok) {
      const page = await response.json() as { entries: OperationalLog[]; nextCursor: string | null };
      setLogs(page.entries);
      setLogNextCursor(page.nextCursor);
    }
  }

  async function loadMore(kind: 'queue' | 'incidents' | 'logs' | 'api') {
    const headers: Record<string, string> = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
    const cursor = kind === 'queue' ? queueSnapshot.nextCursor : kind === 'incidents' ? incidentNextCursor : kind === 'logs' ? logNextCursor : attemptNextCursor;
    if (!cursor) return;
    const endpoint = kind === 'queue' ? `/api/admin/monitoring/queue?cursor=${encodeURIComponent(cursor)}`
      : kind === 'incidents' ? `/api/admin/monitoring/incidents?status=OPEN&cursor=${encodeURIComponent(cursor)}`
        : kind === 'logs' ? `/api/admin/monitoring/logs?category=${logCategory}&cursor=${encodeURIComponent(cursor)}`
          : `/api/admin/monitoring/api-attempts?cursor=${encodeURIComponent(cursor)}`;
    const response = await fetch(endpoint, { headers });
    if (!response.ok) throw new Error('Не удалось загрузить следующую страницу мониторинга');
    if (kind === 'queue') {
      const page = await response.json() as QueueSnapshot;
      setQueueSnapshot((current) => ({ ...page, events: [...current.events, ...page.events] }));
    } else if (kind === 'incidents') {
      const page = await response.json() as { cases: ReviewCase[]; nextCursor: string | null };
      setIncidents((current) => [...current, ...page.cases]);
      setIncidentNextCursor(page.nextCursor);
    } else if (kind === 'logs') {
      const page = await response.json() as { entries: OperationalLog[]; nextCursor: string | null };
      setLogs((current) => [...current, ...page.entries]);
      setLogNextCursor(page.nextCursor);
    } else {
      const page = await response.json() as { attempts: ApiAttempt[]; nextCursor: string | null };
      setApiAttempts((current) => [...current, ...page.attempts]);
      setAttemptNextCursor(page.nextCursor);
    }
  }

  return <main>
    {previewMode && <aside className="preview-banner" role="status">Локальный режим просмотра — проверка прав Bitrix24 отключена</aside>}
    <header><div className="mark">↔</div><div><p className="eyebrow">BITRIX24 · АДМИН-ПАНЕЛЬ</p><h1>Контур синхронизации</h1></div><span className="status"><i />{serviceStatus}</span></header>
    <section className="intro"><div><p className="eyebrow">{previewMode ? 'ЛОКАЛЬНЫЙ ПРОСМОТР' : 'ДОСТУП ПО ПРАВАМ BITRIX24'}</p><h2>Управление контуром</h2><p>{previewMode ? 'Пробный экран доступен в локальном режиме просмотра.' : 'Сервер проверяет права текущего пользователя через Bitrix24 при каждом административном запросе.'}</p></div><div className="flow"><span>Bitrix24</span><b>→</b><span>API</span><b>→</b><span>PostgreSQL</span></div></section>
    {authorized ? <section className="workspace">
      <section className="card monitoring" aria-label="Мониторинг обмена">
        <div className="records-head"><div><p className="eyebrow">ОЧЕРЕДЬ · ИНЦИДЕНТЫ · ЖУРНАЛЫ</p><h3>Мониторинг обмена</h3></div><button className="refresh-monitoring" type="button" onClick={() => void refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Обновить</button></div>
        <nav className="monitor-tabs" aria-label="Раздел мониторинга">
          {([['queue', 'Очередь'], ['incidents', `Ручная проверка · ${incidents.length}`], ['logs', 'Журналы'], ['api', 'История API']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={monitorView === key} onClick={() => setMonitorView(key)}>{label}</button>)}
        </nav>
        {monitorView === 'queue' && <>
          <div className="status-counts">{Object.entries(queueSnapshot.counts).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => <span key={status}><strong>{count}</strong> {status}</span>)}</div>
          {queueSnapshot.events.length ? <><div className="monitor-list">{queueSnapshot.events.map((event) => <article key={event.id}><div><strong>{event.eventType ?? event.source}</strong><small>{event.source} · {event.externalEntityId ? `ID ${event.externalEntityId}` : 'без ID'} · {new Date(event.receivedAt).toLocaleString('ru-RU')}</small></div><span className={`event-status status-${event.status.toLowerCase()}`}>{event.status}</span><small>Попыток: {event.attempts}{event.lastErrorCategory ? ` · ${event.lastErrorCategory}` : ''}</small></article>)}</div>{queueSnapshot.nextCursor && <button className="load-more" type="button" onClick={() => void loadMore('queue').catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Загрузить следующие события</button>}</> : <p className="empty">Очередь пуста.</p>}
        </>}
        {monitorView === 'incidents' && (incidents.length ? <><div className="monitor-list">{incidents.map((incident) => <article key={incident.id}><div><strong>{incident.reason}</strong><small>{incident.source} · {incident.externalEntityId ? `ID ${incident.externalEntityId}` : 'без ID'} · событие {incident.eventId}</small>{incident.diagnostic && <small>Диагностика: {Object.entries(incident.diagnostic).map(([key, value]) => `${key}=${value}`).join(' · ')}</small>}<small>{new Date(incident.openedAt).toLocaleString('ru-RU')}</small></div><div className="incident-actions"><button type="button" className="resolve-incident" onClick={() => void retryIncident(incident.id).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Повторить</button><button type="button" className="resolve-incident" onClick={() => void resolveIncident(incident.id).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Отметить решённым</button></div></article>)}</div>{incidentNextCursor && <button className="load-more" type="button" onClick={() => void loadMore('incidents').catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Загрузить следующие случаи</button>}</> : <p className="empty">Открытых случаев ручной проверки нет.</p>)}
        {monitorView === 'logs' && <><div className="log-tabs">{logCategories.map((category) => <button key={category} type="button" aria-pressed={logCategory === category} onClick={() => void showLogCategory(category)}>{category}</button>)}</div>{logs.length ? <><div className="monitor-list">{logs.map((entry) => <article key={entry.id}><div><strong>{entry.message}</strong><small>{new Date(entry.occurredAt).toLocaleString('ru-RU')}{entry.referenceId ? ` · ${entry.referenceId}` : ''}</small></div><span className="event-status">{entry.category}</span></article>)}</div>{logNextCursor && <button className="load-more" type="button" onClick={() => void loadMore('logs').catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Загрузить следующие записи</button>}</> : <p className="empty">Записей в этой категории пока нет.</p>}</>}
        {monitorView === 'api' && (apiAttempts.length ? <><div className="monitor-list">{apiAttempts.map((attempt) => <article key={attempt.id}><div><strong>{attempt.provider} · {attempt.operation}</strong><small>{attempt.method} · {new Date(attempt.occurredAt).toLocaleString('ru-RU')}{attempt.eventId ? ` · событие ${attempt.eventId}` : ''}</small></div><span className={`event-status ${attempt.succeeded ? 'status-succeeded' : 'status-manual_review'}`}>{attempt.statusCode ?? 'ошибка сети'} · {attempt.succeeded ? 'OK' : 'ошибка'}</span></article>)}</div>{attemptNextCursor && <button className="load-more" type="button" onClick={() => void loadMore('api').catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Загрузить следующие вызовы</button>}</> : <p className="empty">История вызовов API пуста.</p>)}
        {error && <p role="alert" className="error">{error}</p>}
      </section>
      <section className="card sync-settings" aria-label="Настройки обмена">
        <p className="eyebrow">РЕЖИМ И НАПРАВЛЕНИЯ</p><h3>Обмен данными</h3>
        <p className="mode-value">Текущий режим: <strong>{mode === 'on' ? 'Включён' : mode === 'pause' ? 'Пауза' : 'Выключен'}</strong></p>
        {recovery.status !== 'idle' && <p className="mode-value" role="status">Поиск изменений: <strong>{recovery.status}</strong>{recovery.status === 'running' ? ` · ${recovery.provider === 'BITRIX24' ? `Bitrix24 с записи ${recovery.bitrixStart}` : `МойСклад со смещения ${recovery.moyskladOffset}`}` : ''}{recovery.error ? ` · ${recovery.error}` : ''}</p>}
        <div className="mode-buttons">
          {(['on', 'pause', 'off'] as const).map((nextMode) => <button key={nextMode} type="button" aria-label={`Выбрать режим ${nextMode}`} aria-pressed={mode === nextMode} disabled={mode === nextMode} onClick={() => setConfirmMode(nextMode)}>{nextMode === 'on' ? 'Включить' : nextMode === 'pause' ? 'Пауза' : 'Выключить'}</button>)}
        </div>
        {confirmMode && <div role="alertdialog" aria-labelledby="mode-warning-title" aria-describedby="mode-warning-text" className="mode-warning">
          <h4 id="mode-warning-title">Подтвердите изменение режима</h4>
          <p id="mode-warning-text">{confirmMode === 'on' ? 'Включение разрешит обработку событий и обмен согласно доступным направлениям.' : confirmMode === 'pause' ? 'Пауза остановит обработку; принятые события будут сохранены до возобновления.' : 'Выключение остановит приём событий; после возобновления будет выполнен поиск изменений с сохранённого курсора.'}</p>
          <button type="button" onClick={() => void saveMode(confirmMode).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Подтвердить</button>
          <button type="button" onClick={() => setConfirmMode(null)}>Отмена</button>
        </div>}
        <div className="entity-settings">{entities.map((entity) => <article key={entity.key} className="entity-row">
          <h4>{entity.label}</h4><span>{entity.ready ? 'Частично готово' : 'Недоступно'}</span><p>{entity.availability}</p>
          <label><input type="checkbox" checked={entity.ready && entity.bitrix24ToMoysklad} disabled={!entity.ready} onChange={(event) => setConfirmDirections({ entity, bitrix24ToMoysklad: event.target.checked, moyskladToBitrix24: entity.moyskladToBitrix24 })} /> Bitrix24 → МойСклад</label>
          <label><input type="checkbox" checked={entity.ready && entity.moyskladToBitrix24} disabled={!entity.ready} onChange={(event) => setConfirmDirections({ entity, bitrix24ToMoysklad: entity.bitrix24ToMoysklad, moyskladToBitrix24: event.target.checked })} /> МойСклад → Bitrix24</label>
        </article>)}</div>
        {confirmDirections && <div role="alertdialog" aria-label="Подтвердите изменение направления" className="mode-warning">
          <h4>Подтвердите изменение направления</h4>
          <p>Изменение направления повлияет на обработку новых событий для этой сущности.</p>
          <button type="button" onClick={() => void saveDirections(confirmDirections.entity, confirmDirections.bitrix24ToMoysklad, confirmDirections.moyskladToBitrix24).then(() => setConfirmDirections(null)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Подтвердить</button>
          <button type="button" onClick={() => setConfirmDirections(null)}>Отмена</button>
        </div>}
        {error && <p role="alert" className="error">{error}</p>}
      </section>
      <form onSubmit={submit} className="card form"><p className="eyebrow">ПРОБНОЕ ДЕЙСТВИЕ</p><h3>Добавить запись</h3><label htmlFor="message">Сообщение</label><input id="message" value={message} maxLength={200} onChange={(event) => setMessage(event.target.value)} placeholder="Например: проверка запуска" required /><button disabled={!message.trim() || (!accessToken && !previewMode) || loading} type="submit">Сохранить в базу <span>→</span></button>{error && <p role="alert" className="error">{error}</p>}</form>
      <section className="card records"><div className="records-head"><div><p className="eyebrow">POSTGRESQL</p><h3>Сохранённые действия</h3></div><span className="count">{actions.length}</span></div>{loading ? <p className="empty">Загружаем записи…</p> : actions.length === 0 ? <p className="empty">Пока пусто. Добавьте первую пробную запись.</p> : <ul>{actions.map((action) => <li key={action.id}><span className="record-icon">✓</span><span className="record-copy"><strong>{action.message}</strong><small>{new Date(action.createdAt).toLocaleString('ru-RU')}</small></span></li>)}</ul>}</section>
    </section> : <section className="card access-state"><h3>{loading ? 'Проверяем доступ…' : 'Доступ закрыт'}</h3>{error && <p role="alert" className="error">{error}</p>}</section>}
    <footer><span>Все данные остаются в локальной базе</span><span>PostgreSQL · Prisma · NestJS</span></footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
