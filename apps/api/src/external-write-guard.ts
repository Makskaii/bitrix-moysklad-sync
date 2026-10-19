let databaseRecoveryReady = true;
let controlledWriteCheck: ((provider: string, operation: string, nativeId?: string | null) => void) | null = null;

/** Closed by bootstrap before the server starts accepting requests. */
export function setDatabaseRecoveryReady(ready: boolean): void {
  databaseRecoveryReady = ready;
}

export function assertApplyExternalWrite(provider: string, operation: string, nativeId?: string | null): void {
  if (process.env.SYNC_MODE === 'dry') {
    throw new Error(`${provider}_${operation}_WRITE_REQUIRES_APPLY_MODE`);
  }
  if (process.env.SYNC_MODE === 'apply' && !databaseRecoveryReady) {
    throw new Error(`${provider}_${operation}_BLOCKED_DATABASE_RECOVERY_REQUIRED`);
  }
  if (process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
    if (!controlledWriteCheck) throw new Error('CONTROLLED_LIVE_TEST_POLICY_NOT_INITIALIZED');
    // Missing IDs are denied: a per-call guard without the exact resource ID
    // must never inherit permission from a manifest-scoped event.
    controlledWriteCheck(provider, operation, nativeId);
  }
}

/** Installs the manifest-backed policy. Enabling test mode without this policy fails closed. */
export function setControlledLiveTestWriteCheck(check: ((provider: string, operation: string, nativeId?: string | null) => void) | null): void {
  controlledWriteCheck = check;
}

/** Final transport guard catches provider writes that bypass a domain adapter's local assertion. */
export function installControlledLiveFetchGuard(): void {
  if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  const configured = [
    { provider: 'BITRIX24', base: process.env.BITRIX24_REST_BASE_URL },
    { provider: 'MOYSKLAD', base: process.env.MOYSKLAD_API_BASE_URL },
  ].map(({ provider, base }) => {
    if (!base) throw new Error(`CONTROLLED_LIVE_TEST_${provider}_BASE_URL_REQUIRED`);
    const url = new URL(base);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error(`CONTROLLED_LIVE_TEST_${provider}_BASE_URL_INVALID`);
    return { provider, origin: url.origin, prefix: url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/` };
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const method = request.method.toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const url = new URL(request.url);
      const match = configured.find((entry) => url.origin === entry.origin && url.pathname.startsWith(entry.prefix));
      if (!match) throw new Error('CONTROLLED_LIVE_TEST_UNCLASSIFIED_EXTERNAL_MUTATION');
      const relativePath = url.pathname.slice(match.prefix.length);
      if (match.provider === 'BITRIX24' && isBitrixReadMethod(relativePath)) return originalFetch(input, init);
      const bodyText = init?.body instanceof URLSearchParams ? init.body.toString()
        : typeof init?.body === 'string' ? init.body
        : input instanceof Request ? await input.clone().text() : '';
      const nativeId = extractMutationTarget(match.provider, relativePath, bodyText);
      assertApplyExternalWrite(match.provider, mutationOperation(match.provider, method, relativePath), nativeId);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

function mutationOperation(provider: string, method: string, path: string): string {
  if (provider === 'BITRIX24') {
    const restMethod = path.split('/').pop()?.replace(/\.json$/i, '') ?? '';
    if (/\.(?:add|create)$/i.test(restMethod)) return 'CONTROLLED_CREATE';
    return 'CONTROLLED_UPDATE';
  }
  const segments = path.split('/').filter(Boolean);
  return method === 'POST' && (segments.length === 2 || ['contactpersons', 'positions', 'prices', 'accounts'].includes(segments.at(-1) ?? ''))
    ? 'CONTROLLED_CREATE' : 'CONTROLLED_UPDATE';
}

function isBitrixReadMethod(path: string): boolean {
  const method = path.split('/').pop()?.replace(/\.json$/i, '').toLowerCase() ?? '';
  return /\.(?:get|list|fields|types|available|current|count|methods)$/.test(method) || method === 'user.current';
}

function extractMutationTarget(provider: string, path: string, bodyText: string): string | null {
  if (provider === 'MOYSKLAD') {
    const segments = path.split('/').filter(Boolean);
    if (segments.length >= 3 && segments[0] === 'entity') {
      if (segments[3] === 'contactpersons' && segments[4]) return decodeURIComponent(segments[4]);
      if (segments[3] === 'positions' || segments[3] === 'prices' || segments[3] === 'accounts' || segments[3] === 'attributes') return decodeURIComponent(segments[2]);
      if (segments[2] && segments.length >= 3) return decodeURIComponent(segments[2]);
    }
    return null;
  }
  const form = new URLSearchParams(bodyText);
  const method = path.split('/').pop()?.replace(/\.json$/i, '') ?? '';
  if (/\.(?:add|create)$/i.test(method)) return null;
  for (const key of ['id', 'fields[ENTITY_ID]', 'entityId', 'ownerId', 'fields[ownerId]', 'productId', 'fields[productId]', 'catalogProductId']) {
    const value = form.get(key);
    if (value) return value;
  }
  return null;
}
