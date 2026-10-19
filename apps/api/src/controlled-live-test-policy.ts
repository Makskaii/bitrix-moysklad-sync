import { AsyncLocalStorage } from 'node:async_hooks';

export type ControlledProvider = 'BITRIX24' | 'MOYSKLAD';
export interface ControlledLiveManifestRecord {
  entity: string;
  direction: string;
  name: string;
  syntheticOnly: true;
  sourceSystem: ControlledProvider;
  sourceNativeId: string | null;
  targetSystem: ControlledProvider;
  targetNativeId: string | null;
  createdAfterUtc: string;
}
export interface ControlledLiveManifest {
  runId: string;
  testDatabaseName: string;
  records: ControlledLiveManifestRecord[];
}
export interface ControlledLiveEventScope {
  eventId: string;
  runId: string;
  entity: string;
  sourceSystem: ControlledProvider;
  sourceNativeId: string;
  targetSystem: ControlledProvider;
  targetNativeId: string | null;
  admittedSourceName: string;
  admittedSourceCreatedAt: string;
}

const scopeStorage = new AsyncLocalStorage<ControlledLiveEventScope>();

/**
 * Creates the server-side allowlist for one controlled run. The DB name must be
 * an explicitly named, dedicated test database and match the manifest exactly.
 */
export function createControlledLiveTestPolicy(
  manifestValue: unknown,
  databaseUrl: string | undefined,
): (provider: string, operation: string, nativeId?: string | null) => void {
  const manifest = parseManifest(manifestValue);
  const target = databaseTarget(databaseUrl);
  const actualDatabaseName = target.name;
  if (!['localhost', '127.0.0.1', '::1'].includes(target.host)) throw new Error('CONTROLLED_LIVE_TEST_DATABASE_MUST_BE_LOCAL');
  if (!/^(?=.*(?:^|[_-])test(?:$|[_-]))[a-z0-9_-]+$/i.test(actualDatabaseName) || manifest.testDatabaseName !== actualDatabaseName) {
    throw new Error('CONTROLLED_LIVE_TEST_DATABASE_IS_NOT_DEDICATED');
  }

  return (providerValue, operation, nativeId) => {
    const scope = scopeStorage.getStore();
    if (!scope) throw new Error('CONTROLLED_LIVE_TEST_EVENT_SCOPE_REQUIRED');
    if (scope.runId !== manifest.runId) throw new Error('CONTROLLED_LIVE_TEST_RUN_ID_MISMATCH');
    if (!isProvider(providerValue)) throw new Error('CONTROLLED_LIVE_TEST_PROVIDER_INVALID');
    const isCreate = /(?:^|_)CREATE(?:_|$)/i.test(operation);
    const allowed = manifest.records.some((record) => record.entity === scope.entity &&
      ((record.sourceSystem === scope.sourceSystem && (record.sourceNativeId === null || record.sourceNativeId === scope.sourceNativeId) &&
        record.targetSystem === scope.targetSystem && (record.targetNativeId === null || record.targetNativeId === scope.targetNativeId)) ||
       (record.targetSystem === scope.sourceSystem && (record.targetNativeId === null || record.targetNativeId === scope.sourceNativeId) &&
        record.sourceSystem === scope.targetSystem && record.sourceNativeId === scope.targetNativeId)) &&
      scope.targetSystem === providerValue && scope.admittedSourceName === record.name &&
      new Date(scope.admittedSourceCreatedAt).getTime() >= new Date(record.createdAfterUtc).getTime() &&
      (isCreate ? record.sourceSystem === scope.sourceSystem && record.targetNativeId === null && scope.targetNativeId === null && nativeId === null :
        scope.targetNativeId !== null && nativeId === scope.targetNativeId));
    if (!allowed) throw new Error('CONTROLLED_LIVE_TEST_TARGET_NOT_IN_MANIFEST');
  };
}

/** Scope is intentionally explicit and async-local so concurrent events cannot borrow another event's allowlist. */
export function withControlledLiveEventScope<T>(scope: ControlledLiveEventScope, action: () => T): T {
  if (!scope.eventId || !scope.runId || !scope.entity || !scope.sourceNativeId || !isProvider(scope.sourceSystem) ||
      !isProvider(scope.targetSystem) || scope.targetSystem === scope.sourceSystem) {
    throw new Error('CONTROLLED_LIVE_TEST_EVENT_SCOPE_INVALID');
  }
  return scopeStorage.run(scope, action);
}

export function enterControlledLiveEventScope(scope: ControlledLiveEventScope): void {
  if (!scope.eventId || !scope.runId || !scope.entity || !scope.sourceNativeId || !isProvider(scope.sourceSystem) || !isProvider(scope.targetSystem) || scope.sourceSystem === scope.targetSystem) {
    throw new Error('CONTROLLED_LIVE_TEST_EVENT_SCOPE_INVALID');
  }
  scopeStorage.enterWith(scope);
}

export function bindControlledLiveTarget(targetNativeId: string): void {
  const scope = scopeStorage.getStore();
  if (!scope || !targetNativeId) throw new Error('CONTROLLED_LIVE_TEST_SCOPE_REQUIRED_FOR_TARGET_BIND');
  scope.targetNativeId = targetNativeId;
}

function parseManifest(value: unknown): ControlledLiveManifest {
  if (!isRecord(value) || typeof value.runId !== 'string' || !/^LIVE-TEST-[0-9TZ-]+-[a-z0-9]{6,}$/i.test(value.runId) ||
      typeof value.testDatabaseName !== 'string' || !Array.isArray(value.records) || value.records.length === 0) {
    throw new Error('CONTROLLED_LIVE_TEST_MANIFEST_INVALID');
  }
  const records = value.records.map((item): ControlledLiveManifestRecord => {
    if (!isRecord(item) || typeof item.entity !== 'string' || !item.entity || typeof item.direction !== 'string' || !item.direction ||
        typeof item.name !== 'string' || !item.name.includes('тест') || !item.name.includes(value.runId as string) || item.syntheticOnly !== true ||
        !isProvider(item.sourceSystem) || !isProvider(item.targetSystem) || typeof item.createdAfterUtc !== 'string' ||
        !Number.isFinite(new Date(item.createdAfterUtc).getTime()) ||
        !(item.sourceNativeId === null || (typeof item.sourceNativeId === 'string' && item.sourceNativeId)) ||
        !(item.targetNativeId === null || (typeof item.targetNativeId === 'string' && item.targetNativeId)) || item.sourceSystem === item.targetSystem) {
      throw new Error('CONTROLLED_LIVE_TEST_MANIFEST_RECORD_INVALID');
    }
    return item as unknown as ControlledLiveManifestRecord;
  });
  const uniqueness = records.map((record) => record.sourceNativeId === null ? `${record.targetSystem}:${record.name}` : `${record.sourceSystem}:${record.sourceNativeId}`);
  if (new Set(uniqueness).size !== uniqueness.length) throw new Error('CONTROLLED_LIVE_TEST_MANIFEST_DUPLICATE_RECORD');
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
