export const COMPANY_PRICE_TYPE_FIELD = 'UF_CRM_MS_PRICE_TYPE';
export const COMPANY_PRICE_TYPE_MARKER = 'MOYSKLAD_COMPANY_PRICE_TYPE';
export const COMPANY_PRICE_TYPE_IBLOCK = '108';
export const COMPANY_PRICE_TYPE_IBLOCK_TYPE = 'lists';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type PriceTypeOption = { id: string; uuid: string; name: string };

export function companyPriceTypeOptions(value: unknown): PriceTypeOption[] {
  if (!Array.isArray(value)) throw new Error('COMPANY_PRICE_TYPE_OPTIONS_INVALID');
  const ids = new Set<string>(), uuids = new Set<string>();
  return value.map((row: unknown) => {
    if (!isRecord(row) || !/^\d+$/.test(String(row.ID)) || String(row.IBLOCK_ID) !== COMPANY_PRICE_TYPE_IBLOCK || typeof row.CODE !== 'string' || !uuid.test(row.CODE) || typeof row.NAME !== 'string' || ids.has(String(row.ID)) || uuids.has(row.CODE.toLowerCase())) throw new Error('COMPANY_PRICE_TYPE_OPTIONS_INVALID');
    const item = { id: String(row.ID), uuid: row.CODE.toLowerCase(), name: row.NAME };
    ids.add(item.id); uuids.add(item.uuid); return item;
  });
}

export function assertCompanyPriceTypeSchema(value: unknown): void {
  if (!isRecord(value) || value.FIELD_NAME !== COMPANY_PRICE_TYPE_FIELD || value.XML_ID !== COMPANY_PRICE_TYPE_MARKER || value.USER_TYPE_ID !== 'iblock_element' || value.MULTIPLE !== 'N' || String(value.SETTINGS?.IBLOCK_ID) !== COMPANY_PRICE_TYPE_IBLOCK) throw new Error('COMPANY_PRICE_TYPE_SCHEMA_INVALID');
}

export function selectedCompanyPriceType(value: unknown, options: PriceTypeOption[]): string | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length !== 1) throw new Error('COMPANY_PRICE_TYPE_SELECTION_INVALID');
    return selectedCompanyPriceType(value[0], options);
  }
  if (value === undefined || value === null || value === '' || value === false) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('COMPANY_PRICE_TYPE_SELECTION_INVALID');
  const matches = options.filter(option => option.id === String(value));
  if (matches.length !== 1) throw new Error('COMPANY_PRICE_TYPE_SELECTION_UNMAPPED');
  return matches[0].uuid;
}

export function normalizeMoyskladPriceType(record: Record<string, unknown>, base: string | undefined): Record<string, unknown> {
  if (record.priceType === undefined || record.priceType === null) return { ...record, priceType: null };
  const value = record.priceType;
  // Dry journals use the same normalized scalar representation as pair state.
  if (typeof value === 'string' && uuid.test(value)) return { ...record, priceType: value.toLowerCase() };
  if (!isRecord(value)) throw new Error('CLIENT_PRICE_TYPE_REFERENCE_INVALID');
  const id = typeof value.id === 'string' && uuid.test(value.id) ? value.id.toLowerCase() : null;
  const meta = isRecord(value.meta) ? value.meta : null;
  let referenceId: string | null = null;
  if (meta) {
    if (!base || meta.type !== 'pricetype' || typeof meta.href !== 'string') throw new Error('CLIENT_PRICE_TYPE_REFERENCE_INVALID');
    const url = new URL(meta.href);
    const candidate = url.pathname.split('/').at(-1) ?? '';
    if (!uuid.test(candidate) || url.href !== new URL(`context/companysettings/pricetype/${candidate}`, base.replace(/\/?$/, '/')).href) throw new Error('CLIENT_PRICE_TYPE_REFERENCE_INVALID');
    referenceId = candidate.toLowerCase();
  }
  if ((!id && !referenceId) || id && referenceId && id !== referenceId) throw new Error('CLIENT_PRICE_TYPE_REFERENCE_INVALID');
  return { ...record, priceType: id ?? referenceId };
}

export function encodeMoyskladPriceType(fields: Record<string, unknown>, base: string | undefined): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(fields, 'priceType')) return fields;
  if (fields.priceType === null) return { ...fields, priceType: null };
  if (typeof fields.priceType !== 'string' || !uuid.test(fields.priceType) || !base || new URL(base).protocol !== 'https:') throw new Error('CLIENT_PRICE_TYPE_WRITE_INVALID');
  return { ...fields, priceType: { meta: { href: new URL(`context/companysettings/pricetype/${fields.priceType.toLowerCase()}`, base.replace(/\/?$/, '/')).href, type: 'pricetype', mediaType: 'application/json' } } };
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
