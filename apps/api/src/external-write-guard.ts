import { assertControlledCreateMarker } from './controlled-live-test-policy';
import { parseExpectedNamespace, parseProviderBase } from './controlled-live-test-namespace';

let databaseRecoveryReady = true;
let controlledWriteCheck: ((provider: string, operation: string, nativeId?: string | null, entity?: string) => void) | null = null;

/** Closed by bootstrap before the server starts accepting requests. */
export function setDatabaseRecoveryReady(ready: boolean): void {
  databaseRecoveryReady = ready;
}

export function assertApplyExternalWrite(provider: string, operation: string, nativeId?: string | null, entity?: string): void {
  if (process.env.SYNC_MODE === 'dry') {
    throw new Error(`${provider}_${operation}_WRITE_REQUIRES_APPLY_MODE`);
  }
  if (process.env.SYNC_MODE === 'apply' && !databaseRecoveryReady) {
    throw new Error(`${provider}_${operation}_BLOCKED_DATABASE_RECOVERY_REQUIRED`);
  }
  if (process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
    if (!controlledWriteCheck) throw new Error('CONTROLLED_LIVE_TEST_POLICY_NOT_INITIALIZED');
    // Some legacy adapters use this as an apply-mode preflight before they
    // construct the provider request. It carries no target authority; the
    // final fetch guard classifies and checks the complete request immediately
    // before transport. Calls that do carry a target are checked here too.
    if (nativeId !== undefined || entity !== undefined) controlledWriteCheck(provider, operation, nativeId, entity);
  }
}

export function assertControlledExternalRead(provider: string, nativeId: string | null, entity?: string, operation: 'CONTROLLED_READ' | 'CONTROLLED_RECOVERY_READ' = 'CONTROLLED_READ'): void {
  if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
  if (!controlledWriteCheck) throw new Error('CONTROLLED_LIVE_TEST_POLICY_NOT_INITIALIZED');
  controlledWriteCheck(provider, operation, nativeId, entity);
}

/** Installs the manifest-backed policy. Enabling test mode without this policy fails closed. */
export function setControlledLiveTestWriteCheck(check: ((provider: string, operation: string, nativeId?: string | null, entity?: string) => void) | null): void {
  controlledWriteCheck = check;
}

/** Final transport guard catches provider writes that bypass a domain adapter's local assertion. */
export function installControlledLiveFetchGuard(expectedNamespaceValue?: unknown): void {
  if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
  if (!expectedNamespaceValue) throw new Error('CONTROLLED_LIVE_TEST_PROVIDER_NAMESPACE_REQUIRED');
  const expectedNamespace = parseExpectedNamespace(expectedNamespaceValue, process.env.CONTROLLED_LIVE_TEST_FAKE_PROVIDER_HTTP === 'enabled');
  const originalFetch = globalThis.fetch.bind(globalThis);
  const configured = [
    { provider: 'BITRIX24', base: process.env.BITRIX24_REST_BASE_URL },
    { provider: 'MOYSKLAD', base: process.env.MOYSKLAD_API_BASE_URL },
  ].map(({ provider, base }) => {
    const parsed = parseProviderBase(provider as 'BITRIX24' | 'MOYSKLAD', base, process.env.CONTROLLED_LIVE_TEST_FAKE_PROVIDER_HTTP === 'enabled');
    if (provider === 'BITRIX24' && parsed.origin !== expectedNamespace.bitrix24PortalOrigin) throw new Error('CONTROLLED_LIVE_TEST_BITRIX24_PORTAL_ORIGIN_MISMATCH');
    return { provider, origin: parsed.origin, prefix: parsed.base.pathname };
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, { ...init, redirect: 'error' });
    const method = request.method.toUpperCase();
    const url = new URL(request.url);
    const match = configured.find((entry) => url.origin === entry.origin && url.pathname.startsWith(entry.prefix));
    if (!match) throw new Error('CONTROLLED_LIVE_TEST_UNCLASSIFIED_EXTERNAL_REQUEST');
    const relativePath = url.pathname.slice(match.prefix.length);
    if (['GET', 'HEAD', 'OPTIONS'].includes(method) || match.provider === 'BITRIX24' && isBitrixReadMethod(relativePath)) {
      if (!isUnscopedMetadataRead(match.provider, relativePath)) {
        const bodyText = init?.body instanceof URLSearchParams ? init.body.toString()
          : typeof init?.body === 'string' ? init.body
          : await request.clone().text();
        const recoverySourceId = exactRecoverySourceId(match.provider, relativePath, url, bodyText);
        const assortmentProductId = match.provider === 'MOYSKLAD' && method === 'GET' && relativePath === 'entity/assortment'
          && url.searchParams.getAll('filter').length === 1 && url.searchParams.getAll('limit').length === 1 && url.searchParams.get('limit') === '2'
          && [...url.searchParams.keys()].every((key) => key === 'filter' || key === 'limit')
          ? /^id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url.searchParams.get('filter') ?? '')?.[1] : undefined;
        assertControlledExternalRead(match.provider, recoverySourceId ?? assortmentProductId ?? extractMutationTarget(match.provider, relativePath, bodyText),
          assortmentProductId ? 'catalog-product' : mutationEntity(match.provider, relativePath, bodyText), recoverySourceId ? 'CONTROLLED_RECOVERY_READ' : 'CONTROLLED_READ');
      }
    } else {
      const bodyText = init?.body instanceof URLSearchParams ? init.body.toString()
        : typeof init?.body === 'string' ? init.body
        : await request.clone().text();
      const nativeId = extractMutationTarget(match.provider, relativePath, bodyText);
      const requestEntity = mutationEntity(match.provider, relativePath, bodyText);
      const operation = mutationOperation(match.provider, method, relativePath);
      if (operation === 'CONTROLLED_CREATE') assertControlledCreateMarker(match.provider, relativePath, bodyText, requestEntity);
      assertApplyExternalWrite(match.provider, operation, nativeId, requestEntity);
    }
    return originalFetch(request);
  }) as typeof fetch;
}

function exactRecoverySourceId(provider: string, path: string, url: URL, bodyText: string): string | null {
  if (provider === 'MOYSKLAD' && path === 'entity/invoiceout') {
    const match = /^externalCode=(\d{1,20})$/.exec(url.searchParams.get('filter') ?? '');
    return match?.[1] ?? null;
  }
  if (provider === 'BITRIX24' && path.split('/').at(-1)?.replace(/\.json$/i, '') === 'crm.item.list') {
    const form = new URLSearchParams(bodyText);
    if (form.get('entityTypeId') === '31' && form.get('filter[originatorId]') === 'MOYSKLAD') {
      const id = form.get('filter[originId]') ?? '';
      return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
    }
  }
  return null;
}

function mutationOperation(provider: string, method: string, path: string): string {
  if (provider === 'BITRIX24') {
    const restMethod = path.split('/').pop()?.replace(/\.json$/i, '') ?? '';
    if (/\.(?:add|create)$/i.test(restMethod)) {
      return /^(?:crm\.(?:company|contact|deal|item)\.add|catalog\.product\.add|crm\.product\.add)$/i.test(restMethod)
        || restMethod.toLowerCase() === 'catalog.product.service.add'
        ? 'CONTROLLED_CREATE' : 'CONTROLLED_CHILD_CREATE';
    }
    return 'CONTROLLED_UPDATE';
  }
  const segments = path.split('/').filter(Boolean);
  if (method === 'POST' && ['contactpersons', 'positions', 'prices', 'accounts', 'attributes'].includes(segments.at(-1) ?? '')) return 'CONTROLLED_CHILD_CREATE';
  return method === 'POST' && segments.length === 2 ? 'CONTROLLED_CREATE' : 'CONTROLLED_UPDATE';
}

function isBitrixReadMethod(path: string): boolean {
  const method = path.split('/').pop()?.replace(/\.json$/i, '').toLowerCase() ?? '';
  return /\.(?:get|list|fields|types|available|current|count|methods)$/.test(method) || method === 'user.current';
}

function isUnscopedMetadataRead(provider: string, path: string): boolean {
  if (provider === 'BITRIX24') {
    const method = path.split('/').pop()?.replace(/\.json$/i, '').toLowerCase() ?? '';
    return /\.(?:fields|types|available|methods)$/.test(method) || method === 'user.current';
  }
  return /^entity\/metadata(?:\/|$)/.test(path) || path === 'context/employee';
}

function mutationEntity(provider: string, path: string, bodyText: string): string | undefined {
  if (provider === 'BITRIX24') {
    const method = path.split('/').pop()?.replace(/\.json$/i, '').toLowerCase() ?? '';
    if (method.startsWith('crm.company.')) return 'client:COMPANY';
    if (method.startsWith('crm.contact.')) return 'client:CONTACT';
    if (method.startsWith('crm.deal.') || method.startsWith('crm.item.productrow.')) return 'deal-order';
    if (method.startsWith('crm.product.') || method.startsWith('catalog.price.')) return 'catalog-product';
    if (method.startsWith('catalog.product.service.')) return 'catalog-service';
    if (method.startsWith('catalog.product.')) return 'catalog-product';
    if (method.startsWith('crm.invoice.') || method.startsWith('crm.item.')) {
      const form = new URLSearchParams(bodyText);
      const entityType = form.get('entityTypeId') ?? form.get('fields[entityTypeId]');
      if (entityType === '31') return 'invoice';
      if (entityType === '2') return 'deal-order';
      return undefined;
    }
    if (method.startsWith('crm.requisite.') || method.startsWith('crm.timeline.comment.')) {
      const form = new URLSearchParams(bodyText);
      const entityType = form.get('ENTITY_TYPE_ID') ?? form.get('fields[ENTITY_TYPE_ID]') ?? form.get('filter[ENTITY_TYPE_ID]') ?? form.get('fields[ENTITY_TYPE]') ?? form.get('filter[ENTITY_TYPE]') ?? '';
      if (/^(?:4|COMPANY)$/i.test(entityType)) return 'client:COMPANY';
      if (/^(?:3|CONTACT)$/i.test(entityType)) return 'client:CONTACT';
      if (/^DEAL$/i.test(entityType)) return 'deal-order';
      if (/^PRODUCT$/i.test(entityType)) return 'catalog-product';
      if (/^INVOICE$/i.test(entityType)) return 'invoice';
      return undefined;
    }
    return undefined;
  }
  const segments = path.split('/').filter(Boolean);
  if (segments[0] !== 'entity') return undefined;
  if (segments[1] === 'customerorder' && segments[2] === 'metadata' && segments[3] === 'states') return 'readonly:state';
  if (segments[1] === 'counterparty') {
    if (!segments.includes('contactpersons') && !/"companyType"\s*:\s*"individual"/.test(bodyText)) return 'client:COUNTERPARTY';
    if (segments.includes('contactpersons') || /(?:^|&)companyType=individual(?:&|$)/.test(bodyText)) return 'client:CONTACT';
    return 'client:COMPANY';
  }
  if (segments[1] === 'customerorder') return 'deal-order';
  if (segments[1] === 'invoiceout') return 'invoice';
  if (segments[1] === 'product') return 'catalog-product';
  if (segments[1] === 'service') return 'catalog-service';
  return segments[1] ? `readonly:${segments[1]}` : undefined;
}

function extractMutationTarget(provider: string, path: string, bodyText: string): string | null {
  if (provider === 'MOYSKLAD') {
    const segments = path.split('/').filter(Boolean);
    if (segments.length >= 3 && segments[0] === 'entity') {
      if (segments[1] === 'customerorder' && segments[2] === 'metadata' && segments[3] === 'states' && segments[4]) return decodeURIComponent(segments[4]);
      if (segments[3] === 'contactpersons' && segments[4]) return decodeURIComponent(segments[4]);
      if (segments[3] === 'positions' || segments[3] === 'prices' || segments[3] === 'accounts' || segments[3] === 'attributes') return decodeURIComponent(segments[2]);
      if (segments[2] && segments.length >= 3) return decodeURIComponent(segments[2]);
    }
    return null;
  }
  const form = new URLSearchParams(bodyText);
  const method = path.split('/').pop()?.replace(/\.json$/i, '') ?? '';
  if (/^crm\.(?:requisite|timeline\.comment)\./i.test(method)) {
    for (const key of ['fields[ENTITY_ID]', 'filter[ENTITY_ID]', 'ENTITY_ID']) {
      const value = form.get(key);
      if (value) return value;
    }
  }
  if (/\.(?:add|create)$/i.test(method)) return null;
  if (/^crm\.item\.productrow\.list$/i.test(method)) {
    // The document reader scopes this list by its owning DEAL, not a row ID.
    // Accept only its exact-equality form; an unfiltered/foreign/ambiguous list
    // must still be rejected before network by the manifest policy.
    const owners = form.getAll('filter[=ownerId]');
    const types = form.getAll('filter[=ownerType]');
    if (owners.length === 1 && /^\d{1,20}$/.test(owners[0]) && types.length === 1 && types[0] === 'D'
      && [...form.keys()].every((key) => ['filter[=ownerId]', 'filter[=ownerType]', 'start'].includes(key))) return owners[0];
    return null;
  }
  if (/^crm\.item\.productrow\./i.test(method)) {
    for (const key of ['ownerId', 'fields[ownerId]']) {
      const value = form.get(key);
      if (value) return value;
    }
  }
  if (/^catalog\.price\./i.test(method)) {
    for (const key of ['productId', 'fields[productId]', 'catalogProductId']) {
      const value = form.get(key);
      if (value) return value;
    }
  }
  for (const key of ['id', 'fields[ENTITY_ID]', 'filter[ENTITY_ID]', 'ENTITY_ID', 'entityId', 'ownerId', 'fields[ownerId]', 'productId', 'fields[productId]', 'catalogProductId']) {
    const value = form.get(key);
    if (value) return value;
  }
  return null;
}
