import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PrismaClient } from '@prisma/client';
import { withNightlySettingLock } from '../src/nightly-setting-lock';
import { DatabaseService } from '../src/database.service';

test('lease clock must be checked after a conflicting mode lock is released', async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/root23_nightly_init_test');
  assert.equal(url.searchParams.get('schema'), 'issue10_test');
  const db = new PrismaClient();
  try {
    // Use a persistent isolated-test table so two pool connections share it.
    await db.$executeRaw`CREATE TABLE IF NOT EXISTS "NightlyLeaseClockProbe" (id int PRIMARY KEY, expires timestamp)`;
    await db.$executeRaw`INSERT INTO "NightlyLeaseClockProbe" VALUES (1, clock_timestamp() AT TIME ZONE 'UTC' + interval '150 milliseconds') ON CONFLICT(id) DO UPDATE SET expires=EXCLUDED.expires`;
    let locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const blocker = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "NightlyLeaseClockProbe" WHERE id=1 FOR SHARE`;
      locked();
      await new Promise(resolve => setTimeout(resolve, 350));
    });
    await ready;
    const renewed = await db.$executeRaw`UPDATE "NightlyLeaseClockProbe" SET expires=(NOW() AT TIME ZONE 'UTC')+interval '150 milliseconds' WHERE id=1 AND expires>(NOW() AT TIME ZONE 'UTC')`;
    await blocker;
    const rows = await db.$queryRaw<Array<{expired:boolean}>>`SELECT expires <= (clock_timestamp() AT TIME ZONE 'UTC') AS expired FROM "NightlyLeaseClockProbe" WHERE id=1`;
    assert.equal(renewed, 1);
    assert.equal(rows[0].expired, true, 'old renewal reports success with an already expired lease after waiting for lock');
    await db.syncSetting.upsert({ where: { id: 'global' }, create: {}, update: {} });
    for (const duration of [150, 2000]) {
      await db.$executeRaw`UPDATE "SyncSetting" SET "nightlyLeaseToken"='clock-probe', "nightlyLeaseExpiresAt"=(clock_timestamp() AT TIME ZONE 'UTC') + (${duration} * interval '1 millisecond') WHERE id='global'`;
      let acquired!: () => void;
      const waiting = new Promise<void>(resolve => { acquired = resolve; });
      const hold = db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "SyncSetting" WHERE id='global' FOR SHARE`;
        acquired();
        await new Promise(resolve => setTimeout(resolve, 350));
      });
      await waiting;
      const changed = await withNightlySettingLock(db as DatabaseService, tx => tx.$executeRaw`
        UPDATE "SyncSetting" SET "nightlyLeaseExpiresAt"=(clock_timestamp() AT TIME ZONE 'UTC')+interval '60 seconds'
        WHERE id='global' AND "nightlyLeaseToken"='clock-probe' AND "nightlyLeaseExpiresAt">(clock_timestamp() AT TIME ZONE 'UTC')
      `);
      await hold;
      assert.equal(changed, duration === 150 ? 0 : 1, 'expired ownership is rejected after lock wait, live ownership renews');
    }
  } finally {
    await db.$executeRaw`UPDATE "SyncSetting" SET "nightlyLeaseToken"=NULL,"nightlyLeaseExpiresAt"=NULL WHERE id='global' AND "nightlyLeaseToken"='clock-probe'`;
    await db.$executeRaw`DROP TABLE IF EXISTS "NightlyLeaseClockProbe"`;
    await db.$disconnect();
  }
});
