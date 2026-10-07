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
type AdminSection = 'overview' | 'queue' | 'pairs' | 'review' | 'settings' | 'dictionaries' | 'fields' | 'logs';
declare global { interface Window { BX24?: BitrixSdk } }

const trialActionsEndpoint = '/api/admin/trial-actions';
const logCategories = ['EVENT', 'SCHEDULED', 'ERROR', 'ADMIN'] as const;
const sections: { id: AdminSection; label: string; icon: string }[] = [
  { id: 'overview', label: 'Обзор', icon: '⌂' },
  { id: 'queue', label: 'Очередь и попытки', icon: '≡' },
  { id: 'pairs', label: 'Связи записей', icon: '↔' },
  { id: 'review', label: 'Ручная проверка', icon: '!' },
  { id: 'settings', label: 'Настройки', icon: '⚙' },
  { id: 'dictionaries', label: 'Справочники', icon: '▦' },
  { id: 'fields', label: 'Соответствия полей', icon: '⇄' },
  { id: 'logs', label: 'Логи', icon: '▤' },
];

function App() {
  const [actions, setActions] = useState<TrialAction[]>([]);
  const [message, setMessage] = useState('Проверка контура');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [serviceStatus, setServiceStatus] = useState('Проверяем API и базу…');
  const [accessToken, setAccessToken] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [activeSection, setActiveSection] = useState<AdminSection>('overview');
  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot>({ counts: {}, events: [], nextCursor: null });
  const [incidents, setIncidents] = useState<ReviewCase[]>([]);
  const [incidentNextCursor, setIncidentNextCursor] = useState<string | null>(null);
  const [logs, setLogs] = useState<OperationalLog[]>([]);
  const [logNextCursor, setLogNextCursor] = useState<string | null>(null);
  const [apiAttempts, setApiAttempts] = useState<ApiAttempt[]>([]);
  const [attemptNextCursor, setAttemptNextCursor] = useState<string | null>(null);
  const [logCategory, setLogCategory] = useState<typeof logCategories[number]>('EVENT');
  const [mode, setMode] = useState<ServiceMode>('off');
  const [entities, setEntities] = useState<EntityControl[]>([]);
  const [confirmMode, setConfirmMode] = useState<ServiceMode | null>(null);
  const [confirmDirections, setConfirmDirections] = useState<{ entity: EntityControl; bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean } | null>(null);
  const [recovery, setRecovery] = useState<RecoveryStatus>({ status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null });

  function denyAdminAccess() {
    setAuthorized(false);
    setAccessToken('');
    setActions([]);
    setEntities([]);
    setConfirmMode(null);
    setConfirmDirections(null);
    setError('Доступ только для администратора Bitrix24');
  }

  function handleForbidden(response: Response) {
    if (response.status !== 403) return;
    denyAdminAccess();
    throw new Error('Доступ только для администратора Bitrix24');
  }

  async function refresh(token = accessToken) {
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const [actionsResponse, modeResponse, entitiesResponse, recoveryResponse] = await Promise.all([
      fetch(trialActionsEndpoint, { headers }),
      fetch('/api/admin/sync-mode', { headers }),
      fetch('/api/admin/sync-mode/entities', { headers }),
      fetch('/api/admin/sync-mode/recovery', { headers }),
    ]);
    if ([actionsResponse, modeResponse, entitiesResponse, recoveryResponse].some((response) => response.status === 403)) {
      denyAdminAccess();
      throw new Error('Доступ только для администратора Bitrix24');
    }
    if (!actionsResponse.ok || !modeResponse.ok || !entitiesResponse.ok || !recoveryResponse.ok) {
      throw new Error('Не удалось загрузить состояние админки');
    }

    setActions(await actionsResponse.json() as TrialAction[]);
    setMode((await modeResponse.json() as { mode: ServiceMode }).mode);
    setEntities(await entitiesResponse.json() as EntityControl[]);
    setRecovery(await recoveryResponse.json() as RecoveryStatus);
    const [queueResponse, incidentResponse, logResponse, attemptResponse] = await Promise.all([
      fetch('/api/admin/monitoring/queue', { headers }),
      fetch('/api/admin/monitoring/incidents?status=OPEN', { headers }),
      fetch(`/api/admin/monitoring/logs?category=${logCategory}`, { headers }),
      fetch('/api/admin/monitoring/api-attempts', { headers }),
    ]);
    if ([queueResponse, incidentResponse, logResponse, attemptResponse].some((response) => response.status === 403)) {
      denyAdminAccess();
      throw new Error('Доступ только для администратора Bitrix24');
    }
    if ([queueResponse, incidentResponse, logResponse, attemptResponse].some((response) => !response.ok)) throw new Error('Не удалось загрузить мониторинг обмена');
    setQueueSnapshot(await queueResponse.json() as QueueSnapshot);
    const incidentPage = await incidentResponse.json() as { cases: ReviewCase[]; nextCursor: string | null };
    const logPage = await logResponse.json() as { entries: OperationalLog[]; nextCursor: string | null };
    const attemptPage = await attemptResponse.json() as { attempts: ApiAttempt[]; nextCursor: string | null };
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
      setServiceStatus(health.database === 'ok' ? 'API и база доступны' : 'База недоступна');
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
          const preview = await response.json() as { enabled?: unknown };
          localPreview = preview.enabled === true;
        }
      } catch {
        // Normal mode continues through Bitrix24 authentication.
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
      await new Promise<void>((resolve) => {
        sdk.init(() => {
          const auth = sdk.getAuth();
          if (!auth || typeof auth.access_token !== 'string' || !auth.access_token) {
            setError('Не удалось получить авторизацию Bitrix24');
            resolve();
            return;
          }
          setAccessToken(auth.access_token);
          refresh(auth.access_token)
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Проверка доступа не пройдена'))
            .finally(resolve);
        });
      });
    }

    initialize()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Проверка доступа не пройдена'))
      .finally(() => setLoading(false));
  }, []);

  async function submitTrialAction(event: React.FormEvent) {
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
        denyAdminAccess();
        throw new Error('Доступ только для администратора Bitrix24');
      }
      if (!response.ok) throw new Error('Не удалось сохранить пробное действие');
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
    if (response.status === 403) {
      denyAdminAccess();
      throw new Error('Доступ только для администратора Bitrix24');
    }
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
    if (response.status === 403) {
      denyAdminAccess();
      throw new Error('Доступ только для администратора Bitrix24');
    }
    if (!response.ok) throw new Error('Не удалось сохранить направления обмена');
    setEntities((current) => current.map((item) => item.key === entity.key ? { ...item, bitrix24ToMoysklad, moyskladToBitrix24 } : item));
  }

  async function resolveIncident(incidentId: string) {
    const response = await fetch(`/api/admin/monitoring/incidents/${encodeURIComponent(incidentId)}/resolve`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ confirmed: true }),
    });
    handleForbidden(response);
    if (!response.ok) throw new Error('Не удалось закрыть случай ручной проверки');
    setIncidents((current) => current.filter((incident) => incident.id !== incidentId));
  }

  async function retryIncident(incidentId: string) {
    const response = await fetch(`/api/admin/monitoring/incidents/${encodeURIComponent(incidentId)}/retry`, {
      method: 'POST', headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
    handleForbidden(response);
    if (!response.ok) throw new Error(response.status === 409 ? 'История события уже недоступна для повтора' : 'Не удалось поставить событие на повтор');
    await refresh();
  }

  async function showLogCategory(category: typeof logCategories[number]) {
    setLogCategory(category);
    const response = await fetch(`/api/admin/monitoring/logs?category=${category}`, { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
    handleForbidden(response);
    if (!response.ok) throw new Error('Не удалось загрузить журнал');
    const page = await response.json() as { entries: OperationalLog[]; nextCursor: string | null };
    setLogs(page.entries);
    setLogNextCursor(page.nextCursor);
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
    handleForbidden(response);
    if (!response.ok) throw new Error('Не удалось загрузить следующую страницу мониторинга');
    if (kind === 'queue') {
      const page = await response.json() as QueueSnapshot;
      setQueueSnapshot((current) => ({ ...page, events: [...current.events, ...page.events] }));
    } else if (kind === 'incidents') {
      const page = await response.json() as { cases: ReviewCase[]; nextCursor: string | null };
      setIncidents((current) => [...current, ...page.cases]); setIncidentNextCursor(page.nextCursor);
    } else if (kind === 'logs') {
      const page = await response.json() as { entries: OperationalLog[]; nextCursor: string | null };
      setLogs((current) => [...current, ...page.entries]); setLogNextCursor(page.nextCursor);
    } else {
      const page = await response.json() as { attempts: ApiAttempt[]; nextCursor: string | null };
      setApiAttempts((current) => [...current, ...page.attempts]); setAttemptNextCursor(page.nextCursor);
    }
  }

  /* Legacy combined monitor view is replaced by the section-based views below.
  return <main className="app-shell">
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
  */
  return <main className="app-shell">
    {previewMode && <aside className="preview-banner" role="status">Локальный режим просмотра — проверка прав Bitrix24 отключена</aside>}
    <header className="app-header">
      <div className="brand-mark" aria-hidden="true">↔</div>
      <div className="brand-copy"><p className="eyebrow">BITRIX24 · АДМИН-ПАНЕЛЬ</p><h1>Контур синхронизации</h1></div>
      <div className={`service-indicator ${serviceStatus === 'API и база доступны' ? 'is-ready' : ''}`}>
        <i aria-hidden="true" />{serviceStatus}
      </div>
    </header>

    {authorized ? <>
      <section className="welcome-panel">
        <div>
          <p className="eyebrow">{previewMode ? 'ЛОКАЛЬНЫЙ ПРОСМОТР' : 'ДОСТУП ПО ПРАВАМ BITRIX24'}</p>
          <h2>Администрирование обмена</h2>
          <p>{previewMode ? 'Пробный экран доступен в локальном режиме просмотра.' : 'Для каждого административного запроса сервер проверяет права текущего пользователя в Bitrix24.'}</p>
        </div>
      <div className="system-flow" aria-label="Поток данных: Bitrix24, сервис, PostgreSQL">
          <span>Bitrix24</span><b>→</b><span>Сервис</span><b>→</b><span>PostgreSQL</span>
        </div>
      </section>

      <section className="admin-layout">
        <nav className="side-nav" aria-label="Разделы админки">
          <p className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</p>
          {sections.map((section) => <button
            key={section.id}
            type="button"
            className={activeSection === section.id ? 'nav-item is-active' : 'nav-item'}
            aria-current={activeSection === section.id ? 'page' : undefined}
            onClick={() => { setActiveSection(section.id); setError(''); }}
          ><span className="nav-icon" aria-hidden="true">{section.icon}</span>{section.label}
            {section.id === 'fields' && <span className="nav-soon">Скоро</span>}
          </button>)}
          <div className="nav-note"><span className="note-dot" />Доступ администратора подтверждён</div>
        </nav>

        <div className="page-content">
          {activeSection === 'overview' && <Overview mode={mode} recovery={recovery} serviceStatus={serviceStatus} actions={actions} loading={loading} message={message} setMessage={setMessage} submit={submitTrialAction} error={error} />}
          {activeSection === 'queue' && <MonitoringPage kind="queue" queue={queueSnapshot} attempts={apiAttempts} onLoadMore={loadMore} onError={setError} />}
          {activeSection === 'pairs' && <PairManager accessToken={accessToken} onError={setError} onForbidden={denyAdminAccess} />}
          {activeSection === 'review' && <MonitoringPage kind="review" incidents={incidents} incidentNextCursor={incidentNextCursor} onLoadMore={loadMore} onResolve={resolveIncident} onRetry={retryIncident} onError={setError} />}
          {activeSection === 'settings' && <Settings mode={mode} entities={entities} recovery={recovery} confirmMode={confirmMode} setConfirmMode={setConfirmMode} saveMode={saveMode} confirmDirections={confirmDirections} setConfirmDirections={setConfirmDirections} saveDirections={saveDirections} error={error} setError={setError} />}
          {activeSection === 'dictionaries' && <UnavailablePage title="Справочники" eyebrow="СОПОСТАВЛЕНИЯ ЗНАЧЕНИЙ" description="Связи сотрудников, организаций, складов, валют и значений справочников пока не загружаются. Демонстрационные пары не используются." action="Добавить соответствие" />}
          {activeSection === 'fields' && <UnavailablePage title="Соответствия полей" eyebrow="ПРАВИЛА ПЕРЕНОСА" description="Редактор соответствий полей готовится отдельно. На этой странице пока нет фиктивных правил или кнопок сохранения." action="Открыть редактор" badge="Функция в разработке" />}
          {activeSection === 'logs' && <MonitoringPage kind="logs" logs={logs} logCategory={logCategory} onCategory={showLogCategory} logNextCursor={logNextCursor} attempts={apiAttempts} attemptNextCursor={attemptNextCursor} onLoadMore={loadMore} onError={setError} />}
          {error && activeSection !== 'overview' && activeSection !== 'settings' && <p role="alert" className="inline-error">{error}</p>}
        </div>
      </section>
    </> : <section className="access-state" aria-live="polite">
      <span className="access-symbol" aria-hidden="true">{loading ? '…' : '🔒'}</span>
      <h2>{loading ? 'Проверяем доступ…' : 'Доступ закрыт'}</h2>
      {error && <p role="alert">{error}</p>}
    </section>}
    <footer className="app-footer"><span>Синхронизация Bitrix24 ↔ МойСклад</span><span>Интерфейс администратора · Доступ защищён Bitrix24</span></footer>
  </main>;
}

function Overview({ mode, recovery, serviceStatus, actions, loading, message, setMessage, submit, error }: {
  mode: ServiceMode;
  recovery: RecoveryStatus;
  serviceStatus: string;
  actions: TrialAction[];
  loading: boolean;
  message: string;
  setMessage: (value: string) => void;
  submit: (event: React.FormEvent) => void;
  error: string;
}) {
  const modeLabel = mode === 'on' ? 'Включён' : mode === 'pause' ? 'Пауза' : 'Выключен';
  const recoveryLabel = recovery.status === 'idle' ? 'Не запущен' : recovery.status === 'running' ? 'Выполняется' : recovery.status;
  return <>
    <PageHeading eyebrow="ОБЗОР" title="Обзор" subtitle="Текущее состояние сервиса и доступность административных данных." />
    <div className="status-grid">
      <article className="status-card"><span className="card-label">Сервис и база</span><strong className={serviceStatus === 'API и база доступны' ? 'value-positive' : ''}>{serviceStatus}</strong><small>Проверено через /health</small></article>
      <article className="status-card"><span className="card-label">Режим обработки</span><strong>{modeLabel}</strong><small>Фактическое состояние сервиса</small></article>
      <article className="status-card"><span className="card-label">Поиск изменений</span><strong>{recoveryLabel}</strong><small>{recovery.error || (recovery.status === 'idle' ? 'Последний ответ API' : `Источник: ${recovery.provider === 'BITRIX24' ? 'Bitrix24' : 'МойСклад'}`)}</small></article>
    </div>
    <section className="panel metrics-panel">
      <div className="panel-heading"><div><p className="eyebrow">ПОКАЗАТЕЛИ</p><h3>Обмен и данные</h3></div><span className="availability-tag">Часть показателей недоступна</span></div>
      <div className="metric-grid">
        <Metric label="Записи в очереди" />
        <Metric label="Активные пары" />
        <Metric label="Случаи проверки" />
        <Metric label="Последняя операция" />
      </div>
      <p className="honesty-note"><span aria-hidden="true">i</span> Сводные показатели очереди, пар и последней операции пока не подключены. Очередь и случаи ручной проверки доступны в своих разделах.</p>
    </section>
    <section className="panel trial-panel">
      <div className="panel-heading"><div><p className="eyebrow">ЛОКАЛЬНАЯ БАЗА</p><h3>Пробный контур</h3></div><span className="availability-tag is-local">Техническая проверка</span></div>
      <p className="panel-description">Это существующая проверка записи в базу приложения. Она не отправляет изменения в Bitrix24 или МойСклад.</p>
      <form onSubmit={submit} className="trial-form">
        <label htmlFor="message">Сообщение</label>
        <div className="trial-input-row"><input id="message" value={message} maxLength={200} onChange={(event) => setMessage(event.target.value)} placeholder="Например: проверка запуска" required /><button type="submit" disabled={!message.trim() || loading}>Сохранить в базу <span aria-hidden="true">→</span></button></div>
        {error && <p role="alert" className="inline-error">{error}</p>}
      </form>
      <div className="trial-records" aria-label="Сохранённые пробные записи">
        <div className="trial-records-heading"><strong>Сохранённые записи</strong><span>{actions.length}</span></div>
        {loading ? <p className="muted-empty">Загружаем записи…</p> : actions.length === 0 ? <p className="muted-empty">Пробных записей пока нет.</p> : <ul>{actions.map((action) => <li key={action.id}><span>{action.message}</span><time>{new Date(action.createdAt).toLocaleString('ru-RU')}</time></li>)}</ul>}
      </div>
    </section>
  </>;
}

function MonitoringPage({ kind, queue, incidents, incidentNextCursor, logs, logCategory, logNextCursor, attempts, attemptNextCursor, onCategory, onLoadMore, onResolve, onRetry, onError }: {
  kind: 'queue' | 'review' | 'logs';
  queue?: QueueSnapshot;
  incidents?: ReviewCase[];
  incidentNextCursor?: string | null;
  logs?: OperationalLog[];
  logCategory?: typeof logCategories[number];
  logNextCursor?: string | null;
  attempts?: ApiAttempt[];
  attemptNextCursor?: string | null;
  onCategory?: (category: typeof logCategories[number]) => Promise<void>;
  onLoadMore: (kind: 'queue' | 'incidents' | 'logs' | 'api') => Promise<void>;
  onResolve?: (id: string) => Promise<void>;
  onRetry?: (id: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const run = (action: () => Promise<void>) => void action().catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)));
  const headings = {
    queue: ['ОБРАБОТКА СОБЫТИЙ', 'Очередь и попытки'],
    review: ['ТРЕБУЮТ ВНИМАНИЯ', 'Ручная проверка'],
    logs: ['ИСТОРИЯ РАБОТЫ', 'Логи и история API'],
  } as const;
  const [eyebrow, title] = headings[kind];
  return <>
    <PageHeading eyebrow={eyebrow} title={title} subtitle="Данные загружаются из журнала сервиса и доступны с постраничной навигацией." />
    {kind === 'queue' && <>
      <section className="panel monitoring-panel" aria-label="Очередь событий">
        <div className="panel-heading"><div><p className="eyebrow">ТЕКУЩЕЕ СОСТОЯНИЕ</p><h3>События очереди</h3></div></div>
        <div className="metric-grid">{Object.entries(queue?.counts ?? {}).map(([status, count]) => <article className="metric" key={status}><span>{status}</span><strong>{count}</strong></article>)}</div>
        {queue?.events.length ? <div className="monitor-list">{queue.events.map((event) => <article key={event.id}><div><strong>{event.eventType ?? event.source}</strong><small>{event.source} · {event.externalEntityId ? `ID ${event.externalEntityId}` : 'без ID'} · {new Date(event.receivedAt).toLocaleString('ru-RU')}</small></div><span className={`event-status status-${event.status.toLowerCase()}`}>{event.status}</span><small>Попыток: {event.attempts}{event.lastErrorCategory ? ` · ${event.lastErrorCategory}` : ''}</small></article>)}</div> : <p className="muted-empty">Очередь пуста.</p>}
        {queue?.nextCursor && <button className="load-more" type="button" onClick={() => run(() => onLoadMore('queue'))}>Загрузить следующие события</button>}
      </section>
      <ApiAttempts attempts={attempts ?? []} nextCursor={attemptNextCursor} onLoadMore={onLoadMore} onError={onError} />
    </>}
    {kind === 'review' && <section className="panel monitoring-panel" aria-label="Случаи ручной проверки">
      {incidents?.length ? <div className="monitor-list">{incidents.map((incident) => <article key={incident.id}><div><strong>{incident.reason}</strong><small>{incident.source} · {incident.externalEntityId ? `ID ${incident.externalEntityId}` : 'без ID'} · событие {incident.eventId}</small>{incident.diagnostic && <small>Диагностика: {Object.entries(incident.diagnostic).map(([key, value]) => `${key}=${value}`).join(' · ')}</small>}<small>{new Date(incident.openedAt).toLocaleString('ru-RU')}</small></div><div className="incident-actions"><button type="button" className="button-secondary" onClick={() => run(() => onRetry?.(incident.id) ?? Promise.resolve())}>Повторить</button><button type="button" className="button-secondary" onClick={() => run(() => onResolve?.(incident.id) ?? Promise.resolve())}>Отметить решённым</button></div></article>)}</div> : <p className="muted-empty">Открытых случаев ручной проверки нет.</p>}
      {incidentNextCursor && <button className="load-more" type="button" onClick={() => run(() => onLoadMore('incidents'))}>Загрузить следующие случаи</button>}
    </section>}
    {kind === 'logs' && <>
      <section className="panel monitoring-panel" aria-label="Операционные журналы">
        <div className="panel-heading"><div><p className="eyebrow">СОБЫТИЯ И ДЕЙСТВИЯ</p><h3>Операционные журналы</h3></div></div>
        <div className="log-tabs">{logCategories.map((category) => <button key={category} type="button" aria-pressed={logCategory === category} onClick={() => onCategory && run(() => onCategory(category))}>{category}</button>)}</div>
        {logs?.length ? <div className="monitor-list">{logs.map((entry) => <article key={entry.id}><div><strong>{entry.message}</strong><small>{new Date(entry.occurredAt).toLocaleString('ru-RU')}{entry.referenceId ? ` · ${entry.referenceId}` : ''}</small></div><span className="event-status">{entry.category}</span></article>)}</div> : <p className="muted-empty">В этой категории пока нет записей.</p>}
        {logNextCursor && <button className="load-more" type="button" onClick={() => run(() => onLoadMore('logs'))}>Загрузить следующие записи</button>}
      </section>
      <ApiAttempts attempts={attempts ?? []} nextCursor={attemptNextCursor} onLoadMore={onLoadMore} onError={onError} />
    </>}
  </>;
}

function ApiAttempts({ attempts, nextCursor, onLoadMore, onError }: { attempts: ApiAttempt[]; nextCursor?: string | null; onLoadMore: (kind: 'queue' | 'incidents' | 'logs' | 'api') => Promise<void>; onError: (message: string) => void }) {
  return <section className="panel monitoring-panel" aria-label="История вызовов API"><div className="panel-heading"><div><p className="eyebrow">ВНЕШНИЕ СИСТЕМЫ</p><h3>История вызовов API</h3></div></div>
    {attempts.length ? <div className="monitor-list">{attempts.map((attempt) => <article key={attempt.id}><div><strong>{attempt.provider} · {attempt.operation}</strong><small>{attempt.method} · {new Date(attempt.occurredAt).toLocaleString('ru-RU')}{attempt.eventId ? ` · событие ${attempt.eventId}` : ''}</small></div><span className={`event-status ${attempt.succeeded ? 'status-succeeded' : 'status-manual_review'}`}>{attempt.statusCode ?? 'ошибка сети'} · {attempt.succeeded ? 'OK' : 'ошибка'}</span></article>)}</div> : <p className="muted-empty">История вызовов API пуста.</p>}
    {nextCursor && <button className="load-more" type="button" onClick={() => void onLoadMore('api').catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))}>Загрузить следующие вызовы</button>}
  </section>;
}

function Metric({ label }: { label: string }) {
  return <div className="metric"><span>{label}</span><strong aria-label={`${label}: данных нет`}>—</strong><small>Нет достоверных данных</small></div>;
}

function Settings({ mode, entities, recovery, confirmMode, setConfirmMode, saveMode, confirmDirections, setConfirmDirections, saveDirections, error, setError }: {
  mode: ServiceMode;
  entities: EntityControl[];
  recovery: RecoveryStatus;
  confirmMode: ServiceMode | null;
  setConfirmMode: (mode: ServiceMode | null) => void;
  saveMode: (mode: ServiceMode) => Promise<void>;
  confirmDirections: { entity: EntityControl; bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean } | null;
  setConfirmDirections: (value: { entity: EntityControl; bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean } | null) => void;
  saveDirections: (entity: EntityControl, bitrix24ToMoysklad: boolean, moyskladToBitrix24: boolean) => Promise<void>;
  error: string;
  setError: (error: string) => void;
}) {
  return <>
    <PageHeading eyebrow="КОНФИГУРАЦИЯ" title="Настройки сущностей и направлений" subtitle="Состояние сервиса и доступные направления для каждой сущности." />
    <section className="panel settings-panel" aria-label="Настройки обмена">
      <div className="panel-heading"><div><p className="eyebrow">ОБЩЕЕ СОСТОЯНИЕ</p><h3>Режим сервиса</h3></div><span className={`mode-chip mode-${mode}`}>{mode === 'on' ? 'Включён' : mode === 'pause' ? 'Пауза' : 'Выключен'}</span></div>
      {recovery.status !== 'idle' && <p className="recovery-line" role="status">Поиск изменений: <strong>{recovery.status}</strong>{recovery.error ? ` · ${recovery.error}` : ''}</p>}
      <p className="panel-description">Изменение режима требует подтверждения. Переключатели сущностей доступны только для уже настроенных направлений.</p>
      <div className="mode-buttons">
        {(['on', 'pause', 'off'] as const).map((nextMode) => <button key={nextMode} type="button" aria-label={`Выбрать режим ${nextMode}`} aria-pressed={mode === nextMode} disabled={mode === nextMode} onClick={() => setConfirmMode(nextMode)}>{nextMode === 'on' ? 'Включить' : nextMode === 'pause' ? 'Пауза' : 'Выключить'}</button>)}
      </div>
      {confirmMode && <div role="alertdialog" aria-labelledby="mode-warning-title" aria-describedby="mode-warning-text" className="confirm-box">
        <h4 id="mode-warning-title">Подтвердите изменение режима</h4>
        <p id="mode-warning-text">{confirmMode === 'on' ? 'Включение разрешит обработку событий и обмен согласно доступным направлениям.' : confirmMode === 'pause' ? 'Пауза остановит обработку; принятые события будут сохранены до возобновления.' : 'Выключение остановит приём событий; после возобновления будет выполнен поиск изменений с сохранённого курсора.'}</p>
        <button type="button" onClick={() => void saveMode(confirmMode).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Подтвердить</button>
        <button type="button" className="button-secondary" onClick={() => setConfirmMode(null)}>Отмена</button>
      </div>}
      <div className="entity-settings">{entities.map((entity) => <article key={entity.key} className="entity-row">
        <div className="entity-row-heading"><h4>{entity.label}</h4><span className={entity.ready ? 'entity-state is-configured' : 'entity-state'}>{entity.ready ? 'Настроено частично' : 'Недоступно'}</span></div>
        <p>{entity.availability}</p>
        <label><input type="checkbox" checked={entity.ready && entity.bitrix24ToMoysklad} disabled={!entity.ready} onChange={(event) => setConfirmDirections({ entity, bitrix24ToMoysklad: event.target.checked, moyskladToBitrix24: entity.moyskladToBitrix24 })} /> Bitrix24 → МойСклад</label>
        <label><input type="checkbox" checked={entity.ready && entity.moyskladToBitrix24} disabled={!entity.ready} onChange={(event) => setConfirmDirections({ entity, bitrix24ToMoysklad: entity.bitrix24ToMoysklad, moyskladToBitrix24: event.target.checked })} /> МойСклад → Bitrix24</label>
      </article>)}</div>
      {confirmDirections && <div role="alertdialog" aria-label="Подтвердите изменение направления" className="confirm-box">
        <h4>Подтвердите изменение направления</h4>
        <p>Изменение направления повлияет на обработку новых событий для этой сущности.</p>
        <button type="button" onClick={() => void saveDirections(confirmDirections.entity, confirmDirections.bitrix24ToMoysklad, confirmDirections.moyskladToBitrix24).then(() => setConfirmDirections(null)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Подтвердить</button>
        <button type="button" className="button-secondary" onClick={() => setConfirmDirections(null)}>Отмена</button>
      </div>}
      {error && <p role="alert" className="inline-error">{error}</p>}
    </section>
    <p className="security-caption"><span aria-hidden="true">✓</span> Настройки загружаются через защищённые административные запросы Bitrix24.</p>
  </>;
}

function PageHeading({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return <div className="page-heading"><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{subtitle}</p></div>;
}

function UnavailablePage({ title, eyebrow, description, action, badge = 'Пока недоступно' }: { title: string; eyebrow: string; description: string; action: string; badge?: string }) {
  return <>
    <PageHeading eyebrow={eyebrow} title={title} subtitle={description} />
    <section className="panel unavailable-panel">
      <div className="unavailable-icon" aria-hidden="true">· · ·</div>
      <span className="availability-tag">{badge}</span>
      <h3>{title === 'Соответствия полей' ? 'Редактор ещё не подключён' : 'Данные раздела недоступны'}</h3>
      <p>{title === 'Соответствия полей' ? 'Редактор соответствий полей будет реализован отдельно. Текущая страница не заменяет его.' : 'На экране нет демонстрационных записей. Раздел покажет реальные данные после подключения соответствующего хранилища.'}</p>
      <button type="button" disabled>{action}</button>
    </section>
  </>;
}

type PairEntityType = 'CONTACT' | 'COMPANY' | 'DEAL' | 'PRODUCT';
const pairEntityTypes: { id: PairEntityType; label: string }[] = [
  { id: 'CONTACT', label: 'Контакт' },
  { id: 'COMPANY', label: 'Компания' },
  { id: 'DEAL', label: 'Сделка / заказ покупателя' },
  { id: 'PRODUCT', label: 'Товар / модификация' },
];
const pairReviewReasonLabels: Record<string, string> = {
  NO_APPROVED_MATCH_KEY: 'Нет утверждённого ключа для безопасного сопоставления',
  AMBIGUOUS_CANDIDATES: 'Найдено несколько возможных пар',
  INCOMPLETE_EVIDENCE: 'Недостаточно данных для проверки пары',
  PAIR_ALREADY_ASSIGNED: 'Запись уже входит в другую подтверждённую пару',
  PAIR_INACTIVE: 'Ранее сохранённая пара неактивна',
  ENTITY_TYPE_UNSUPPORTED: 'Этот тип записи не поддерживается',
  PAIR_STORE_UNAVAILABLE: 'Хранилище пар временно недоступно',
};
type PairRow = { id: string; entityType: PairEntityType; bitrix24Id: string; moyskladId: string; source: string; reason: string | null; createdAt: string };
type PairReviewRow = { id: string; entityType: PairEntityType; sourceSystem: 'BITRIX24' | 'MOYSKLAD'; sourceEntityId: string; eventId: string | null; reason: string; openedAt: string };

function PairManager({ accessToken, onError, onForbidden }: { accessToken: string; onError: (message: string) => void; onForbidden: () => void }) {
  const [pairs, setPairs] = useState<PairRow[]>([]);
  const [reviews, setReviews] = useState<PairReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    const headers: Record<string, string> = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
    const [pairsResponse, reviewsResponse] = await Promise.all([
      fetch('/api/admin/pairs', { headers }),
      fetch('/api/admin/pairs/reviews', { headers }),
    ]);
    if (pairsResponse.status === 403 || reviewsResponse.status === 403) {
      onForbidden();
      throw new Error('Доступ только для администратора Bitrix24');
    }
    if (!pairsResponse.ok || !reviewsResponse.ok) throw new Error('Не удалось загрузить пары записей');
    setPairs(await pairsResponse.json() as PairRow[]);
    setReviews(await reviewsResponse.json() as PairReviewRow[]);
  }

  useEffect(() => {
    refresh().catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);

  async function assign(input: { entityType: PairEntityType; bitrix24Id: string; moyskladId: string; replaceExisting: boolean }) {
    setSaving(true);
    try {
      const response = await fetch('/api/admin/pairs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify(input),
      });
      if (response.status === 403) {
        onForbidden();
        throw new Error('Доступ только для администратора Bitrix24');
      }
      if (response.status === 409) throw new Error('Одна из записей уже входит в активную пару. Для переназначения включите подтверждение замены.');
      if (!response.ok) throw new Error('Не удалось сохранить пару');
      await refresh();
      onError('');
    } finally {
      setSaving(false);
    }
  }

  return <>
    <PageHeading eyebrow="СВЯЗИ ЗАПИСЕЙ" title="Пары Bitrix24 и МойСклад" subtitle="Подтверждённая пара хранится по ID обеих записей. Непроверенное совпадение всегда остаётся на ручной проверке." />
    <section className="panel pair-manager">
      <div className="records-head"><div><p className="eyebrow">АКТИВНЫЕ ПАРЫ</p><h3>Сохранённые связи</h3></div><button type="button" className="refresh-monitoring" onClick={() => void refresh().catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))}>Обновить</button></div>
      {loading ? <p>Загрузка пар…</p> : pairs.length ? <div className="pair-list">{pairs.map((pair) => <article className="pair-card" key={pair.id}>
        <div><span className="pair-entity">{pairEntityTypes.find((type) => type.id === pair.entityType)?.label ?? pair.entityType}</span><span className="pair-state">{pair.source === 'MANUAL' ? 'Подтверждена администратором' : 'Сохранённая подтверждённая пара'}</span></div>
        <div className="pair-sides"><p><small>Bitrix24 · ID записи</small><code>{pair.bitrix24Id}</code></p><b aria-hidden="true">↔</b><p><small>МойСклад · ID записи</small><code>{pair.moyskladId}</code></p></div>
        {pair.reason && <small>Основание: {pair.reason}</small>}
      </article>)}</div> : <p className="empty-state">Сохранённых пар пока нет.</p>}
    </section>
    <section className="panel pair-manager">
      <p className="eyebrow">ТРЕБУЕТСЯ РЕШЕНИЕ</p><h3>Ручная проверка пар · {reviews.length}</h3>
      <p className="pair-safety-note">Новое сопоставление сохраняет только связь ID в базе сервиса. Оно не создаёт, не изменяет, не объединяет и не удаляет записи во внешних системах.</p>
      {reviews.length ? <div className="pair-review-list">{reviews.map((review) => <PairReviewForm key={review.id} review={review} saving={saving} onAssign={assign} />)}</div> : <p className="empty-state">Открытых случаев ручной проверки нет.</p>}
    </section>
    <section className="panel pair-manager">
      <p className="eyebrow">РУЧНОЕ НАЗНАЧЕНИЕ</p><h3>Создать или переназначить пару</h3>
      <ManualPairForm saving={saving} onAssign={assign} />
    </section>
  </>;
}

function PairReviewForm({ review, saving, onAssign }: { review: PairReviewRow; saving: boolean; onAssign: (input: { entityType: PairEntityType; bitrix24Id: string; moyskladId: string; replaceExisting: boolean }) => Promise<void> }) {
  const [bitrix24Id, setBitrix24Id] = useState(review.sourceSystem === 'BITRIX24' ? review.sourceEntityId : '');
  const [moyskladId, setMoyskladId] = useState(review.sourceSystem === 'MOYSKLAD' ? review.sourceEntityId : '');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [localError, setLocalError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError('');
    try {
      await onAssign({ entityType: review.entityType, bitrix24Id: bitrix24Id.trim(), moyskladId: moyskladId.trim(), replaceExisting });
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return <article className="pair-review-card">
    <div className="pair-review-heading"><div><span className="pair-entity">{pairEntityTypes.find((type) => type.id === review.entityType)?.label ?? review.entityType}</span><strong>{pairReviewReasonLabels[review.reason] ?? review.reason}</strong></div><time>{new Date(review.openedAt).toLocaleString()}</time></div>
    <form onSubmit={(event) => void submit(event)}>
      <label>Bitrix24 · ID записи<input required maxLength={200} value={bitrix24Id} onChange={(event) => setBitrix24Id(event.target.value)} /></label>
      <label>МойСклад · ID записи<input required maxLength={200} value={moyskladId} onChange={(event) => setMoyskladId(event.target.value)} /></label>
      <label className="pair-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Я проверил, что это одна и та же запись в обеих системах.</label>
      <label className="pair-check"><input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} />Заменить существующие пары для выбранной записи.</label>
      <button type="submit" disabled={!confirmed || saving}>Сохранить пару</button>
      {localError && <p className="inline-error" role="alert">{localError}</p>}
    </form>
  </article>;
}

function ManualPairForm({ saving, onAssign }: { saving: boolean; onAssign: (input: { entityType: PairEntityType; bitrix24Id: string; moyskladId: string; replaceExisting: boolean }) => Promise<void> }) {
  const [entityType, setEntityType] = useState<PairEntityType>('DEAL');
  const [bitrix24Id, setBitrix24Id] = useState('');
  const [moyskladId, setMoyskladId] = useState('');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [localError, setLocalError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError('');
    try {
      await onAssign({ entityType, bitrix24Id: bitrix24Id.trim(), moyskladId: moyskladId.trim(), replaceExisting });
      setBitrix24Id('');
      setMoyskladId('');
      setReplaceExisting(false);
      setConfirmed(false);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return <form className="manual-pair-form" onSubmit={(event) => void submit(event)}>
    <label>Сущность<select required value={entityType} onChange={(event) => setEntityType(event.target.value as PairEntityType)}>{pairEntityTypes.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}</select></label>
    <label>Bitrix24 · ID записи<input required maxLength={200} value={bitrix24Id} onChange={(event) => setBitrix24Id(event.target.value)} /></label>
    <label>МойСклад · ID записи<input required maxLength={200} value={moyskladId} onChange={(event) => setMoyskladId(event.target.value)} /></label>
    <label className="pair-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Я проверил, что это одна и та же запись в обеих системах.</label>
    <label className="pair-check"><input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} />Заменить существующие пары для выбранной записи.</label>
    <button type="submit" disabled={!confirmed || saving}>Сохранить пару</button>
    {localError && <p className="inline-error" role="alert">{localError}</p>}
  </form>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
