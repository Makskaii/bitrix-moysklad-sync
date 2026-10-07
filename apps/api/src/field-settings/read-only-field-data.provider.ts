import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export type CatalogCandidate = { id: string; code: string; label: string };
export type LiveFieldCatalogs = {
  units: { bitrix24: CatalogCandidate[]; moysklad: CatalogCandidate[] };
  priceTypes: { bitrix24: CatalogCandidate[]; moysklad: CatalogCandidate[] };
};
export type PairSnapshot = {
  sourceLabel: string;
  sourceValues: Record<string, unknown>;
  targetCurrent: Record<string, unknown>;
};

const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class ReadOnlyFieldDataProvider {
  async catalogs(bitrixAccessToken: string): Promise<LiveFieldCatalogs> {
    const [b24Units, b24Prices, msUnits, msPrices] = await Promise.all([
      this.bitrixList(bitrixAccessToken, 'catalog.measure.list'),
      this.bitrixList(bitrixAccessToken, 'catalog.priceType.list'),
      this.moyskladList('/entity/uom'),
      this.moyskladList('/context/companysettings/pricetype'),
    ]);
    return {
      units: {
        bitrix24: b24Units.map((row) => ({ id: text(row.id), code: text(row.code ?? row.symbolIntl ?? row.symbol), label: text(row.name ?? row.title ?? row.symbolIntl ?? row.code) })),
        moysklad: msUnits.map((row) => ({ id: text(row.id), code: text(row.code), label: text(row.name ?? row.code) })),
      },
      priceTypes: {
        bitrix24: b24Prices.map((row) => ({ id: text(row.id), code: text(row.xmlId ?? row.code ?? row.name), label: text(row.name ?? row.code) })),
        moysklad: msPrices.map((row) => ({ id: text(row.id), code: text(row.externalCode ?? row.name), label: text(row.name) })),
      },
    };
  }

  async readPair(bitrixAccessToken: string, entity: string, sourceId: string, targetId: string): Promise<PairSnapshot> {
    const contract = pairContract(entity, sourceId, targetId);
    const [source, target] = await Promise.all([
      this.bitrixCall(bitrixAccessToken, contract.bitrixMethod, contract.bitrixParams),
      this.moyskladGet(contract.moyskladPath),
    ]);
    return {
      sourceLabel: sourceLabel(source),
      sourceValues: asRecord(source),
      targetCurrent: asRecord(target),
    };
  }

  private async bitrixList(accessToken: string, method: string): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    let start = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const payload = await this.bitrixCall(accessToken, method, { start, 'order[id]': 'ASC' });
      const pageRows = Array.isArray(payload) ? payload : isRecord(payload)
        ? Object.values(payload).find((value) => Array.isArray(value)) as unknown[] | undefined
        : undefined;
      if (!pageRows) throw new ServiceUnavailableException(`Bitrix24 returned an invalid ${method} catalog`);
      rows.push(...pageRows.filter(isRecord));
      if (pageRows.length < PAGE_SIZE) return rows;
      start += PAGE_SIZE;
    }
    throw new ServiceUnavailableException(`Bitrix24 ${method} catalog exceeds the supported ${MAX_PAGES * PAGE_SIZE} records; use a narrower catalog filter`);
  }

  private async bitrixCall(accessToken: string, method: string, params: Record<string, string | number>): Promise<unknown> {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new ServiceUnavailableException('Bitrix24 read-only catalog provider is not configured');
    const form = new URLSearchParams({ auth: accessToken, ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])) });
    const response = await fetch(new URL(`${method}.json`, ensureSlash(base)), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => { throw new ServiceUnavailableException('Bitrix24 read-only request failed'); });
    if (!response.ok) throw new ServiceUnavailableException(`Bitrix24 read-only request failed (${response.status})`);
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || !('result' in payload) || 'error' in payload) throw new ServiceUnavailableException('Bitrix24 rejected the read-only request');
    return payload.result;
  }

  private async moyskladList(path: string): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    let url = new URL(path.replace(/^\//, ''), ensureSlash(process.env.MOYSKLAD_API_BASE_URL ?? 'https://api.moysklad.ru/api/remap/1.2/'));
    const visited = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const key = url.toString();
      if (visited.has(key)) throw new ServiceUnavailableException('MoySklad returned a repeating catalog page');
      visited.add(key);
      const payload = await this.moyskladGet(url.toString());
      if (!isRecord(payload) || !Array.isArray(payload.rows)) throw new ServiceUnavailableException('MoySklad returned an invalid catalog');
      rows.push(...payload.rows.filter(isRecord));
      const nextHref = isRecord(payload.meta) && typeof payload.meta.nextHref === 'string' ? payload.meta.nextHref : '';
      if (!nextHref) return rows;
      url = new URL(nextHref);
    }
    throw new ServiceUnavailableException(`MoySklad catalog exceeds ${MAX_PAGES} pages; use a narrower catalog filter`);
  }

  private async moyskladGet(path: string): Promise<unknown> {
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new ServiceUnavailableException('MoySklad read-only catalog provider is not configured');
    const url = path.startsWith('http') ? new URL(path) : new URL(path.replace(/^\//, ''), ensureSlash(base));
    const allowedOrigin = new URL(base).origin;
    if (url.origin !== allowedOrigin) throw new ServiceUnavailableException('MoySklad returned an untrusted pagination URL');
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .catch(() => { throw new ServiceUnavailableException('MoySklad read-only request failed'); });
    if (!response.ok) throw new ServiceUnavailableException(`MoySklad read-only request failed (${response.status})`);
    return response.json().catch(() => { throw new ServiceUnavailableException('MoySklad returned invalid JSON'); });
  }
}

function pairContract(entity: string, sourceId: string, targetId: string): { bitrixMethod: string; bitrixParams: Record<string, string | number>; moyskladPath: string } {
  const msId = encodeURIComponent(targetId);
  switch (entity) {
    case 'contacts-companies': return { bitrixMethod: 'crm.contact.get', bitrixParams: { id: sourceId }, moyskladPath: `entity/counterparty/${msId}` };
    case 'deals-orders': return { bitrixMethod: 'crm.deal.get', bitrixParams: { id: sourceId }, moyskladPath: `entity/customerorder/${msId}` };
    case 'smart-invoices': return { bitrixMethod: 'crm.item.get', bitrixParams: { entityTypeId: 31, id: sourceId }, moyskladPath: `entity/invoiceout/${msId}` };
    case 'catalog': return { bitrixMethod: 'catalog.product.get', bitrixParams: { id: sourceId }, moyskladPath: `entity/product/${msId}` };
    default: throw new ServiceUnavailableException('This entity type has no read-only pair provider');
  }
}

function sourceLabel(value: unknown): string {
  const row = asRecord(value);
  const person = [row.NAME, row.LAST_NAME, row.SECOND_NAME].filter((part) => typeof part === 'string' && part.trim()).join(' ');
  if (person) return person;
  return [row.TITLE, row.name, row.PRODUCT_NAME].find((part) => typeof part === 'string' && part.trim()) as string | undefined ?? 'Без подписи';
}
function asRecord(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): string { return value === null || value === undefined ? '' : String(value); }
function ensureSlash(value: string) { return value.endsWith('/') ? value : `${value}/`; }
