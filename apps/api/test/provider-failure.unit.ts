import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ProviderFailure, isRetryableFailure, providerResponseFailure, retryAfterAt, retryAtForFailure } from '../src/provider-failure';

test('Retry-After seconds and HTTP dates become bounded durable due times', () => {
  const now = Date.parse('2026-10-14T10:00:00Z');
  assert.equal(retryAfterAt('12', now)?.toISOString(), '2026-10-14T10:00:12.000Z');
  assert.equal(retryAfterAt('Wed, 14 Oct 2026 10:02:00 GMT', now)?.toISOString(), '2026-10-14T10:02:00.000Z');
  assert.equal(retryAfterAt('999999', now)?.toISOString(), '2026-10-14T11:00:00.000Z');
  assert.equal(retryAfterAt('not a date', now), null);
});

test('429 and server/network failures retry; permanent client errors require review', () => {
  const rateLimited = providerResponseFailure('MOYSKLAD', 429, '60');
  const unavailable = providerResponseFailure('BITRIX24', 503, null);
  const rejected = providerResponseFailure('BITRIX24', 422, null);
  const network = new ProviderFailure('MOYSKLAD', null);
  assert.equal(isRetryableFailure(rateLimited), true);
  assert.equal(isRetryableFailure(unavailable), true);
  assert.equal(isRetryableFailure(network), true);
  assert.equal(isRetryableFailure(rejected), false);
  assert.equal(retryAtForFailure(rateLimited, 1).getTime(), rateLimited.retryAfterAt!.getTime());
  const now = 1_800_000_000_000;
  assert.equal(retryAtForFailure(unavailable, 2, now).getTime(), now + 10_000);
});
