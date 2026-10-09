import { expect, test } from '@playwright/test';

test('field settings select, save, and reload field pairs while preview stays read-only', async ({ page }) => {
  test.skip(process.env.ADMIN_PREVIEW_EXPECTED !== '1');
  const writes: string[] = [];
  let version = 1;
  let config = { rules: [], groups: [], references: {
    units: [{ bitrix24Id: 14, bitrix24Code: '1720010507', moyskladId: null, moyskladCode: null, status: 'unmapped' }],
    priceTypes: [], dictionaries: [
      { key: 'service', bitrix24Field: 'UF_CRM_1766085949', bitrix24ListId: '42', moyskladAttributeId: '0ad997c8-8e75-11e3-1ec9-002590a28eca', moyskladDirectoryId: 'f0177126-8e74-11e3-b761-002590a28eca', pairs: [{ bitrix24Id: 42, moyskladId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] },
      { key: 'payment-method', bitrix24Field: 'UF_CRM_1766072752', bitrix24ListId: '44', moyskladAttributeId: 'f214f966-dc1a-11f0-0a80-0ef700278459', moyskladDirectoryId: '0ecffb86-d8a3-11eb-0a80-0dbc000256e5', pairs: [{ bitrix24Id: 44, moyskladId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] },
    ],
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
  await page.route('**/api/admin/pairs', (route) => route.fulfill({ json: [
    { id: 'contact-pair-42', entityType: 'CONTACT', bitrix24Id: '42', moyskladId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', active: true, source: 'MANUAL', reason: 'ADMIN_ASSIGNED', createdAt: '2026-10-07T00:00:00.000Z' },
    { id: 'contact-pair-43', entityType: 'CONTACT', bitrix24Id: '43', moyskladId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', active: true, source: 'MANUAL', reason: 'ADMIN_ASSIGNED', createdAt: '2026-10-07T00:00:00.000Z' },
  ] }));
  await page.route('**/api/admin/field-settings/catalogs?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const items = query.get('kind') === 'units' && query.get('system') === 'moysklad'
      ? [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', code: 'TEST-UOM', label: 'Тестовая единица' }]
      : [];
    return route.fulfill({ json: { items, nextCursor: null } });
  });
  await page.route('**/api/admin/field-settings/catalogs', (route) => route.fulfill({ json: { units: { bitrix24: [], moysklad: [] }, priceTypes: { bitrix24: [], moysklad: [] }, dictionaries: [
    { key: 'service', bitrix24Field: 'UF_CRM_1766085949', bitrix24ListId: '42', moyskladAttributeId: '0ad997c8-8e75-11e3-1ec9-002590a28eca', moyskladDirectoryId: 'f0177126-8e74-11e3-b761-002590a28eca', values: { bitrix24: [{ id: '42', title: 'Delivery', code: 'DELIVERY' }], moysklad: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Delivery MS', code: '' }, { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', title: 'Install MS', code: '' }] } },
    { key: 'payment-method', bitrix24Field: 'UF_CRM_1766072752', bitrix24ListId: '44', moyskladAttributeId: 'f214f966-dc1a-11f0-0a80-0ef700278459', moyskladDirectoryId: '0ecffb86-d8a3-11eb-0a80-0dbc000256e5', values: { bitrix24: [{ id: '44', title: 'Card', code: 'CARD' }], moysklad: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Card MS', code: '' }] } },
  ] } }));
  await page.route('**/api/admin/field-settings/fields?*', (route) => route.fulfill({ json: { entity: 'contacts', bitrix24: [{ code: 'EMAIL', title: 'Email', type: 'crm_multifield', writable: true }], moysklad: [{ code: 'email', title: 'email', type: 'string', writable: null }] } }));
  await page.route('**/api/admin/field-settings', async (route) => {
    const method = route.request().method();
    if (method === 'PUT') {
      writes.push(method);
      version += 1;
      config = JSON.parse(route.request().postData() ?? '{}').config;
      await route.fulfill({ json: { version, createdAt: '2026-10-07T00:00:00.000Z', config } });
    } else {
      await route.fulfill({ json: { version, createdAt: '2026-10-07T00:00:00.000Z', config } });
    }
  });
  await page.route('**/api/admin/field-settings/preview', async (route) => {
    expect(route.request().method()).toBe('POST');
    const body = route.request().postDataJSON() as { pairIds: string[] };
    expect(body.pairIds).toEqual(['contact-pair-42', 'contact-pair-43']);
    await route.fulfill({ json: { writes: 0, results: body.pairIds.map((pairId) => ({ pairId, sourceLabel: 'Ada Lovelace', sourceValues: { NAME: 'Ada', LAST_NAME: 'Lovelace' }, transformed: { name: { value: 'Ada Lovelace', transform: 'join-non-empty' } }, targetCurrent: { name: 'Ada' }, errors: [], version: 1, writes: 0 })) } });
  });
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', database: 'ok' } }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Соответствия полей' }).click();
  await expect(page.getByText('Версия 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Bitrix24' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'МойСклад' })).toBeVisible();
  await expect(page.locator('option[value="smart-invoices"]').first()).toHaveAttribute('disabled', '');
  await page.getByText('Дополнительные настройки:', { exact: false }).click();
  await expect(page.getByLabel('Пара сущностей группы')).toHaveValue('contacts');
  await page.getByLabel('Сущность соответствий').selectOption('contacts');
  await page.getByLabel('Пара записей для метаданных').selectOption('contact-pair-42');
  await page.getByRole('button', { name: 'Обновить поля' }).click();
  await page.getByRole('button', { name: '＋ Добавить соответствие' }).click();
  const mappingRow = page.locator('.field-mapping-row').first();
  await expect(page.getByLabel('Поле Bitrix24')).toBeEnabled();
  await expect(page.getByLabel('Поле МойСклад')).toBeEnabled();
  await expect(page.getByLabel('Не сохранено')).toBeVisible();
  await page.getByRole('button', { name: 'Сохранить новую версию' }).click();
  await page.getByRole('button', { name: 'Подтвердить и сохранить' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Выберите оба поля или удалите незавершённую строку.' })).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByLabel('Поле Bitrix24').selectOption('EMAIL');
  await page.getByLabel('Поле МойСклад').selectOption('email');
  await expect(page.getByLabel('Поле Bitrix24')).toHaveValue('EMAIL');
  await expect(page.getByLabel('Поле МойСклад')).toHaveValue('email');
  await expect(page.getByLabel('Поле Bitrix24')).toHaveAttribute('title', 'EMAIL · crm_multifield');
  await mappingRow.getByText('Направления и коды').click();
  await mappingRow.getByRole('group', { name: 'Bitrix24 → МойСклад' }).getByRole('checkbox').check();
  await page.getByLabel('Преобразование Bitrix24 в МойСклад').selectOption('copy');
  await mappingRow.getByText('Технические коды').click();
  await expect(mappingRow.getByText('EMAIL → email')).toBeVisible();
  await mappingRow.getByText('Направления и коды').click();
  await page.getByText('Предпросмотр преобразования').click();
  await page.getByLabel('Активные пары предпросмотра').selectOption(['contact-pair-42', 'contact-pair-43']);
  await page.getByRole('button', { name: 'Прочитать пары и выполнить предпросмотр' }).click();
  await expect(page.getByText('Ada Lovelace', { exact: true }).first()).toBeVisible();
  await expect(page.locator('[aria-label="Результат предпросмотра"] article')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/field-settings-preview.png', fullPage: true });
  expect(writes).toEqual([]);

  await page.getByLabel('Единица МойСклад для 14').selectOption('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.getByLabel('service: значение МойСклад для 42').selectOption('dddddddd-dddd-4ddd-8ddd-dddddddddddd');

  await page.getByRole('button', { name: 'Сохранить новую версию' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Предупреждение о настройках' })).toBeVisible();
  await expect(page.getByText(/обычный повтор не переключает версию/i)).toBeVisible();
  await page.getByRole('button', { name: 'Подтвердить и сохранить' }).click();
  await expect(page.getByText('Версия 2', { exact: true })).toBeVisible();
  expect(writes).toEqual(['PUT']);
  await expect(page.getByLabel('Сохранено')).toBeVisible();
  await expect(page.getByText('Сохранённая пара · код TEST-UOM')).toBeVisible();
  await page.getByText('Дополнительные настройки:', { exact: false }).click();
  await page.screenshot({ path: 'test-results/field-settings-mapping.png' });

  await page.reload();
  await page.getByRole('button', { name: 'Соответствия полей' }).click();
  await expect(page.getByText('Версия 2', { exact: true })).toBeVisible();
  await page.getByLabel('Сущность соответствий').selectOption('contacts');
  await expect(page.getByLabel('Поле Bitrix24')).toHaveValue('EMAIL');
  await expect(page.getByLabel('Поле МойСклад')).toHaveValue('email');
  expect(config.rules).toEqual([expect.objectContaining({ sourceField: 'EMAIL', targetField: 'email' })]);
});
