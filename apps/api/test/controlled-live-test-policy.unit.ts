import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createControlledLiveTestPolicy, withControlledLiveEventScope } from '../src/controlled-live-test-policy';
import { assertApplyExternalWrite, setControlledLiveTestWriteCheck } from '../src/external-write-guard';

const manifest = {
  runId: 'LIVE-TEST-20261019T120000Z-a1b2c3',
  testDatabaseName: 'sync_issue60_test',
  records: [{ entity: 'client', direction: 'BITRIX24_TO_MOYSKLAD', name: 'тест LIVE-TEST-20261019T120000Z-a1b2c3 client', syntheticOnly: true, sourceSystem: 'BITRIX24', sourceNativeId: 'b24-17', targetSystem: 'MOYSKLAD', targetNativeId: 'ms-29' }],
};
const scope = {
  runId: manifest.runId, entity: 'client', sourceSystem: 'BITRIX24' as const, sourceNativeId: 'b24-17',
  targetSystem: 'MOYSKLAD' as const, targetNativeId: 'ms-29',
};

test('controlled writes require a dedicated database named exactly in the manifest', () => {
  assert.throws(() => createControlledLiveTestPolicy(manifest, 'postgres://localhost/business'), /DATABASE_IS_NOT_DEDICATED/);
  assert.throws(() => createControlledLiveTestPolicy({ ...manifest, testDatabaseName: 'other_test' }, 'postgres://localhost/sync_issue60_test'), /DATABASE_IS_NOT_DEDICATED/);
  assert.throws(() => createControlledLiveTestPolicy(manifest, 'postgres://db.example/sync_issue60_test'), /DATABASE_MUST_BE_LOCAL/);
  assert.throws(() => createControlledLiveTestPolicy(manifest, 'mysql://localhost/sync_issue60_test'), /DATABASE_URL_INVALID/);
});

test('malformed manifests, duplicate targets and omitted policy data fail closed', () => {
  assert.throws(() => createControlledLiveTestPolicy({ ...manifest, runId: 'run' }, 'postgres://localhost/sync_issue60_test'), /MANIFEST_INVALID/);
  assert.throws(() => createControlledLiveTestPolicy({ ...manifest, records: [...manifest.records, ...manifest.records] }, 'postgres://localhost/sync_issue60_test'), /DUPLICATE_TARGET/);
  assert.throws(() => createControlledLiveTestPolicy(manifest, undefined), /DATABASE_URL_REQUIRED/);
  assert.throws(() => createControlledLiveTestPolicy({ ...manifest, records: [{ ...manifest.records[0], name: 'тест invented-run client' }] }, 'postgres://localhost/sync_issue60_test'), /MANIFEST_RECORD_INVALID/);
  assert.throws(() => createControlledLiveTestPolicy({ ...manifest, records: [{ ...manifest.records[0], syntheticOnly: false }] }, 'postgres://localhost/sync_issue60_test'), /MANIFEST_RECORD_INVALID/);
});

test('a mutation is allowed only for the exact current run, source, entity, provider and target ID', () => {
  const assertWrite = createControlledLiveTestPolicy(manifest, 'postgres://localhost/sync_issue60_test');
  assert.throws(() => assertWrite('MOYSKLAD', 'CLIENT_UPDATE'), /EVENT_SCOPE_REQUIRED/);
  withControlledLiveEventScope(scope, () => assert.doesNotThrow(() => assertWrite('MOYSKLAD', 'CLIENT_UPDATE')));
  withControlledLiveEventScope({ ...scope, targetNativeId: 'shared-customer-1' }, () =>
    assert.throws(() => assertWrite('MOYSKLAD', 'CLIENT_UPDATE'), /TARGET_NOT_IN_MANIFEST/));
  withControlledLiveEventScope({ ...scope, runId: 'LIVE-TEST-20261019T120000Z-xxxxxx' }, () =>
    assert.throws(() => assertWrite('MOYSKLAD', 'CLIENT_UPDATE'), /RUN_ID_MISMATCH/));
  withControlledLiveEventScope(scope, () => assert.throws(() => assertWrite('BITRIX24', 'CLIENT_UPDATE'), /TARGET_NOT_IN_MANIFEST/));
});

test('creation stays blocked until a readback can be committed to the manifest', () => {
  const assertWrite = createControlledLiveTestPolicy(manifest, 'postgres://localhost/sync_issue60_test');
  withControlledLiveEventScope(scope, () =>
    assert.throws(() => assertWrite('MOYSKLAD', 'CLIENT_CREATE'), /CREATE_REQUIRES_MANIFEST_COMMIT/));
});

test('async event scopes remain isolated when concurrent events overlap', async () => {
  const assertWrite = createControlledLiveTestPolicy(manifest, 'postgres://localhost/sync_issue60_test');
  const outcomes = await Promise.all([
    withControlledLiveEventScope(scope, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      assertWrite('MOYSKLAD', 'CLIENT_UPDATE');
      return 'allowed';
    }),
    withControlledLiveEventScope({ ...scope, targetNativeId: 'other' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      assert.throws(() => assertWrite('MOYSKLAD', 'CLIENT_UPDATE'), /TARGET_NOT_IN_MANIFEST/);
      return 'rejected';
    }),
  ]);
  assert.deepEqual(outcomes, ['allowed', 'rejected']);
});

test('the existing provider-write seam blocks missing controlled-test policy and delegates to the manifest allowlist', () => {
  const previousMode = process.env.CONTROLLED_LIVE_TEST_MODE;
  process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
  try {
    setControlledLiveTestWriteCheck(null);
    assert.throws(() => assertApplyExternalWrite('MOYSKLAD', 'CLIENT_CHILD_RESOURCE_UPDATE'), /POLICY_NOT_INITIALIZED/);
    setControlledLiveTestWriteCheck(createControlledLiveTestPolicy(manifest, 'postgres://localhost/sync_issue60_test'));
    withControlledLiveEventScope(scope, () => assert.doesNotThrow(() => assertApplyExternalWrite('MOYSKLAD', 'CLIENT_CHILD_RESOURCE_UPDATE')));
    withControlledLiveEventScope({ ...scope, targetNativeId: 'work-record-9' }, () =>
      assert.throws(() => assertApplyExternalWrite('MOYSKLAD', 'CLIENT_CHILD_RESOURCE_UPDATE'), /TARGET_NOT_IN_MANIFEST/));
  } finally {
    setControlledLiveTestWriteCheck(null);
    if (previousMode === undefined) delete process.env.CONTROLLED_LIVE_TEST_MODE;
    else process.env.CONTROLLED_LIVE_TEST_MODE = previousMode;
  }
});
