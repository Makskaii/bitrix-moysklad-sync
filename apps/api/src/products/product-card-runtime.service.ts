import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { SyncModeService } from '../sync-mode.service';
import { ProductCardHttpApi } from './product-card-api';
import { ProductCardApi, ProductCardLeaseError, ProductCardSettings, ProductCardStateStore, ProductCardSyncService } from './product-card-sync.service';

const PRODUCT_PAIR_LOCK_LEASE_MS = 60_000;
const PRODUCT_PAIR_LOCK_RENEW_INTERVAL_MS = 15_000;
const PRODUCT_PAIR_LOCK_OPERATION_TIMEOUT_MS = 30_000;

type ProductPairLease = { entityKey: string; ownerToken: string };
type ProductCardStateDatabase = Pick<Prisma.TransactionClient, 'entityPairSyncState'>;
type ProductPairLeaseOperation<T> = (transaction: Prisma.TransactionClient) => Promise<T>;

export type ProductCardRuntimeGate =
  | { status: 'READY' }
  | { status: 'SKIPPED_DISABLED'; reason: string }
  | { status: 'SKIPPED_DIRECTION_DISABLED'; reason: string }
  | { status: 'DEFERRED_PAUSE'; reason: string }
  | { status: 'RETRYABLE_FAILURE'; reason: string };

@Injectable()
export class ProductCardRuntimeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly api: ProductCardHttpApi,
    private readonly fieldSettings: FieldSettingsService,
    private readonly syncMode: SyncModeService,
  ) {}

  async preflight(source: 'BITRIX24' | 'MOYSKLAD'): Promise<ProductCardRuntimeGate> {
    // Product cards are deliberately one-way. Persisted legacy direction flags
    // must not reopen the Bitrix24 → MySklad write path.
    if (source === 'BITRIX24') return { status: 'SKIPPED_DIRECTION_DISABLED', reason: 'PRODUCT_DIRECTION_DISABLED' };
    if (process.env.SYNC_MODE !== 'apply') return { status: 'SKIPPED_DISABLED', reason: 'APPLY_MODE_REQUIRED' };
    let mode: 'on' | 'pause' | 'off';
    try { mode = (await this.syncMode.read()).mode; }
    catch { return { status: 'RETRYABLE_FAILURE', reason: 'PRODUCT_RUNTIME_MODE_READ_FAILED' }; }
    if (mode === 'off') return { status: 'SKIPPED_DISABLED', reason: 'SERVICE_OFF' };
    if (mode === 'pause') return { status: 'DEFERRED_PAUSE', reason: 'SERVICE_PAUSED' };
    const direction = 'moyskladToBitrix24';
    try {
      if (!await this.syncMode.isDirectionEnabled('products-variations', direction)) {
        return { status: 'SKIPPED_DIRECTION_DISABLED', reason: 'PRODUCT_DIRECTION_DISABLED' };
      }
    } catch {
      return { status: 'RETRYABLE_FAILURE', reason: 'PRODUCT_RUNTIME_DIRECTION_READ_FAILED' };
    }
    return { status: 'READY' };
  }

  async process(input: { pairId: string; source: 'BITRIX24' | 'MOYSKLAD'; settingsVersion: number; eventId?: string }) {
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

    const lease: ProductPairLease = { entityKey: `PRODUCT_PAIR:${pair.id}`, ownerToken: randomUUID() };
    try {
      if (!await this.acquirePairLease(lease, input.eventId ?? lease.ownerToken)) {
        return { status: 'RETRYABLE_FAILURE' as const, reason: 'PRODUCT_PAIR_BUSY', changedFields: [] };
      }
    } catch {
      return { status: 'RETRYABLE_FAILURE' as const, reason: 'PRODUCT_PAIR_LOCK_UNAVAILABLE', changedFields: [] };
    }

    const renewalTimer = this.renewPairLease(lease);
    const guardedApi = new LeaseBoundProductCardApi(this.api, (operation) => this.withPairLease(lease, operation));
    const stateStore = new DatabaseProductCardStateStore(this.database, (operation) => this.withPairLease(lease, operation));
    const reconciler = new ProductCardSyncService(guardedApi, stateStore);
    try {
      return await reconciler.sync({ pair, source: input.source, settingsVersion: versioned.version, settings });
    } catch (error) {
      if (error instanceof ProductCardLeaseError) {
        return { status: 'RETRYABLE_FAILURE' as const, reason: error.reason, changedFields: [] };
      }
      return { status: 'RETRYABLE_FAILURE' as const, reason: 'PRODUCT_CARD_PROCESSING_FAILED', changedFields: [] };
    } finally {
      clearInterval(renewalTimer);
      await this.releasePairLease(lease);
    }
  }

  private async acquirePairLease(lease: ProductPairLease, eventId: string): Promise<boolean> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + PRODUCT_PAIR_LOCK_LEASE_MS);
    const reclaimed = await this.database.inboundEntityLock.updateMany({
      where: { entityKey: lease.entityKey, leaseExpiresAt: { lte: now } },
      data: { ownerToken: lease.ownerToken, eventId, leaseExpiresAt },
    });
    if (reclaimed.count === 1) return true;
    try {
      await this.database.inboundEntityLock.create({
        data: { entityKey: lease.entityKey, ownerToken: lease.ownerToken, eventId, leaseExpiresAt },
      });
      return true;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  private renewPairLease(lease: ProductPairLease): NodeJS.Timeout {
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.database.inboundEntityLock.updateMany({
        where: { entityKey: lease.entityKey, ownerToken: lease.ownerToken },
        data: { leaseExpiresAt: new Date(Date.now() + PRODUCT_PAIR_LOCK_LEASE_MS) },
      }).then(() => { renewing = false; }, () => { renewing = false; });
    }, PRODUCT_PAIR_LOCK_RENEW_INTERVAL_MS);
    timer.unref();
    return timer;
  }

  private async releasePairLease(lease: ProductPairLease): Promise<void> {
    await this.database.inboundEntityLock.deleteMany({
      where: { entityKey: lease.entityKey, ownerToken: lease.ownerToken },
    }).catch(() => undefined);
  }

  private async withPairLease<T>(lease: ProductPairLease, operation: ProductPairLeaseOperation<T>): Promise<T> {
    let result: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      result = await this.database.$transaction(async (transaction) => {
        const rows = await transaction.$queryRaw<Array<{ ownerToken: string; leaseExpiresAt: Date }>>`
          SELECT "ownerToken", "leaseExpiresAt"
          FROM "InboundEntityLock"
          WHERE "entityKey" = ${lease.entityKey}
          FOR UPDATE
        `;
        const owner = rows[0];
        if (!owner || owner.ownerToken !== lease.ownerToken || owner.leaseExpiresAt <= new Date()) {
          throw new ProductCardLeaseError('PRODUCT_PAIR_LOCK_LOST');
        }
        try {
          return { ok: true as const, value: await operation(transaction) };
        } catch (error) {
          return { ok: false as const, error };
        }
      }, { maxWait: 5_000, timeout: PRODUCT_PAIR_LOCK_OPERATION_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof ProductCardLeaseError) throw error;
      throw new ProductCardLeaseError('PRODUCT_PAIR_LOCK_UNAVAILABLE');
    }
    if (!result.ok) throw result.error;
    return result.value;
  }
}

export class DatabaseProductCardStateStore implements ProductCardStateStore {
  constructor(
    private readonly database: ProductCardStateDatabase,
    private readonly withLease?: <T>(operation: ProductPairLeaseOperation<T>) => Promise<T>,
  ) {}

  async read(pairId: string) {
    return this.run(async (database) => {
      const row = await database.entityPairSyncState.findUnique({ where: { pairId } });
      return row ? {
        bitrix24Values: jsonRecord(row.bitrix24Values),
        moyskladValues: jsonRecord(row.moyskladValues),
      } : null;
    });
  }

  async write(pairId: string, settingsVersion: number, state: { bitrix24Values: Record<string, unknown>; moyskladValues: Record<string, unknown> }) {
    await this.run((database) => database.entityPairSyncState.upsert({
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
      }),
    );
  }

  private async run<T>(operation: (database: ProductCardStateDatabase) => Promise<T>): Promise<T> {
    if (this.withLease) return this.withLease((transaction) => operation(transaction));
    return operation(this.database);
  }
}

class LeaseBoundProductCardApi implements ProductCardApi {
  constructor(
    private readonly api: ProductCardApi,
    private readonly withLease: <T>(operation: () => Promise<T>) => Promise<T>,
  ) {}

  readBitrix24(id: string) { return this.withLease(() => this.api.readBitrix24(id)); }
  readMoysklad(id: string) { return this.withLease(() => this.api.readMoysklad(id)); }
  updateBitrix24(id: string, fields: Record<string, unknown>) { return this.withLease(() => this.api.updateBitrix24(id, fields)); }
  updateBitrix24Price(priceId: string, value: number, currency: string) { return this.withLease(() => this.api.updateBitrix24Price(priceId, value, currency)); }
  updateMoysklad(id: string, fields: Record<string, unknown>) { return this.withLease(() => this.api.updateMoysklad(id, fields)); }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'P2002';
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
