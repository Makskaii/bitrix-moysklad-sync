import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { writeOperationalLog } from '../monitoring-log';
import { DEFAULT_FIELD_SETTINGS } from './approved-mappings';
import { FieldSettingsConfigDto, VersionedFieldSettingsDto } from './field-settings.dto';
import { ReadOnlyFieldDataProvider } from './read-only-field-data.provider';
import { EntityPairService, EntityType } from '../pairs/entity-pair.service';

type JsonRecord = Record<string, unknown>;
type FieldSettingsConfig = FieldSettingsConfigDto;
type VersionRow = { version: number; config: FieldSettingsConfigDto; createdAt: Date };

@Injectable()
export class FieldSettingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly readOnlyData: ReadOnlyFieldDataProvider,
    private readonly entityPairs: EntityPairService,
  ) {}

  async active() {
    await this.ensureInitialized();
    const rows = await this.database.$queryRaw<VersionRow[]>`
      SELECT version."version", version."config", version."createdAt"
      FROM "FieldSettingsState" AS state
      JOIN "FieldSettingsVersion" AS version ON version."version" = state."version"
      WHERE state."id" = 'global'
    `;
    if (!rows[0]) throw new Error('Active field settings are unavailable');
    return serializeVersion(rows[0]);
  }

  async version(version: number) {
    if (!Number.isInteger(version) || version < 1) throw new BadRequestException('version must be a positive integer');
    await this.ensureInitialized();
    const rows = await this.database.$queryRaw<VersionRow[]>`
      SELECT "version", "config", "createdAt" FROM "FieldSettingsVersion" WHERE "version" = ${version}
    `;
    if (!rows[0]) throw new NotFoundException('Field settings version not found');
    return serializeVersion(rows[0]);
  }

  async save(value: unknown, bitrixAccessToken: string) {
    const config = validateConfiguration(value);
    await this.ensureInitialized();
    const catalogs = await this.readOnlyData.catalogs(bitrixAccessToken);
    const configuredUnitSources = new Set(config.references.units.map((unit) => String(unit.bitrix24Id)));
    const configuredPriceSources = new Set(config.references.priceTypes.map((priceType) => String(priceType.bitrix24Id)));
    const dictionaryCatalogs = await this.readOnlyData.dictionaryCatalogs(bitrixAccessToken);
    for (const mapping of config.references.dictionaries) {
      const live = dictionaryCatalogs.find((candidate) => candidate.key === mapping.key);
      if (!live) throw new BadRequestException(`Dictionary ${mapping.key} is not supported`);
      const sourceIds = new Set(live.bitrix24.map((candidate) => Number(candidate.id)));
      const targetIds = new Set(live.moysklad.map((candidate) => candidate.id));
      const seenSources = new Set<number>();
      const seenTargets = new Set<string>();
      for (const pair of mapping.pairs) {
        if (!sourceIds.has(pair.bitrix24Id)) throw new BadRequestException(`Bitrix24 dictionary value ${pair.bitrix24Id} does not exist in ${mapping.key}`);
        if (!targetIds.has(pair.moyskladId)) throw new BadRequestException(`MySklad dictionary value ${pair.moyskladId} does not exist in ${mapping.key}`);
        if (seenSources.has(pair.bitrix24Id) || seenTargets.has(pair.moyskladId)) throw new BadRequestException(`Dictionary ${mapping.key} pairs must be one-to-one`);
        seenSources.add(pair.bitrix24Id);
        seenTargets.add(pair.moyskladId);
      }
    }
    if (catalogs.units.bitrix24.some((unit) => !configuredUnitSources.has(unit.id))) throw new BadRequestException('Every current Bitrix24 measure must remain visible in the mapping table');
    if (catalogs.priceTypes.bitrix24.some((priceType) => !configuredPriceSources.has(priceType.id))) throw new BadRequestException('Every current Bitrix24 price type must remain visible in the mapping table');
    const liveUnitIds = new Set(catalogs.units.moysklad.map((unit) => unit.id));
    const livePriceTypeIds = new Set(catalogs.priceTypes.moysklad.map((priceType) => priceType.id));
    for (const unit of config.references.units) if (unit.moyskladId && !liveUnitIds.has(unit.moyskladId)) throw new BadRequestException(`MySklad unit ${unit.moyskladId} no longer exists`);
    for (const priceType of config.references.priceTypes) if (priceType.moyskladId && !livePriceTypeIds.has(priceType.moyskladId)) throw new BadRequestException(`MySklad price type ${priceType.moyskladId} no longer exists`);
    const version = await this.database.$transaction(async (transaction) => {
      const states = await transaction.$queryRaw<Array<{ version: number }>>`
        SELECT "version" FROM "FieldSettingsState" WHERE "id" = 'global' FOR UPDATE
      `;
      const previousVersion = states[0]?.version;
      if (!previousVersion) throw new Error('Active field settings state is unavailable');
      const nextVersion = previousVersion + 1;
      await transaction.$executeRaw`
        INSERT INTO "FieldSettingsVersion" ("version", "config")
        VALUES (${nextVersion}, ${JSON.stringify(config)}::jsonb)
      `;
      await transaction.$executeRaw`
        UPDATE "FieldSettingsState" SET "version" = ${nextVersion} WHERE "id" = 'global'
      `;
      return nextVersion;
    }, { isolationLevel: 'Serializable' });

    await writeOperationalLog(this.database, 'ADMIN', `Field settings version ${version} activated`, String(version));
    return this.version(version);
  }

  async catalogs(bitrixAccessToken: string) {
    const [live, dictionaryCatalogs] = await Promise.all([
      this.readOnlyData.catalogs(bitrixAccessToken),
      this.readOnlyData.dictionaryCatalogs(bitrixAccessToken),
    ]);
    return {
      ...live,
      dictionaries: DEFAULT_FIELD_SETTINGS.references.dictionaries.map(({ key, bitrix24Field, bitrix24ListId, moyskladAttributeId, moyskladDirectoryId }) => ({
        key, bitrix24Field, bitrix24ListId, moyskladAttributeId, moyskladDirectoryId,
        values: dictionaryCatalogs.find((candidate) => candidate.key === key),
      })),
    };
  }

  async catalogPage(bitrixAccessToken: string, kind: 'units' | 'priceTypes', system: 'bitrix24' | 'moysklad', cursor = 0) {
    if (!Number.isInteger(cursor) || cursor < 0) throw new BadRequestException('cursor must be a non-negative offset');
    const catalogs = await this.readOnlyData.catalogs(bitrixAccessToken);
    const items = catalogs[kind][system];
    const pageSize = 100;
    return { items: items.slice(cursor, cursor + pageSize), nextCursor: cursor + pageSize < items.length ? String(cursor + pageSize) : null };
  }

  async fieldCatalogs(bitrixAccessToken: string, value: { entity: unknown; pairId: unknown }) {
    if (!isString(value.entity) || !isString(value.pairId)) {
      throw new BadRequestException('entity and pairId are required to load field metadata for an active saved pair');
    }
    const entityType = entityTypeForFieldEntity(value.entity);
    const pair = (await this.entityPairs.listActive(entityType)).find((candidate) => candidate.id === value.pairId);
    if (!pair) throw new BadRequestException('pairId must reference an active saved pair for this entity');
    return this.readOnlyData.fieldCatalogs(bitrixAccessToken, value.entity, pair.bitrix24Id, pair.moyskladId);
  }

  async preview(value: unknown, bitrixAccessToken: string) {
    if (!isRecord(value)) throw new BadRequestException('preview body must be an object');
    const entity = isString(value.entity) ? value.entity : '';
    const direction = value.direction;
    const pairIds = Array.isArray(value.pairIds) ? value.pairIds : [];
    if (!['BITRIX24_TO_MOYSKLAD', 'MOYSKLAD_TO_BITRIX24'].includes(String(direction))) throw new BadRequestException('direction is invalid');
    if (!entity) throw new BadRequestException('entity is required');
    if (pairIds.length < 1 || pairIds.length > 10 || pairIds.some((id) => !isString(id))) throw new BadRequestException('pairIds must contain between 1 and 10 active saved pair IDs');
    if (new Set(pairIds).size !== pairIds.length) throw new BadRequestException('pairIds must be unique');
    const entityType = entityTypeForFieldEntity(entity);
    const activePairs = await this.entityPairs.listActive(entityType);
    const activeById = new Map(activePairs.map((pair) => [pair.id, pair]));
    const selectedPairs = pairIds.map((pairId) => activeById.get(String(pairId)));
    if (selectedPairs.some((pair) => !pair)) throw new BadRequestException('Every pairId must reference an active saved pair for this entity');
    const active = await this.active();
    const config = isRecord(value.config) ? value.config : active.config;
    const snapshots = await Promise.all(selectedPairs.map((pair) => this.readOnlyData.readPair(bitrixAccessToken, entity, pair!.bitrix24Id, pair!.moyskladId)));
    const results = snapshots.map((snapshot, index) => {
      const sourceIsBitrix = direction === 'BITRIX24_TO_MOYSKLAD';
      const fields = sourceIsBitrix ? snapshot.sourceValues : snapshot.targetCurrent;
      const target = sourceIsBitrix ? snapshot.targetCurrent : snapshot.sourceValues;
      const transformed = applyFieldSettings(config, entity, fields, String(direction));
      const errors = Object.entries(transformed).filter(([, result]) => result.error).map(([field, result]) => `${field}: ${result.error}`);
      return { pairId: selectedPairs[index]!.id, sourceLabel: snapshot.sourceLabel, sourceValues: fields, transformed, targetCurrent: target, errors, version: active.version, writes: 0 };
    });
    return { results, writes: 0 };
  }

  async pinEvent(eventId: string) {
    await this.ensureInitialized();
    return this.database.$transaction(async (transaction) => {
      const state = await transaction.$queryRaw<Array<{ version: number }>>`
        SELECT "version" FROM "FieldSettingsState" WHERE "id" = 'global' FOR SHARE
      `;
      const activeVersion = state[0]?.version;
      if (!activeVersion) throw new Error('Active field settings state is unavailable');
      await transaction.$executeRaw`
        INSERT INTO "InboundEventSettings" ("eventId", "settingsVersion")
        VALUES (${eventId}, ${activeVersion}) ON CONFLICT ("eventId") DO NOTHING
      `;
      const rows = await transaction.$queryRaw<Array<{ settingsVersion: number }>>`
        SELECT "settingsVersion" FROM "InboundEventSettings" WHERE "eventId" = ${eventId}
      `;
      return rows[0]?.settingsVersion ?? activeVersion;
    }, { isolationLevel: 'Serializable' });
  }

  async saveAcceptedEvent(input: {
    source: string;
    deliveryKey: string;
    eventType: string | null;
    externalEntityId: string | null;
    externalEntityType: string | null;
    payload: Prisma.InputJsonValue;
    directionDisabled: boolean;
  }) {
    await this.ensureInitialized();
    return this.database.$transaction(async (transaction) => {
      const event = await transaction.inboundEvent.upsert({
        where: { source_deliveryKey: { source: input.source, deliveryKey: input.deliveryKey } },
        create: {
          source: input.source,
          deliveryKey: input.deliveryKey,
          eventType: input.eventType,
          externalEntityId: input.externalEntityId,
          externalEntityType: input.externalEntityType,
          payload: input.payload,
          status: input.directionDisabled ? 'SKIPPED_DIRECTION_DISABLED' : 'RECEIVED',
          lastErrorCategory: input.directionDisabled ? 'DIRECTION_DISABLED' : null,
        },
        update: {},
        select: { id: true },
      });
      const state = await transaction.$queryRaw<Array<{ version: number }>>`
        SELECT "version" FROM "FieldSettingsState" WHERE "id" = 'global' FOR SHARE
      `;
      if (!state[0]) throw new Error('Active field settings state is unavailable');
      await transaction.$executeRaw`
        INSERT INTO "InboundEventSettings" ("eventId", "settingsVersion")
        VALUES (${event.id}, ${state[0].version}) ON CONFLICT ("eventId") DO NOTHING
      `;
      return event;
    }, { isolationLevel: 'Serializable' });
  }

  async eventConfig(eventId: string): Promise<VersionedFieldSettingsDto> {
    await this.ensureInitialized();
    const rows = await this.database.$queryRaw<VersionRow[]>`
      SELECT version."version", version."config", version."createdAt"
      FROM "InboundEventSettings" AS pin
      JOIN "FieldSettingsVersion" AS version ON version."version" = pin."settingsVersion"
      WHERE pin."eventId" = ${eventId}
    `;
    if (!rows[0]) throw new NotFoundException('Event settings version was not pinned');
    return serializeVersion(rows[0]);
  }

  transformField(config: unknown, entity: string, direction: 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24', targetField: string, source: JsonRecord) {
    if (!isRecord(config)) return null;
    const ruleDirection = direction === 'BITRIX24_TO_MOYSKLAD' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
    const rules = Array.isArray(config.rules) ? config.rules : [];
    const sourceFieldKey = direction === 'BITRIX24_TO_MOYSKLAD' ? 'sourceField' : 'targetField';
    const targetFieldKey = direction === 'BITRIX24_TO_MOYSKLAD' ? 'targetField' : 'sourceField';
    const rule = rules.find((candidate) => isRecord(candidate) && candidate.entity === entity && candidate[targetFieldKey] === targetField);
    if (isRecord(rule)) {
      const mapping = rule[ruleDirection];
      if (isRecord(mapping) && mapping.enabled === true && isRecord(mapping.transform)) {
        const kind = mapping.transform.kind;
        const sourceField = rule[sourceFieldKey];
        const value = isString(sourceField) ? source[sourceField] : undefined;
        if (kind === 'copy' && value !== undefined && value !== null) return { value, error: null, transform: 'copy' };
        return { value: null, error: kind === 'tbd' ? 'transform is not configured' : 'source value is missing', transform: String(kind) };
      }
    }
    const groups = Array.isArray(config.groups) ? config.groups : [];
    const group = groups.find((candidate) => isRecord(candidate) && candidate.entity === entity && candidate.direction === direction && candidate.targetField === targetField);
    if (isRecord(group)) {
      if (!Array.isArray(group.sourceFields) || !isRecord(group.transform) || group.transform.kind !== 'join-non-empty' || typeof group.transform.separator !== 'string') {
        return { value: null, error: 'transform is not supported', transform: 'unsupported' };
      }
      const fields = group.sourceFields.filter(isString);
      if (fields.some((field) => source[field] !== undefined && source[field] !== null && typeof source[field] === 'object')) return { value: null, error: 'a source value is not a scalar', transform: 'join-non-empty' };
      const value = fields.map((field) => source[field]).filter((part) => part !== undefined && part !== null).map(String).map((part) => part.trim()).filter(Boolean).join(group.transform.separator);
      return { value, error: null, transform: 'join-non-empty' };
    }
    return null;
  }

  async eventSettings(eventIds: string[]) {
    if (eventIds.length === 0) return new Map<string, { version: number; transforms: string[] }>();
    const rows = await this.database.$queryRaw<Array<{ eventId: string; version: number; config: FieldSettingsConfig }>>`
      SELECT event."eventId", event."settingsVersion" AS version, version."config"
      FROM "InboundEventSettings" AS event
      JOIN "FieldSettingsVersion" AS version ON version."version" = event."settingsVersion"
      WHERE event."eventId" IN (${Prisma.join(eventIds)})
    `;
    return new Map(rows.map((row) => [row.eventId, { version: row.version, transforms: configuredTransforms(row.config) }]));
  }

  async repinEvent(eventId: string) {
    await this.ensureInitialized();
    return this.database.$transaction(async (transaction) => {
      const states = await transaction.$queryRaw<Array<{ version: number }>>`
        SELECT "version" FROM "FieldSettingsState" WHERE "id" = 'global' FOR SHARE
      `;
      const activeVersion = states[0]?.version;
      if (!activeVersion) throw new Error('Active field settings state is unavailable');
      const events = await transaction.$queryRaw<Array<{ status: string }>>`
        SELECT "status" FROM "InboundEvent" WHERE "id" = ${eventId} FOR UPDATE
      `;
      const status = events[0]?.status;
      if (!status) throw new NotFoundException('Event not found');
      if (!['MANUAL_REVIEW', 'RETRYABLE_FAILURE', 'SUCCEEDED', 'UNCHANGED', 'SUPERSEDED', 'SKIPPED_DIRECTION_DISABLED'].includes(status)) {
        throw new ConflictException('Only one completed or reviewable event can be explicitly recomputed');
      }
      const changed = await transaction.$executeRaw`
        UPDATE "InboundEventSettings" SET "settingsVersion" = ${activeVersion}, "pinnedAt" = CURRENT_TIMESTAMP
        WHERE "eventId" = ${eventId}
      `;
      if (changed !== 1) throw new NotFoundException('Event settings were not found');
      await transaction.$executeRaw`
        UPDATE "InboundEvent" SET "status" = 'RECEIVED', "processingStartedAt" = NULL, "lastErrorCategory" = NULL, "retryAfter" = NULL
        WHERE "id" = ${eventId}
      `;
      return activeVersion;
    }, { isolationLevel: 'Serializable' });
  }

  private async ensureInitialized() {
    const initialConfig = JSON.stringify(DEFAULT_FIELD_SETTINGS);
    await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        INSERT INTO "FieldSettingsVersion" ("version", "config")
        VALUES (1, ${initialConfig}::jsonb) ON CONFLICT ("version") DO NOTHING
      `;
      await transaction.$executeRaw`
        INSERT INTO "FieldSettingsState" ("id", "version") VALUES ('global', 1)
        ON CONFLICT ("id") DO NOTHING
      `;
      await transaction.$executeRaw`
        INSERT INTO "InboundEventSettings" ("eventId", "settingsVersion", "pinnedAt")
        SELECT "id", 1, "receivedAt" FROM "InboundEvent"
        ON CONFLICT ("eventId") DO NOTHING
      `;
    }, { isolationLevel: 'Serializable' });
  }
}

function serializeVersion(row: VersionRow): VersionedFieldSettingsDto {
  return {
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    config: row.config,
    references: row.config.references,
  };
}

function validateConfiguration(value: unknown): FieldSettingsConfig {
  if (!isRecord(value) || !Array.isArray(value.rules) || !Array.isArray(value.groups) || !isRecord(value.references)) {
    throw new BadRequestException('config must include rules, groups, and references');
  }
  const references = value.references;
  const units = validateUnits(references.units);
  const priceTypes = validatePriceTypes(references.priceTypes);
  const dictionaries = validateDictionaries(references.dictionaries);
  for (const rule of value.rules) validateRule(rule);
  for (const group of value.groups) validateGroup(group);
  return { ...value, references: { ...references, units, priceTypes, dictionaries } } as FieldSettingsConfig;
}

function validateDictionaries(value: unknown) {
  if (!Array.isArray(value)) throw new BadRequestException('references.dictionaries must be an array');
  const allowed = new Set(DEFAULT_FIELD_SETTINGS.references.dictionaries.map((dictionary) => dictionary.key));
  const seenKeys = new Set<string>();
  const dictionaries = value.map((candidate) => {
    if (!isRecord(candidate) || !isString(candidate.key) || !allowed.has(candidate.key) || !Array.isArray(candidate.pairs)) {
      throw new BadRequestException('Each dictionary must use a supported key and a pairs array');
    }
    if (seenKeys.has(candidate.key)) throw new BadRequestException(`Dictionary ${candidate.key} is duplicated`);
    seenKeys.add(candidate.key);
    const pairs = candidate.pairs.map((pair) => {
      if (!isRecord(pair) || !Number.isInteger(pair.bitrix24Id) || (pair.bitrix24Id as number) < 1 || !isString(pair.moyskladId) || !isUuid(pair.moyskladId)) {
        throw new BadRequestException(`Dictionary ${candidate.key} contains an invalid value pair`);
      }
      return { bitrix24Id: pair.bitrix24Id as number, moyskladId: pair.moyskladId };
    });
    return { ...candidate, pairs };
  });
  if (seenKeys.size !== allowed.size) throw new BadRequestException('All supported dictionaries must remain in the configuration');
  return dictionaries;
}

function validateUnits(value: unknown) {
  if (!Array.isArray(value)) throw new BadRequestException('references.units must be an array');
  const seenSources = new Set<number>();
  const seenTargets = new Set<string>();
  const units = value.map((candidate) => {
    if (!isRecord(candidate) || !Number.isInteger(candidate.bitrix24Id) || (candidate.bitrix24Id as number) < 1) {
      throw new BadRequestException('Each unit must use a positive Bitrix24 measure ID');
    }
    const sourceId = candidate.bitrix24Id as number;
    if (seenSources.has(sourceId)) throw new BadRequestException('A Bitrix24 measure can only appear once');
    seenSources.add(sourceId);
    const targetId = candidate.moyskladId === null ? null : typeof candidate.moyskladId === 'string' ? candidate.moyskladId : '';
    if (targetId && !isUuid(targetId)) throw new BadRequestException('The selected MySklad unit ID must be a UUID');
    if (targetId && seenTargets.has(targetId)) throw new BadRequestException('A MySklad unit can only be assigned once');
    if (targetId) seenTargets.add(targetId);
    return { ...candidate, moyskladId: targetId, status: targetId ? 'configured' : 'unmapped' };
  });
  return units;
}

function validatePriceTypes(value: unknown) {
  if (!Array.isArray(value)) throw new BadRequestException('references.priceTypes must be an array');
  const seenSources = new Set<number>();
  const seenTargets = new Set<string>();
  const priceTypes = value.map((candidate) => {
    if (!isRecord(candidate) || !Number.isInteger(candidate.bitrix24Id) || (candidate.bitrix24Id as number) < 1) {
      throw new BadRequestException('Each price type must use a positive Bitrix24 price-type ID');
    }
    const sourceId = candidate.bitrix24Id as number;
    if (seenSources.has(sourceId)) throw new BadRequestException('A Bitrix24 price type can only appear once');
    seenSources.add(sourceId);
    const targetId = candidate.moyskladId === null ? null : typeof candidate.moyskladId === 'string' ? candidate.moyskladId : '';
    if (targetId && !isUuid(targetId)) throw new BadRequestException('The selected MySklad price-type ID must be a UUID');
    if (targetId && seenTargets.has(targetId)) throw new BadRequestException('A MySklad price type can only be assigned once');
    if (targetId) seenTargets.add(targetId);
    return { ...candidate, moyskladId: targetId, status: targetId ? 'configured' : 'excluded' };
  });
  return priceTypes;
}

function validateRule(value: unknown) {
  if (!isRecord(value) || !isString(value.id) || !isString(value.entity) || !isString(value.sourceField) || !isString(value.targetField)) {
    throw new BadRequestException('Each field rule needs an ID, entity, and source/target field codes');
  }
  validateDirection(value.bitrix24ToMoysklad);
  validateDirection(value.moyskladToBitrix24);
}

function validateGroup(value: unknown) {
  if (!isRecord(value) || !isString(value.id) || !isString(value.entity) || !isString(value.targetField) || !Array.isArray(value.sourceFields) || value.sourceFields.length === 0 || value.sourceFields.some((field) => !isString(field))) {
    throw new BadRequestException('Each field group needs an ID, entity, target field, and source field codes');
  }
  if (value.direction !== 'BITRIX24_TO_MOYSKLAD' && value.direction !== 'MOYSKLAD_TO_BITRIX24') {
    throw new BadRequestException('Field group direction is invalid');
  }
  if (!isRecord(value.transform) || value.transform.kind !== 'join-non-empty' || typeof value.transform.separator !== 'string') {
    throw new BadRequestException('Field groups currently support the join-non-empty transform');
  }
}

function validateDirection(value: unknown) {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !isRecord(value.transform) || !['copy', 'tbd'].includes(String(value.transform.kind))) {
    throw new BadRequestException('Each direction needs an enabled flag and a supported transform');
  }
}

function previewRule(rule: unknown, sample: JsonRecord, sampleIndex: number) {
  if (!isRecord(rule)) return [];
  const sourceField = rule.sourceField;
  const targetField = rule.targetField;
  if (!isString(sourceField) || !isString(targetField)) return [];
  return (['bitrix24ToMoysklad', 'moyskladToBitrix24'] as const).flatMap((direction) => {
    const setting = rule[direction];
    if (!isRecord(setting) || setting.enabled !== true || !isRecord(setting.transform) || setting.transform.kind !== 'copy') return [];
    return [{
      sampleIndex,
      field: targetField,
      source: { [sourceField]: sample[sourceField] ?? null },
      value: sample[sourceField] ?? null,
      direction,
      transform: 'copy',
      writes: 0,
    }];
  });
}

function previewGroup(group: unknown, sample: JsonRecord, sampleIndex: number) {
  if (!isRecord(group) || !isString(group.targetField) || !Array.isArray(group.sourceFields) || !isRecord(group.transform)) return [];
  const fields = group.sourceFields.filter(isString);
  const values = fields.map((field) => sample[field]).filter((value) => value !== undefined && value !== null).map((value) => String(value).trim()).filter(Boolean);
  const value = group.transform.kind === 'join-non-empty' && isString(group.transform.separator)
    ? values.join(group.transform.separator)
    : null;
  return [{
    sampleIndex,
    field: group.targetField,
    source: Object.fromEntries(fields.map((field) => [field, sample[field] ?? null])),
    value,
    direction: group.direction,
    transform: group.transform.kind,
    writes: 0,
  }];
}

function applyFieldSettings(config: unknown, entity: string, source: JsonRecord, direction: string): Record<string, { value: unknown; error?: string; transform: string }> {
  const result: Record<string, { value: unknown; error?: string; transform: string }> = {};
  if (!isRecord(config)) return result;
  const ruleDirection = direction === 'BITRIX24_TO_MOYSKLAD' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
  for (const rule of Array.isArray(config.rules) ? config.rules : []) {
    if (!isRecord(rule) || rule.entity !== entity || !isString(rule.sourceField) || !isString(rule.targetField)) continue;
    const mapping = rule[ruleDirection];
    if (!isRecord(mapping) || mapping.enabled !== true || !isRecord(mapping.transform)) continue;
    const kind = String(mapping.transform.kind);
    const sourceField = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.sourceField : rule.targetField;
    const targetField = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.targetField : rule.sourceField;
    const value = source[sourceField];
    result[targetField] = kind === 'copy' && value !== undefined
      ? { value, transform: kind }
      : { value: null, error: kind === 'tbd' ? 'transform is not configured' : 'source value is missing', transform: kind };
  }
  for (const group of Array.isArray(config.groups) ? config.groups : []) {
    if (!isRecord(group) || group.entity !== entity || group.direction !== direction || !isString(group.targetField) || !Array.isArray(group.sourceFields) || !isRecord(group.transform)) continue;
    const fields = group.sourceFields.filter(isString);
    if (group.transform.kind !== 'join-non-empty' || typeof group.transform.separator !== 'string') {
      result[group.targetField] = { value: null, error: 'transform is not supported', transform: String(group.transform.kind) };
      continue;
    }
    const values = fields.map((field) => source[field]).filter((item) => item !== undefined && item !== null).map((item) => typeof item === 'string' || typeof item === 'number' ? String(item).trim() : '');
    if (fields.some((field) => source[field] !== undefined && source[field] !== null && typeof source[field] === 'object')) {
      result[group.targetField] = { value: null, error: 'a source value is not a scalar', transform: 'join-non-empty' };
    } else {
      result[group.targetField] = { value: values.filter(Boolean).join(group.transform.separator), transform: 'join-non-empty' };
    }
  }
  return result;
}

function configuredTransforms(config: FieldSettingsConfig): string[] {
  const transforms = new Set<string>();
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const groups = Array.isArray(config.groups) ? config.groups : [];
  for (const rule of rules) {
    if (!isRecord(rule)) continue;
    for (const direction of [rule.bitrix24ToMoysklad, rule.moyskladToBitrix24]) {
      if (isRecord(direction) && direction.enabled === true && isRecord(direction.transform) && isString(direction.transform.kind) && direction.transform.kind !== 'tbd') transforms.add(direction.transform.kind);
    }
  }
  for (const group of groups) if (isRecord(group) && isRecord(group.transform) && isString(group.transform.kind)) transforms.add(group.transform.kind);
  return [...transforms].sort();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function entityTypeForFieldEntity(entity: string): EntityType {
  switch (entity) {
    case 'contacts':
    case 'contacts-companies': return 'CONTACT';
    case 'companies': return 'COMPANY';
    case 'deals-orders': return 'DEAL';
    case 'catalog': return 'PRODUCT';
    default: throw new BadRequestException('This entity type has no active field-settings pair catalog');
  }
}

