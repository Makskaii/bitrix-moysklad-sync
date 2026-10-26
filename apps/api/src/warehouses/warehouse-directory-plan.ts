export type WarehouseStore = { id: string; name: string; archived: boolean };
export type WarehouseElement = { id: string; code: string; name: string };
export type WarehouseDirectoryIssue = { code: string; bitrix24Id?: string; moyskladId?: string };
export type WarehouseDirectoryAction = { kind: 'ADD' | 'RENAME'; moyskladId: string; name: string; bitrix24Id?: string };
export type WarehouseDirectoryPlan = { actions: WarehouseDirectoryAction[]; issues: WarehouseDirectoryIssue[]; unchanged: number };

export function warehouseUuid(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
}

/** CODE is the identity. Names can flag an unsafe legacy collision, never establish a pair. */
export function planWarehouseDirectory(stores: WarehouseStore[], elements: WarehouseElement[], heldIds: ReadonlySet<string>): WarehouseDirectoryPlan {
  const result: WarehouseDirectoryPlan = { actions: [], issues: [], unchanged: 0 };
  const byUuid = new Map<string, WarehouseElement[]>();
  const sourceIds = new Set<string>();
  for (const store of stores) {
    if (!warehouseUuid(store.id) || sourceIds.has(store.id.toLowerCase()) || !store.name.trim()) throw new Error('WAREHOUSE_SOURCE_INVALID');
    sourceIds.add(store.id.toLowerCase());
  }
  for (const row of elements) {
    const code = warehouseUuid(row.code);
    if (!code) result.issues.push({ code: 'WAREHOUSE_CODE_INVALID', bitrix24Id: row.id });
    else {
      byUuid.set(code, [...byUuid.get(code) ?? [], row]);
      if (!sourceIds.has(code)) result.issues.push({ code: 'WAREHOUSE_SOURCE_MISSING', bitrix24Id: row.id, moyskladId: code });
    }
  }
  for (const store of stores) {
    const id = store.id.toLowerCase();
    const matches = byUuid.get(id) ?? [];
    if (matches.length > 1) {
      result.issues.push({ code: 'WAREHOUSE_CODE_DUPLICATE', moyskladId: id });
      continue;
    }
    const row = matches[0];
    if (row && heldIds.has(row.id)) {
      result.issues.push({ code: 'WAREHOUSE_ELEMENT_HELD', bitrix24Id: row.id, moyskladId: id });
      continue;
    }
    // Existing references remain usable for historical cards; archive/delete policy is separate.
    if (store.archived) {
      result.issues.push({ code: 'WAREHOUSE_SOURCE_ARCHIVED', moyskladId: id, bitrix24Id: row?.id });
      continue;
    }
    if (!row) {
      const legacyCollision = elements.some(element => !warehouseUuid(element.code) && element.name === store.name);
      if (legacyCollision) result.issues.push({ code: 'WAREHOUSE_LEGACY_COLLISION', moyskladId: id });
      else result.actions.push({ kind: 'ADD', moyskladId: id, name: store.name });
    } else if (row.name !== store.name) result.actions.push({ kind: 'RENAME', moyskladId: id, bitrix24Id: row.id, name: store.name });
    else result.unchanged += 1;
  }
  return result;
}
