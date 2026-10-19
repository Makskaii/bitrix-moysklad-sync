import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { DatabaseRecoveryService } from './database-recovery.service';
import { assertApplyExternalWrite } from './external-write-guard';
import { ClientLifecycleService } from './clients/client-lifecycle.service';

export type ServiceMode = 'on' | 'pause' | 'off';
export type DealOrderWriteDirection = 'bitrix24ToMoysklad' | 'moyskladToBitrix24';
export class DealOrderWriteGateError extends Error {
  constructor(readonly reason: 'PAUSE' | 'OFF' | 'RECOVERY' | 'DIRECTION' | 'LEASE' | 'NOT_APPLY') { super(`DEAL_ORDER_WRITE_BLOCKED_${reason}`); }
}

const entityControls = [
  {
    key: 'contacts-companies',
    label: 'Контакты и компании ↔ контрагенты и контактные лица',
    ready: true,
    directionScope: 'CONTACT_EMAIL_EXISTING_PAIRS',
    availability: 'Частично готово: только поле EMAIL существующей пары контакта.',
  },
  {
    key: 'deals-orders',
    label: 'Сделки ↔ заказы покупателей',
    ready: false,
    directionScope: null,
    availability: 'Обмен этой сущности пока недоступен.',
  },
  {
    key: 'invoices',
    label: 'Счета ↔ счета покупателям',
    ready: false,
    directionScope: null,
    availability: 'Обмен этой сущности пока недоступен.',
  },
  {
    key: 'products-variations',
    label: 'Товары ↔ товары и модификации',
    ready: false,
    directionScope: null,
    availability: 'Обмен этой сущности пока недоступен.',
  },
  {
    key: 'service-dictionary',
    label: 'Справочник услуг сделки ↔ поле справочника заказа',
    ready: false,
    directionScope: null,
    availability: 'Обмен этой сущности пока недоступен.',
  },
] as const;

@Injectable()
export class SyncModeService {
  constructor(
    private readonly database: DatabaseService,
    @Optional() @Inject(DatabaseRecoveryService) private readonly databaseRecovery?: DatabaseRecoveryService,
    @Optional() @Inject(ClientLifecycleService) private readonly clientLifecycle?: ClientLifecycleService,
  ) {}

  async read() {
    const setting = await this.ensureGlobalSetting();
    if (this.databaseRecovery) await this.databaseRecovery.assertReady();
    return { mode: setting.serviceMode as ServiceMode };
  }

  async setMode(mode: ServiceMode) {
    if (mode === 'on' && this.databaseRecovery && !await this.databaseRecovery.assertReady()) {
      throw new ConflictException('Database loss recovery must be explicitly confirmed before Apply can be enabled');
    }
    const current = await this.ensureGlobalSetting();
    if (mode === current.serviceMode) return { mode: current.serviceMode as ServiceMode };
    const enteringOff = mode === 'off' && current.serviceMode !== 'off';
    const leavingOffInterval = mode === 'on' && current.offSince !== null;
    const now = new Date();
    const offSince = enteringOff ? new Date() : current.offSince;
    const setting = await this.database.syncSetting.update({
      where: { id: 'global' },
      data: {
        serviceMode: mode,
        offSince,
        ...((mode === 'pause' || mode === 'off') ? { lastInactiveAt: now } : {}),
        ...(mode === 'on' && current.serviceMode !== 'on' ? { lastActiveAt: now } : {}),
        ...(enteringOff ? {
          resumeStatus: 'skipped',
          resumeFrom: null,
          resumeThrough: null,
          resumeProvider: 'BITRIX24',
          resumeBitrixStart: 0,
          resumeMoyskladOffset: 0,
          resumeError: 'Events missed during OFF are intentionally not replayed.',
          resumeRetryAfter: null,
          resumeAttempts: 0,
        } : {}),
        ...(leavingOffInterval ? {
          resumeStatus: 'skipped',
          resumeFrom: null,
          resumeThrough: null,
          resumeProvider: 'BITRIX24',
          resumeBitrixStart: 0,
          resumeMoyskladOffset: 0,
          resumeError: 'Events missed during OFF are intentionally not replayed.',
          resumeRetryAfter: null,
          resumeAttempts: 0,
          offSince: null,
        } : {}),
      },
      select: { serviceMode: true },
    });
    return { mode: setting.serviceMode as ServiceMode };
  }

  async readEntitySettings() {
    const ready = entityControls.find((entity) => entity.ready)!;
    const directions = await this.ensureDirectionSetting(ready.key);
    return entityControls.map((entity) => ({
      ...entity,
      bitrix24ToMoysklad: entity.ready ? directions.bitrix24ToMoysklad : false,
      moyskladToBitrix24: entity.ready ? directions.moyskladToBitrix24 : false,
    }));
  }

  async setEntityDirections(
    entityKey: string,
    directions: { bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean },
  ) {
    const entity = entityControls.find((control) => control.key === entityKey);
    if (!entity || !entity.ready) {
      throw new ConflictException('This entity is not ready to be enabled');
    }
    await this.ensureDirectionSetting(entityKey);
    const setting = await this.database.syncDirectionSetting.update({
      where: { entityKey },
      data: directions,
      select: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
    });
    return { key: entityKey, ...setting };
  }

  private async ensureGlobalSetting() {
    try {
      return await this.database.syncSetting.upsert({
        where: { id: 'global' },
        create: {},
        update: {},
        select: { serviceMode: true, offSince: true, resumeStatus: true },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const setting = await this.database.syncSetting.findUnique({
        where: { id: 'global' },
        select: { serviceMode: true, offSince: true, resumeStatus: true },
      });
      if (!setting) throw error;
      return setting;
    }
  }

  private async ensureDirectionSetting(entityKey: string) {
    try {
      return await this.database.syncDirectionSetting.upsert({
        where: { entityKey },
        create: { entityKey },
        update: {},
        select: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const setting = await this.database.syncDirectionSetting.findUnique({
        where: { entityKey },
        select: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
      });
      if (!setting) throw error;
      return setting;
    }
  }

  async isDirectionEnabled(
    entityKey: string,
    direction: 'bitrix24ToMoysklad' | 'moyskladToBitrix24',
  ): Promise<boolean> {
    const setting = await this.database.syncDirectionSetting.findUnique({ where: { entityKey } });
    return setting?.[direction] ?? true;
  }

  /** Re-read durable global/direction/recovery state immediately before each
   * provider mutation; callers supply their current worker/pair lease check. */
  async assertDealOrderExternalWriteAllowed(direction: DealOrderWriteDirection, assertLease?: () => Promise<boolean>, pair?: { id: string; entityType: string } | Array<{ id: string; entityType: string }>): Promise<void> {
    const setting = await this.database.syncSetting.findUnique({ where: { id: 'global' }, select: { serviceMode: true } });
    if (!setting) throw new DealOrderWriteGateError('RECOVERY');
    if (setting.serviceMode !== 'on') throw new DealOrderWriteGateError(setting.serviceMode === 'off' ? 'OFF' : 'PAUSE');
    if (this.databaseRecovery && !await this.databaseRecovery.assertReady()) throw new DealOrderWriteGateError('RECOVERY');
    const directions = await this.database.syncDirectionSetting.findUnique({ where: { entityKey: 'deals-orders' } });
    if (directions?.[direction] === false) throw new DealOrderWriteGateError('DIRECTION');
    if (assertLease && !await assertLease()) throw new DealOrderWriteGateError('LEASE');
    if (pair && this.clientLifecycle) {
      for (const item of Array.isArray(pair) ? pair : [pair]) await this.clientLifecycle.assertPairActive(item.id, item.entityType);
    }
    if (process.env.SYNC_MODE !== 'apply') throw new DealOrderWriteGateError('NOT_APPLY');
    assertApplyExternalWrite('DEAL_ORDER', 'PROVIDER_MUTATION');
  }

  /** Hold lifecycle leases over the provider mutation so a confirmed delete cannot
   * tombstone the pair between our final active-state check and the API call. */
  async runDealOrderExternalWrite<T>(
    direction: DealOrderWriteDirection,
    assertLease: (() => Promise<boolean>) | undefined,
    pair: { id: string; entityType: string } | Array<{ id: string; entityType: string }> | undefined,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const run = async () => {
      await this.assertDealOrderExternalWriteAllowed(direction, assertLease, pair);
      return mutation();
    };
    const pairs = (pair ? (Array.isArray(pair) ? pair : [pair]) : [])
      .filter((item) => ['COMPANY', 'CONTACT', 'DEAL', 'PRODUCT'].includes(item.entityType))
      .sort((a, b) => `${a.entityType}:${a.id}`.localeCompare(`${b.entityType}:${b.id}`));
    if (!this.clientLifecycle || pairs.length === 0) return run();
    const withLocks = (index: number): Promise<T> => index >= pairs.length
      ? run()
      : this.clientLifecycle!.withPairActiveLock(pairs[index].id, pairs[index].entityType as 'COMPANY' | 'CONTACT' | 'DEAL' | 'PRODUCT', () => withLocks(index + 1));
    return withLocks(0);
  }

  /** Catalog creation has its own direction gate and durable operation lease. */
  async runProductCatalogExternalWrite<T>(assertLease: (() => Promise<boolean>) | undefined, mutation: () => Promise<T>): Promise<T> {
    return this.database.$transaction(async (transaction) => {
      const setting = await transaction.$queryRaw<Array<{ serviceMode: string }>>`
        SELECT "serviceMode" FROM "SyncSetting" WHERE "id" = 'global' FOR SHARE
      `;
      if (!setting[0]) throw new DealOrderWriteGateError('RECOVERY');
      if (setting[0].serviceMode !== 'on') throw new DealOrderWriteGateError(setting[0].serviceMode === 'off' ? 'OFF' : 'PAUSE');
      const direction = await transaction.$queryRaw<Array<{ moyskladToBitrix24: boolean }>>`
        SELECT "moyskladToBitrix24" FROM "SyncDirectionSetting" WHERE "entityKey" = 'products-variations' FOR SHARE
      `;
      if (direction[0] && !direction[0].moyskladToBitrix24) throw new DealOrderWriteGateError('DIRECTION');
      if (this.databaseRecovery && !await this.databaseRecovery.assertReady()) throw new DealOrderWriteGateError('RECOVERY');
      if (process.env.SYNC_MODE !== 'apply') throw new DealOrderWriteGateError('NOT_APPLY');
      if (assertLease && !await assertLease()) throw new DealOrderWriteGateError('LEASE');
      assertApplyExternalWrite('BITRIX24', 'PRODUCT_CREATE');
      return mutation();
    });
  }

}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
