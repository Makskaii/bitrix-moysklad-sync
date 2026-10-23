import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DatabaseService } from '../src/database.service';
import { EventIntakeDisabledError, FieldSettingsService } from '../src/field-settings/field-settings.service';
import { ReadOnlyFieldDataProvider } from '../src/field-settings/read-only-field-data.provider';
import { EntityPairService } from '../src/pairs/entity-pair.service';

function fixture(options: { renewed?: number; mode?: string; token?: string; expiresAt?: Date } = {}) {
  const calls: string[] = [];
  const transaction = {
    $queryRaw: async () => {
      calls.push('read-guard');
      return calls.filter((call) => call === 'read-guard').length === 1
        ? [{ serviceMode: options.mode ?? 'on', nightlyLeaseToken: options.token ?? 'lease-1', nightlyLeaseExpiresAt: options.expiresAt ?? new Date(Date.now() + 60_000) }]
        : [{ version: 7 }];
    },
    inboundEvent: { upsert: async () => { calls.push('upsert'); return { id: 'event-1' }; } },
    $executeRaw: async () => { calls.push('pin'); return 1; },
  };
  const database = {
    $executeRaw: async () => { calls.push('renew'); return options.renewed ?? 1; },
    $transaction: async (run: (client: typeof transaction) => Promise<unknown>) => {
      calls.push('begin');
      return run(transaction);
    },
  };
  const service = new FieldSettingsService(database as unknown as DatabaseService, {} as ReadOnlyFieldDataProvider, {} as EntityPairService);
  (service as unknown as { ensureInitialized: () => Promise<void> }).ensureInitialized = async () => {};
  const accept = () => service.saveAcceptedEvent({
    source: 'BITRIX24', deliveryKey: 'nightly-test', eventType: 'ONCRMCOMPANYUPDATE',
    externalEntityId: '42', externalEntityType: 'company', payload: {}, directionDisabled: false,
    requireServiceNotOff: true, nightlyLeaseToken: 'lease-1',
  });
  return { calls, accept };
}

test('nightly lease renews before the short durable enqueue transaction', async () => {
  const { calls, accept } = fixture();
  assert.equal((await accept()).id, 'event-1');
  assert.deepEqual(calls, ['renew', 'begin', 'read-guard', 'upsert', 'read-guard', 'pin']);
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
