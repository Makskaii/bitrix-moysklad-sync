import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { assertApplyExternalWrite } from '../external-write-guard';
import { writeOperationalLog } from '../monitoring-log';
import { ProviderFailure } from '../provider-failure';
import { ServiceModeNotOnError, withServiceModeOn } from '../service-mode-transaction';
import { WarehouseDirectoryError, WarehouseDirectoryHttp, warehouseFetch } from './warehouse-directory-http';
import { planWarehouseDirectory, warehouseUuid, WarehouseDirectoryIssue } from './warehouse-directory-plan';

const INTERVAL_MS = 5 * 60_000;
const MAX_WRITES = 5;
export type WarehouseDirectoryResult = { status: 'SKIPPED' | 'COMPLETE'; added: number; renamed: number; unchanged: number; deferred: number; issues: WarehouseDirectoryIssue[] };

@Injectable()
export class WarehouseDirectorySyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running: Promise<WarehouseDirectoryResult> | null = null;
  private nextAttemptAt = 0;
  constructor(private readonly database: DatabaseService) {}

  onApplicationBootstrap() {
    if (!this.enabled()) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.running?.catch(() => undefined); }

  private enabled() {
    return process.env.WAREHOUSE_DIRECTORY_SYNC_ENABLED === 'enabled' && process.env.SYNC_MODE === 'apply' && process.env.CONTROLLED_LIVE_TEST_MODE !== 'enabled';
  }

  private async tick() {
    if (this.running || Date.now() < this.nextAttemptAt) return;
    this.running = this.runOnce();
    try {
      const result = await this.running;
      if (result.status === 'COMPLETE') await writeOperationalLog(this.database, 'SCHEDULED',
        `Warehouse directory: added=${result.added}, renamed=${result.renamed}, unchanged=${result.unchanged}, deferred=${result.deferred}; issues=${JSON.stringify(result.issues)}`, 'warehouse-directory');
    } catch (error) {
      if (!(error instanceof ServiceModeNotOnError)) {
        const code = error instanceof WarehouseDirectoryError ? error.message
          : error instanceof ProviderFailure ? `${error.provider}_HTTP_${error.status ?? 'TRANSPORT'}` : 'WAREHOUSE_INTERNAL';
        await writeOperationalLog(this.database, 'ERROR', `Warehouse directory: ${code}`, 'warehouse-directory');
        this.nextAttemptAt = Math.max(Date.now() + INTERVAL_MS, error instanceof ProviderFailure ? error.retryAfterAt?.getTime() ?? 0 : 0);
      }
    } finally { this.running = null; }
  }

  async runOnce(): Promise<WarehouseDirectoryResult> {
    const report: WarehouseDirectoryResult = { status: 'SKIPPED', added: 0, renamed: 0, unchanged: 0, deferred: 0, issues: [] };
    if (!this.enabled()) return report;
    const setting = await this.database.syncSetting.findUnique({ where: { id: 'global' }, select: { serviceMode: true } });
    if (setting?.serviceMode !== 'on') return report;
    // Rollout must explicitly preserve unresolved legacy entries, even when the list is empty.
    const heldValue = process.env.WAREHOUSE_DIRECTORY_SYNC_HELD_IDS;
    if (heldValue === undefined || heldValue !== '' && !/^\d{1,20}(?:,\d{1,20})*$/.test(heldValue)) throw new WarehouseDirectoryError('WAREHOUSE_HOLDS_UNCONFIRMED');
    const heldIds = new Set(heldValue ? heldValue.split(',') : []);
    const http = new WarehouseDirectoryHttp(async (provider, path, params = {}, write = false) => {
      const gated = await withServiceModeOn(this.database, async () => {
        if (!this.enabled()) throw new ServiceModeNotOnError();
        if (write) assertApplyExternalWrite(provider, 'WAREHOUSE_DIRECTORY_UPDATE', params.ELEMENT_ID ?? params.ELEMENT_CODE, 'warehouse-directory');
        return warehouseFetch(provider, path, params);
      });
      if (!gated.enabled) throw new ServiceModeNotOnError();
      return gated.value;
    });
    await http.verifySchema();
    // Both complete snapshots must succeed before the first write; a partial feed is not absence.
    const stores = await http.stores();
    const elements = await http.elements();
    const plan = planWarehouseDirectory(stores, elements, heldIds);
    report.status = 'COMPLETE';
    report.issues = plan.issues;
    report.unchanged = plan.unchanged;
    const selected = plan.actions.slice(0, MAX_WRITES);
    report.deferred = plan.actions.length - selected.length;
    for (const action of selected) {
      const store = await http.store(action.moyskladId);
      if (store.archived || store.name !== action.name) throw new WarehouseDirectoryError('WAREHOUSE_SOURCE_CHANGED');
      const latestElements = await http.elements();
      const fresh = planWarehouseDirectory([store], latestElements, heldIds);
      const relevantIssues = fresh.issues.filter(issue => issue.moyskladId === store.id && issue.code !== 'WAREHOUSE_SOURCE_MISSING');
      if (relevantIssues.length) { report.issues.push(...relevantIssues); continue; }
      const next = fresh.actions[0];
      if (!next) { report.unchanged += 1; continue; }
      if (action.bitrix24Id && next.bitrix24Id !== action.bitrix24Id) throw new WarehouseDirectoryError('WAREHOUSE_TARGET_ID_CHANGED');
      // Recheck configured fields immediately before each mutation.
      await http.verifySchema();
      let id: string;
      if (next.kind === 'RENAME') {
        const row = latestElements.find(element => element.id === next.bitrix24Id)!;
        await http.rename(row, store.name);
        id = row.id;
      } else {
        try { id = await http.add(store); }
        catch (error) {
          // ELEMENT_CODE is the provider's unique key. A competing worker may win.
          // All other uncertain responses stop this run; the next run reads CODE first.
          if (!(error instanceof WarehouseDirectoryError) || error.message !== 'WAREHOUSE_BITRIX_ERROR_ELEMENT_ALREADY_EXISTS') throw error;
          const recovered = await http.elements({ ELEMENT_CODE: store.id });
          if (recovered.length !== 1 || warehouseUuid(recovered[0].code) !== store.id || recovered[0].name !== store.name) throw new WarehouseDirectoryError('WAREHOUSE_CREATE_RECOVERY_CONFLICT');
          id = recovered[0].id;
        }
      }
      const readback = await http.elements({ ELEMENT_ID: id });
      if (readback.length !== 1 || readback[0].id !== id || warehouseUuid(readback[0].code) !== store.id || readback[0].name !== store.name) throw new WarehouseDirectoryError('WAREHOUSE_READBACK_MISMATCH');
      if (next.kind === 'ADD') report.added += 1;
      else report.renamed += 1;
    }
    return report;
  }
}
