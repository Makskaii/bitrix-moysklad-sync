import { expect, test } from '@playwright/test';

test('outside Bitrix24 the admin workspace remains closed', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED === '1', 'The default local preview run covers the preview shell; set ADMIN_PREVIEW_EXPECTED=0 to run this closed-shell scenario.');
  await page.goto('/');
  await expect(page.getByText('Откройте приложение внутри Bitrix24')).toBeVisible();
  await expect(page.getByLabel('Сообщение')).toHaveCount(0);
});

test('local preview opens the trial admin workspace outside Bitrix24', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED !== '1', 'Set ADMIN_PREVIEW_EXPECTED=1 to run the local preview shell scenario.');
  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/overview', (route) => route.fulfill({ json: { queue: {}, openManualReviews: 0, openPairReviews: 0, activePairs: 0, lastEventAt: null } }));
  await page.route('**/api/admin/audit**', (route) => route.fulfill({ json: { entries: [], nextCursor: null } }));
  await page.route('**/api/admin/trial-actions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode', (route) => route.fulfill({ json: { mode: 'off' } }));
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({ json: { status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null } }));
  await page.route('**/api/admin/sync-mode/database-recovery', (route) => route.fulfill({ json: {
    status: 'READY', previousLaunchBoundary: '2026-10-07T00:00:00.000Z', pairsRestored: true, lostEventsAcknowledged: true,
  } }));
  await page.route('**/api/admin/monitoring/queue**', (route) => route.fulfill({ json: { counts: {}, events: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/incidents**', (route) => route.fulfill({ json: { cases: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/logs**', (route) => route.fulfill({ json: { entries: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/api-attempts**', (route) => route.fulfill({ json: { attempts: [], nextCursor: null } }));
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Локальный предпросмотр');
  await expect(page.getByRole('status')).toContainText('настройки сохраняются только в локальную базу');
  await expect(page.getByLabel('Сообщение')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сохранить в базу' })).toBeEnabled();
});
