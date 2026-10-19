import { AsyncLocalStorage } from 'node:async_hooks';

export type ControlledProvider = 'BITRIX24' | 'MOYSKLAD';
export type ControlledTestDirection = 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24' | 'BOTH';
export interface ControlledLiveManifestRecord {
  entity: string;
  direction: ControlledTestDirection;
  name: string;
  syntheticOnly: true;
  sourceSystem: ControlledProvider;
  sourceNativeId: string | null;
  targetSystem: ControlledProvider;
  targetNativeId: string | null;
  createdAfterUtc: string;
  readOnlyDependencies?: Array<{ provider: ControlledProvider; entity: string; nativeId: string }>;
}
export interface ControlledLiveManifest {
  runId: string;
  testDatabaseName: string;
  testSchemaName: string;
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
  phase?: 'SOURCE_READ' | 'ADMITTED';
  pendingTargetNativeId?: string | null;
  pendingTargetSystem?: ControlledProvider | null;
}

const scopeStorage = new AsyncLocalStorage<ControlledLiveEventScope>();

/**
 * Creates the server-side allowlist for one controlled run. The DB name must be
 * an explicitly named, dedicated test database and match the manifest exactly.
 */
export function createControlledLiveTestPolicy(
  manifestValue: unknown,
  databaseUrl: string | undefined,
): (provider: string, operation: string, nativeId?: string | null, entity?: string) => void {
  const manifest = parseManifest(manifestValue);
  const target = databaseTarget(databaseUrl);
  const actualDatabaseName = target.name;
  if (!['localhost', '127.0.0.1', '::1'].includes(target.host)) throw new Error('CONTROLLED_LIVE_TEST_DATABASE_MUST_BE_LOCAL');
  if (!/^(?=.*(?:^|[_-])test(?:$|[_-]))[a-z0-9_-]+$/i.test(actualDatabaseName) || manifest.testDatabaseName !== actualDatabaseName) {
    throw new Error('CONTROLLED_LIVE_TEST_DATABASE_IS_NOT_DEDICATED');
  }
  if (!/^(?=.*(?:^|[_-])test(?:$|[_-]))[a-z0-9_-]+$/i.test(target.schema) || manifest.testSchemaName !== target.schema) {
    throw new Error('CONTROLLED_LIVE_TEST_SCHEMA_IS_NOT_DEDICATED');
  }

  return (providerValue, operation, nativeId, requestEntity) => {
    const scope = scopeStorage.getStore();
    if (!scope) throw new Error('CONTROLLED_LIVE_TEST_EVENT_SCOPE_REQUIRED');
    if (scope.runId !== manifest.runId) throw new Error('CONTROLLED_LIVE_TEST_RUN_ID_MISMATCH');
    if (!isProvider(providerValue)) throw new Error('CONTROLLED_LIVE_TEST_PROVIDER_INVALID');
    if (operation === 'CONTROLLED_READ') {
      if (!nativeId) throw new Error('CONTROLLED_LIVE_TEST_READ_SCOPE_INVALID');
      const directRead = providerValue === scope.sourceSystem && nativeId === scope.sourceNativeId ||
        providerValue === scope.targetSystem && nativeId === scope.targetNativeId ||
        providerValue === scope.pendingTargetSystem && nativeId === scope.pendingTargetNativeId;
      const sourceAllowed = manifest.records.some((record) => record.entity === scope.entity &&
        ((record.sourceSystem === providerValue && (record.sourceNativeId === null || record.sourceNativeId === nativeId)) ||
         (record.targetSystem === providerValue && (record.targetNativeId === null || record.targetNativeId === nativeId))));
      const dependencyAllowed = manifest.records.some((record) => record.entity === scope.entity && scopeMatchesManifestPair(record, scope) &&
        record.readOnlyDependencies?.some((dependency) => dependency.provider === providerValue && dependency.nativeId === nativeId && entityMatchesScope(requestEntity, dependency.entity)));
      if (!entityMatchesScope(requestEntity, scope.entity) && !dependencyAllowed) throw new Error('CONTROLLED_LIVE_TEST_READ_SCOPE_INVALID');
      if (!directRead && !dependencyAllowed) throw new Error('CONTROLLED_LIVE_TEST_READ_ID_NOT_APPROVED');
      if (!sourceAllowed && !dependencyAllowed) throw new Error('CONTROLLED_LIVE_TEST_READ_NOT_IN_MANIFEST');
      return;
    }
    if (!entityMatchesScope(requestEntity, scope.entity)) throw new Error('CONTROLLED_LIVE_TEST_ENTITY_MISMATCH');
    const isCreate = /(?:^|_)CREATE(?:_|$)/i.test(operation) && !/CHILD/i.test(operation);
    const allowed = manifest.records.some((record) => record.entity === scope.entity &&
      ((record.sourceSystem === scope.sourceSystem && (record.sourceNativeId === null || record.sourceNativeId === scope.sourceNativeId) &&
        record.targetSystem === scope.targetSystem && (record.targetNativeId === null || record.targetNativeId === scope.targetNativeId)) ||
       (record.direction === 'BOTH' && record.targetSystem === scope.sourceSystem && (record.targetNativeId === null || record.targetNativeId === scope.sourceNativeId) &&
        record.sourceSystem === scope.targetSystem && (record.sourceNativeId === null || record.sourceNativeId === scope.targetNativeId))) &&
      ((scope.targetSystem === providerValue && scope.admittedSourceName === record.name &&
        (isCreate ? record.sourceSystem === scope.sourceSystem && record.targetNativeId === null && scope.targetNativeId === null && nativeId === null :
          scope.targetNativeId !== null && nativeId === scope.targetNativeId)) ||
       (record.direction === 'BOTH' && !isCreate && scope.sourceSystem === providerValue && nativeId === scope.sourceNativeId &&
        (record.sourceSystem === scope.sourceSystem && record.name === scope.admittedSourceName || record.targetSystem === scope.sourceSystem && record.name === scope.admittedSourceName))) &&
      new Date(scope.admittedSourceCreatedAt).getTime() >= new Date(record.createdAfterUtc).getTime() &&
      (!isCreate || scope.targetSystem === providerValue));
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
  scope.pendingTargetNativeId = null;
  scope.pendingTargetSystem = null;
}

export function registerControlledTargetReadback(provider: ControlledProvider, targetNativeId: string): void {
  const scope = scopeStorage.getStore();
  if (scope && scope.phase !== 'SOURCE_READ' && scope.targetSystem === provider && scope.targetNativeId === targetNativeId && targetNativeId) return;
  if (!scope || scope.phase === 'SOURCE_READ' || scope.targetNativeId !== null || !targetNativeId || provider !== scope.targetSystem) {
    throw new Error('CONTROLLED_LIVE_TEST_TARGET_READBACK_SCOPE_INVALID');
  }
  scope.pendingTargetNativeId = targetNativeId;
  scope.pendingTargetSystem = provider;
}

function parseManifest(value: unknown): ControlledLiveManifest {
  if (!isRecord(value) || typeof value.runId !== 'string' || !/^LIVE-TEST-[0-9TZ-]+-[a-z0-9]{6,}$/i.test(value.runId) ||
      typeof value.testDatabaseName !== 'string' || typeof value.testSchemaName !== 'string' || !Array.isArray(value.records) || value.records.length === 0) {
    throw new Error('CONTROLLED_LIVE_TEST_MANIFEST_INVALID');
  }
  const records = value.records.map((item): ControlledLiveManifestRecord => {
    if (!isRecord(item) || typeof item.entity !== 'string' || !item.entity || !['BITRIX24_TO_MOYSKLAD', 'MOYSKLAD_TO_BITRIX24', 'BOTH'].includes(String(item.direction)) ||
        typeof item.name !== 'string' || !item.name.includes('тест') || !item.name.includes(value.runId as string) || item.syntheticOnly !== true ||
        !isProvider(item.sourceSystem) || !isProvider(item.targetSystem) || typeof item.createdAfterUtc !== 'string' ||
        !Number.isFinite(new Date(item.createdAfterUtc).getTime()) ||
        !(item.sourceNativeId === null || (typeof item.sourceNativeId === 'string' && item.sourceNativeId)) ||
        !(item.targetNativeId === null || (typeof item.targetNativeId === 'string' && item.targetNativeId)) || item.sourceSystem === item.targetSystem ||
        (item.readOnlyDependencies !== undefined && (!Array.isArray(item.readOnlyDependencies) || item.readOnlyDependencies.some((dependency) =>
          !isRecord(dependency) || !isProvider(dependency.provider) || typeof dependency.entity !== 'string' || !dependency.entity || typeof dependency.nativeId !== 'string' || !dependency.nativeId))) ||
        (item.direction === 'BITRIX24_TO_MOYSKLAD' && (item.sourceSystem !== 'BITRIX24' || item.targetSystem !== 'MOYSKLAD')) ||
        (item.direction === 'MOYSKLAD_TO_BITRIX24' && (item.sourceSystem !== 'MOYSKLAD' || item.targetSystem !== 'BITRIX24'))) {
      throw new Error('CONTROLLED_LIVE_TEST_MANIFEST_RECORD_INVALID');
    }
    return item as unknown as ControlledLiveManifestRecord;
  });
  const uniqueness = new Set<string>();
  for (const record of records) {
    const identities = [
      record.sourceNativeId === null ? null : `${record.entity}:${record.sourceSystem}:${record.sourceNativeId}`,
      record.targetNativeId === null ? `${record.entity}:${record.targetSystem}:name:${record.name}` : `${record.entity}:${record.targetSystem}:${record.targetNativeId}`,
    ].filter((value): value is string => value !== null);
    for (const identity of identities) {
      if (uniqueness.has(identity)) throw new Error('CONTROLLED_LIVE_TEST_MANIFEST_DUPLICATE_RECORD');
      uniqueness.add(identity);
    }
  }
  return { runId: value.runId, testDatabaseName: value.testDatabaseName, testSchemaName: value.testSchemaName, records };
}

function databaseTarget(value: string | undefined): { name: string; host: string; schema: string } {
  if (!value) throw new Error('CONTROLLED_LIVE_TEST_DATABASE_URL_REQUIRED');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('CONTROLLED_LIVE_TEST_DATABASE_URL_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('CONTROLLED_LIVE_TEST_DATABASE_URL_INVALID');
  const schema = url.searchParams.get('schema');
  if (!schema) throw new Error('CONTROLLED_LIVE_TEST_DATABASE_SCHEMA_REQUIRED');
  return { name: decodeURIComponent(url.pathname.replace(/^\//, '')), host: url.hostname.toLowerCase().replace(/^\[|\]$/g, ''), schema };
}
function isProvider(value: unknown): value is ControlledProvider { return value === 'BITRIX24' || value === 'MOYSKLAD'; }
function entityMatchesScope(requestEntity: string | undefined, scopeEntity: string): boolean {
  return requestEntity === scopeEntity || (requestEntity === 'client:COUNTERPARTY' && ['client:COMPANY', 'client:CONTACT'].includes(scopeEntity));
}
function scopeMatchesManifestPair(record: ControlledLiveManifestRecord, scope: ControlledLiveEventScope): boolean {
  const forward = record.sourceSystem === scope.sourceSystem && (record.sourceNativeId === null || record.sourceNativeId === scope.sourceNativeId) &&
    record.targetSystem === scope.targetSystem && (record.targetNativeId === null || record.targetNativeId === scope.targetNativeId);
  const reverse = record.direction === 'BOTH' && record.targetSystem === scope.sourceSystem && (record.targetNativeId === null || record.targetNativeId === scope.sourceNativeId) &&
    record.sourceSystem === scope.targetSystem && (record.sourceNativeId === null || record.sourceNativeId === scope.targetNativeId);
  return forward || reverse;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
