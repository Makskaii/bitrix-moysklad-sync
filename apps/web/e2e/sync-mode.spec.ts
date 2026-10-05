import { expect, test } from '@playwright/test';

test('risky mode changes require UI confirmation and unavailable directions stay disabled', async ({ page }) => {
  const modeWrites: unknown[] = [];
  const directionWrites: unknown[] = [];
  let currentMode = 'off';
  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
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
  await page.route('**/api/admin/sync-mode/entities/*', (route) => {
    directionWrites.push(route.request().postDataJSON());
    return route.fulfill({ json: { key: 'contacts-companies', bitrix24ToMoysklad: false, moyskladToBitrix24: true } });
  });
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({ json: { status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null } }));
  await page.route('**/api/admin/monitoring/queue', (route) => route.fulfill({ json: { counts: {}, events: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/incidents*', (route) => route.fulfill({ json: { cases: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/logs*', (route) => route.fulfill({ json: { entries: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/api-attempts*', (route) => route.fulfill({ json: { attempts: [], nextCursor: null } }));
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [
    { key: 'contacts-companies', label: 'Контакты ↔ контрагенты', ready: true, availability: 'Только EMAIL существующей пары', bitrix24ToMoysklad: true, moyskladToBitrix24: true },
    { key: 'deals-orders', label: 'Сделки ↔ заказы покупателей', ready: false, availability: 'Обмен этой сущности пока недоступен.', bitrix24ToMoysklad: false, moyskladToBitrix24: false },
    { key: 'invoices', label: 'Счета ↔ счета покупателям', ready: false, availability: 'Обмен этой сущности пока недоступен.', bitrix24ToMoysklad: false, moyskladToBitrix24: false },
    { key: 'products-variations', label: 'Товары ↔ товары и модификации', ready: false, availability: 'Обмен этой сущности пока недоступен.', bitrix24ToMoysklad: false, moyskladToBitrix24: false },
    { key: 'service-dictionary', label: 'Справочник услуг ↔ поле справочника заказа', ready: false, availability: 'Обмен этой сущности пока недоступен.', bitrix24ToMoysklad: false, moyskladToBitrix24: false },
  ] }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Выбрать режим on' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Включение разрешит обработку событий');
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
  await expect(directionDialog).toContainText('новых событий');
  expect(directionWrites).toHaveLength(0);
  await directionDialog.getByRole('button', { name: 'Подтвердить' }).click();
  await expect.poll(() => directionWrites).toEqual([{ bitrix24ToMoysklad: false, moyskladToBitrix24: true, confirmed: true }]);
  const unavailable = page.locator('.entity-row').filter({ hasText: 'Сделки ↔ заказы покупателей' });
  await expect(page.locator('.entity-row')).toHaveCount(5);
  await expect(page.getByText('Соответствия сотрудников, организаций, складов, валют')).toHaveCount(0);
  await expect(unavailable.getByRole('checkbox')).toHaveCount(2);
  await expect(unavailable.getByRole('checkbox').nth(0)).toBeDisabled();
  await expect(unavailable.getByRole('checkbox').nth(1)).toBeDisabled();
});
