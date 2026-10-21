import { expect, test } from '@playwright/test';

test('risky mode changes require UI confirmation and unavailable directions stay disabled', async ({ page }) => {
  const modeWrites: unknown[] = [];
  const directionWrites: unknown[] = [];
  const preflightReads: string[] = [];
  let currentMode = 'off';
  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/overview', (route) => route.fulfill({ json: { queue: {}, openManualReviews: 0, openPairReviews: 0, activePairs: 0, lastEventAt: null } }));
  await page.route('**/api/admin/audit**', (route) => route.fulfill({ json: { entries: [], nextCursor: null } }));
  await page.route('**/api/admin/trial-actions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode', (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as { mode: string };
      modeWrites.push(body);
      currentMode = body.mode;
      return route.fulfill({ json: { mode: currentMode } });
    }
    return route.fulfill({ json: { mode: currentMode } });
  });
  await page.route('**/api/admin/sync-mode/entities/*/preflight?*', (route) => {
    const url = new URL(route.request().url());
    preflightReads.push(url.pathname + url.search);
    const blocked = url.pathname.includes('deals-orders');
    return route.fulfill({ json: { entityKey: blocked ? 'deals-orders' : 'invoices', direction: url.searchParams.get('direction'), settingsVersion: blocked ? null : 7, canEnable: !blocked, blockers: blocked ? [{ code: 'FIELD_SETTINGS_UNAVAILABLE', message: 'Настройки недоступны' }] : [], warnings: [] } });
  });
  await page.route('**/api/admin/sync-mode/entities/*', (route) => {
    if (route.request().method() === 'PATCH') {
      directionWrites.push(route.request().postDataJSON());
      return route.fulfill({ json: { key: 'invoices', bitrix24ToMoysklad: true, moyskladToBitrix24: false } });
    }
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({ json: { status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null } }));
  await page.route('**/api/admin/sync-mode/database-recovery', (route) => route.fulfill({ json: {
    status: 'READY', previousLaunchBoundary: '2026-10-07T00:00:00.000Z', pairsRestored: true, lostEventsAcknowledged: true,
  } }));
  await page.route('**/api/admin/monitoring/queue', (route) => route.fulfill({ json: { counts: {}, events: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/incidents*', (route) => route.fulfill({ json: { cases: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/logs*', (route) => route.fulfill({ json: { entries: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/api-attempts*', (route) => route.fulfill({ json: { attempts: [], nextCursor: null } }));
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [
    { key: 'contacts-companies', label: 'Контакты ↔ контрагенты', ready: true, implementation: 'partial', supportedDirections: ['bitrix24ToMoysklad', 'moyskladToBitrix24'], availability: 'Только EMAIL существующей пары', bitrix24ToMoysklad: true, moyskladToBitrix24: true },
    { key: 'deals-orders', label: 'Сделки ↔ заказы покупателей', ready: true, implementation: 'implemented', supportedDirections: ['bitrix24ToMoysklad', 'moyskladToBitrix24'], availability: 'Требуется preflight.', bitrix24ToMoysklad: false, moyskladToBitrix24: false },
    { key: 'invoices', label: 'Счета ↔ счета покупателям', ready: true, implementation: 'implemented', supportedDirections: ['bitrix24ToMoysklad', 'moyskladToBitrix24'], availability: 'Требуется preflight.', bitrix24ToMoysklad: false, moyskladToBitrix24: false },
    { key: 'products-variations', label: 'Товары ↔ товары и модификации', ready: true, implementation: 'implemented', supportedDirections: ['moyskladToBitrix24'], availability: 'Требуется preflight.', bitrix24ToMoysklad: false, moyskladToBitrix24: false },
    { key: 'service-dictionary', label: 'Справочник услуг ↔ поле справочника заказа', ready: false, implementation: 'not_implemented', supportedDirections: [], availability: 'Обмен этой сущности пока недоступен.', bitrix24ToMoysklad: false, moyskladToBitrix24: false },
  ] }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать режим on' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('уже включённых и прошедших preflight направлений');
  expect(modeWrites).toHaveLength(0);
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect.poll(() => modeWrites).toEqual([{ mode: 'on', confirmed: true }]);
  await page.getByRole('button', { name: 'Выбрать режим pause' }).click();
  const pauseDialog = page.getByRole('alertdialog', { name: 'Подтвердите изменение режима' });
  await expect(pauseDialog).toContainText('Пауза остановит обработку');
  expect(modeWrites).toHaveLength(1);
  await pauseDialog.getByRole('button', { name: 'Подтвердить' }).click();
  await expect.poll(() => modeWrites).toEqual([
    { mode: 'on', confirmed: true },
    { mode: 'pause', confirmed: true },
  ]);
  const ready = page.locator('.entity-row').filter({ hasText: 'Контакты ↔ контрагенты' });
  await ready.getByRole('checkbox').nth(0).click();
  const directionDialog = page.getByRole('alertdialog', { name: 'Подтвердите изменение направления' });
  await expect(directionDialog).toContainText('Проверка использует только выбранную сущность');
  expect(directionWrites).toHaveLength(0);
  await directionDialog.getByRole('button', { name: 'Подтвердить' }).click();
  await expect.poll(() => directionWrites).toEqual([{ bitrix24ToMoysklad: false, moyskladToBitrix24: true, confirmed: true }]);
  const unavailable = page.locator('.entity-row').filter({ hasText: 'Справочник услуг ↔ поле справочника заказа' });
  await expect(page.locator('.entity-row')).toHaveCount(5);
  await expect(page.getByText('Соответствия сотрудников, организаций, складов, валют')).toHaveCount(0);
  await expect(unavailable.getByRole('checkbox').nth(0)).toBeDisabled();
  await expect(unavailable.getByRole('checkbox').nth(1)).toBeDisabled();

  const dealRow = page.locator('.entity-row').filter({ hasText: 'Сделки ↔ заказы покупателей' });
  await dealRow.getByRole('checkbox').nth(0).click();
  const blockedDialog = page.getByRole('alertdialog', { name: 'Подтвердите изменение направления' });
  await expect(blockedDialog).toContainText('Настройки недоступны');
  await expect(blockedDialog.getByRole('button', { name: 'Подтвердить' })).toBeDisabled();
  expect(directionWrites).toHaveLength(1);
  await blockedDialog.getByRole('button', { name: 'Отмена' }).click();

  const invoiceRow = page.locator('.entity-row').filter({ hasText: 'Счета ↔ счета покупателям' });
  await invoiceRow.getByRole('checkbox').nth(0).click();
  const readyDialog = page.getByRole('alertdialog', { name: 'Подтвердите изменение направления' });
  await expect(readyDialog).toContainText('Настройки версии: 7');
  await expect(readyDialog.getByRole('button', { name: 'Подтвердить' })).toBeEnabled();
  await readyDialog.getByRole('button', { name: 'Подтвердить' }).click();
  await expect.poll(() => directionWrites).toHaveLength(2);
  expect(preflightReads.some((path) => path.includes('/invoices/preflight?direction=bitrix24ToMoysklad'))).toBe(true);
});
