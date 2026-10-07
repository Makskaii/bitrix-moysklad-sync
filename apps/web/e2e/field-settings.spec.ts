import { expect, test } from '@playwright/test';

test('field settings preview is read-only and saving requires an explicit warning confirmation', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED !== '1');
  const writes: string[] = [];
  let version = 1;
  const config = { rules: [], groups: [], references: {
    units: [{ bitrix24Id: 14, bitrix24Code: '1720010507', moyskladId: null, moyskladCode: null, status: 'unmapped' }],
    priceTypes: [], dictionaries: [],
  } };
  await page.route('**/api/admin/preview-mode', (route) => route.fulfill({ json: { enabled: true } }));
  await page.route('**/api/admin/trial-actions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/entities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/admin/sync-mode/recovery', (route) => route.fulfill({ json: { status: 'idle', provider: 'BITRIX24', bitrixStart: 0, moyskladOffset: 0, error: null } }));
  await page.route('**/api/admin/sync-mode', (route) => route.fulfill({ json: { mode: 'off' } }));
  await page.route('**/api/admin/monitoring/queue**', (route) => route.fulfill({ json: { counts: {}, events: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/incidents**', (route) => route.fulfill({ json: { cases: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/logs**', (route) => route.fulfill({ json: { entries: [], nextCursor: null } }));
  await page.route('**/api/admin/monitoring/api-attempts**', (route) => route.fulfill({ json: { attempts: [], nextCursor: null } }));
  await page.route('**/api/admin/field-settings/catalogs?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const items = query.get('kind') === 'units' && query.get('system') === 'moysklad'
      ? [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', code: 'TEST-UOM', label: 'Тестовая единица' }]
      : [];
    return route.fulfill({ json: { items, nextCursor: null } });
  });
  await page.route('**/api/admin/field-settings/catalogs', (route) => route.fulfill({ json: { units: { bitrix24: [], moysklad: [] }, priceTypes: { bitrix24: [], moysklad: [] }, dictionaries: [] } }));
  await page.route('**/api/admin/field-settings', async (route) => {
    const method = route.request().method();
    if (method === 'PUT') {
      writes.push(method);
      version += 1;
      await route.fulfill({ json: { version, createdAt: '2026-10-07T00:00:00.000Z', config: JSON.parse(route.request().postData() ?? '{}').config } });
    } else {
      await route.fulfill({ json: { version, createdAt: '2026-10-07T00:00:00.000Z', config } });
    }
  });
  await page.route('**/api/admin/field-settings/preview', async (route) => {
    expect(route.request().method()).toBe('POST');
    await route.fulfill({ json: { writes: 0, results: [{ sourceLabel: 'Ada Lovelace', sourceValues: { NAME: 'Ada', LAST_NAME: 'Lovelace' }, transformed: { name: { value: 'Ada Lovelace', transform: 'join-non-empty' } }, targetCurrent: { name: 'Ada' }, errors: [], version: 1, writes: 0 }] } });
  });
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Соответствия полей' }).click();
  await expect(page.getByRole('heading', { name: 'Версия 1' })).toBeVisible();
  await page.getByLabel('Пары записей').fill('42,00000000-0000-4000-8000-000000000001');
  await page.getByRole('button', { name: 'Прочитать пары и выполнить предпросмотр' }).click();
  await expect(page.getByText('Ada Lovelace', { exact: true })).toBeVisible();
  expect(writes).toEqual([]);

  await page.getByLabel('Единица МойСклад для 14').selectOption('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

  await page.getByRole('button', { name: 'Сохранить новую версию' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Предупреждение о настройках' })).toBeVisible();
  await expect(page.getByText(/обычный повтор не переключает версию/i)).toBeVisible();
  await page.getByRole('button', { name: 'Подтвердить и сохранить' }).click();
  await expect(page.getByRole('heading', { name: 'Версия 2' })).toBeVisible();
  expect(writes).toEqual(['PUT']);
  await expect(page.getByText('Сохранённая пара · код TEST-UOM')).toBeVisible();
});
