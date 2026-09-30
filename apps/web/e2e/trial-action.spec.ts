import { expect, test } from '@playwright/test';

test('outside Bitrix24 the admin workspace remains closed', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Откройте приложение внутри Bitrix24')).toBeVisible();
  await expect(page.getByLabel('Сообщение')).toHaveCount(0);
});
