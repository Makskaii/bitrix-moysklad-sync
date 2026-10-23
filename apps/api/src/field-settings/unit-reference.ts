/** Explicit additional native IDs apply only to MS -> Bitrix reads.
 * The canonical moyskladId remains the only forward write destination. */
export function matchesReverseUnit(candidate: unknown, nativeId: string | null): boolean {
  if (!nativeId || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const unit = candidate as Record<string, unknown>;
  if (unit.status !== 'configured' || typeof unit.moyskladId !== 'string' || !unit.moyskladId) return false;
  return unit.moyskladId === nativeId ||
    (Array.isArray(unit.reverseMoyskladIds) && unit.reverseMoyskladIds.includes(nativeId));
}
