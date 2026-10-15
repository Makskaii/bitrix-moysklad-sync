export type ClientInventoryEntity = 'COMPANY' | 'CONTACT';
export type ClientInventoryTargetType = 'counterparty' | 'contactperson';
export type BitrixClientRow = { id: string; uuid: string | null };
export type MoyskladClientRow = { id: string; parentId?: string | null; companyType?: string | null };
export type ClientPage<T> = { rows: T[]; next: number | null; total: number | null };

export interface ClientInventoryProvider {
  bitrixPage(entity: ClientInventoryEntity, start: number, accessToken: string): Promise<ClientPage<BitrixClientRow>>;
  counterpartyPage(offset: number): Promise<ClientPage<MoyskladClientRow>>;
  contactpersonPage(counterpartyId: string, offset: number): Promise<ClientPage<MoyskladClientRow>>;
}

/** Read-only Bitrix24/MoySklad inventory API. It only requests the UUID field and native IDs. */
export class HttpClientInventoryProvider implements ClientInventoryProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async bitrixPage(entity: ClientInventoryEntity, start: number, accessToken: string): Promise<ClientPage<BitrixClientRow>> {
    const base = requiredUrl(process.env.BITRIX24_REST_BASE_URL, 'Bitrix24 REST URL');
    const method = entity === 'COMPANY' ? 'crm.company.list.json' : 'crm.contact.list.json';
    const field = entity === 'COMPANY' ? 'UF_CRM_1719834633' : 'UF_CRM_1719834658';
    const payload = await this.request(new URL(method, withSlash(base)), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([['select[]', 'ID'], ['select[]', field], ['start', String(start)], ['auth', accessToken]]),
    });
    const result = isRecord(payload) ? payload.result : null;
    if (!Array.isArray(result)) throw new Error('BITRIX24_CLIENT_INVENTORY_INVALID_RESPONSE');
    const rows = result.map((row) => {
      if (!isRecord(row) || !readId(row.ID)) throw new Error('BITRIX24_CLIENT_INVENTORY_INVALID_ROW');
      return { id: readId(row.ID)!, uuid: readOptionalString(row[field]) };
    });
    if (!isRecord(payload) || !Number.isInteger(payload.total) || Number(payload.total) < 0) {
      throw new Error('BITRIX24_CLIENT_INVENTORY_INVALID_PAGINATION');
    }
    const total = Number(payload.total);
    const hasNext = Object.prototype.hasOwnProperty.call(payload, 'next');
    if (hasNext && (!Number.isInteger(payload.next) || Number(payload.next) <= start)) {
      throw new Error('BITRIX24_CLIENT_INVENTORY_INVALID_PAGINATION');
    }
    const next = hasNext ? Number(payload.next) : null;
    const expectedRows = Math.min(50, Math.max(0, total - start));
    if (rows.length !== expectedRows || (next !== null) !== (start + rows.length < total) || (next !== null && next !== start + 50)) {
      throw new Error('BITRIX24_CLIENT_INVENTORY_INVALID_PAGINATION');
    }
    return { rows, next, total };
  }

  async counterpartyPage(offset: number): Promise<ClientPage<MoyskladClientRow>> {
    const url = this.moyskladUrl('entity/counterparty');
    url.searchParams.set('limit', '1000');
    url.searchParams.set('offset', String(offset));
    // companyType is the minimal native metadata needed to distinguish
    // organization counterparties from individual clients in the UUID map.
    url.searchParams.set('fields', 'id,companyType');
    return readMoyskladPage(await this.request(url, { method: 'GET', headers: this.moyskladHeaders() }), offset);
  }

  async contactpersonPage(counterpartyId: string, offset: number): Promise<ClientPage<MoyskladClientRow>> {
    const url = this.moyskladUrl(`entity/counterparty/${encodeURIComponent(counterpartyId)}/contactpersons`);
    url.searchParams.set('limit', '1000');
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('fields', 'id');
    return readMoyskladPage(await this.request(url, { method: 'GET', headers: this.moyskladHeaders() }), offset, counterpartyId);
  }

  private moyskladUrl(path: string): URL {
    return new URL(path, withSlash(requiredUrl(process.env.MOYSKLAD_API_BASE_URL, 'MoySklad API URL')));
  }

  private moyskladHeaders(): Record<string, string> {
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!token) throw new Error('MOYSKLAD_API_TOKEN_NOT_CONFIGURED');
    return { authorization: `Bearer ${token}`, accept: 'application/json' };
  }

  private async request(url: URL, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new Error('CLIENT_INVENTORY_UPSTREAM_UNAVAILABLE');
    }
    if (!response.ok) throw new Error(`CLIENT_INVENTORY_UPSTREAM_HTTP_${response.status}`);
    try { return await response.json(); } catch { throw new Error('CLIENT_INVENTORY_UPSTREAM_INVALID_JSON'); }
  }
}

function readMoyskladPage(payload: unknown, requestedOffset: number, parentId?: string): ClientPage<MoyskladClientRow> {
  if (!isRecord(payload) || !Array.isArray(payload.rows) || !isRecord(payload.meta)) throw new Error('MOYSKLAD_CLIENT_INVENTORY_INVALID_RESPONSE');
  const { size, offset, limit } = payload.meta;
  if (!Number.isInteger(size) || Number(size) < 0 || !Number.isInteger(offset) || Number(offset) !== requestedOffset ||
      !Number.isInteger(limit) || Number(limit) <= 0 || Number(limit) > 1000) {
    throw new Error('MOYSKLAD_CLIENT_INVENTORY_INVALID_PAGINATION');
  }
  const rows = payload.rows.map((row) => {
    if (!isRecord(row) || !readId(row.id)) throw new Error('MOYSKLAD_CLIENT_INVENTORY_INVALID_ROW');
    return {
      id: readId(row.id)!, parentId: parentId ?? null,
      ...(parentId === undefined ? { companyType: readOptionalString(row.companyType) } : {}),
    };
  });
  const total = Number(size);
  const pageOffset = Number(offset);
  const pageLimit = Number(limit);
  const expectedRows = Math.min(pageLimit, Math.max(0, total - pageOffset));
  if (rows.length !== expectedRows) throw new Error('MOYSKLAD_CLIENT_INVENTORY_INVALID_PAGINATION');
  const next = pageOffset + rows.length < total ? pageOffset + rows.length : null;
  return { rows, next, total };
}

function readId(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredUrl(value: string | undefined, name: string): URL {
  if (!value) throw new Error(`${name.toUpperCase().replace(/\W/g, '_')}_NOT_CONFIGURED`);
  try { return new URL(value); } catch { throw new Error(`${name.toUpperCase().replace(/\W/g, '_')}_INVALID`); }
}

function withSlash(url: URL): URL {
  return new URL(url.toString().endsWith('/') ? url.toString() : `${url.toString()}/`);
}
