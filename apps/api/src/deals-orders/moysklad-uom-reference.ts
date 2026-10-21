/** Native unexpanded MS relationships contain meta.href rather than id. */
export function moyskladUomReferenceId(value: unknown, base: URL): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const relation = value as Record<string, unknown>;
  const uuid = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  if (relation.meta === undefined) return uuid(relation.id) ? relation.id : null;
  if (!relation.meta || typeof relation.meta !== 'object' || Array.isArray(relation.meta)) return null;
  const meta = relation.meta as Record<string, unknown>;
  if (meta.type !== 'uom' || typeof meta.href !== 'string') return null;
  const prefix = new URL('entity/uom/', base.href.endsWith('/') ? base : new URL(base.href + '/')).href;
  if (!meta.href.startsWith(prefix)) return null;
  const id = meta.href.slice(prefix.length);
  if (!uuid(id) || relation.id !== undefined && relation.id !== id) return null;
  return id;
}
