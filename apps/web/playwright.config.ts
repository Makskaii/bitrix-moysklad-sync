import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
    browserName: 'chromium',
  },
});
