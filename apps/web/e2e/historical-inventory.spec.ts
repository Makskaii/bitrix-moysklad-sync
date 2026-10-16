import { expect, test } from '@playwright/test';

test('historical inventory browses each provider independently and resets pages for a new run', async ({ page }) => {
  let runId = 'run-one';
  const cursors: Record<string, string[]> = { BITRIX24: [], MOYSKLAD: [] };
  let firstB24Page = true;
  let releaseStaleB24Page!: () => void;
  let staleB24PageStarted!: () => void;
  const staleB24Gate = new Promise<void>((resolve) => { releaseStaleB24Page = resolve; });
  const staleB24Started = new Promise<void>((resolve) => { staleB24PageStarted = resolve; });
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
  await page.route('**/api/admin/historical-inventory', (route) => route.fulfill({ json: {
    runId, status: 'complete', phase: 'COMPLETE', bitrixStart: 0, moyskladOffset: 0, bitrixProcessed: 51, moyskladProcessed: 51,
    bitrixTotal: 51, moyskladTotal: 51, bitrixPageSize: 50, moyskladPageSize: 500, requestIntervalMs: 1000,
    error: null, retryAfter: null, checkpointAt: '2026-10-07T00:00:00.000Z', leaseUntil: null, pauseRequested: false, stats: [],
  } }));
  await page.route('**/api/admin/historical-inventory/entries?*', async (route) => {
    const url = new URL(route.request().url());
    const source = url.searchParams.get('source')!;
    const cursor = url.searchParams.get('cursor');
    cursors[source].push(cursor ?? 'first');
    if (source === 'BITRIX24' && !cursor && firstB24Page) {
      firstB24Page = false;
      staleB24PageStarted();
      await staleB24Gate;
      return route.fulfill({ json: { entries: [{ source, externalId: 'stale-deal', label: 'stale response', fields: [], observedAt: '2026-10-07T00:00:00.000Z' }], nextCursor: null } });
    }
    const prefix = source === 'BITRIX24' ? 'deal' : 'order';
    const entries = cursor
      ? [{ source, externalId: `${prefix}-051`, label: `${prefix} 51`, fields: [], observedAt: '2026-10-07T00:00:00.000Z' }]
      : Array.from({ length: 50 }, (_, index) => ({ source, externalId: `${prefix}-${String(index + 1).padStart(3, '0')}`, label: `${prefix} ${index + 1}`, fields: [], observedAt: '2026-10-07T00:00:00.000Z' }));
    await route.fulfill({ json: { entries, nextCursor: cursor ? null : `${prefix}-050` } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Исторический каталог' }).click();
  await expect(page.getByRole('heading', { name: 'Фоновый каталог' })).toBeVisible();
  await staleB24Started;
  await page.getByRole('button', { name: 'Обновить' }).click();
  await expect(page.getByText('deal 50', { exact: true })).toBeVisible();
  releaseStaleB24Page();
  await expect(page.getByText('stale response', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Загрузить следующие: сделки bitrix24' }).click();
  await expect(page.getByText('deal 51', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Загрузить следующие: заказы покупателей мойсклад' })).toBeVisible();
  await page.getByRole('button', { name: 'Загрузить следующие: заказы покупателей мойсклад' }).click();
  await expect(page.getByText('order 51', { exact: true })).toBeVisible();
  expect(cursors.BITRIX24).toEqual(['first', 'first', 'deal-050']);
  expect(cursors.MOYSKLAD).toEqual(['first', 'first', 'order-050']);

  runId = 'run-two';
  await page.getByRole('button', { name: 'Обновить' }).click();
  await expect(page.getByText('deal 51', { exact: true })).toHaveCount(0);
  await expect(page.getByText('order 51', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Загрузить следующие: сделки bitrix24' })).toBeVisible();
  expect(cursors.BITRIX24).toEqual(['first', 'first', 'deal-050', 'first']);
  expect(cursors.MOYSKLAD).toEqual(['first', 'first', 'order-050', 'first']);
});
