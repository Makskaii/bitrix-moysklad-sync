import { DatabaseService } from '../database.service';
import { lockEntityPairState } from '../pairs/pair-db-lock';
import { ServiceModeNotOnError, withServiceModeOn } from '../service-mode-transaction';

/** Portal catalog identity: property108 (Товары UUID) is the native MS ID.
 * XML_ID is a different field and must never be guessed as this identity. */
export class DocumentProductIdentityError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

export async function ensureDocumentProductIdentity(database: DatabaseService, input: {
  bitrix24ProductId: string; bitrix24CatalogId: string; eventId: string;
}): Promise<void> {
  const productId = input.bitrix24ProductId;
  if (!/^\d{1,20}$/.test(productId)) fail('PRODUCT_UUID_CATALOG_OR_ID_INVALID');
  // Persisted pairs and explicit duplicate aliases remain authoritative.
  const existing = await database.entityPair.findMany({ where: { entityType: 'PRODUCT', bitrix24Id: productId }, take: 2 });
  if (existing.length) {
    if (existing.length !== 1 || !existing[0].active || existing[0].lifecycleStatus !== 'ACTIVE' || !uuid(existing[0].moyskladId)) fail('PRODUCT_UUID_PAIR_CONFLICT');
    return;
  }
  const alias = await database.productDuplicateAlias.findUnique({ where: { duplicateBitrix24Id: productId } });
  if (alias) {
    const canonical = await database.entityPair.findFirst({ where: { id: alias.canonicalPairId, entityType: 'PRODUCT', active: true, lifecycleStatus: 'ACTIVE' } });
    if (!canonical || canonical.bitrix24Id !== alias.canonicalBitrix24Id || canonical.moyskladId !== alias.canonicalMoyskladId) fail('PRODUCT_UUID_ALIAS_CONFLICT');
    return;
  }
  if (!/^\d{1,20}$/.test(input.bitrix24CatalogId)) fail('PRODUCT_UUID_CATALOG_OR_ID_INVALID');

  const read = async (url: URL, init: RequestInit): Promise<Record<string, any>> => {
    const result = await withServiceModeOn(database, async () => {
      const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (response.status === 404) fail('PRODUCT_UUID_TARGET_NOT_FOUND');
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !record(body) || body.error) fail('PRODUCT_UUID_PROVIDER_READ_FAILED');
      return body;
    });
    if (!result.enabled) throw new ServiceModeNotOnError();
    return result.value;
  };
  const b24Base = process.env.BITRIX24_REST_BASE_URL;
  const msBase = process.env.MOYSKLAD_API_BASE_URL;
  if (!b24Base || !msBase) fail('PRODUCT_UUID_PROVIDER_NOT_CONFIGURED');
  const bitrixUrl = new URL('catalog.product.get.json', slash(b24Base));
  const msUrl = new URL(slash(msBase));
  if (bitrixUrl.protocol !== 'https:' || msUrl.protocol !== 'https:') fail('PRODUCT_UUID_PROVIDER_NAMESPACE_INVALID');
  const sourceBody = await read(bitrixUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: productId }) });
  const source = record(sourceBody.result) && record(sourceBody.result.product) ? sourceBody.result.product : null;
  if (!source || String(source.id) !== productId || String(source.iblockId) !== input.bitrix24CatalogId || Number(source.type) !== 1 || source.active === 'N') fail('PRODUCT_UUID_SOURCE_INVALID');
  const identity = record(source.property108) ? source.property108.value : source.property108;
  if (!uuid(identity)) fail(identity === null || identity === undefined || identity === '' ? 'PRODUCT_UUID_MISSING' : 'PRODUCT_UUID_INVALID');
  const target = await read(new URL(`entity/product/${identity}`, slash(msBase)), { method: 'GET', headers: {
    Authorization: `Bearer ${process.env.MOYSKLAD_API_TOKEN ?? ''}`, Accept: 'application/json;charset=utf-8', 'Accept-Encoding': 'gzip',
  } });
  if (target.id !== identity || !record(target.meta) || target.meta.type !== 'product' || target.archived === true) fail('PRODUCT_UUID_TARGET_INVALID');

  const persisted = await withServiceModeOn(database, async (transaction) => {
    await lockEntityPairState(transaction);
    const direction = await transaction.syncDirectionSetting.findUnique({ where: { entityKey: 'deals-orders' } });
    if (direction && !direction.bitrix24ToMoysklad) fail('PRODUCT_UUID_DEAL_DIRECTION_DISABLED');
    const conflicts = await transaction.entityPair.findMany({ where: { entityType: 'PRODUCT', OR: [{ bitrix24Id: productId }, { moyskladId: identity }] } });
    if (conflicts.length) {
      if (conflicts.length === 1 && conflicts[0].active && conflicts[0].lifecycleStatus === 'ACTIVE' && conflicts[0].bitrix24Id === productId && conflicts[0].moyskladId === identity && (conflicts[0].moyskladType === null || conflicts[0].moyskladType === 'product')) return;
      fail('PRODUCT_UUID_PAIR_CONFLICT');
    }
    if (await transaction.productDuplicateAlias.findUnique({ where: { duplicateBitrix24Id: productId } })) fail('PRODUCT_UUID_ALIAS_CONFLICT');
    await transaction.entityPair.create({ data: { entityType: 'PRODUCT', bitrix24Id: productId, moyskladId: identity, moyskladType: 'product', source: 'AUTO', reason: 'BITRIX_PROPERTY108_EXACT_MOYSKLAD_ID' } });
    await transaction.operationalLog.create({ data: { category: 'EVENT', message: `Product identity linked from property108; bitrix24Id=${productId}; moyskladId=${identity}`, referenceId: input.eventId } });
  });
  if (!persisted.enabled) throw new ServiceModeNotOnError();
}

function fail(reason: string): never { throw new DocumentProductIdentityError(reason); }
function record(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function slash(value: string): string { return value.endsWith('/') ? value : `${value}/`; }
