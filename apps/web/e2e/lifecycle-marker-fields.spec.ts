import { expect, test } from '@playwright/test';

test('lifecycle markers are editable, statuses are truthful, and restore is offered only in safe states', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED !== '1', 'This UI scenario uses the isolated local preview shell.');
  const rows = [
    { id: 'company-1', entityType: 'COMPANY', bitrix24Id: 'b-company', moyskladId: 'm-company', moyskladType: null, moyskladParentId: null, lifecycleStatus: 'TOMBSTONED', tombstonedAt: '2026-10-01T00:00:00.000Z', tombstoneSource: 'BITRIX24', tombstoneReason: 'DELETE', deletionMarkerStatus: 'MARKED', deletionTimelineStatus: 'NOT_REQUIRED' },
    { id: 'deal-1', entityType: 'DEAL', bitrix24Id: 'b-deal', moyskladId: 'm-deal', moyskladType: null, moyskladParentId: null, lifecycleStatus: 'TOMBSTONED', tombstonedAt: '2026-10-01T00:00:00.000Z', tombstoneSource: 'MOYSKLAD', tombstoneReason: 'DELETE', deletionMarkerStatus: 'CLEARING', deletionTimelineStatus: 'NOT_REQUIRED' },
    { id: 'product-1', entityType: 'PRODUCT', bitrix24Id: 'b-product', moyskladId: 'm-product', moyskladType: null, moyskladParentId: null, lifecycleStatus: 'TOMBSTONED', tombstonedAt: '2026-10-01T00:00:00.000Z', tombstoneSource: 'BITRIX24', tombstoneReason: 'DELETE', deletionMarkerStatus: 'FAILED', deletionTimelineStatus: 'NOT_REQUIRED' },
    { id: 'contact-1', entityType: 'CONTACT', bitrix24Id: 'b-contact', moyskladId: 'm-contact', moyskladType: 'counterparty', moyskladParentId: null, lifecycleStatus: 'TOMBSTONED', tombstonedAt: '2026-10-01T00:00:00.000Z', tombstoneSource: 'MOYSKLAD', tombstoneReason: 'DELETE', deletionMarkerStatus: 'NOT_REQUIRED', deletionTimelineStatus: 'NOT_REQUIRED' },
  ];
  let configuredFields: Record<string, string> = { COMPANY: 'UF_CRM_123' };
  let restoreRequests = 0;

  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/trial-actions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode', (route) => route.fulfill({ json: { mode: 'off' } }));
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({ json: { status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null } }));
  await page.route('**/api/admin/sync-mode/database-recovery', (route) => route.fulfill({ json: { status: 'READY', previousLaunchBoundary: null, pairsRestored: true, lostEventsAcknowledged: true } }));
  await page.route('**/api/admin/overview', (route) => route.fulfill({ json: { queue: {}, openManualReviews: 0, openPairReviews: 0, activePairs: 0, lastEventAt: null } }));
  await page.route('**/api/admin/audit**', (route) => route.fulfill({ json: { entries: [], nextCursor: null } }));
  await page.route('**/api/admin/field-settings', (route) => route.fulfill({ json: { version: 1, config: { rules: [], groups: [], references: { units: [], priceTypes: [], dictionaries: [] } } } }));
  await page.route('**/api/admin/field-settings/catalogs**', (route) => route.fulfill({ json: { units: { bitrix24: [], moysklad: [] }, priceTypes: { bitrix24: [], moysklad: [] }, dictionaries: [], namedReferences: {} } }));
  await page.route('**/api/admin/monitoring/queue**', (route) => route.fulfill({ json: { counts: {}, events: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/incidents**', (route) => route.fulfill({ json: { cases: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/logs**', (route) => route.fulfill({ json: { entries: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/api-attempts**', (route) => route.fulfill({ json: { attempts: [], nextCursor: null } }));
  await page.route('**/api/admin/pairs', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/pairs/reviews', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/clients/lifecycle', (route) => route.fulfill({ json: rows }));
  await page.route('**/api/admin/clients/lifecycle/marker-fields', async (route) => {
    if (route.request().method() === 'PUT') {
      configuredFields = (route.request().postDataJSON() as { fields: Record<string, string> }).fields;
    }
    await route.fulfill({ json: { fields: configuredFields } });
  });
  await page.route('**/api/admin/clients/lifecycle/*/restore', async (route) => {
    restoreRequests++;
    await route.fulfill({ json: { status: 'RESTORED' } });
  });
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Связи записей' }).click();
  await expect(page.getByText(/жизненный цикл клиента/i)).toBeVisible();
  await expect(page.getByLabel('Компания · код UF-поля')).toHaveValue('UF_CRM_123');
  await page.getByLabel('Товар · код UF-поля').fill('UF_CRM_PRODUCT_123');
  await page.getByRole('button', { name: 'Сохранить настройки меток' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Поля меток сохранены на сервере' })).toBeVisible();
  expect(configuredFields.PRODUCT).toBe('UF_CRM_PRODUCT_123');

  const companyRow = page.locator('.pair-card').filter({ hasText: 'b-company' });
  await expect(companyRow.getByRole('button', { name: /очистить метку.*восстановить/i })).toBeVisible();
  const dealRow = page.locator('.pair-card').filter({ hasText: 'b-deal' });
  await expect(dealRow.getByText('Восстановление ожидает завершения операции с меткой удаления.')).toBeVisible();
  await expect(dealRow.getByRole('button', { name: /восстановить/i })).toHaveCount(0);
  const productRow = page.locator('.pair-card').filter({ hasText: 'b-product' });
  await expect(productRow.getByRole('button', { name: /очистить метку.*восстановить/i })).toBeVisible();
  await expect(productRow.getByText('Товар')).toBeVisible();
  const contactRow = page.locator('.pair-card').filter({ hasText: 'b-contact' });
  await expect(contactRow.getByRole('button', { name: /очистить метку.*восстановить/i })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await companyRow.getByRole('button', { name: /очистить метку.*восстановить/i }).click();
  await expect.poll(() => restoreRequests).toBe(1);
});
