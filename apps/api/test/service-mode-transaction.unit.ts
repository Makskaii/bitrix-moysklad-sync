import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { withServiceModeOn } from '../src/service-mode-transaction';

function databaseFor(mode: string | null, onWork?: () => Promise<unknown>) {
  const transaction = {
    $queryRaw: async () => mode === null ? [] : [{ serviceMode: mode }],
  };
  return {
    $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
    onWork,
  };
}

test('service mode transaction only enters work when the authoritative row is ON', async () => {
  for (const mode of ['off', 'pause', null]) {
    let calls = 0;
    const database = databaseFor(mode);
    const result = await withServiceModeOn(database as never, async () => { calls += 1; return 'ran'; });
    assert.deepEqual(result, { enabled: false });
    assert.equal(calls, 0);
  }

  let calls = 0;
  const result = await withServiceModeOn(databaseFor('on') as never, async () => { calls += 1; return 'ran'; });
  assert.deepEqual(result, { enabled: true, value: 'ran' });
  assert.equal(calls, 1);
});

test('service mode transaction fails closed by propagating unavailable-mode errors', async () => {
  const database = {
    $transaction: async (callback: (tx: { $queryRaw: () => Promise<never> }) => Promise<unknown>) => callback({
      $queryRaw: async () => { throw new Error('database unavailable'); },
    }),
  };
  await assert.rejects(withServiceModeOn(database as never, async () => 'must not run'), /database unavailable/);
});
