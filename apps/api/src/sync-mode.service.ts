import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { DatabaseRecoveryService } from './database-recovery.service';
import { assertApplyExternalWrite } from './external-write-guard';
import { ClientLifecycleService } from './clients/client-lifecycle.service';
import { FieldSettingsService } from './field-settings/field-settings.service';
import { ReadOnlyFieldDataProvider } from './field-settings/read-only-field-data.provider';
import { EnablePreflightReport, SyncModeDirection, evaluateEnablePreflight } from './sync-mode-preflight';

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
    supportedDirections: ['bitrix24ToMoysklad', 'moyskladToBitrix24'],
    implementation: 'implemented',
    directionScope: 'CLIENT_CONFIGURED_FIELDS_GROUPS_CREATE_DEPENDENCIES',
    availability: 'Реализованы события компаний и контактов: настроенные поля и группы, baseline/readback, безопасное создание пары и зависимости контакта. Полнота acceptance проверяется отдельно; preflight обязателен.',
  },
  {
    key: 'deals-orders',
    label: 'Сделки ↔ заказы покупателей',
    ready: true,
    supportedDirections: ['bitrix24ToMoysklad', 'moyskladToBitrix24'],
    implementation: 'implemented',
    directionScope: 'DEAL_ORDER_RUNTIME',
    availability: 'Обмен реализован; перед включением каждого направления проверяются настройки и доступ API.',
  },
  {
    key: 'invoices',
    label: 'Счета ↔ счета покупателям',
    ready: true,
    supportedDirections: ['bitrix24ToMoysklad', 'moyskladToBitrix24'],
    implementation: 'implemented',
    directionScope: 'INVOICE_PAIRS',
    availability: 'Только новые смарт-счета entityTypeId=31 и счета покупателям со связью на подтверждённый заказ.',
  },
  {
    key: 'products-variations',
    label: 'Товары ↔ товары и модификации',
    ready: true,
    supportedDirections: ['moyskladToBitrix24'],
    implementation: 'implemented',
    directionScope: 'MOYSKLAD_PRODUCT_CATALOG_TO_BITRIX24',
    availability: 'Каталожный обмен реализован только из МойСклад в Bitrix24; перед включением проверяются каталог и единицы измерения.',
  },
  {
    key: 'service-dictionary',
    label: 'Отдельный обмен справочником услуг (вне полей сделки/заказа)',
    ready: false,
    supportedDirections: [],
    implementation: 'not_implemented',
    directionScope: null,
    availability: 'Отдельный поток справочника услуг не реализован. Сопоставленные поля справочника услуг внутри сделки/заказа обслуживаются настройками и runtime обмена сделки/заказа.',
  },
] as const;

@Injectable()
export class SyncModeService {
  constructor(
    private readonly database: DatabaseService,
    @Optional() @Inject(DatabaseRecoveryService) private readonly databaseRecovery?: DatabaseRecoveryService,
    @Optional() @Inject(ClientLifecycleService) private readonly clientLifecycle?: ClientLifecycleService,
    @Optional() @Inject(FieldSettingsService) private readonly fieldSettings?: FieldSettingsService,
    @Optional() @Inject(ReadOnlyFieldDataProvider) private readonly fieldData?: ReadOnlyFieldDataProvider,
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
    await this.ensureGlobalSetting();
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "SyncSetting" WHERE "id" = 'global' FOR UPDATE`;
      const current = await tx.syncSetting.findUniqueOrThrow({ where: { id: 'global' } });
      if (mode === current.serviceMode) return { mode: current.serviceMode as ServiceMode };
      const enteringOff = mode === 'off' && current.serviceMode !== 'off';
      const leavingOffInterval = mode === 'on' && current.offSince !== null;
      const now = new Date();
      const lastTransition = await tx.syncModeTransition.findFirst({
        orderBy: [{ transitionedAt: 'desc' }, { id: 'desc' }], select: { transitionedAt: true },
      });
      const transitionedAt = lastTransition && lastTransition.transitionedAt >= now
        ? new Date(lastTransition.transitionedAt.getTime() + 1)
        : now;
      if (!current.modeHistoryTrackedFrom) {
        const trackedFrom = new Date(transitionedAt.getTime() - 1);
        await tx.syncSetting.update({ where: { id: 'global' }, data: { modeHistoryTrackedFrom: trackedFrom } });
        await tx.syncModeTransition.create({ data: {
          fromMode: 'unknown', toMode: current.serviceMode, transitionedAt: trackedFrom,
        } });
      }
      const offSince = enteringOff ? transitionedAt : current.offSince;
      const setting = await tx.syncSetting.update({
        where: { id: 'global' },
        data: {
          serviceMode: mode,
          offSince,
          ...((mode === 'pause' || mode === 'off') ? { lastInactiveAt: transitionedAt } : {}),
          ...(mode === 'on' && current.serviceMode !== 'on' ? { lastActiveAt: transitionedAt } : {}),
          ...(enteringOff ? {
            resumeStatus: 'skipped', resumeFrom: null, resumeThrough: null,
            resumeProvider: 'BITRIX24', resumeBitrixStart: 0, resumeMoyskladOffset: 0,
            resumeError: 'Events missed during OFF are intentionally not replayed.',
            resumeRetryAfter: null, resumeAttempts: 0,
          } : {}),
          ...(leavingOffInterval ? {
            resumeStatus: 'skipped', resumeFrom: null, resumeThrough: null,
            resumeProvider: 'BITRIX24', resumeBitrixStart: 0, resumeMoyskladOffset: 0,
            resumeError: 'Events missed during OFF are intentionally not replayed.',
            resumeRetryAfter: null, resumeAttempts: 0, offSince: null,
          } : {}),
        },
        select: { serviceMode: true },
      });
      await tx.syncModeTransition.create({ data: { fromMode: current.serviceMode, toMode: mode, transitionedAt } });
      return { mode: setting.serviceMode as ServiceMode };
    });
  }

  async readEntitySettings() {
    return Promise.all(entityControls.map(async (entity) => {
      const directions = entity.ready ? await this.ensureDirectionSetting(entity.key) : null;
      return {
        ...entity,
        bitrix24ToMoysklad: directions?.bitrix24ToMoysklad ?? false,
        moyskladToBitrix24: directions?.moyskladToBitrix24 ?? false,
      };
    }));
  }

  async setEntityDirections(
    entityKey: string,
    directions: { bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean },
    bitrixAccessToken = '',
  ) {
    const entity = entityControls.find((control) => control.key === entityKey);
    if (!entity || !entity.ready) {
      throw new ConflictException('This entity is not ready to be enabled');
    }
    const current = await this.ensureDirectionSetting(entityKey);
    const candidates: SyncModeDirection[] = [
      ...(directions.bitrix24ToMoysklad && !current.bitrix24ToMoysklad ? ['bitrix24ToMoysklad' as const] : []),
      ...(directions.moyskladToBitrix24 && !current.moyskladToBitrix24 ? ['moyskladToBitrix24' as const] : []),
    ];
    if (candidates.length === 0) {
      if (directions.bitrix24ToMoysklad === current.bitrix24ToMoysklad && directions.moyskladToBitrix24 === current.moyskladToBitrix24) {
        return { key: entityKey, ...current };
      }
      const setting = await this.database.syncDirectionSetting.update({
        where: { entityKey },
        data: directions,
        select: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
      });
      return { key: entityKey, ...setting };
    }
    const reports: EnablePreflightReport[] = [];
    for (const direction of candidates) {
      const report = await this.preflightEntityDirection(entityKey, direction, bitrixAccessToken);
      if (!report.canEnable) throw new ConflictException({ message: 'SYNC_PREFLIGHT_BLOCKED', preflight: report });
      reports.push(report);
    }
    const checkedVersions = new Set(reports.map((report) => report.settingsVersion));
    if (checkedVersions.size > 1 || reports.some((report) => report.settingsVersion === null)) {
      throw new ConflictException('SYNC_PREFLIGHT_STALE');
    }
    const expectedSettingsVersion = reports[0]?.settingsVersion;
    const setting = await this.database.$transaction(async (transaction) => {
      const activeVersions = await transaction.$queryRaw<Array<{ version: number }>>`
        SELECT "version" FROM "FieldSettingsState" WHERE "id" = 'global' FOR SHARE
      `;
      if (!activeVersions[0] || activeVersions[0].version !== expectedSettingsVersion) {
        throw new ConflictException('SYNC_PREFLIGHT_STALE');
      }
      return transaction.syncDirectionSetting.update({
        where: { entityKey },
        data: directions,
        select: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
      });
    });
    return { key: entityKey, ...setting };
  }

  async preflightEntityDirection(entityKey: string, direction: SyncModeDirection, bitrixAccessToken: string): Promise<EnablePreflightReport> {
    let settings: { version: number; config: Record<string, unknown> } | null = null;
    try {
      const active = await this.fieldSettings?.active();
      if (active && active.config) settings = { version: active.version, config: active.config as unknown as Record<string, unknown> };
    } catch { /* The report below will make unavailable settings a blocker. */ }

    let apiAccess = false;
    let applicableStages: string[] = [];
    let applicableCurrencies: string[] = [];
    let applicableUnits: string[] = [];
    let availableProductCatalogIds: string[] = [];
    let optionalEndpointWarnings: string[] = [];
    let unverifiedRequiredReferences: string[] = [];
    if (this.fieldData && bitrixAccessToken) {
      try {
        if (entityKey === 'deals-orders') {
          const catalogs = await this.fieldData.dealOrderCatalogs(bitrixAccessToken, direction);
          applicableStages = catalogs.stages;
          applicableCurrencies = catalogs.currencies;
          optionalEndpointWarnings = await this.fieldData.optionalDealOrderReferenceWarnings(bitrixAccessToken);
          if (direction === 'bitrix24ToMoysklad') {
            unverifiedRequiredReferences = await this.fieldData.verifyRequiredDealOrderReferences(settings?.config);
          }
        } else if (entityKey === 'products-variations') {
          const catalogs = await this.fieldData.productCatalogReadiness(bitrixAccessToken);
          applicableUnits = catalogs.units;
          availableProductCatalogIds = catalogs.productCatalogs;
        } else if (entityKey === 'invoices') {
          await this.fieldData.fieldCatalogs(bitrixAccessToken, 'smart-invoices');
        } else if (entityKey === 'contacts-companies') {
          await this.fieldData.fieldCatalogs(bitrixAccessToken, 'contacts-companies');
        }
        apiAccess = true;
      } catch { /* Do not disclose provider responses or credential details in admin diagnostics. */ }
    }

    const incomingSource = direction === 'bitrix24ToMoysklad' ? 'BITRIX24_EVENT_APPLICATION_TOKEN' : 'MOYSKLAD_WEBHOOK_SECRET';
    const optionalReferenceWarnings = collectOptionalReferenceWarnings(settings?.config, entityKey);
    return evaluateEnablePreflight({
      entityKey, direction, settings, apiAccess,
      webhookAuthConfigured: Boolean(process.env[incomingSource]),
      applicableStages, applicableCurrencies, applicableUnits, availableProductCatalogIds,
      optionalReferenceWarnings,
      optionalEndpointWarnings,
      unverifiedRequiredReferences,
    });
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
        create: { entityKey, bitrix24ToMoysklad: directionDefault(entityKey), moyskladToBitrix24: directionDefault(entityKey) },
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
    return setting?.[direction] ?? directionDefault(entityKey);
  }

  /** Re-read durable global/direction/recovery state immediately before each
   * provider mutation; callers supply their current worker/pair lease check. */
  async assertDealOrderExternalWriteAllowed(direction: DealOrderWriteDirection, assertLease?: () => Promise<boolean>, pair?: { id: string; entityType: string } | Array<{ id: string; entityType: string }>): Promise<void> {
    const setting = await this.database.syncSetting.findUnique({ where: { id: 'global' }, select: { serviceMode: true } });
    if (!setting) throw new DealOrderWriteGateError('RECOVERY');
    if (setting.serviceMode !== 'on') throw new DealOrderWriteGateError(setting.serviceMode === 'off' ? 'OFF' : 'PAUSE');
    if (this.databaseRecovery && !await this.databaseRecovery.assertReady()) throw new DealOrderWriteGateError('RECOVERY');
    const directions = await this.database.syncDirectionSetting.findUnique({ where: { entityKey: 'deals-orders' } });
    if (!directions?.[direction]) throw new DealOrderWriteGateError('DIRECTION');
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
      if (!direction[0]?.moyskladToBitrix24) throw new DealOrderWriteGateError('DIRECTION');
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

function collectOptionalReferenceWarnings(config: Record<string, unknown> | undefined, entityKey: string): string[] {
  if (!config || typeof config.references !== 'object' || config.references === null) return [];
  const references = config.references as Record<string, unknown>;
  const optionalKinds = entityKey === 'deals-orders' ? ['projects'] : [];
  const pairs = Array.isArray(references.namedPairs) ? references.namedPairs : [];
  return optionalKinds.filter((kind) => {
    const applicable = pairs.filter((pair) => typeof pair === 'object' && pair !== null && 'kind' in pair && pair.kind === kind);
    return applicable.some((pair) => typeof pair === 'object' && pair !== null && 'status' in pair && pair.status !== 'confirmed');
  });
}

function directionDefault(entityKey: string): boolean {
  // Preserve existing direction defaults; newly implemented scopes remain
  // opt-in until their preflight succeeds.
  return entityKey === 'contacts-companies';
}
