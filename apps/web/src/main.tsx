import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type TrialAction = { id: string; message: string; createdAt: string };
type BitrixAuth = { access_token: string };
type BitrixSdk = { init(callback: () => void): void; getAuth(): BitrixAuth | false };
declare global { interface Window { BX24?: BitrixSdk } }
const trialActionsEndpoint = '/api/admin/trial-actions';

function App() {
  const [actions, setActions] = useState<TrialAction[]>([]);
  const [message, setMessage] = useState('Проверка контура');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [serviceStatus, setServiceStatus] = useState('Проверяем сервис…');
  const [accessToken, setAccessToken] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);

  async function refresh(token = accessToken) {
    const response = await fetch(trialActionsEndpoint, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (response.status === 403) throw new Error('Доступ только для администратора Bitrix24');
    if (!response.ok) throw new Error('Не удалось загрузить пробные действия');
    setActions(await response.json() as TrialAction[]);
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

  return <main>
    {previewMode && <aside className="preview-banner" role="status">Локальный режим просмотра — проверка прав Bitrix24 отключена</aside>}
    <header><div className="mark">↔</div><div><p className="eyebrow">BITRIX24 · АДМИН-ПАНЕЛЬ</p><h1>Контур синхронизации</h1></div><span className="status"><i />{serviceStatus}</span></header>
    <section className="intro"><div><p className="eyebrow">{previewMode ? 'ЛОКАЛЬНЫЙ ПРОСМОТР' : 'ДОСТУП ПО ПРАВАМ BITRIX24'}</p><h2>Управление контуром</h2><p>{previewMode ? 'Пробный экран доступен в локальном режиме просмотра.' : 'Сервер проверяет права текущего пользователя через Bitrix24 при каждом административном запросе.'}</p></div><div className="flow"><span>Bitrix24</span><b>→</b><span>API</span><b>→</b><span>PostgreSQL</span></div></section>
    {authorized ? <section className="workspace">
      <form onSubmit={submit} className="card form"><p className="eyebrow">ПРОБНОЕ ДЕЙСТВИЕ</p><h3>Добавить запись</h3><label htmlFor="message">Сообщение</label><input id="message" value={message} maxLength={200} onChange={(event) => setMessage(event.target.value)} placeholder="Например: проверка запуска" required /><button disabled={!message.trim() || (!accessToken && !previewMode) || loading} type="submit">Сохранить в базу <span>→</span></button>{error && <p role="alert" className="error">{error}</p>}</form>
      <section className="card records"><div className="records-head"><div><p className="eyebrow">POSTGRESQL</p><h3>Сохранённые действия</h3></div><span className="count">{actions.length}</span></div>{loading ? <p className="empty">Загружаем записи…</p> : actions.length === 0 ? <p className="empty">Пока пусто. Добавьте первую пробную запись.</p> : <ul>{actions.map((action) => <li key={action.id}><span className="record-icon">✓</span><span className="record-copy"><strong>{action.message}</strong><small>{new Date(action.createdAt).toLocaleString('ru-RU')}</small></span></li>)}</ul>}</section>
    </section> : <section className="card access-state"><h3>{loading ? 'Проверяем доступ…' : 'Доступ закрыт'}</h3>{error && <p role="alert" className="error">{error}</p>}</section>}
    <footer><span>Все данные остаются в локальной базе</span><span>PostgreSQL · Prisma · NestJS</span></footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
