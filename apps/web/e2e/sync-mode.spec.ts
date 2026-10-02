import { expect, test } from '@playwright/test';

test('risky mode changes require UI confirmation and unavailable directions stay disabled', async ({ page }) => {
  const modeWrites: unknown[] = [];
  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/trial-actions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode', (route) => {
    if (route.request().method() === 'PATCH') {
      modeWrites.push(route.request().postDataJSON());
      return route.fulfill({ json: { mode: 'on' } });
    }
    return route.fulfill({ json: { mode: 'off' } });
  });
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({ json: { status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null } }));
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [
    { key: 'contacts-companies', label: 'Контакты ↔ контрагенты', ready: true, availability: 'Только EMAIL существующей пары', bitrix24ToMoysklad: true, moyskladToBitrix24: true },
    { key: 'deals-orders', label: 'Сделки ↔ заказы покупателей', ready: false, availability: 'Обмен этой сущности пока недоступен.', bitrix24ToMoysklad: false, moyskladToBitrix24: false },
  ] }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Выбрать режим on' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Включение разрешит обработку событий');
  expect(modeWrites).toHaveLength(0);
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect.poll(() => modeWrites).toEqual([{ mode: 'on', confirmed: true }]);
  const unavailable = page.locator('.entity-row').filter({ hasText: 'Сделки ↔ заказы покупателей' });
  await expect(unavailable.getByRole('checkbox')).toHaveCount(2);
  await expect(unavailable.getByRole('checkbox').nth(0)).toBeDisabled();
  await expect(unavailable.getByRole('checkbox').nth(1)).toBeDisabled();
});
