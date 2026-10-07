import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { SyncModeService } from '../sync-mode.service';
import { ProductCardHttpApi } from './product-card-api';
import { ProductCardSettings, ProductCardStateStore, ProductCardSyncService } from './product-card-sync.service';

export type ProductCardRuntimeGate =
  | { status: 'READY' }
  | { status: 'SKIPPED_DISABLED'; reason: string }
  | { status: 'SKIPPED_DIRECTION_DISABLED'; reason: string }
  | { status: 'DEFERRED_PAUSE'; reason: string }
  | { status: 'RETRYABLE_FAILURE'; reason: string };

@Injectable()
export class ProductCardRuntimeService {
  private readonly reconciler: ProductCardSyncService;

  constructor(
    private readonly database: DatabaseService,
    api: ProductCardHttpApi,
    private readonly fieldSettings: FieldSettingsService,
    private readonly syncMode: SyncModeService,
  ) {
    this.reconciler = new ProductCardSyncService(api, new DatabaseProductCardStateStore(database));
  }

  async preflight(source: 'BITRIX24' | 'MOYSKLAD'): Promise<ProductCardRuntimeGate> {
    if (process.env.SYNC_MODE !== 'apply') return { status: 'SKIPPED_DISABLED', reason: 'APPLY_MODE_REQUIRED' };
    let mode: 'on' | 'pause' | 'off';
    try { mode = (await this.syncMode.read()).mode; }
    catch { return { status: 'RETRYABLE_FAILURE', reason: 'PRODUCT_RUNTIME_MODE_READ_FAILED' }; }
    if (mode === 'off') return { status: 'SKIPPED_DISABLED', reason: 'SERVICE_OFF' };
    if (mode === 'pause') return { status: 'DEFERRED_PAUSE', reason: 'SERVICE_PAUSED' };
    const direction = source === 'BITRIX24' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
    try {
      if (!await this.syncMode.isDirectionEnabled('products-variations', direction)) {
        return { status: 'SKIPPED_DIRECTION_DISABLED', reason: 'PRODUCT_DIRECTION_DISABLED' };
      }
    } catch {
      return { status: 'RETRYABLE_FAILURE', reason: 'PRODUCT_RUNTIME_DIRECTION_READ_FAILED' };
    }
    return { status: 'READY' };
  }

  async process(input: { pairId: string; source: 'BITRIX24' | 'MOYSKLAD'; settingsVersion: number }) {
    const gate = await this.preflight(input.source);
    if (gate.status !== 'READY') return { ...gate, changedFields: [] as [] };
    let pair;
    let versioned;
    try {
      [pair, versioned] = await Promise.all([
        this.database.entityPair.findFirst({
          where: { id: input.pairId, entityType: 'PRODUCT', active: true },
          select: { id: true, entityType: true, bitrix24Id: true, moyskladId: true, active: true, source: true, reason: true, createdAt: true },
        }),
        this.fieldSettings.version(input.settingsVersion),
      ]);
    } catch {
      return { status: 'RETRYABLE_FAILURE' as const, reason: 'PRODUCT_RUNTIME_CONFIG_READ_FAILED', changedFields: [] };
    }
    if (!pair) return { status: 'MANUAL_REVIEW' as const, reason: 'PRODUCT_PAIR_NOT_ACTIVE', changedFields: [] };
    const settings = versioned.config as unknown as ProductCardSettings;
    return this.reconciler.sync({ pair, source: input.source, settingsVersion: versioned.version, settings });
  }
}

export class DatabaseProductCardStateStore implements ProductCardStateStore {
  constructor(private readonly database: DatabaseService) {}

  async read(pairId: string) {
    const row = await this.database.entityPairSyncState.findUnique({ where: { pairId } });
    return row ? {
      bitrix24Values: jsonRecord(row.bitrix24Values),
      moyskladValues: jsonRecord(row.moyskladValues),
    } : null;
  }

  async write(pairId: string, settingsVersion: number, state: { bitrix24Values: Record<string, unknown>; moyskladValues: Record<string, unknown> }) {
    await this.database.entityPairSyncState.upsert({
      where: { pairId },
      create: {
        pairId, settingsVersion,
        bitrix24Values: state.bitrix24Values as Prisma.InputJsonValue,
        moyskladValues: state.moyskladValues as Prisma.InputJsonValue,
      },
      update: {
        settingsVersion,
        bitrix24Values: state.bitrix24Values as Prisma.InputJsonValue,
        moyskladValues: state.moyskladValues as Prisma.InputJsonValue,
      },
    });
  }
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
