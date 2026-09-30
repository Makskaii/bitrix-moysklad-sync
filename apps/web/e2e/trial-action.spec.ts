import { expect, test } from '@playwright/test';

test('a trial action is saved and remains visible after reload', async ({ page }) => {
  const message = `browser-path-${Date.now()}`;

  await page.goto('/');
  await expect(page.getByText('Сервис и база доступны')).toBeVisible();
  await page.getByLabel('Сообщение').fill(message);
  await page.getByRole('button', { name: /Сохранить в базу/ }).click();
  await expect(page.locator('.record-copy strong').filter({ hasText: message })).toBeVisible();

  await page.reload();
  await expect(page.locator('.record-copy strong').filter({ hasText: message })).toBeVisible();
});
