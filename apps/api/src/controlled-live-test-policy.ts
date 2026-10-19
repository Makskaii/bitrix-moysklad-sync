import { AsyncLocalStorage } from 'node:async_hooks';

export type ControlledProvider = 'BITRIX24' | 'MOYSKLAD';
export interface ControlledLiveManifestRecord {
  entity: string;
  direction: string;
  name: string;
  syntheticOnly: true;
  sourceSystem: ControlledProvider;
  sourceNativeId: string;
  targetSystem: ControlledProvider;
  targetNativeId: string;
}
export interface ControlledLiveManifest {
  runId: string;
  testDatabaseName: string;
  records: ControlledLiveManifestRecord[];
}
export interface ControlledLiveEventScope {
  runId: string;
  entity: string;
  sourceSystem: ControlledProvider;
  sourceNativeId: string;
  targetSystem: ControlledProvider;
  targetNativeId: string;
}

const scopeStorage = new AsyncLocalStorage<ControlledLiveEventScope>();

/**
 * Creates the server-side allowlist for one controlled run. The DB name must be
 * an explicitly named, dedicated test database and match the manifest exactly.
 */
export function createControlledLiveTestPolicy(
  manifestValue: unknown,
  databaseUrl: string | undefined,
): (provider: string, operation: string) => void {
  const manifest = parseManifest(manifestValue);
  const target = databaseTarget(databaseUrl);
  const actualDatabaseName = target.name;
  if (!['localhost', '127.0.0.1', '::1'].includes(target.host)) throw new Error('CONTROLLED_LIVE_TEST_DATABASE_MUST_BE_LOCAL');
  if (!/^(?=.*(?:^|[_-])test(?:$|[_-]))[a-z0-9_-]+$/i.test(actualDatabaseName) || manifest.testDatabaseName !== actualDatabaseName) {
    throw new Error('CONTROLLED_LIVE_TEST_DATABASE_IS_NOT_DEDICATED');
  }

  return (providerValue, operation) => {
    const scope = scopeStorage.getStore();
    if (!scope) throw new Error('CONTROLLED_LIVE_TEST_EVENT_SCOPE_REQUIRED');
    if (scope.runId !== manifest.runId) throw new Error('CONTROLLED_LIVE_TEST_RUN_ID_MISMATCH');
    if (!isProvider(providerValue)) throw new Error('CONTROLLED_LIVE_TEST_PROVIDER_INVALID');
    // Creates have no known target ID yet. They require a separate readback and
    // manifest-commit path, so they remain blocked until that path is installed.
    if (/(?:^|_)CREATE(?:_|$)/i.test(operation)) throw new Error('CONTROLLED_LIVE_TEST_CREATE_REQUIRES_MANIFEST_COMMIT');
    const allowed = manifest.records.some((record) => record.entity === scope.entity &&
      record.sourceSystem === scope.sourceSystem && record.sourceNativeId === scope.sourceNativeId &&
      record.targetSystem === scope.targetSystem && record.targetNativeId === scope.targetNativeId &&
      scope.targetSystem === providerValue);
    if (!allowed) throw new Error('CONTROLLED_LIVE_TEST_TARGET_NOT_IN_MANIFEST');
  };
}

/** Scope is intentionally explicit and async-local so concurrent events cannot borrow another event's allowlist. */
export function withControlledLiveEventScope<T>(scope: ControlledLiveEventScope, action: () => T): T {
  if (!scope.runId || !scope.entity || !scope.sourceNativeId || !isProvider(scope.sourceSystem) ||
      !isProvider(scope.targetSystem) || !scope.targetNativeId || scope.sourceSystem === scope.targetSystem) {
    throw new Error('CONTROLLED_LIVE_TEST_EVENT_SCOPE_INVALID');
  }
  return scopeStorage.run(scope, action);
}

function parseManifest(value: unknown): ControlledLiveManifest {
  if (!isRecord(value) || typeof value.runId !== 'string' || !/^LIVE-TEST-[0-9TZ-]+-[a-z0-9]{6,}$/i.test(value.runId) ||
      typeof value.testDatabaseName !== 'string' || !Array.isArray(value.records) || value.records.length === 0) {
    throw new Error('CONTROLLED_LIVE_TEST_MANIFEST_INVALID');
  }
  const records = value.records.map((item): ControlledLiveManifestRecord => {
    if (!isRecord(item) || typeof item.entity !== 'string' || !item.entity || typeof item.direction !== 'string' || !item.direction ||
        typeof item.name !== 'string' || !item.name.includes('тест') || !item.name.includes(value.runId as string) || item.syntheticOnly !== true ||
        !isProvider(item.sourceSystem) || !isProvider(item.targetSystem) ||
        typeof item.sourceNativeId !== 'string' || !item.sourceNativeId ||
        typeof item.targetNativeId !== 'string' || !item.targetNativeId || item.sourceSystem === item.targetSystem) {
      throw new Error('CONTROLLED_LIVE_TEST_MANIFEST_RECORD_INVALID');
    }
    return item as unknown as ControlledLiveManifestRecord;
  });
  const uniqueness = records.map((record) => `${record.targetSystem}:${record.targetNativeId}`);
  if (new Set(uniqueness).size !== uniqueness.length) throw new Error('CONTROLLED_LIVE_TEST_MANIFEST_DUPLICATE_TARGET');
  return { runId: value.runId, testDatabaseName: value.testDatabaseName, records };
}

function databaseTarget(value: string | undefined): { name: string; host: string } {
  if (!value) throw new Error('CONTROLLED_LIVE_TEST_DATABASE_URL_REQUIRED');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('CONTROLLED_LIVE_TEST_DATABASE_URL_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('CONTROLLED_LIVE_TEST_DATABASE_URL_INVALID');
  return { name: decodeURIComponent(url.pathname.replace(/^\//, '')), host: url.hostname.toLowerCase().replace(/^\[|\]$/g, '') };
}
function isProvider(value: unknown): value is ControlledProvider { return value === 'BITRIX24' || value === 'MOYSKLAD'; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
