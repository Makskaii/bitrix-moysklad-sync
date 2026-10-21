export type InvoiceLinkResolution =
  | { status: 'linked'; orderId: string }
  | { status: 'missing' }
  | { status: 'ambiguous' };

/** Read only the explicit parent order relation; invoice numbers and totals are not identities. */
export function resolveInvoiceOrderLink(value: unknown, source: 'BITRIX24' | 'MOYSKLAD'): InvoiceLinkResolution {
  if (!isRecord(value)) return { status: 'missing' };
  if (source === 'BITRIX24') {
    const parent = value.parentId2;
    if (parent === null || parent === undefined || parent === '') return { status: 'missing' };
    if (Array.isArray(parent)) return { status: 'ambiguous' };
    const id = typeof parent === 'string' || typeof parent === 'number' ? String(parent) : '';
    return /^\d{1,20}$/.test(id) ? { status: 'linked', orderId: id } : { status: 'ambiguous' };
  }
  const order = value.customerOrder;
  if (order === null || order === undefined) return { status: 'missing' };
  if (!isRecord(order)) return { status: 'ambiguous' };
  const meta = isRecord(order.meta) ? order.meta : {};
  const href = typeof meta.href === 'string' ? meta.href : '';
  const hrefId = href.match(/\/entity\/customerorder\/([0-9a-f-]{36})(?:\?.*)?$/i)?.[1];
  const id = typeof order.id === 'string' ? order.id : hrefId;
  return id && isUuid(id) && (!hrefId || hrefId === id)
    ? { status: 'linked', orderId: id }
    : { status: 'ambiguous' };
}

export function invoicePairLinksMatchOrder(
  bitrixInvoice: unknown,
  moyskladInvoice: unknown,
  order: { bitrix24Id: string; moyskladId: string },
): boolean {
  const bitrixLink = resolveInvoiceOrderLink(bitrixInvoice, 'BITRIX24');
  const moyskladLink = resolveInvoiceOrderLink(moyskladInvoice, 'MOYSKLAD');
  return bitrixLink.status === 'linked' && bitrixLink.orderId === order.bitrix24Id &&
    moyskladLink.status === 'linked' && moyskladLink.orderId === order.moyskladId;
}

export function isInvoiceEvent(event: { source: string; eventType: string | null; externalEntityType: string | null; payload?: unknown }): boolean {
  if (event.source === 'MOYSKLAD') {
    return event.externalEntityType === 'invoiceout' && ['CREATE', 'UPDATE', 'DELETE'].includes(event.eventType ?? '');
  }
  if (event.source !== 'BITRIX24' || !/^ONCRMDYNAMICITEM(?:ADD|UPDATE|DELETE)$/.test(event.eventType ?? '')) return false;
  if (event.externalEntityType === 'invoice') return true;
  const root = isRecord(event.payload) ? event.payload : {};
  const data = isRecord(root.data) ? root.data : {};
  const fields = isRecord(data.FIELDS) ? data.FIELDS : {};
  return Number(fields.ENTITY_TYPE_ID ?? data.ENTITY_TYPE_ID ?? root.ENTITY_TYPE_ID) === 31;
}

export function invoiceCreatedAt(value: unknown): Date | null {
  if (!isRecord(value)) return null;
  const raw = value.createdTime ?? value.created ?? value.CREATED_TIME ?? value.DATE_CREATE;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
