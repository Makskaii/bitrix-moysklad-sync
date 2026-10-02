import { ConflictException, Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';

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
  {
    key: 'reference-mappings',
    label: 'Соответствия сотрудников, организаций, складов, валют и значений справочников',
    ready: false,
    directionScope: null,
    availability: 'Настройки связей; отдельный обработчик синхронизации не включается.',
  },
] as const;

@Injectable()
export class SyncModeService {
  constructor(private readonly database: DatabaseService) {}

  async read() {
    const setting = await this.ensureGlobalSetting();
    return { mode: setting.serviceMode as ServiceMode };
  }

  async setMode(mode: ServiceMode) {
    const current = await this.ensureGlobalSetting();
    const enteringOff = mode === 'off' && current.serviceMode !== 'off';
    const startingResume = mode === 'on' && current.serviceMode !== 'on' && current.offSince !== null &&
      ['idle', 'complete'].includes(current.resumeStatus);
    const offSince = enteringOff ? new Date() : current.offSince;
    const setting = await this.database.syncSetting.update({
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
        } : {}),
        ...(startingResume ? {
          resumeStatus: 'pending',
          resumeFrom: new Date(Math.floor(current.offSince!.getTime() / 1_000) * 1_000),
          resumeThrough: new Date(),
          resumeProvider: 'BITRIX24',
          resumeBitrixStart: 0,
          resumeMoyskladOffset: 0,
          resumeError: null,
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

}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
