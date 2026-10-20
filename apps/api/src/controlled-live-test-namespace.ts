export interface ControlledLiveProviderNamespace {
  bitrix24PortalOrigin: string;
  bitrix24UserId: string;
  moyskladAccountId: string;
}

let verifiedNamespace: ControlledLiveProviderNamespace | null = null;

export function setVerifiedControlledLiveProviderNamespace(value: ControlledLiveProviderNamespace): void {
  verifiedNamespace = parseExpectedNamespace(value, true);
}

export function getVerifiedControlledLiveProviderNamespace(expected?: unknown): ControlledLiveProviderNamespace {
  if (!verifiedNamespace) throw new Error('CONTROLLED_LIVE_TEST_PROVIDER_NAMESPACE_NOT_VERIFIED');
  const allowLoopbackHttp = process.env.CONTROLLED_LIVE_TEST_FAKE_PROVIDER_HTTP === 'enabled';
  if (expected && !sameNamespace(verifiedNamespace, parseExpectedNamespace(expected, allowLoopbackHttp))) {
    throw new Error('CONTROLLED_LIVE_TEST_PROVIDER_NAMESPACE_MISMATCH');
  }
  return { ...verifiedNamespace };
}

export interface ControlledLiveProviderNamespaceOptions {
  bitrix24RestBaseUrl: string | undefined;
  moyskladApiBaseUrl: string | undefined;
  moyskladApiToken: string | undefined;
  allowLoopbackHttp: boolean;
}

/**
 * Reads stable account-context identifiers using the currently configured
 * credentials. Neither response bodies nor credentials are included in errors.
 */
export async function verifyControlledLiveProviderNamespace(
  expectedValue: unknown,
  options: ControlledLiveProviderNamespaceOptions,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ControlledLiveProviderNamespace> {
  const expected = parseExpectedNamespace(expectedValue, options.allowLoopbackHttp);
  const bitrixBase = parseProviderBase('BITRIX24', options.bitrix24RestBaseUrl, options.allowLoopbackHttp);
  const moyskladBase = parseProviderBase('MOYSKLAD', options.moyskladApiBaseUrl, options.allowLoopbackHttp);
  if (bitrixBase.origin !== expected.bitrix24PortalOrigin) throw new Error('CONTROLLED_LIVE_TEST_BITRIX24_PORTAL_ORIGIN_MISMATCH');
  if (!options.moyskladApiToken || /\s/.test(options.moyskladApiToken)) throw new Error('CONTROLLED_LIVE_TEST_MOYSKLAD_TOKEN_REQUIRED');

  const bitrixResponse = await fetcher(new URL('user.current.json', ensureTrailingSlash(bitrixBase.base)), {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{}', redirect: 'error',
  });
  if (!bitrixResponse.ok) throw new Error('CONTROLLED_LIVE_TEST_BITRIX24_IDENTITY_READ_FAILED');
  const bitrixPayload: unknown = await bitrixResponse.json();
  const bitrixUserId = nestedString(bitrixPayload, 'result', 'ID');
  if (bitrixUserId !== expected.bitrix24UserId) throw new Error('CONTROLLED_LIVE_TEST_BITRIX24_CREDENTIAL_IDENTITY_MISMATCH');

  const moyskladResponse = await fetcher(new URL('context/employee', ensureTrailingSlash(moyskladBase.base)), {
    method: 'GET', headers: {
      authorization: `Bearer ${options.moyskladApiToken}`,
      accept: 'application/json;charset=utf-8',
      'accept-encoding': 'gzip',
    }, redirect: 'error',
  });
  if (!moyskladResponse.ok) throw new Error('CONTROLLED_LIVE_TEST_MOYSKLAD_IDENTITY_READ_FAILED');
  const moyskladPayload: unknown = await moyskladResponse.json();
  const accountId = nestedString(moyskladPayload, 'accountId');
  if (accountId !== expected.moyskladAccountId) throw new Error('CONTROLLED_LIVE_TEST_MOYSKLAD_ACCOUNT_IDENTITY_MISMATCH');
  setVerifiedControlledLiveProviderNamespace(expected);
  return expected;
}

export function parseExpectedNamespace(value: unknown, allowLoopbackHttp = false): ControlledLiveProviderNamespace {
  if (!isRecord(value) || typeof value.bitrix24PortalOrigin !== 'string' || typeof value.bitrix24UserId !== 'string' ||
      !/^\d{1,20}$/.test(value.bitrix24UserId) || typeof value.moyskladAccountId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.moyskladAccountId)) {
    throw new Error('CONTROLLED_LIVE_TEST_PROVIDER_NAMESPACE_INVALID');
  }
  let portal: URL;
  try { portal = new URL(value.bitrix24PortalOrigin); } catch { throw new Error('CONTROLLED_LIVE_TEST_PROVIDER_NAMESPACE_INVALID'); }
  const portalHost = portal.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const localHttp = portal.protocol === 'http:' && allowLoopbackHttp && ['localhost', '127.0.0.1', '::1'].includes(portalHost);
  if (portal.protocol !== 'https:' && !localHttp || portal.origin !== value.bitrix24PortalOrigin || portal.username || portal.password || portal.search || portal.hash) {
    throw new Error('CONTROLLED_LIVE_TEST_PROVIDER_NAMESPACE_INVALID');
  }
  return { bitrix24PortalOrigin: portal.origin, bitrix24UserId: value.bitrix24UserId, moyskladAccountId: value.moyskladAccountId };
}

export function parseProviderBase(provider: 'BITRIX24' | 'MOYSKLAD', value: string | undefined, allowLoopbackHttp: boolean): { base: URL; origin: string } {
  if (!value) throw new Error(`CONTROLLED_LIVE_TEST_${provider}_BASE_URL_REQUIRED`);
  let base: URL;
  try { base = new URL(value); } catch { throw new Error('CONTROLLED_LIVE_TEST_PROVIDER_BASE_URL_INVALID'); }
  if (base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) throw new Error('CONTROLLED_LIVE_TEST_PROVIDER_BASE_URL_INVALID');
  if (base.protocol !== 'https:') {
    const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(host);
    if (base.protocol !== 'http:' || !allowLoopbackHttp || !isLoopback) throw new Error('CONTROLLED_LIVE_TEST_PROVIDER_BASE_URL_MUST_USE_HTTPS');
  }
  return { base, origin: base.origin };
}

function ensureTrailingSlash(url: URL): URL {
  const result = new URL(url.href);
  if (!result.pathname.endsWith('/')) result.pathname += '/';
  return result;
}
function nestedString(value: unknown, ...path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === 'string' || typeof current === 'number' ? String(current) : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sameNamespace(left: ControlledLiveProviderNamespace, right: ControlledLiveProviderNamespace): boolean {
  return left.bitrix24PortalOrigin === right.bitrix24PortalOrigin && left.bitrix24UserId === right.bitrix24UserId &&
    left.moyskladAccountId === right.moyskladAccountId;
}
