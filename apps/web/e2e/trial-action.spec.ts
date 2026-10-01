import { expect, test } from '@playwright/test';

test('outside Bitrix24 the admin workspace remains closed', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED === '1');
  await page.goto('/');
  await expect(page.getByText('Откройте приложение внутри Bitrix24')).toBeVisible();
  await expect(page.getByLabel('Сообщение')).toHaveCount(0);
});

test('local preview opens the trial admin workspace outside Bitrix24', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED !== '1');
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Локальный режим просмотра');
  await expect(page.getByLabel('Сообщение')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сохранить в базу' })).toBeEnabled();
});
