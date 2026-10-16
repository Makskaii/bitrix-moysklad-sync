import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DealOrderTotalAdapter, DealOrderTotalReconciliationHandler, DealOrderTotalSnapshot, DealOrderTotalState, parseMinorUnits } from '../src/deals-orders/deal-order-total-reconciliation';

const handler = new DealOrderTotalReconciliationHandler();
const version = 7;
const pairId = 'pair-1';
const eventId = 'event-1';
const same = (amount: unknown, currencyCode: unknown = 'RUB'): DealOrderTotalSnapshot => ({
  bitrix24: { amount, currencyCode }, moysklad: { amount, currencyCode },
});
const mismatch = (b24: unknown, ms: unknown, currencyCode: unknown = 'RUB'): DealOrderTotalSnapshot => ({
  bitrix24: { amount: b24, currencyCode }, moysklad: { amount: ms, currencyCode },
});
const state = (snapshot: DealOrderTotalSnapshot): DealOrderTotalState => ({ settingsVersion: version, ...structuredClone(snapshot) });

function fakeAdapter(initial: DealOrderTotalSnapshot, options: { dry?: boolean; failWrite?: boolean; lease?: () => Promise<boolean>; readInterference?: boolean } = {}) {
  let current = structuredClone(initial);
  let interfered = false;
  const writes: unknown[] = [];
  const externalWrites: unknown[] = [];
  const saved: DealOrderTotalState[] = [];
  const history: Array<{ outcome: string; raw: DealOrderTotalSnapshot }> = [];
  const adapter: DealOrderTotalAdapter = {
    async readCurrent() {
      if (options.readInterference && !interfered) { interfered = true; current = { ...current, moysklad: { ...current.moysklad, amount: 100.01 } }; }
      return structuredClone(current);
    },
    async writeBitrix24Opportunity(amount) {
      writes.push(amount);
      if (options.failWrite) throw new Error('provider write failed');
      if (options.dry) current = { ...current, bitrix24: { ...current.bitrix24, amount } };
      else { externalWrites.push(amount); current = { ...current, bitrix24: { ...current.bitrix24, amount } }; }
    },
    async persistState(value) { saved.push(structuredClone(value)); },
    async recordHistory(value) { history.push({ outcome: value.outcome, raw: structuredClone(value.raw) }); },
  };
  return { adapter, writes, externalWrites, saved, history, getCurrent: () => current };
}

async function run(input: {
  current: DealOrderTotalSnapshot;
  baseline: DealOrderTotalState;
  completeRows?: boolean;
  rowValuesChanged?: boolean;
  dry?: boolean;
  lease?: () => Promise<boolean>;
  failWrite?: boolean;
}) {
  const fake = fakeAdapter(input.current, input);
  const result = await handler.process({
    pairId, eventId, pinnedConfig: { version },
    bitrix24Current: input.current.bitrix24, moyskladCurrent: input.current.moysklad,
    priorBaseline: input.baseline, completeRows: input.completeRows ?? true,
    adapter: fake.adapter, assertLease: input.lease ?? (async () => true), rowValuesChanged: input.rowValuesChanged,
  });
  return { ...fake, result };
}

test('exact decimal parsing uses integer minor units and rejects precision loss', () => {
  assert.equal(parseMinorUnits('100.01'), 10001n);
  assert.equal(parseMinorUnits(100.01), 10001n);
  assert.equal(parseMinorUnits('100.010'), null);
  assert.equal(parseMinorUnits(1e-7), null);
});

test('matching totals are idempotent and persist both raw current values', async () => {
  const current: DealOrderTotalSnapshot = { bitrix24: { amount: 12.3, currencyCode: 'RUB' }, moysklad: { amount: 12.30, currencyCode: 'RUB' } };
  const result = await run({ current, baseline: state(current) });
  assert.equal(result.result.status, 'SYNCED');
  assert.deepEqual(result.writes, []);
  assert.deepEqual(result.saved[0], state(current));
  assert.deepEqual(result.history[0]?.raw, current);
});

test('a B24-origin one-kopeck difference is retained without a conflict or write', async () => {
  const current = mismatch(100.01, 100);
  const result = await run({ current, baseline: state(same(100)) });
  assert.deepEqual(result.result, { status: 'SYNCED', state: state(current), conflict: false, reason: 'B24_ONE_KOPECK_RETAINED' });
  assert.deepEqual(result.writes, []);
  assert.deepEqual(result.history[0]?.raw, current);
});

test('two kopecks or more restores B24 OPPORTUNITY from the read-only MS sum', async () => {
  const result = await run({ current: mismatch(100.02, 100), baseline: state(same(100)) });
  assert.equal(result.result.status, 'SYNCED');
  assert.equal(result.result.conflict, true);
  assert.deepEqual(result.writes, [100]);
});

test('MS-origin change wins over a simultaneous B24 change', async () => {
  const result = await run({ current: { bitrix24: { amount: 102, currencyCode: 'RUB' }, moysklad: { amount: 100, currencyCode: 'RUB' } }, baseline: state(same(99)) });
  assert.equal(result.result.status, 'SYNCED');
  assert.deepEqual(result.writes, [100]);
});

test('a B24-origin change already matching the current MS total is accepted', async () => {
  const result = await run({ current: same(100), baseline: state(mismatch(99, 100)) });
  assert.equal(result.result.status, 'SYNCED');
  assert.deepEqual(result.writes, []);
});

test('non-RUB mismatches get no kopeck tolerance', async () => {
  const current = mismatch(100.01, 100, 'USD');
  const result = await run({ current, baseline: state(same(100, 'USD')) });
  assert.equal(result.result.status, 'SYNCED');
  assert.equal(result.result.conflict, true);
  assert.deepEqual(result.writes, [100]);
});

test('unresolved row quantity or price changes hold even a one-cent total difference', async () => {
  const partial = await run({ current: mismatch(100.01, 100), baseline: state(same(100)), completeRows: false });
  assert.deepEqual(partial.result, { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_TOTAL_ROWS_INCOMPLETE' });
  const changedRows = await run({ current: mismatch(100.01, 100), baseline: state(same(100)), rowValuesChanged: true });
  assert.equal(changedRows.result.status, 'SYNCED');
  assert.deepEqual(changedRows.writes, [100]);
});

test('missing currency or differing currencies are held for review', async () => {
  const unset = await run({ current: same(100, null), baseline: state(same(100, null)) });
  assert.deepEqual(unset.result, { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_TOTAL_CURRENCY_UNSET_OR_UNSUPPORTED' });
  const mismatch = await run({ current: { bitrix24: { amount: 100, currencyCode: 'RUB' }, moysklad: { amount: 100, currencyCode: 'USD' } }, baseline: state(same(100)) });
  assert.deepEqual(mismatch.result, { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_TOTAL_CURRENCY_MISMATCH' });
});

test('absent baseline does not write', async () => {
  const current = same(100);
  const missing = await handler.process({ pairId, eventId, pinnedConfig: { version }, bitrix24Current: current.bitrix24, moyskladCurrent: current.moysklad, priorBaseline: null, completeRows: true, adapter: fakeAdapter(current).adapter, assertLease: async () => true });
  assert.deepEqual(missing, { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_TOTAL_BASELINE_MISSING' });
});

test('dry mode journals only B24 target intent and does not make an external write', async () => {
  const result = await run({ current: mismatch(100.02, 100), baseline: state(same(100)), dry: true });
  assert.equal(result.result.status, 'SYNCED');
  assert.deepEqual(result.writes, [100]);
  assert.deepEqual(result.externalWrites, []);
  assert.equal(result.getCurrent().bitrix24.amount, 100);
});

test('corrected totals are idempotent on the following event', async () => {
  const initial = mismatch(100.02, 100);
  const first = await run({ current: initial, baseline: state(same(100)) });
  assert.equal(first.result.status, 'SYNCED');
  if (first.result.status !== 'SYNCED') return;
  const second = await run({ current: first.getCurrent(), baseline: first.result.state });
  assert.deepEqual(second.writes, []);
  assert.equal(second.result.status, 'SYNCED');
});

test('provider state changing between initial read and write yields retry without write', async () => {
  const current = mismatch(100.02, 100);
  const fake = fakeAdapter(current, { readInterference: true });
  const result = await handler.process({
    pairId, eventId, pinnedConfig: { version }, bitrix24Current: current.bitrix24,
    moyskladCurrent: current.moysklad, priorBaseline: state(same(100)), completeRows: true,
    adapter: fake.adapter, assertLease: async () => true,
  });
  assert.deepEqual(result, { status: 'RETRY', reason: 'DEAL_ORDER_TOTAL_CHANGED_BEFORE_WRITE' });
  assert.deepEqual(fake.writes, []);
});

test('lease loss prevents any write and provider failures remain retryable', async () => {
  const lease = await run({ current: mismatch(100.02, 100), baseline: state(same(100)), lease: async () => false });
  assert.deepEqual(lease.result, { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_LOCK_LOST' });
  assert.deepEqual(lease.writes, []);
  const provider = await run({ current: mismatch(100.02, 100), baseline: state(same(100)), failWrite: true });
  assert.deepEqual(provider.result, { status: 'RETRY', reason: 'DEAL_ORDER_TOTAL_PROVIDER_FAILURE' });
});
