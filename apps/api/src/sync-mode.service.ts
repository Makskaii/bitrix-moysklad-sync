import { ConflictException, Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { Prisma } from '@prisma/client';

type SyncSettingsClient = Pick<Prisma.TransactionClient, 'syncSetting' | 'syncDirectionSetting'>;

export type ServiceMode = 'on' | 'pause' | 'off';

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
  constructor(private readonly database: DatabaseService) {}

  async read(client: SyncSettingsClient = this.database) {
    const setting = await this.ensureGlobalSetting(client);
    return { mode: setting.serviceMode as ServiceMode };
  }

  async setMode(mode: ServiceMode, client: SyncSettingsClient = this.database) {
    const current = await this.ensureGlobalSetting(client);
    if (mode === current.serviceMode) return { mode: current.serviceMode as ServiceMode };
    const enteringOff = mode === 'off' && current.serviceMode !== 'off';
    const startingResume = mode === 'on' && current.serviceMode !== 'on' && current.offSince !== null &&
      ['idle', 'complete'].includes(current.resumeStatus);
    const now = new Date();
    const offSince = enteringOff ? new Date() : current.offSince;
    const setting = await client.syncSetting.update({
      where: { id: 'global' },
      data: {
        serviceMode: mode,
        offSince,
        ...(enteringOff ? {
          resumeStatus: 'idle',
          resumeFrom: null,
          resumeThrough: null,
          resumeProvider: 'BITRIX24',
          resumeBitrixStart: 0,
          resumeMoyskladOffset: 0,
          resumeError: null,
          resumeRetryAfter: null,
          resumeAttempts: 0,
        } : {}),
        ...(startingResume ? {
          resumeStatus: 'pending',
          resumeFrom: new Date(Math.floor(current.offSince!.getTime() / 1_000) * 1_000),
          resumeThrough: now,
          resumeProvider: 'BITRIX24',
          resumeBitrixStart: 0,
          resumeMoyskladOffset: 0,
          resumeError: null,
          resumeRetryAfter: null,
          resumeAttempts: 0,
        } : {}),
      },
      select: { serviceMode: true },
    });
    return { mode: setting.serviceMode as ServiceMode };
  }

  async readEntitySettings(client: SyncSettingsClient = this.database) {
    const ready = entityControls.find((entity) => entity.ready)!;
    const directions = await this.ensureDirectionSetting(ready.key, client);
    return entityControls.map((entity) => ({
      ...entity,
      bitrix24ToMoysklad: entity.ready ? directions.bitrix24ToMoysklad : false,
      moyskladToBitrix24: entity.ready ? directions.moyskladToBitrix24 : false,
    }));
  }

  async setEntityDirections(
    entityKey: string,
    directions: { bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean },
    client: SyncSettingsClient = this.database,
  ) {
    const entity = entityControls.find((control) => control.key === entityKey);
    if (!entity || !entity.ready) {
      throw new ConflictException('This entity is not ready to be enabled');
    }
    await this.ensureDirectionSetting(entityKey, client);
    const setting = await client.syncDirectionSetting.update({
      where: { entityKey },
      data: directions,
      select: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
    });
    return { key: entityKey, ...setting };
  }

  private async ensureGlobalSetting(client: SyncSettingsClient = this.database) {
    try {
      return await client.syncSetting.upsert({
        where: { id: 'global' },
        create: {},
        update: {},
        select: { serviceMode: true, offSince: true, resumeStatus: true },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const setting = await client.syncSetting.findUnique({
        where: { id: 'global' },
        select: { serviceMode: true, offSince: true, resumeStatus: true },
      });
      if (!setting) throw error;
      return setting;
    }
  }

  private async ensureDirectionSetting(entityKey: string, client: SyncSettingsClient = this.database) {
    try {
      return await client.syncDirectionSetting.upsert({
        where: { entityKey },
        create: { entityKey },
        update: {},
        select: { bitrix24ToMoysklad: true, moyskladToBitrix24: true },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const setting = await client.syncDirectionSetting.findUnique({
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

}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
