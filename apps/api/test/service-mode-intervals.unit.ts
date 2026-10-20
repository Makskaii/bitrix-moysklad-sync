import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildActiveWindowSegments } from '../src/service-mode-intervals';

test('nightly coverage keeps active slices and excludes multiple OFF intervals', () => {
  const from = new Date('2026-10-19T22:00:00.000Z');
  const through = new Date('2026-10-20T22:00:00.000Z');
  const result = buildActiveWindowSegments(from, through, from, [
    { id: 'baseline', fromMode: 'unknown', toMode: 'on', transitionedAt: from },
    { id: '1', fromMode: 'on', toMode: 'off', transitionedAt: new Date('2026-10-20T02:00:00.000Z') },
    { id: '2', fromMode: 'off', toMode: 'on', transitionedAt: new Date('2026-10-20T04:00:00.000Z') },
    { id: '3', fromMode: 'on', toMode: 'off', transitionedAt: new Date('2026-10-20T09:00:00.000Z') },
    { id: '4', fromMode: 'off', toMode: 'on', transitionedAt: new Date('2026-10-20T10:00:00.000Z') },
  ]);
  assert.deepEqual(result.segments.map(({ from: start, through: end }) => [start.toISOString(), end.toISOString()]), [
    ['2026-10-19T22:00:00.000Z', '2026-10-20T01:59:59.999Z'],
    ['2026-10-20T04:00:00.000Z', '2026-10-20T08:59:59.999Z'],
    ['2026-10-20T10:00:00.000Z', '2026-10-20T22:00:00.000Z'],
  ]);
  assert.equal(result.skipped.filter(({ mode }) => mode === 'off').length, 2);
});

test('nightly coverage excludes PAUSE while retaining before and after slices', () => {
  const from = new Date('2026-10-19T22:00:00.000Z');
  const through = new Date('2026-10-20T22:00:00.000Z');
  const result = buildActiveWindowSegments(from, through, from, [
    { id: 'baseline', fromMode: 'unknown', toMode: 'on', transitionedAt: from },
    { id: '1', fromMode: 'on', toMode: 'pause', transitionedAt: new Date('2026-10-20T02:00:00.000Z') },
    { id: '2', fromMode: 'pause', toMode: 'on', transitionedAt: new Date('2026-10-20T04:00:00.000Z') },
  ]);
  assert.equal(result.segments.length, 2);
  assert.equal(result.skipped[0].mode, 'pause');
  assert.match(result.skipped[0].reason, /accepted queued events resume separately/i);
});

test('nightly coverage reports unknown legacy time without treating it as active', () => {
  const from = new Date('2026-10-19T22:00:00.000Z');
  const trackedFrom = new Date('2026-10-20T02:00:00.000Z');
  const through = new Date('2026-10-20T22:00:00.000Z');
  const result = buildActiveWindowSegments(from, through, trackedFrom, [
    { id: 'baseline', fromMode: 'unknown', toMode: 'on', transitionedAt: trackedFrom },
  ]);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].from.toISOString(), trackedFrom.toISOString());
  assert.equal(result.skipped[0].mode, 'unknown');
});
