import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DryRunWriteJournal } from './dry-run-write-journal';
import { ProviderFailure, providerResponseFailure } from './provider-failure';

const READ_TIMEOUT_MS = 10_000;

@Injectable()
export class DryRunDocumentReader {
  constructor(private readonly dryWrites?: DryRunWriteJournal) {}

  async readBitrix24Deal(id: string): Promise<Record<string, unknown>> {
    assertDryServerMode();
    return this.readBitrix24DealForBaseline(id);
  }

  async readBitrix24DealForBaseline(id: string): Promise<Record<string, unknown>> {
    assertConfiguredSyncMode();
    if (!/^\d{1,20}$/.test(id)) throw new ServiceUnavailableException('Bitrix24 deal ID is invalid');
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new ServiceUnavailableException('Bitrix24 read endpoint is not configured');
    const url = new URL('crm.deal.get.json', withTrailingSlash(base));
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id }),
      redirect: 'error',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    }).catch(() => { throw new ProviderFailure('BITRIX24', null); });
    if (!response.ok) throw providerResponseFailure('BITRIX24', response.status, response.headers.get('retry-after'));
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body) || body.error || !isRecord(body.result) || String(body.result.ID ?? '') !== id) {
      throw new ProviderFailure('BITRIX24', 400);
    }
    return { ...body.result, ...(await this.dryWrites?.readback('BITRIX24', 'deal', id)) };
  }

  async readMoySkladCustomerOrder(id: string): Promise<Record<string, unknown>> {
    assertDryServerMode();
    return this.readMoySkladCustomerOrderForBaseline(id);
  }

  async readMoySkladCustomerOrderForBaseline(id: string): Promise<Record<string, unknown>> {
    assertConfiguredSyncMode();
    if (!isUuid(id)) throw new ServiceUnavailableException('MoySklad customer-order ID is invalid');
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new ServiceUnavailableException('MoySklad read endpoint is not configured');
    const url = new URL(`entity/customerorder/${encodeURIComponent(id)}`, withTrailingSlash(base));
    const response = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    }).catch(() => { throw new ProviderFailure('MOYSKLAD', null); });
    if (!response.ok) throw providerResponseFailure('MOYSKLAD', response.status, response.headers.get('retry-after'));
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body) || body.id !== id || !isRecord(body.meta) || body.meta.type !== 'customerorder') {
      throw new ProviderFailure('MOYSKLAD', 400);
    }
    return { ...body, ...(await this.dryWrites?.readback('MOYSKLAD', 'customerorder', id)) };
  }
}

function assertDryServerMode() {
  if (process.env.SYNC_MODE !== 'dry') {
    throw new ServiceUnavailableException('External document reads are available only when SYNC_MODE=dry');
  }
}

function assertConfiguredSyncMode() {
  if (process.env.SYNC_MODE !== 'dry' && process.env.SYNC_MODE !== 'apply') {
    throw new ServiceUnavailableException('Source reads require SYNC_MODE=dry or apply');
  }
}

function withTrailingSlash(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ServiceUnavailableException('External read endpoint is invalid');
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
