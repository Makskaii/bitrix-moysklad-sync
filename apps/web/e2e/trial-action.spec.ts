import { expect, test } from '@playwright/test';

test('outside Bitrix24 the admin workspace remains closed', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED === '1');
  await page.goto('/');
  await expect(page.getByText('Откройте приложение внутри Bitrix24')).toBeVisible();
  await expect(page.getByLabel('Сообщение')).toHaveCount(0);
});

test('local preview opens the trial admin workspace outside Bitrix24', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED !== '1');
  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/trial-actions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode', (route) => route.fulfill({ json: { mode: 'off' } }));
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({ json: { status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null } }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Локальный режим просмотра');
  await expect(page.getByLabel('Сообщение')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сохранить в базу' })).toBeEnabled();
});
