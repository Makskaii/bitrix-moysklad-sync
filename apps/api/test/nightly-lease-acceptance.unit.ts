import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { EventIntakeDisabledError, FieldSettingsService } from '../src/field-settings/field-settings.service';
import { ReadOnlyFieldDataProvider } from '../src/field-settings/read-only-field-data.provider';
import { EntityPairService } from '../src/pairs/entity-pair.service';
import { DEFAULT_FIELD_SETTINGS } from '../src/field-settings/approved-mappings';

function fixture(options: { renewed?: number; mode?: string; token?: string; expiresAt?: Date; initFailOnce?: boolean } = {}) {
  const calls: string[] = [];
  let initializationCount = 0;
  let guardReadCount = 0;
  const transaction = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      if (strings.join('').includes('set_config')) return [];
      if (strings.join('').includes('FOR UPDATE')) { calls.push('lock'); return [{ id: 'global' }]; }
      calls.push('read-guard');
      guardReadCount += 1;
      return guardReadCount === 1
        ? [{ serviceMode: options.mode ?? 'on', nightlyLeaseToken: options.token ?? 'lease-1', nightlyLeaseExpiresAt: options.expiresAt ?? new Date(Date.now() + 60_000) }]
        : [{ version: 7 }];
    },
    inboundEvent: { upsert: async () => { calls.push('upsert'); return { id: 'event-1' }; } },
    $executeRaw: async (strings: TemplateStringsArray) => {
      if (strings.join('').includes('clock_timestamp')) { calls.push('renew'); return options.renewed ?? 1; }
      calls.push('pin'); return 1;
    },
  };
  const database = {
    $queryRaw: async () => [{ version: 7, config: DEFAULT_FIELD_SETTINGS, createdAt: new Date() }],
    $executeRaw: async () => { calls.push('renew'); return options.renewed ?? 1; },
    $transaction: async (run: (client: typeof transaction) => Promise<unknown>) => {
      calls.push('begin');
      guardReadCount = 0;
      return run(transaction);
    },
  };
  const service = new FieldSettingsService(database as unknown as DatabaseService, {} as ReadOnlyFieldDataProvider, {} as EntityPairService);
  (service as unknown as { ensureInitialized: () => Promise<void> }).ensureInitialized = async () => {
    initializationCount += 1;
    if (options.initFailOnce && initializationCount === 1) throw new Error('Synthetic initialization failure');
  };
  const accept = () => service.saveAcceptedEvent({
    source: 'BITRIX24', deliveryKey: 'nightly-test', eventType: 'ONCRMCOMPANYUPDATE',
    externalEntityId: '42', externalEntityType: 'company', payload: {}, directionDisabled: false,
    requireServiceNotOff: true, nightlyLeaseToken: 'lease-1',
  });
  return { calls, accept, service, initializationCount: () => initializationCount };
}

test('nightly lease renews before the short durable enqueue transaction', async () => {
  const { calls, accept } = fixture();
  assert.equal((await accept()).id, 'event-1');
  assert.deepEqual(calls, ['begin', 'lock', 'renew', 'begin', 'read-guard', 'upsert', 'read-guard', 'pin']);
});

test('event intake performs the historical settings backfill only once per service instance', async () => {
  const { accept, initializationCount } = fixture();
  await accept();
  await accept();
  assert.equal(initializationCount(), 1);
});

test('failed initial backfill can be retried without accepting a partial event', async () => {
  const { accept, initializationCount, calls } = fixture({ initFailOnce: true });
  await assert.rejects(accept(), /Synthetic initialization failure/);
  assert.equal(calls.includes('upsert'), false);
  await accept();
  assert.equal(initializationCount(), 2);
});

test('accepted event processing and active configuration reads share the completed historical backfill', async () => {
  const { accept, service, initializationCount } = fixture();
  await accept();
  await Promise.all([service.eventConfig('event-1'), service.active(), service.version(7)]);
  await service.eventConfig('event-1');
  await accept();
  assert.equal(initializationCount(), 1);
});

test('lost or expired lease and OFF mode reject before an event is accepted', async () => {
  for (const options of [
    { renewed: 0 },
    { token: 'other-lease' },
    { expiresAt: new Date(Date.now() - 1_000) },
    { mode: 'off' },
  ]) {
    const { calls, accept } = fixture(options);
    await assert.rejects(accept(), options.mode === 'off' ? EventIntakeDisabledError : /Nightly run lease was lost/);
    assert.equal(calls.includes('upsert'), false);
  }
});
