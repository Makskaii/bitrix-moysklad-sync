import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { FieldSettingsPage } from './field-settings';
import { HistoricalInventoryPage } from './historical-inventory';
import { HistoricalDealOrderMatchingPage } from './historical-deal-order-matching';
import { ClientMappingPage } from './client-mapping';

type TrialAction = { id: string; message: string; createdAt: string };
type ServiceMode = 'on' | 'pause' | 'off';
type EntityControl = { key: string; label: string; ready: boolean; implementation?: string; supportedDirections?: string[]; availability: string; bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean };
type PreflightFinding = { code: string; message: string; referenceId?: string };
type EnablePreflightReport = { entityKey: string; direction: 'bitrix24ToMoysklad' | 'moyskladToBitrix24'; settingsVersion: number | null; canEnable: boolean; blockers: PreflightFinding[]; warnings: PreflightFinding[] };
type DirectionConfirmation = { entity: EntityControl; bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean; preflight?: EnablePreflightReport | null; preflightLoading?: boolean };
type RecoveryStatus = { status: string; provider: string; bitrixStart: number; moyskladOffset: number; error: string | null };
type DatabaseRecoveryStatus = { status: string; previousLaunchBoundary: string | null; pairsRestored: boolean; lostEventsAcknowledged: boolean; acknowledgedAt?: string | null; acknowledgement?: string | null; audit?: Array<{ action: string; actorId: string; oldBoundaryAt: string | null; boundaryAt: string; occurredAt: string; acknowledgement: string }> };
type BitrixAuth = { access_token: string };
type BitrixSdk = { init(callback: () => void): void; getAuth(): BitrixAuth | false };
type QueueEvent = { id: string; source: string; eventType: string | null; externalEntityId: string | null; entityLabel?: string | null; status: string; receivedAt: string; attempts: number; direction: string | null; lastErrorCategory: string | null; retryAfter: string | null };
type QueueSnapshot = { counts: Record<string, number>; events: QueueEvent[]; nextCursor: string | null };
type ReviewCase = { id: string; eventId: string; source: string; externalEntityId: string | null; reason: string; diagnostic: Record<string, unknown> | null; entityLabel: string | null; labelStatus?: string; fieldTitle: string | null; previousValue: unknown; proposedValue: unknown; valueStatus?: string; valueReason?: string | null; status: string; openedAt: string };
type OperationalLog = { id: string; category: string; message: string; referenceId: string | null; occurredAt: string };
type ApiAttempt = { id: string; eventId: string | null; provider: string; operation: string; method: string; statusCode: number | null; succeeded: boolean; occurredAt: string };
type AdminAuditRow = { id: string; actorId: string; action: string; targetType: string; targetId: string | null; reason: string | null; before: unknown; after: unknown; occurredAt: string };
type OverviewStats = { queue: Record<string, number>; openManualReviews: number; openPairReviews: number; activePairs: number; lastEventAt: string | null };
const emptyOverview: OverviewStats = { queue: {}, openManualReviews: 0, openPairReviews: 0, activePairs: 0, lastEventAt: null };
type AdminSection = 'overview' | 'queue' | 'pairs' | 'clients' | 'history' | 'matching' | 'review' | 'settings' | 'dictionaries' | 'fields' | 'logs';
declare global { interface Window { BX24?: BitrixSdk } }

const trialActionsEndpoint = '/api/admin/trial-actions';
const logCategories = ['EVENTS', 'CRON_SYSTEM', 'MANUAL'] as const;
const logCategoryLabels: Record<typeof logCategories[number], string> = { EVENTS: 'События', CRON_SYSTEM: 'Система и расписание', MANUAL: 'Действия вручную' };
const sections: { id: AdminSection; label: string; icon: string }[] = [
  { id: 'overview', label: 'Обзор', icon: '⌂' },
  { id: 'queue', label: 'Очередь и попытки', icon: '≡' },
  { id: 'pairs', label: 'Связи записей', icon: '↔' },
  { id: 'clients', label: 'Карта клиентов', icon: '◎' },
  { id: 'history', label: 'Исторический каталог', icon: '⌕' },
  { id: 'matching', label: 'Сопоставление истории', icon: '⇄' },
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
  const [auditEntries, setAuditEntries] = useState<AdminAuditRow[]>([]);
  const [auditNextCursor, setAuditNextCursor] = useState<string | null>(null);
  const [overview, setOverview] = useState<OverviewStats>(emptyOverview);
  const [logCategory, setLogCategory] = useState<typeof logCategories[number]>('EVENTS');
  const [mode, setMode] = useState<ServiceMode>('off');
  const [entities, setEntities] = useState<EntityControl[]>([]);
  const [confirmMode, setConfirmMode] = useState<ServiceMode | null>(null);
  const [confirmDirections, setConfirmDirections] = useState<DirectionConfirmation | null>(null);
  const [recovery, setRecovery] = useState<RecoveryStatus>({ status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null });
  const [databaseRecovery, setDatabaseRecovery] = useState<DatabaseRecoveryStatus>({ status: 'RECOVERY_REQUIRED', previousLaunchBoundary: null, pairsRestored: false, lostEventsAcknowledged: false });

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
    const [actionsResponse, modeResponse, entitiesResponse, recoveryResponse, databaseRecoveryResponse, overviewResponse, auditResponse] = await Promise.all([
      fetch(trialActionsEndpoint, { headers }),
      fetch('/api/admin/sync-mode', { headers }),
      fetch('/api/admin/sync-mode/entities', { headers }),
      fetch('/api/admin/sync-mode/recovery', { headers }),
      fetch('/api/admin/sync-mode/database-recovery', { headers }),
      fetch('/api/admin/overview', { headers }),
      fetch('/api/admin/audit?limit=50', { headers }),
    ]);
    if ([actionsResponse, modeResponse, entitiesResponse, recoveryResponse, databaseRecoveryResponse, overviewResponse, auditResponse].some((response) => response.status === 403)) {
      denyAdminAccess();
      throw new Error('Доступ только для администратора Bitrix24');
    }
    if (!actionsResponse.ok || !modeResponse.ok || !entitiesResponse.ok || !recoveryResponse.ok || !databaseRecoveryResponse.ok || !overviewResponse.ok || !auditResponse.ok) {
      throw new Error('Не удалось загрузить состояние админки');
    }

    setActions(await actionsResponse.json() as TrialAction[]);
    setMode((await modeResponse.json() as { mode: ServiceMode }).mode);
    setEntities(await entitiesResponse.json() as EntityControl[]);
    setRecovery(await recoveryResponse.json() as RecoveryStatus);
    setDatabaseRecovery(await databaseRecoveryResponse.json() as DatabaseRecoveryStatus);
    setOverview(await overviewResponse.json() as OverviewStats);
    const auditPage = await auditResponse.json() as { entries: AdminAuditRow[]; nextCursor: string | null };
    setAuditEntries(auditPage.entries);
    setAuditNextCursor(auditPage.nextCursor);
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
    if (!response.ok) {
      const problem = await response.json().catch(() => null) as { message?: unknown; preflight?: EnablePreflightReport } | null;
      const blockerText = problem?.preflight?.blockers.map((item) => item.message).join(' ');
      const message = typeof problem?.message === 'string' ? problem.message : 'Не удалось сохранить направления обмена';
      throw new Error(blockerText || message);
    }
    const refreshed = await fetch('/api/admin/sync-mode/entities', { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
    if (refreshed.ok) setEntities(await refreshed.json() as EntityControl[]);
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

  async function loadMore(kind: 'queue' | 'incidents' | 'logs' | 'api' | 'audit') {
    const headers: Record<string, string> = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
    const cursor = kind === 'queue' ? queueSnapshot.nextCursor : kind === 'incidents' ? incidentNextCursor : kind === 'logs' ? logNextCursor : kind === 'api' ? attemptNextCursor : auditNextCursor;
    if (!cursor) return;
    const endpoint = kind === 'queue' ? `/api/admin/monitoring/queue?cursor=${encodeURIComponent(cursor)}`
      : kind === 'incidents' ? `/api/admin/monitoring/incidents?status=OPEN&cursor=${encodeURIComponent(cursor)}`
        : kind === 'logs' ? `/api/admin/monitoring/logs?category=${logCategory}&cursor=${encodeURIComponent(cursor)}`
          : kind === 'api' ? `/api/admin/monitoring/api-attempts?cursor=${encodeURIComponent(cursor)}` : `/api/admin/audit?cursor=${encodeURIComponent(cursor)}`;
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
    } else if (kind === 'api') {
      const page = await response.json() as { attempts: ApiAttempt[]; nextCursor: string | null };
      setApiAttempts((current) => [...current, ...page.attempts]); setAttemptNextCursor(page.nextCursor);
    } else {
      const page = await response.json() as { entries: AdminAuditRow[]; nextCursor: string | null };
      setAuditEntries((current) => [...current, ...page.entries]); setAuditNextCursor(page.nextCursor);
    }
  }

  /* Legacy combined monitor view is replaced by the section-based views below.
  return <main className="app-shell">
    {previewMode && <aside className="preview-banner" role="status">Локальный предпросмотр: поля читаются из систем; настройки сохраняются только в локальную базу.</aside>}
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
          {queueSnapshot.events.length ? <><div className="monitor-list">{queueSnapshot.events.map((event) => <article key={event.id}><div><strong>{event.entityLabel ?? event.eventType ?? event.source}</strong><small>{event.source} · {event.externalEntityId ? `ID ${event.externalEntityId}` : 'без ID'} · {new Date(event.receivedAt).toLocaleString('ru-RU')}</small>{!event.entityLabel && event.externalEntityId && <small>Название не загружено из проверенного источника</small>}</div><span className={`event-status status-${event.status.toLowerCase()}`}>{event.status}</span><small>Попыток: {event.attempts}{event.lastErrorCategory ? ` · ${event.lastErrorCategory}` : ''}</small></article>)}</div>{queueSnapshot.nextCursor && <button className="load-more" type="button" onClick={() => void loadMore('queue').catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Загрузить следующие события</button>}</> : <p className="empty">Очередь пуста.</p>}
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
    {previewMode && <aside className="preview-banner" role="status">Локальный предпросмотр: поля читаются из систем; настройки сохраняются только в локальную базу.</aside>}
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
          </button>)}
          <div className="nav-note"><span className="note-dot" />Доступ администратора подтверждён</div>
        </nav>

        <div className="page-content">
          {activeSection === 'overview' && <Overview mode={mode} recovery={recovery} serviceStatus={serviceStatus} actions={actions} loading={loading} message={message} setMessage={setMessage} submit={submitTrialAction} error={error} stats={overview} />}
          {activeSection === 'queue' && <MonitoringPage kind="queue" queue={queueSnapshot} attempts={apiAttempts} onLoadMore={loadMore} onError={setError} />}
          {activeSection === 'pairs' && <PairManager accessToken={accessToken} onError={setError} onForbidden={denyAdminAccess} />}
          {activeSection === 'clients' && <ClientMappingPage accessToken={accessToken} onError={setError} onForbidden={denyAdminAccess} />}
          {activeSection === 'history' && <HistoricalInventoryPage accessToken={accessToken} onError={setError} onForbidden={denyAdminAccess} />}
          {activeSection === 'matching' && <HistoricalDealOrderMatchingPage accessToken={accessToken} onError={setError} onForbidden={denyAdminAccess} />}
          {activeSection === 'review' && <MonitoringPage kind="review" incidents={incidents} incidentNextCursor={incidentNextCursor} onLoadMore={loadMore} onResolve={resolveIncident} onRetry={retryIncident} onError={setError} />}
          {activeSection === 'settings' && <Settings accessToken={accessToken} mode={mode} entities={entities} recovery={recovery} databaseRecovery={databaseRecovery} setDatabaseRecovery={setDatabaseRecovery} confirmMode={confirmMode} setConfirmMode={setConfirmMode} saveMode={saveMode} confirmDirections={confirmDirections} setConfirmDirections={setConfirmDirections} saveDirections={saveDirections} error={error} setError={setError} />}
          {activeSection === 'dictionaries' && <UnavailablePage title="Справочники" eyebrow="СОПОСТАВЛЕНИЯ ЗНАЧЕНИЙ" description="Связи сотрудников, организаций, складов, валют и значений справочников пока не загружаются. Демонстрационные пары не используются." action="Добавить соответствие" />}
          {activeSection === 'fields' && <FieldSettingsPage accessToken={accessToken} onForbidden={denyAdminAccess} onError={setError} />}
          {activeSection === 'logs' && <MonitoringPage kind="logs" logs={logs} logCategory={logCategory} onCategory={showLogCategory} logNextCursor={logNextCursor} attempts={apiAttempts} attemptNextCursor={attemptNextCursor} auditEntries={auditEntries} auditNextCursor={auditNextCursor} onLoadMore={loadMore} onError={setError} />}
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

function Overview({ mode, recovery, serviceStatus, actions, loading, message, setMessage, submit, error, stats }: {
  mode: ServiceMode;
  recovery: RecoveryStatus;
  serviceStatus: string;
  actions: TrialAction[];
  loading: boolean;
  message: string;
  setMessage: (value: string) => void;
  submit: (event: React.FormEvent) => void;
  error: string;
  stats: OverviewStats;
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
      <div className="panel-heading"><div><p className="eyebrow">ПОКАЗАТЕЛИ</p><h3>Обмен и данные</h3></div><span className="availability-tag">Данные из API</span></div>
      <div className="metric-grid">
        <article className="metric"><span>События в очереди</span><strong>{loading ? '…' : Object.values(stats.queue).reduce((sum, count) => sum + count, 0)}</strong></article>
        <article className="metric"><span>Активные пары</span><strong>{loading ? '…' : stats.activePairs}</strong></article>
        <article className="metric"><span>Открытые проверки</span><strong>{loading ? '…' : stats.openManualReviews + stats.openPairReviews}</strong></article>
        <article className="metric"><span>Последнее событие</span><strong>{loading ? '…' : stats.lastEventAt ? new Date(stats.lastEventAt).toLocaleString('ru-RU') : 'Нет событий'}</strong></article>
      </div>
      <p className="honesty-note"><span aria-hidden="true">i</span> Доступны проверки очереди и ручные решения; фактическое применение внешних изменений определяется серверным режимом и направлением обмена.</p>
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

function MonitoringPage({ kind, queue, incidents, incidentNextCursor, logs, logCategory, logNextCursor, attempts, attemptNextCursor, auditEntries, auditNextCursor, onCategory, onLoadMore, onResolve, onRetry, onError }: {
  kind: 'queue' | 'review' | 'logs';
  queue?: QueueSnapshot;
  incidents?: ReviewCase[];
  incidentNextCursor?: string | null;
  logs?: OperationalLog[];
  logCategory?: typeof logCategories[number];
  logNextCursor?: string | null;
  attempts?: ApiAttempt[];
  attemptNextCursor?: string | null;
  auditEntries?: AdminAuditRow[];
  auditNextCursor?: string | null;
  onCategory?: (category: typeof logCategories[number]) => Promise<void>;
  onLoadMore: (kind: 'queue' | 'incidents' | 'logs' | 'api' | 'audit') => Promise<void>;
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
        {queue?.events.length ? <div className="monitor-list">{queue.events.map((event) => <article key={event.id}><div><strong>{event.eventType ?? event.source}</strong><small>{event.source} · {event.externalEntityId ? `ID ${event.externalEntityId}` : 'без ID'} · {new Date(event.receivedAt).toLocaleString('ru-RU')}{event.direction ? ` · ${event.direction}` : ''}</small></div><span className={`event-status status-${event.status.toLowerCase()}`}>{event.status}</span><small>Попыток: {event.attempts}{event.lastErrorCategory ? ` · ${event.lastErrorCategory}` : ''}{event.retryAfter ? ` · повтор после ${new Date(event.retryAfter).toLocaleString('ru-RU')}` : ''}</small></article>)}</div> : <p className="muted-empty">Очередь пуста.</p>}
        {queue?.nextCursor && <button className="load-more" type="button" onClick={() => run(() => onLoadMore('queue'))}>Загрузить следующие события</button>}
      </section>
      <ApiAttempts attempts={attempts ?? []} nextCursor={attemptNextCursor} onLoadMore={onLoadMore} onError={onError} />
    </>}
    {kind === 'review' && <section className="panel monitoring-panel" aria-label="Случаи ручной проверки">
      {incidents?.length ? <div className="monitor-list">{incidents.map((incident) => <article key={incident.id}><div><strong>{incident.entityLabel ? `${incident.entityLabel} · ` : ''}{incident.reason}</strong><small>{incident.source} · {incident.externalEntityId ? `ID ${incident.externalEntityId}` : 'без ID'} · событие {incident.eventId}</small>{incident.fieldTitle && <small>Поле: {incident.fieldTitle}</small>}{incident.previousValue !== null && incident.previousValue !== undefined && <small>Текущее значение: {JSON.stringify(incident.previousValue)}</small>}{incident.proposedValue !== null && incident.proposedValue !== undefined && <small>Предлагаемое значение: {JSON.stringify(incident.proposedValue)}</small>}{incident.valueReason && <small>{incident.valueReason}</small>}{incident.diagnostic && <small>Диагностика: {Object.entries(incident.diagnostic).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ')}</small>}<small>{new Date(incident.openedAt).toLocaleString('ru-RU')}</small></div><div className="incident-actions"><button type="button" className="button-secondary" onClick={() => run(() => onRetry?.(incident.id) ?? Promise.resolve())}>Повторить</button><button type="button" className="button-secondary" onClick={() => run(() => onResolve?.(incident.id) ?? Promise.resolve())}>Отметить решённым</button></div></article>)}</div> : <p className="muted-empty">Открытых случаев ручной проверки нет.</p>}
      {incidentNextCursor && <button className="load-more" type="button" onClick={() => run(() => onLoadMore('incidents'))}>Загрузить следующие случаи</button>}
    </section>}
    {kind === 'logs' && <>
      <section className="panel monitoring-panel" aria-label="Операционные журналы">
        <div className="panel-heading"><div><p className="eyebrow">СОБЫТИЯ И ДЕЙСТВИЯ</p><h3>Операционные журналы</h3></div></div>
        <div className="log-tabs">{logCategories.map((category) => <button key={category} type="button" aria-pressed={logCategory === category} onClick={() => onCategory && run(() => onCategory(category))}>{logCategoryLabels[category]}</button>)}</div>
        {logs?.length ? <div className="monitor-list">{logs.map((entry) => <article key={entry.id}><div><strong>{entry.message}</strong><small>{new Date(entry.occurredAt).toLocaleString('ru-RU')}{entry.referenceId ? ` · ${entry.referenceId}` : ''}</small></div><span className="event-status">{entry.category}</span></article>)}</div> : <p className="muted-empty">В этой категории пока нет записей.</p>}
        {logNextCursor && <button className="load-more" type="button" onClick={() => run(() => onLoadMore('logs'))}>Загрузить следующие записи</button>}
      </section>
      <ApiAttempts attempts={attempts ?? []} nextCursor={attemptNextCursor} onLoadMore={onLoadMore} onError={onError} />
      <section className="panel monitoring-panel" aria-label="Аудит действий администратора">
        <div className="panel-heading"><div><p className="eyebrow">НЕИЗМЕНЯЕМАЯ ИСТОРИЯ</p><h3>Аудит действий администратора</h3></div></div>
        {auditEntries?.length ? <div className="monitor-list">{auditEntries.map((entry) => <article key={entry.id}><div><strong>{entry.action} · {entry.targetType}</strong><small>{entry.actorId} · {new Date(entry.occurredAt).toLocaleString('ru-RU')}{entry.targetId ? ` · ${entry.targetId}` : ''}{entry.reason ? ` · ${entry.reason}` : ''}</small><details><summary>До / после</summary><pre>{JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}</pre></details></div></article>)}</div> : <p className="muted-empty">Записей аудита пока нет.</p>}
        {auditNextCursor && <button className="load-more" type="button" onClick={() => run(() => onLoadMore('audit'))}>Загрузить следующие записи</button>}
      </section>
    </>}
  </>;
}

function ApiAttempts({ attempts, nextCursor, onLoadMore, onError }: { attempts: ApiAttempt[]; nextCursor?: string | null; onLoadMore: (kind: 'queue' | 'incidents' | 'logs' | 'api' | 'audit') => Promise<void>; onError: (message: string) => void }) {
  return <section className="panel monitoring-panel" aria-label="История вызовов API"><div className="panel-heading"><div><p className="eyebrow">ВНЕШНИЕ СИСТЕМЫ</p><h3>История вызовов API</h3></div></div>
    {attempts.length ? <div className="monitor-list">{attempts.map((attempt) => <article key={attempt.id}><div><strong>{attempt.provider} · {attempt.operation}</strong><small>{attempt.method} · {new Date(attempt.occurredAt).toLocaleString('ru-RU')}{attempt.eventId ? ` · событие ${attempt.eventId}` : ''}</small></div><span className={`event-status ${attempt.succeeded ? 'status-succeeded' : 'status-manual_review'}`}>{attempt.statusCode ?? 'ошибка сети'} · {attempt.succeeded ? 'OK' : 'ошибка'}</span></article>)}</div> : <p className="muted-empty">История вызовов API пуста.</p>}
    {nextCursor && <button className="load-more" type="button" onClick={() => void onLoadMore('api').catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))}>Загрузить следующие вызовы</button>}
  </section>;
}

function Metric({ label }: { label: string }) {
  return <div className="metric"><span>{label}</span><strong aria-label={`${label}: данных нет`}>—</strong><small>Нет достоверных данных</small></div>;
}

function Settings({ accessToken, mode, entities, recovery, databaseRecovery, setDatabaseRecovery, confirmMode, setConfirmMode, saveMode, confirmDirections, setConfirmDirections, saveDirections, error, setError }: {
  accessToken: string;
  mode: ServiceMode;
  entities: EntityControl[];
  recovery: RecoveryStatus;
  databaseRecovery: DatabaseRecoveryStatus;
  setDatabaseRecovery: (status: DatabaseRecoveryStatus) => void;
  confirmMode: ServiceMode | null;
  setConfirmMode: (mode: ServiceMode | null) => void;
  saveMode: (mode: ServiceMode) => Promise<void>;
  confirmDirections: DirectionConfirmation | null;
  setConfirmDirections: (value: DirectionConfirmation | null) => void;
  saveDirections: (entity: EntityControl, bitrix24ToMoysklad: boolean, moyskladToBitrix24: boolean) => Promise<void>;
  error: string;
  setError: (error: string) => void;
}) {
  async function requestDirectionChange(entity: EntityControl, direction: 'bitrix24ToMoysklad' | 'moyskladToBitrix24', enabled: boolean) {
    const next = {
      entity,
      bitrix24ToMoysklad: direction === 'bitrix24ToMoysklad' ? enabled : entity.bitrix24ToMoysklad,
      moyskladToBitrix24: direction === 'moyskladToBitrix24' ? enabled : entity.moyskladToBitrix24,
      preflightLoading: enabled,
      preflight: null,
    };
    setConfirmDirections(next);
    if (!enabled) return;
    const headers: Record<string, string> = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
    try {
      const response = await fetch(`/api/admin/sync-mode/entities/${encodeURIComponent(entity.key)}/preflight?direction=${direction}`, { headers });
      if (response.status === 403) throw new Error('Доступ только для администратора Bitrix24');
      const report = await response.json() as EnablePreflightReport & { message?: string };
      if (!response.ok) throw new Error(report.message ?? 'Не удалось проверить готовность направления');
      setConfirmDirections({ ...next, preflightLoading: false, preflight: report });
    } catch (cause) {
      setConfirmDirections({ ...next, preflightLoading: false, preflight: { entityKey: entity.key, direction, settingsVersion: null, canEnable: false, blockers: [{ code: 'PREFLIGHT_UNAVAILABLE', message: cause instanceof Error ? cause.message : 'Не удалось выполнить проверку готовности.' }], warnings: [] } });
    }
  }

  return <>
    <PageHeading eyebrow="КОНФИГУРАЦИЯ" title="Настройки сущностей и направлений" subtitle="Состояние сервиса и доступные направления для каждой сущности." />
    <section className="panel settings-panel" aria-label="Настройки обмена">
      <div className="panel-heading"><div><p className="eyebrow">ОБЩЕЕ СОСТОЯНИЕ</p><h3>Режим сервиса</h3></div><span className={`mode-chip mode-${mode}`}>{mode === 'on' ? 'Включён' : mode === 'pause' ? 'Пауза' : 'Выключен'}</span></div>
      {recovery.status !== 'idle' && <p className="recovery-line" role="status">Поиск изменений: <strong>{recovery.status}</strong>{recovery.error ? ` · ${recovery.error}` : ''}</p>}
      <p className="panel-description">Включение режима не включает направления и не устанавливает границу рабочего запуска. Каждое направление включается отдельно после проверки настроек и доступа API.</p>
      <div className="mode-buttons">
        {(['on', 'pause', 'off'] as const).map((nextMode) => <button key={nextMode} type="button" aria-label={`Выбрать режим ${nextMode}`} aria-pressed={mode === nextMode} disabled={mode === nextMode} onClick={() => setConfirmMode(nextMode)}>{nextMode === 'on' ? 'Включить' : nextMode === 'pause' ? 'Пауза' : 'Выключить'}</button>)}
      </div>
      {confirmMode && <div role="alertdialog" aria-labelledby="mode-warning-title" aria-describedby="mode-warning-text" className="confirm-box">
        <h4 id="mode-warning-title">Подтвердите изменение режима</h4>
        <p id="mode-warning-text">{confirmMode === 'on' ? 'Включение разрешит обработку только для уже включённых и прошедших preflight направлений. Граница рабочего запуска подтверждается отдельным действием.' : confirmMode === 'pause' ? 'Пауза остановит обработку; принятые события останутся в очереди до возобновления. Граница запуска не изменится.' : 'Выключение остановит приём событий. Пропущенные в период OFF события не будут переигрываться; сохранённые события останутся в очереди.'}</p>
        <button type="button" onClick={() => void saveMode(confirmMode).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Подтвердить</button>
        <button type="button" className="button-secondary" onClick={() => setConfirmMode(null)}>Отмена</button>
      </div>}
      <div className="entity-settings">{entities.map((entity) => <article key={entity.key} className="entity-row">
        <div className="entity-row-heading"><h4>{entity.label}</h4><span className={entity.ready ? 'entity-state is-configured' : 'entity-state'}>{entity.implementation === 'implemented' ? 'Реализовано · preflight перед включением' : entity.ready ? 'Реализовано частично' : 'Недоступно'}</span></div>
        <p>{entity.availability}</p>
        <label><input type="checkbox" checked={entity.ready && entity.bitrix24ToMoysklad} disabled={!entity.ready || !entity.supportedDirections?.includes('bitrix24ToMoysklad')} onChange={(event) => void requestDirectionChange(entity, 'bitrix24ToMoysklad', event.target.checked)} /> Bitrix24 → МойСклад</label>
        <label><input type="checkbox" checked={entity.ready && entity.moyskladToBitrix24} disabled={!entity.ready || !entity.supportedDirections?.includes('moyskladToBitrix24')} onChange={(event) => void requestDirectionChange(entity, 'moyskladToBitrix24', event.target.checked)} /> МойСклад → Bitrix24</label>
      </article>)}</div>
      {confirmDirections && <div role="alertdialog" aria-label="Подтвердите изменение направления" className="confirm-box">
        <h4>Подтвердите изменение направления</h4>
        <p>Проверка использует только выбранную сущность и направление. Настройки версии: {confirmDirections.preflight?.settingsVersion ?? 'не определена'}. Секреты в отчёт не включаются.</p>
        {confirmDirections.preflightLoading && <p role="status">Проверяем API и настройки…</p>}
        {confirmDirections.preflight?.blockers.map((item, index) => <p key={`blocker-${index}`} className="inline-error" role="alert">Блокирует включение: {item.message}{item.referenceId ? ` · ${item.referenceId}` : ''}</p>)}
        {confirmDirections.preflight?.warnings.map((item, index) => <p key={`warning-${index}`} className="pair-safety-note" role="status">Предупреждение: {item.message}</p>)}
        <button type="button" disabled={Boolean(confirmDirections.preflightLoading || (confirmDirections.preflight && !confirmDirections.preflight.canEnable))} onClick={() => void saveDirections(confirmDirections.entity, confirmDirections.bitrix24ToMoysklad, confirmDirections.moyskladToBitrix24).then(() => setConfirmDirections(null)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Подтвердить</button>
        <button type="button" className="button-secondary" onClick={() => setConfirmDirections(null)}>Отмена</button>
      </div>}
      {error && <p role="alert" className="inline-error">{error}</p>}
    </section>
    <p className="security-caption"><span aria-hidden="true">✓</span> Настройки загружаются через защищённые административные запросы Bitrix24.</p>
    <DatabaseRecoveryPanel accessToken={accessToken} status={databaseRecovery} onUpdated={setDatabaseRecovery} onError={setError} />
  </>;
}

function DatabaseRecoveryPanel({ accessToken, status, onUpdated, onError }: {
  accessToken: string;
  status: DatabaseRecoveryStatus;
  onUpdated: (status: DatabaseRecoveryStatus) => void;
  onError: (message: string) => void;
}) {
  const [boundary, setBoundary] = useState('');
  const [pairsRestored, setPairsRestored] = useState(false);
  const [lostEventsAcknowledged, setLostEventsAcknowledged] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState('');
  const [saving, setSaving] = useState(false);
  const ready = status.status === 'READY';

  async function confirm() {
    setSaving(true);
    try {
      const response = await fetch('/api/admin/sync-mode/database-recovery/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify({ previousLaunchBoundary: boundary, pairsRestored, lostEventsAcknowledged, acknowledgement }),
      });
      if (response.status === 403) throw new Error('Доступ только для администратора Bitrix24');
      const payload = await response.json().catch(() => ({})) as DatabaseRecoveryStatus & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? 'Не удалось подтвердить восстановление базы');
      onUpdated(payload);
      setBoundary('');
      setPairsRestored(false);
      setLostEventsAcknowledged(false);
      setAcknowledgement('');
      onError('');
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return <section className="panel settings-panel" aria-label="Восстановление после потери базы">
    <div className="panel-heading"><div><p className="eyebrow">ЦЕЛОСТНОСТЬ ДАННЫХ</p><h3>Восстановление после потери базы</h3></div><span className={`mode-chip mode-${ready ? 'on' : 'off'}`}>{ready ? 'Подтверждено' : 'Требуется'}</span></div>
    {ready ? <>
      <p className="panel-description">Восстановление подтверждено {status.acknowledgedAt ? new Date(status.acknowledgedAt).toLocaleString() : ''}. Граница запуска: <strong>{status.previousLaunchBoundary ? new Date(status.previousLaunchBoundary).toLocaleString() : 'не задана'}</strong>. Подтверждены пары: {status.pairsRestored ? 'да' : 'нет'}; утраченные события признаны: {status.lostEventsAcknowledged ? 'да' : 'нет'}.</p>
      {status.audit?.map((entry, index) => <p key={`${entry.occurredAt}-${index}`} className="recovery-line">Аудит: {entry.actorId}, {new Date(entry.occurredAt).toLocaleString()}, граница {new Date(entry.boundaryAt).toLocaleString()}. {entry.acknowledgement}</p>)}
    </> : <>
      <p className="panel-description">База не содержит подтверждённого состояния. Очередь, снимки, аудит и решения, которые хранились только в потерянной базе, невозможно гарантированно восстановить. Автоматическое сопоставление и replay истории не выполняются. Сверьте прежнюю границу с независимой эксплуатационной записью и восстановите пары до подтверждения.</p>
      <label>Прежняя граница рабочего запуска из независимой записи
        <input value={boundary} onChange={(event) => setBoundary(event.target.value)} placeholder="2026-09-01T10:00:00+03:00" autoComplete="off" />
      </label>
      <label className="pair-check"><input type="checkbox" checked={pairsRestored} onChange={(event) => setPairsRestored(event.target.checked)} />Я восстановил и проверил пары по точным внешним ID/UUID; неоднозначные пары разобраны вручную.</label>
      <label className="pair-check"><input type="checkbox" checked={lostEventsAcknowledged} onChange={(event) => setLostEventsAcknowledged(event.target.checked)} />Я признаю, что очередь, снимки, журнал аудита и решения, существовавшие только в утраченной базе, не могут быть гарантированно восстановлены.</label>
      <label>Основание восстановления и принятый риск
        <textarea value={acknowledgement} onChange={(event) => setAcknowledgement(event.target.value)} minLength={20} maxLength={1000} rows={3} placeholder="Укажите независимую запись границы и принятые ограничения восстановления." />
      </label>
      <button type="button" disabled={saving || !boundary || !pairsRestored || !lostEventsAcknowledged || acknowledgement.trim().length < 20} onClick={() => void confirm()}>{saving ? 'Сохраняем подтверждение…' : 'Подтвердить восстановление'}</button>
      <p className="security-caption">Это действие сохранит аудит администратора и оставит сервис выключенным. После него включение Apply требует отдельного действия.</p>
    </>}
  </section>;
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

type PairEntityType = 'CONTACT' | 'COMPANY' | 'DEAL' | 'PRODUCT' | 'INVOICE';
const pairEntityTypes: { id: PairEntityType; label: string }[] = [
  { id: 'CONTACT', label: 'Контакт' },
  { id: 'COMPANY', label: 'Компания' },
  { id: 'DEAL', label: 'Сделка / заказ покупателя' },
  { id: 'INVOICE', label: 'Смарт-счёт / счёт покупателю' },
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
type PairRow = { id: string; entityType: PairEntityType; bitrix24Id: string; moyskladId: string; bitrix24Label?: string | null; moyskladLabel?: string | null; labelStatus?: string; moyskladType: string | null; moyskladParentId: string | null; source: string; reason: string | null; createdAt: string };
type PairReviewRow = { id: string; entityType: PairEntityType; sourceSystem: 'BITRIX24' | 'MOYSKLAD'; sourceEntityId: string; sourceLabel?: string | null; labelStatus?: string; eventId: string | null; reason: string; openedAt: string };
type LifecycleEntityType = 'COMPANY' | 'CONTACT' | 'DEAL' | 'PRODUCT' | 'INVOICE';
type LifecycleMarkerFields = Partial<Record<LifecycleEntityType, string>>;
type ClientLifecycleRow = { id: string; entityType: LifecycleEntityType; bitrix24Id: string; moyskladId: string; moyskladType: string | null; moyskladParentId: string | null; lifecycleStatus: string; tombstonedAt: string | null; tombstoneSource: string | null; tombstoneReason: string | null; deletionMarkerStatus: string; deletionTimelineStatus: string };
const lifecycleEntityLabels: Record<LifecycleEntityType, string> = { COMPANY: 'Компания', CONTACT: 'Контакт', DEAL: 'Сделка', PRODUCT: 'Товар', INVOICE: 'Счёт' };
const lifecycleMarkerStatusLabels: Record<string, string> = {
  NOT_REQUIRED: 'Метка не требуется для этого типа записи', PENDING: 'Ожидает записи метки', WRITING: 'Метка записывается',
  MARKED: 'Метка удаления записана', NOT_CONFIGURED: 'Поле метки не настроено', FAILED: 'Не удалось записать метку',
  CLEARING: 'Метка очищается', CLEARED: 'Метка очищена', CLEAR_FAILED: 'Не удалось очистить метку',
};
const lifecycleRestoreEligible = new Set(['NOT_REQUIRED', 'NOT_CONFIGURED', 'MARKED', 'FAILED', 'PENDING', 'CLEAR_FAILED']);

function PairManager({ accessToken, onError, onForbidden }: { accessToken: string; onError: (message: string) => void; onForbidden: () => void }) {
  const [pairs, setPairs] = useState<PairRow[]>([]);
  const [reviews, setReviews] = useState<PairReviewRow[]>([]);
  const [lifecycleRows, setLifecycleRows] = useState<ClientLifecycleRow[]>([]);
  const [lifecycleError, setLifecycleError] = useState('');
  const [markerFields, setMarkerFields] = useState<LifecycleMarkerFields>({});
  const [markerFieldsAvailable, setMarkerFieldsAvailable] = useState(false);
  const [markerFieldsError, setMarkerFieldsError] = useState('');
  const [markerFieldsNotice, setMarkerFieldsNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    const headers: Record<string, string> = accessToken ? { authorization: `Bearer ${accessToken}` } : {};
    const [pairsResponse, reviewsResponse, lifecycleResponse, markerFieldsResponse] = await Promise.all([
      fetch('/api/admin/pairs', { headers }),
      fetch('/api/admin/pairs/reviews', { headers }),
      fetch('/api/admin/clients/lifecycle', { headers }),
      fetch('/api/admin/clients/lifecycle/marker-fields', { headers }),
    ]);
    if (pairsResponse.status === 403 || reviewsResponse.status === 403) {
      onForbidden();
      throw new Error('Доступ только для администратора Bitrix24');
    }
    if (!pairsResponse.ok || !reviewsResponse.ok) throw new Error('Не удалось загрузить пары записей');
    setPairs(await pairsResponse.json() as PairRow[]);
    setReviews(await reviewsResponse.json() as PairReviewRow[]);
    if (lifecycleResponse.status === 403) {
      onForbidden();
      throw new Error('Доступ только для администратора Bitrix24');
    }
    if (!lifecycleResponse.ok) {
      setLifecycleRows([]);
      setLifecycleError('Статус удалённых пар пока недоступен. Повторите загрузку; восстановление не предлагается без данных сервера.');
    } else {
      setLifecycleRows(await lifecycleResponse.json() as ClientLifecycleRow[]);
      setLifecycleError('');
    }
    if (markerFieldsResponse.status === 403) {
      onForbidden();
      throw new Error('Доступ только для администратора Bitrix24');
    }
    if (!markerFieldsResponse.ok) {
      setMarkerFieldsAvailable(false);
      setMarkerFieldsError('Настройки меток удаления пока недоступны; сохранённые ID обеих систем не изменены.');
    } else {
      const result = await markerFieldsResponse.json() as { fields?: LifecycleMarkerFields };
      setMarkerFields(result.fields ?? {});
      setMarkerFieldsAvailable(true);
      setMarkerFieldsError('');
    }
  }

  useEffect(() => {
    refresh().catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);

  async function assign(input: { entityType: PairEntityType; bitrix24Id: string; moyskladId: string; moyskladType?: 'counterparty' | 'contactperson' | 'invoiceout'; moyskladParentId?: string; replaceExisting: boolean }) {
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

  async function restore(pairId: string) {
    if (!window.confirm('Восстановить ту же пару по проверенным ID обеих систем? Внешние записи не создаются и не изменяются.')) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/clients/lifecycle/${encodeURIComponent(pairId)}/restore`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify({ confirmed: true }),
      });
      if (response.status === 403) { onForbidden(); throw new Error('Доступ только для администратора Bitrix24'); }
      const result = await response.json().catch(() => null) as { status?: string } | null;
      if (!response.ok) throw new Error(result?.status ? `Не удалось восстановить пару: ${result.status}` : 'Не удалось проверить и восстановить пару');
      if (result?.status !== 'RESTORED') throw new Error('Сервер не подтвердил восстановление пары');
      await refresh();
      onError('');
    } finally { setSaving(false); }
  }

  async function saveMarkerFields(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMarkerFieldsError('');
    setMarkerFieldsNotice('');
    try {
      const response = await fetch('/api/admin/clients/lifecycle/marker-fields', {
        method: 'PUT', headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify({ fields: markerFields }),
      });
      if (response.status === 403) { onForbidden(); throw new Error('Доступ только для администратора Bitrix24'); }
      const result = await response.json().catch(() => null) as { fields?: LifecycleMarkerFields; status?: string } | null;
      if (!response.ok) throw new Error(result?.status ? `Не удалось сохранить поля меток: ${result.status}` : 'Не удалось сохранить поля меток. Проверьте коды UF-полей.');
      setMarkerFields(result?.fields ?? markerFields);
      setMarkerFieldsNotice('Поля меток сохранены на сервере. Новые метки будут записываться при следующих событиях.');
    } catch (cause) {
      setMarkerFieldsError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  }

  return <>
    <PageHeading eyebrow="СВЯЗИ ЗАПИСЕЙ" title="Пары Bitrix24 и МойСклад" subtitle="Подтверждённая пара хранится по ID обеих записей. Непроверенное совпадение всегда остаётся на ручной проверке." />
    <section className="panel pair-manager">
      <div className="records-head"><div><p className="eyebrow">АКТИВНЫЕ ПАРЫ</p><h3>Сохранённые связи</h3></div><button type="button" className="refresh-monitoring" onClick={() => void refresh().catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))}>Обновить</button></div>
      {loading ? <p>Загрузка пар…</p> : pairs.length ? <div className="pair-list">{pairs.map((pair) => <article className="pair-card" key={pair.id}>
        <div><span className="pair-entity">{pairEntityTypes.find((type) => type.id === pair.entityType)?.label ?? pair.entityType}</span><span className="pair-state">{pair.source === 'MANUAL' ? 'Подтверждена администратором' : 'Сохранённая подтверждённая пара'}</span></div>
        <div className="pair-sides"><p><small>Bitrix24 · ID записи</small><strong>{pair.bitrix24Label ?? 'Название не загружено'}</strong><code>{pair.bitrix24Id}</code></p><b aria-hidden="true">↔</b><p><small>МойСклад · {pair.moyskladType === 'contactperson' ? 'Контактное лицо' : pair.moyskladType === 'counterparty' ? 'Контрагент' : 'ID записи'}</small><strong>{pair.moyskladLabel ?? 'Название не загружено'}</strong><code>{pair.moyskladId}</code>{pair.moyskladParentId && <small>Родительский контрагент · ID {pair.moyskladParentId}</small>}</p></div>
        {pair.reason && <small>Основание: {pair.reason}</small>}
      </article>)}</div> : <p className="empty-state">Сохранённых пар пока нет.</p>}
    </section>
    <section className="panel pair-manager" aria-label="Удалённые клиентские пары">
      <p className="eyebrow">ЖИЗНЕННЫЙ ЦИКЛ КЛИЕНТА</p><h3>Приостановленные пары · {lifecycleRows.length}</h3>
      <p className="pair-safety-note">Удалённая запись не считается несопоставленной и не удаляет запись партнёра. Восстановление проверяет, что обе исходные записи по тем же ID всё ещё существуют.</p>
      <form className="manual-pair-form" onSubmit={(event) => void saveMarkerFields(event)} aria-label="Поля меток удаления">
        <div className="records-head"><div><h4>Поля меток удаления</h4><p className="panel-description">Точные коды пользовательских полей Bitrix24. Код должен быть настроен на сервере; догадки не применяются.</p></div></div>
        {markerFieldsAvailable && (['COMPANY', 'CONTACT', 'DEAL', 'PRODUCT', 'INVOICE'] as const).map((entityType) => <label key={entityType}>{lifecycleEntityLabels[entityType]} · код UF-поля<input maxLength={100} value={markerFields[entityType] ?? ''} onChange={(change) => setMarkerFields((current) => ({ ...current, [entityType]: change.target.value }))} placeholder="UF_CRM_…" /></label>)}
        {markerFieldsError && <p role="alert" className="inline-error">{markerFieldsError}</p>}
        {markerFieldsNotice && <p role="status" className="pair-safety-note">{markerFieldsNotice}</p>}
        {markerFieldsAvailable && <button type="submit" disabled={saving}>Сохранить настройки меток</button>}
      </form>
      {lifecycleError ? <p role="alert" className="inline-error">{lifecycleError}</p> : lifecycleRows.length ? <div className="pair-list">{lifecycleRows.map((row) => <article className="pair-card" key={row.id}>
        <div><span className="pair-entity">{lifecycleEntityLabels[row.entityType] ?? row.entityType}</span><span className="pair-state">Удалена в {row.tombstoneSource ?? 'неизвестной системе'} · {row.tombstonedAt ? new Date(row.tombstonedAt).toLocaleString('ru-RU') : 'время неизвестно'}</span></div>
        <div className="pair-sides"><p><small>Bitrix24 · ID</small><code>{row.bitrix24Id}</code></p><b aria-hidden="true">↔</b><p><small>МойСклад · {row.moyskladType ?? 'ID'}</small><code>{row.moyskladId}</code>{row.moyskladParentId && <small>Родительский ID · {row.moyskladParentId}</small>}</p></div>
        <small>Причина: {row.tombstoneReason ?? 'не указана'} · Метка удаления: {lifecycleMarkerStatusLabels[row.deletionMarkerStatus] ?? row.deletionMarkerStatus} · Запись в истории Bitrix24: {row.deletionTimelineStatus}</small>
        {lifecycleRestoreEligible.has(row.deletionMarkerStatus)
          ? <button type="button" disabled={saving} onClick={() => void restore(row.id).catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))}>Проверить ID и очистить метку, если настроена; затем восстановить</button>
          : <small>Восстановление ожидает завершения операции с меткой удаления.</small>}
      </article>)}</div> : <p className="empty-state">Удалённых связанных клиентских пар нет.</p>}
    </section>
    <section className="panel pair-manager">
      <p className="eyebrow">ТРЕБУЕТСЯ РЕШЕНИЕ</p><h3>Ручная проверка пар · {reviews.length}</h3>
      <p className="pair-safety-note">Новое сопоставление сохраняет только связь ID в базе сервиса. Оно не создаёт, не изменяет, не объединяет и не удаляет записи во внешних системах.</p>
      {reviews.length ? <div className="pair-review-list">{reviews.map((review) => <PairReviewForm key={review.id} review={review} saving={saving} existingPairs={pairs} onAssign={assign} />)}</div> : <p className="empty-state">Открытых случаев ручной проверки нет.</p>}
    </section>
    <section className="panel pair-manager">
      <p className="eyebrow">РУЧНОЕ НАЗНАЧЕНИЕ</p><h3>Создать или переназначить пару</h3>
      <ManualPairForm saving={saving} existingPairs={pairs} onAssign={assign} />
    </section>
  </>;
}

function PairReviewForm({ review, saving, existingPairs, onAssign }: { review: PairReviewRow; saving: boolean; existingPairs: PairRow[]; onAssign: (input: { entityType: PairEntityType; bitrix24Id: string; moyskladId: string; moyskladType?: 'counterparty' | 'contactperson' | 'invoiceout'; moyskladParentId?: string; replaceExisting: boolean }) => Promise<void> }) {
  const [bitrix24Id, setBitrix24Id] = useState(review.sourceSystem === 'BITRIX24' ? review.sourceEntityId : '');
  const [moyskladId, setMoyskladId] = useState(review.sourceSystem === 'MOYSKLAD' ? review.sourceEntityId : '');
  const [moyskladType, setMoyskladType] = useState<'counterparty' | 'contactperson'>('counterparty');
  const [moyskladParentId, setMoyskladParentId] = useState('');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [localError, setLocalError] = useState('');
  const conflicts = existingPairs.filter((pair) => pair.entityType === review.entityType && (pair.bitrix24Id === bitrix24Id.trim() || pair.moyskladId === moyskladId.trim()));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError('');
    try {
      await onAssign({ entityType: review.entityType, bitrix24Id: bitrix24Id.trim(), moyskladId: moyskladId.trim(), ...(review.entityType === 'CONTACT' ? { moyskladType, ...(moyskladType === 'contactperson' ? { moyskladParentId: moyskladParentId.trim() } : {}) } : review.entityType === 'COMPANY' ? { moyskladType: 'counterparty' as const } : {}), replaceExisting });
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return <article className="pair-review-card">
    <div className="pair-review-heading"><div><span className="pair-entity">{pairEntityTypes.find((type) => type.id === review.entityType)?.label ?? review.entityType}</span><strong>{pairReviewReasonLabels[review.reason] ?? review.reason}</strong></div><time>{new Date(review.openedAt).toLocaleString()}</time></div>
    <form onSubmit={(event) => void submit(event)}>
      {review.sourceLabel && <p className="panel-description">Известная запись: {review.sourceLabel} · {review.sourceSystem} · ID {review.sourceEntityId}</p>}
      <label>Bitrix24 · ID записи<input required maxLength={200} value={bitrix24Id} onChange={(event) => setBitrix24Id(event.target.value)} /></label>
      <label>МойСклад · ID записи<input required maxLength={200} value={moyskladId} onChange={(event) => setMoyskladId(event.target.value)} /></label>
      {review.entityType === 'CONTACT' && <MoyskladContactTypeFields moyskladType={moyskladType} setMoyskladType={setMoyskladType} moyskladParentId={moyskladParentId} setMoyskladParentId={setMoyskladParentId} />}
      {replaceExisting && conflicts.length > 0 && <p className="pair-safety-note" role="status">Будет заменена активная связь: {conflicts.map((pair) => `${pair.bitrix24Label ?? 'Название не загружено'} (${pair.bitrix24Id}) ↔ ${pair.moyskladLabel ?? 'Название не загружено'} (${pair.moyskladId})`).join('; ')} → {bitrix24Id.trim()} ↔ {moyskladId.trim()}. Изменится связь в сервисе; внешние записи не изменяются.</p>}
      <label className="pair-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Я проверил, что это одна и та же запись в обеих системах.</label>
      <label className="pair-check"><input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} />Подтверждаю замену показанной активной пары (если она есть).</label>
      <button type="submit" disabled={!confirmed || saving}>Сохранить пару</button>
      {localError && <p className="inline-error" role="alert">{localError}</p>}
    </form>
  </article>;
}

function ManualPairForm({ saving, existingPairs, onAssign }: { saving: boolean; existingPairs: PairRow[]; onAssign: (input: { entityType: PairEntityType; bitrix24Id: string; moyskladId: string; moyskladType?: 'counterparty' | 'contactperson' | 'invoiceout'; moyskladParentId?: string; replaceExisting: boolean }) => Promise<void> }) {
  const [entityType, setEntityType] = useState<PairEntityType>('DEAL');
  const [bitrix24Id, setBitrix24Id] = useState('');
  const [moyskladId, setMoyskladId] = useState('');
  const [moyskladType, setMoyskladType] = useState<'counterparty' | 'contactperson'>('counterparty');
  const [moyskladParentId, setMoyskladParentId] = useState('');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [localError, setLocalError] = useState('');
  const conflicts = existingPairs.filter((pair) => pair.entityType === entityType && (pair.bitrix24Id === bitrix24Id.trim() || pair.moyskladId === moyskladId.trim()));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError('');
    try {
      await onAssign({ entityType, bitrix24Id: bitrix24Id.trim(), moyskladId: moyskladId.trim(), ...(entityType === 'CONTACT' ? { moyskladType, ...(moyskladType === 'contactperson' ? { moyskladParentId: moyskladParentId.trim() } : {}) } : entityType === 'COMPANY' ? { moyskladType: 'counterparty' as const } : entityType === 'INVOICE' ? { moyskladType: 'invoiceout' as const, ...(moyskladParentId ? { moyskladParentId: moyskladParentId.trim() } : {}) } : {}), replaceExisting });
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
      {entityType === 'CONTACT' && <MoyskladContactTypeFields moyskladType={moyskladType} setMoyskladType={setMoyskladType} moyskladParentId={moyskladParentId} setMoyskladParentId={setMoyskladParentId} />}
    {entityType === 'INVOICE' && <label>Связанный заказ МойСклад · ID<input maxLength={200} value={moyskladParentId} onChange={(event) => setMoyskladParentId(event.target.value)} /><small>Необязательно; при обработке связь всё равно проверяется через документ счёта.</small></label>}
    {replaceExisting && conflicts.length > 0 && <p className="pair-safety-note" role="status">Будет заменена активная связь: {conflicts.map((pair) => `${pair.bitrix24Label ?? 'Название не загружено'} (${pair.bitrix24Id}) ↔ ${pair.moyskladLabel ?? 'Название не загружено'} (${pair.moyskladId})`).join('; ')} → {bitrix24Id.trim()} ↔ {moyskladId.trim()}. События не переигрываются автоматически; новая пара применяется при следующем событии.</p>}
    <label className="pair-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Я проверил, что это одна и та же запись в обеих системах.</label>
    <label className="pair-check"><input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} />Подтверждаю замену показанной активной пары (если она есть).</label>
    <button type="submit" disabled={!confirmed || saving}>Сохранить пару</button>
    {localError && <p className="inline-error" role="alert">{localError}</p>}
  </form>;
}

function MoyskladContactTypeFields({ moyskladType, setMoyskladType, moyskladParentId, setMoyskladParentId }: { moyskladType: 'counterparty' | 'contactperson'; setMoyskladType: (value: 'counterparty' | 'contactperson') => void; moyskladParentId: string; setMoyskladParentId: (value: string) => void }) {
  return <>
    <label>Тип записи МойСклад<select required value={moyskladType} onChange={(event) => setMoyskladType(event.target.value as 'counterparty' | 'contactperson')}><option value="counterparty">Контрагент · физическое лицо</option><option value="contactperson">Контактное лицо компании</option></select></label>
    {moyskladType === 'contactperson' && <label>Родительский контрагент · ID<input required maxLength={200} value={moyskladParentId} onChange={(event) => setMoyskladParentId(event.target.value)} /></label>}
  </>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
