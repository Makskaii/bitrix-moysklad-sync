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
    // Missing IDs are denied: a per-call guard without the exact resource ID
    // must never inherit permission from a manifest-scoped event.
    controlledWriteCheck(provider, operation, nativeId, entity);
  }
}

export function assertControlledExternalRead(provider: string, nativeId: string | null, entity?: string): void {
  if (process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled') return;
  if (!controlledWriteCheck) throw new Error('CONTROLLED_LIVE_TEST_POLICY_NOT_INITIALIZED');
  controlledWriteCheck(provider, 'CONTROLLED_READ', nativeId, entity);
}

/** Installs the manifest-backed policy. Enabling test mode without this policy fails closed. */
export function setControlledLiveTestWriteCheck(check: ((provider: string, operation: string, nativeId?: string | null, entity?: string) => void) | null): void {
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
        assertControlledExternalRead(match.provider, extractMutationTarget(match.provider, relativePath, bodyText), mutationEntity(match.provider, relativePath, bodyText));
      }
    } else {
      const bodyText = init?.body instanceof URLSearchParams ? init.body.toString()
        : typeof init?.body === 'string' ? init.body
        : await request.clone().text();
      const nativeId = extractMutationTarget(match.provider, relativePath, bodyText);
      const requestEntity = mutationEntity(match.provider, relativePath, bodyText);
      assertApplyExternalWrite(match.provider, mutationOperation(match.provider, method, relativePath), nativeId, requestEntity);
    }
    return originalFetch(request);
  }) as typeof fetch;
}

function mutationOperation(provider: string, method: string, path: string): string {
  if (provider === 'BITRIX24') {
    const restMethod = path.split('/').pop()?.replace(/\.json$/i, '') ?? '';
    if (/\.(?:add|create)$/i.test(restMethod)) {
      return /^(?:crm\.(?:company|contact|deal|item)\.add|catalog\.product\.add|crm\.product\.add)$/i.test(restMethod)
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
  return /^entity\/metadata(?:\/|$)/.test(path);
}

function mutationEntity(provider: string, path: string, bodyText: string): string | undefined {
  if (provider === 'BITRIX24') {
    const method = path.split('/').pop()?.replace(/\.json$/i, '').toLowerCase() ?? '';
    if (method.startsWith('crm.company.')) return 'client:COMPANY';
    if (method.startsWith('crm.contact.')) return 'client:CONTACT';
    if (method.startsWith('crm.deal.') || method.startsWith('crm.item.productrow.')) return 'deal-order';
    if (method.startsWith('crm.product.') || method.startsWith('catalog.product.') || method.startsWith('catalog.price.')) return 'catalog-product';
    if (method.startsWith('crm.invoice.') || method.startsWith('crm.item.')) {
      const form = new URLSearchParams(bodyText);
      return form.get('entityTypeId') === '31' || form.get('fields[entityTypeId]') === '31' ? 'invoice' : undefined;
    }
    if (method.startsWith('crm.requisite.') || method.startsWith('crm.timeline.comment.')) {
      const form = new URLSearchParams(bodyText);
      const entityType = form.get('ENTITY_TYPE_ID') ?? form.get('fields[ENTITY_TYPE_ID]') ?? form.get('filter[ENTITY_TYPE_ID]') ?? form.get('fields[ENTITY_TYPE]') ?? '';
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
  if (segments[1] === 'counterparty') {
    if (!segments.includes('contactpersons') && !/"companyType"\s*:\s*"individual"/.test(bodyText)) return 'client:COUNTERPARTY';
    if (segments.includes('contactpersons') || /(?:^|&)companyType=individual(?:&|$)/.test(bodyText)) return 'client:CONTACT';
    return 'client:COMPANY';
  }
  if (segments[1] === 'customerorder') return 'deal-order';
  if (segments[1] === 'invoiceout') return 'invoice';
  if (segments[1] === 'product') return 'catalog-product';
  if (segments[1] === 'service') return 'catalog-service';
  return undefined;
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
  for (const key of ['id', 'fields[ENTITY_ID]', 'filter[ENTITY_ID]', 'ENTITY_ID', 'entityId', 'ownerId', 'fields[ownerId]', 'productId', 'fields[productId]', 'catalogProductId']) {
    const value = form.get(key);
    if (value) return value;
  }
  return null;
}
