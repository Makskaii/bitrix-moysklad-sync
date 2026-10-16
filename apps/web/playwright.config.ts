import { defineConfig } from '@playwright/test';

// The local UI suite mocks the preview API per test; run those supported flows by default.
process.env.ADMIN_PREVIEW_EXPECTED ??= '1';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  reporter: 'line',
  webServer: {
    command: 'npm exec --workspace @sync/web -- vite --host 127.0.0.1 --port 15173 --strictPort',
    url: 'http://127.0.0.1:15173',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:15173',
    browserName: 'chromium',
  },
});
