import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type TrialAction = { id: string; message: string; createdAt: string };
const trialActionsEndpoint = '/api/trial-actions';

function App() {
  const [actions, setActions] = useState<TrialAction[]>([]);
  const [message, setMessage] = useState('Проверка контура');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [serviceStatus, setServiceStatus] = useState('Проверяем сервис…');

  async function refresh() {
    const response = await fetch(trialActionsEndpoint);
    if (!response.ok) throw new Error('Не удалось загрузить пробные действия');
    setActions(await response.json() as TrialAction[]);
  }

  useEffect(() => {
    fetch('/health').then((response) => {
      if (!response.ok) throw new Error('Сервис недоступен');
      return response.json() as Promise<{ status: string; database: string }>;
    }).then((health) => setServiceStatus(health.database === 'ok' ? 'Сервис и база доступны' : 'База недоступна'))
      .catch(() => setServiceStatus('Сервис недоступен'));
    refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const response = await fetch(trialActionsEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) throw new Error('Не удалось сохранить действие');
      setMessage('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return <main>
    <header><div className="mark">↔</div><div><p className="eyebrow">ЛОКАЛЬНЫЙ СТЕНД</p><h1>Контур синхронизации</h1></div><span className="status"><i />{serviceStatus}</span></header>
    <section className="intro"><div><p className="eyebrow">ПЕРВЫЙ РАБОЧИЙ КОНТУР</p><h2>Проверим, что путь целиком живой</h2><p>Создайте пробное действие. API сохранит его в PostgreSQL, а список ниже загрузится из базы.</p></div><div className="flow"><span>Интерфейс</span><b>→</b><span>API</span><b>→</b><span>PostgreSQL</span></div></section>
    <section className="workspace">
      <form onSubmit={submit} className="card form"><p className="eyebrow">ПРОБНОЕ ДЕЙСТВИЕ</p><h3>Добавить запись</h3><label htmlFor="message">Сообщение</label><input id="message" value={message} maxLength={200} onChange={(event) => setMessage(event.target.value)} placeholder="Например: проверка запуска" required /><button disabled={!message.trim()} type="submit">Сохранить в базу <span>→</span></button>{error && <p role="alert" className="error">{error}</p>}</form>
      <section className="card records"><div className="records-head"><div><p className="eyebrow">POSTGRESQL</p><h3>Сохранённые действия</h3></div><span className="count">{actions.length}</span></div>{loading ? <p className="empty">Загружаем записи…</p> : actions.length === 0 ? <p className="empty">Пока пусто. Добавьте первую пробную запись.</p> : <ul>{actions.map((action) => <li key={action.id}><span className="record-icon">✓</span><span className="record-copy"><strong>{action.message}</strong><small>{new Date(action.createdAt).toLocaleString('ru-RU')}</small></span></li>)}</ul>}</section>
    </section>
    <footer><span>Все данные остаются в локальной базе</span><span>PostgreSQL · Prisma · NestJS</span></footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
