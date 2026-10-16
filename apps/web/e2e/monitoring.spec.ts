import { expect, test } from '@playwright/test';

test('admin can browse queue, manual-review cases, separate log categories, and API attempts', async ({ page }) => {
  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/trial-actions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode', (route) => route.fulfill({ json: { mode: 'on' } }));
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({ json: { status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null } }));
  await page.route('**/api/admin/sync-mode/database-recovery', (route) => route.fulfill({ json: {
    status: 'READY', previousLaunchBoundary: '2026-10-07T00:00:00.000Z', pairsRestored: true, lostEventsAcknowledged: true,
  } }));
  await page.route('**/api/admin/overview', (route) => route.fulfill({ json: {
    mode: 'on', queue: { RETRYABLE_FAILURE: 1 }, openManualReviews: 1, openPairReviews: 2, activePairs: 12, lastEventAt: '2026-10-05T10:00:00.000Z',
  } }));
  await page.route('**/api/admin/audit*', (route) => route.fulfill({ json: { entries: [{
    id: 'audit-1', actorId: 'BITRIX24_USER:7', action: 'PAIR_REASSIGNED', targetType: 'EntityPair', targetId: 'pair-1', reason: 'Verified IDs',
    before: { moyskladId: 'old-uuid' }, after: { moyskladId: 'new-uuid' }, occurredAt: '2026-10-05T08:00:00.000Z',
  }], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/queue')) return route.fulfill({ json: { counts: { RETRYABLE_FAILURE: 1 }, events: [{ id: 'event-1', source: 'BITRIX24', eventType: 'ONCRMCONTACTUPDATE', externalEntityId: '42', status: 'RETRYABLE_FAILURE', receivedAt: '2026-10-05T10:00:00.000Z', attempts: 2, direction: null, lastErrorCategory: 'EXTERNAL_API_FAILURE' }], nextCursor: null } });
    if (url.pathname.endsWith('/incidents')) return route.fulfill({ json: { cases: [{ id: 'case-1', eventId: 'event-2', source: 'MOYSKLAD', externalEntityId: 'counterparty-1', reason: 'REVIEW_REQUIRED', status: 'OPEN', openedAt: '2026-10-05T09:00:00.000Z' }], nextCursor: null } });
    if (url.pathname.endsWith('/logs')) return route.fulfill({ json: { entries: [{ id: 'log-1', category: url.searchParams.get('category') ?? 'EVENT', message: 'Задача выполнена', occurredAt: '2026-10-05T08:00:00.000Z', referenceId: null }], nextCursor: null } });
    return route.fulfill({ json: { attempts: [{ id: 'api-1', eventId: 'event-1', provider: 'BITRIX24', operation: 'crm.contact.get', method: 'POST', statusCode: 200, succeeded: true, occurredAt: '2026-10-05T08:00:00.000Z' }], nextCursor: null } });
  });
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));

  await page.goto('/');
  await expect(page.getByText('12', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Очередь и попытки' }).click();
  await expect(page.getByRole('heading', { name: 'Очередь и попытки', exact: true })).toBeVisible();
  await expect(page.getByText('RETRYABLE_FAILURE', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('BITRIX24 · crm.contact.get').first()).toBeVisible();

  await page.getByRole('button', { name: /Ручная проверка/ }).click();
  await expect(page.getByText('REVIEW_REQUIRED', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();

  await page.getByRole('button', { name: 'Логи', exact: true }).click();
  await page.getByRole('button', { name: 'Действия вручную' }).click();
  await expect(page.getByText('Задача выполнена')).toBeVisible();
  await expect(page.getByText('BITRIX24 · crm.contact.get')).toBeVisible();
  await expect(page.getByText('PAIR_REASSIGNED · EntityPair')).toBeVisible();
  await page.getByText('До / после').click();
  await expect(page.getByText('old-uuid')).toBeVisible();
});
