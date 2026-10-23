/** Customer-approved MySklad organizations for the order -> deal direction.
 * Use native IDs: organization display names can change independently. */
export const ALLOWED_MOYSKLAD_ORDER_ORGANIZATIONS = new Set([
  '02ada5df-d515-11e2-3c12-7054d21a8d1e', // ООО "АЭРОСИСТЕМЫ"
  'a039078a-7cf0-11e7-7a6c-d2a90051dacf', // ОП "Аэросистемы "Краснодар"
]);

export function orderOrganizationDecision(order: Record<string, unknown>): 'ALLOWED' | 'EXCLUDED' | 'UNVERIFIED' {
  const organization = order.organization;
  if (!organization || typeof organization !== 'object' || Array.isArray(organization)) return 'UNVERIFIED';
  const reference = organization as Record<string, unknown>;
  const meta = reference.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || (meta as Record<string, unknown>).type !== 'organization') return 'UNVERIFIED';
  const href = (meta as Record<string, unknown>).href;
  if (typeof href !== 'string') return 'UNVERIFIED';
  let url: URL;
  try { url = new URL(href); } catch { return 'UNVERIFIED'; }
  if (url.protocol !== 'https:' || url.hostname !== 'api.moysklad.ru' || url.search || url.hash) return 'UNVERIFIED';
  const id = /^\/api\/remap\/1\.2\/entity\/organization\/([0-9a-f-]{36})$/i.exec(url.pathname)?.[1]?.toLowerCase();
  if (!id || (typeof reference.id === 'string' && reference.id.toLowerCase() !== id)) return 'UNVERIFIED';
  return ALLOWED_MOYSKLAD_ORDER_ORGANIZATIONS.has(id) ? 'ALLOWED' : 'EXCLUDED';
}
