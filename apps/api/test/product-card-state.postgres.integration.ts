import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/database.service';
import { DatabaseProductCardStateStore } from '../src/products/product-card-runtime.service';

const databaseUrl = process.env.PRODUCT_TEST_DATABASE_URL;

test('product last-success state persists by active pair in isolated PostgreSQL', { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl, 'PRODUCT_TEST_DATABASE_URL must point to the dedicated #15 test database');
  const parsedUrl = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname), 'refusing to run product-card persistence test against a non-local database');
  assert.equal(parsedUrl.pathname, '/sync', 'product-card persistence test requires its dedicated test database');
  assert.equal(parsedUrl.searchParams.get('schema'), 'issue15_product_test', 'refusing to run product-card persistence outside issue15_product_test schema');
  const previousMode = process.env.SYNC_MODE;
  const previousUrl = process.env.DATABASE_URL;
  process.env.SYNC_MODE = 'apply';
  process.env.DATABASE_URL = databaseUrl;
  const database = new DatabaseService();
  const pairId = randomUUID();
  const stateStore = new DatabaseProductCardStateStore(database);
  try {
    await database.entityPair.create({
      data: { id: pairId, entityType: 'PRODUCT', bitrix24Id: String(Date.now()), moyskladId: randomUUID(), active: true, source: 'MANUAL' },
    });
    const firstState = {
      bitrix24Values: { name: 'V1', unitId: '3', prices: [{ typeId: '2', value: 12.5 }] },
      moyskladValues: { name: 'V1', unitId: 'unit-uuid', prices: [{ typeId: 'price-uuid', value: 12.5 }] },
    };
    await stateStore.write(pairId, 4, firstState);
    assert.deepEqual(await stateStore.read(pairId), firstState);

    const changedState = structuredClone(firstState);
    changedState.bitrix24Values.name = 'V2';
    changedState.moyskladValues.name = 'V2';
    await stateStore.write(pairId, 5, changedState);
    assert.deepEqual(await stateStore.read(pairId), changedState);
  } finally {
    await database.entityPair.deleteMany({ where: { id: pairId } }).catch(() => undefined);
    await database.$disconnect();
    if (previousMode === undefined) delete process.env.SYNC_MODE; else process.env.SYNC_MODE = previousMode;
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
  }
});
