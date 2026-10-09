import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/monitoring/queue**', (route) => route.fulfill({ json: { counts: {}, events: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/incidents**', (route) => route.fulfill({ json: { cases: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/logs**', (route) => route.fulfill({ json: { entries: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/api-attempts**', (route) => route.fulfill({ json: { attempts: [], nextCursor: null } }));
});

test('administrator can navigate the agreed shell without placeholder actions sending writes', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED !== '1');

  const writes: string[] = [];
  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/trial-actions', (route) => {
    if (route.request().method() !== 'GET') writes.push(route.request().url());
    return route.fulfill({ json: [] });
  });
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/entities/*', (route) => {
    if (route.request().method() !== 'GET') writes.push(route.request().url());
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({
    json: { status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null },
  }));
  await page.route('**/api/admin/sync-mode', (route) => {
    if (route.request().method() !== 'GET') writes.push(route.request().url());
    return route.fulfill({ json: { mode: 'off' } });
  });
  await page.route('**/api/admin/monitoring/queue', (route) => route.fulfill({ json: {
    counts: { RECEIVED: 1 }, events: [{ id: 'event-1', source: 'BITRIX24', eventType: 'ONCRMDEALUPDATE', externalEntityId: '42', status: 'RECEIVED', receivedAt: '2026-10-06T10:00:00.000Z', attempts: 0, direction: null, lastErrorCategory: null }], nextCursor: null,
  } }));
  await page.route('**/api/admin/monitoring/incidents?*', (route) => route.fulfill({ json: {
    cases: [{ id: 'incident-1', eventId: 'event-1', source: 'BITRIX24', externalEntityId: '42', reason: 'validation_failed', diagnostic: null, status: 'OPEN', openedAt: '2026-10-06T10:00:00.000Z' }], nextCursor: null,
  } }));
  await page.route('**/api/admin/monitoring/logs?*', (route) => route.fulfill({ json: {
    entries: [{ id: 'log-1', category: 'EVENT', message: 'Inbound event accepted', referenceId: 'event-1', occurredAt: '2026-10-06T10:00:00.000Z' }], nextCursor: null,
  } }));
  await page.route('**/api/admin/monitoring/api-attempts', (route) => route.fulfill({ json: { attempts: [], nextCursor: null } }));
  await page.route('**/api/admin/field-settings', (route) => route.fulfill({ json: {
    version: 1, createdAt: '2026-10-07T00:00:00.000Z', config: { rules: [], groups: [], references: { units: [], priceTypes: [], dictionaries: [] } },
  } }));
  await page.route('**/api/admin/field-settings/catalogs', (route) => route.fulfill({ json: {
    units: { bitrix24: [], moysklad: [] }, priceTypes: { bitrix24: [], moysklad: [] }, dictionaries: [],
  } }));
  await page.route('**/api/admin/field-settings/catalogs?*', (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));

  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Разделы админки' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
  await expect(page.getByText('Нет достоверных данных', { exact: false }).first()).toBeVisible();

  const sections = [
    ['Очередь и попытки', 'Очередь и попытки'],
    ['Связи записей', 'Пары Bitrix24 и МойСклад'],
    ['Ручная проверка', 'Ручная проверка'],
    ['Настройки', 'Настройки сущностей и направлений'],
    ['Справочники', 'Справочники'],
    ['Соответствия полей', 'Соответствия полей'],
    ['Логи', 'Логи и история API'],
  ];
  for (const [label, heading] of sections) {
    await page.getByRole('button', { name: label }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Очередь и попытки' }).click();
  await expect(page.getByText('ONCRMDEALUPDATE')).toBeVisible();
  await page.getByRole('button', { name: 'Ручная проверка' }).click();
  await expect(page.getByText('validation_failed')).toBeVisible();
  await page.getByRole('button', { name: 'Логи', exact: true }).click();
  await expect(page.getByText('Inbound event accepted')).toBeVisible();

  await page.getByRole('button', { name: 'Соответствия полей' }).click();
  await expect(page.getByText('Версия 1', { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

test('admin shell navigation is withheld after an access denial', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED !== '1');

  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/trial-actions', (route) => route.fulfill({ status: 403, json: { message: 'Administrator access required' } }));
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/admin/sync-mode', (route) => route.fulfill({ json: { mode: 'off' } }));
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Доступ закрыт' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Разделы админки' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Доступ только для администратора Bitrix24');
});

test('admin shell shows a loading failure without opening administrative sections', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED !== '1');

  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/trial-actions', (route) => route.abort());
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Доступ закрыт' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Разделы админки' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toBeVisible();
});

test('admin navigation stays hidden while protected workspace data is loading', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED !== '1');

  let finishLoading!: () => void;
  const dataReady = new Promise<void>((resolve) => { finishLoading = resolve; });
  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/trial-actions', async (route) => {
    await dataReady;
    await route.fulfill({ json: [] });
  });
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({ json: { status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null } }));
  await page.route('**/api/admin/sync-mode', (route) => route.fulfill({ json: { mode: 'off' } }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Проверяем доступ…' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Разделы админки' })).toHaveCount(0);
  finishLoading();
  await expect(page.getByRole('navigation', { name: 'Разделы админки' })).toBeVisible();
});

test('admin shell closes when a protected setting is denied by the server', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED !== '1');

  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/trial-actions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({ json: { status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null } }));
  await page.route('**/api/admin/sync-mode', (route) => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 403, json: { message: 'Administrator access required' } })
    : route.fulfill({ json: { mode: 'off' } }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать режим on' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Подтвердить' }).click();

  await expect(page.getByRole('heading', { name: 'Доступ закрыт' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Разделы админки' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Доступ только для администратора Bitrix24');
});

test('settings show a failure instead of implying a successful update', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED !== '1');

  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/trial-actions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({ json: { status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null } }));
  await page.route('**/api/admin/sync-mode', (route) => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 503, json: { message: 'Service unavailable' } })
    : route.fulfill({ json: { mode: 'off' } }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать режим on' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Подтвердить' }).click();

  await expect(page.getByRole('alert')).toContainText('Не удалось изменить режим обмена');
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Разделы админки' })).toBeVisible();
});

test('monitoring closes the admin workspace when a protected action is denied', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED !== '1');

  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/trial-actions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({ json: { status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null } }));
  await page.route('**/api/admin/sync-mode', (route) => route.fulfill({ json: { mode: 'off' } }));
  await page.route('**/api/admin/monitoring/incidents?*', (route) => route.fulfill({ json: {
    cases: [{ id: 'incident-1', eventId: 'event-1', source: 'BITRIX24', externalEntityId: '42', reason: 'validation_failed', diagnostic: null, status: 'OPEN', openedAt: '2026-10-06T10:00:00.000Z' }], nextCursor: null,
  } }));
  await page.route('**/api/admin/monitoring/incidents/*/retry', (route) => route.fulfill({ status: 403, json: { message: 'Administrator access required' } }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Ручная проверка' }).click();
  await page.getByRole('button', { name: 'Повторить' }).click();

  await expect(page.getByRole('heading', { name: 'Доступ закрыт' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Разделы админки' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Доступ только для администратора Bitrix24');
});
