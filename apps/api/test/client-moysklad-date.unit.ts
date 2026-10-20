import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseClientMoyskladTimestamp } from '../src/clients/client-moysklad-date';

test('MySklad readback timestamps without an offset are parsed as Moscow local time independent of host TZ', () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const parsed = parseClientMoyskladTimestamp('2026-10-20 20:35:52.853');
    assert.ok(parsed);
    assert.equal(parsed.toISOString(), '2026-10-20T17:35:52.853Z');
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test('MySklad readback parser preserves explicit offsets and rejects malformed timestamps', () => {
  assert.equal(parseClientMoyskladTimestamp('2026-10-20T17:35:52.853Z')?.toISOString(), '2026-10-20T17:35:52.853Z');
  assert.equal(parseClientMoyskladTimestamp('2026-10-20T20:35:52.853+03:00')?.toISOString(), '2026-10-20T17:35:52.853Z');
  assert.equal(parseClientMoyskladTimestamp('2026-02-31T20:35:52.853Z'), null);
  assert.equal(parseClientMoyskladTimestamp('2026-10-20T20:35:52.853+25:00'), null);
  assert.equal(parseClientMoyskladTimestamp('2026-10-20 99:35:52.853'), null);
  assert.equal(parseClientMoyskladTimestamp('2026-02-31 20:35:52.853'), null);
  assert.equal(parseClientMoyskladTimestamp('not-a-timestamp'), null);
});
