import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LocalAdminPreviewModule } from '../src/admin/local-preview.module';
import { DatabaseService } from '../src/database.service';

test('local preview module boots with isolated apply and dry schemas without external requests', async () => {
  const keys = ['SYNC_MODE', 'DATABASE_URL', 'DRY_DATABASE_URL'] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let externalRequests = 0;
  process.env.SYNC_MODE = 'dry';
  process.env.DATABASE_URL = process.env.LOCAL_PREVIEW_DI_APPLY_DATABASE_URL
    ?? 'postgresql://sync:local-only@127.0.0.1:55414/sync?schema=issue68_apply_test';
  process.env.DRY_DATABASE_URL = process.env.LOCAL_PREVIEW_DI_DRY_DATABASE_URL
    ?? 'postgresql://sync:local-only@127.0.0.1:55414/sync?schema=issue68_dry_test';
  globalThis.fetch = (async () => {
    externalRequests++;
    throw new Error('unexpected external request during module bootstrap');
  }) as typeof fetch;

  let app: INestApplication | undefined;
  try {
    app = await NestFactory.create(LocalAdminPreviewModule.register(), { logger: false });
    assert.ok(app.get(DatabaseService));
    assert.equal(externalRequests, 0);
  } finally {
    if (app) await app.close();
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
