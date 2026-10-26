import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { withNightlySettingLock } from '../nightly-setting-lock';
import { writeOperationalLog } from '../monitoring-log';
import { DEFAULT_FIELD_SETTINGS } from './approved-mappings';
import { FieldSettingsConfigDto, NamedReferenceKind, NamedReferencePair, VersionedFieldSettingsDto } from './field-settings.dto';
import { FieldCandidate, ReadOnlyFieldDataProvider } from './read-only-field-data.provider';
import { EntityPairService, EntityType } from '../pairs/entity-pair.service';
import { validateChildResourceBindings } from '../clients/client-child-resource-sync';
import { applyFieldTransform, FieldTransform } from './field-transform';
import { confirmedDealStageReference } from './deal-stage-catalog-key';
import { sameClientFieldEntity, canonicalClientFieldEntity } from './client-field-entity';

type JsonRecord = Record<string, unknown>;
type FieldSettingsConfig = FieldSettingsConfigDto;
type VersionRow = { version: number; config: FieldSettingsConfigDto; createdAt: Date };

export class EventIntakeDisabledError extends Error {
  constructor() { super('Event intake is disabled by the persisted service mode'); }
}

@Injectable()
export class FieldSettingsService {
  private acceptanceInitialization: Promise<void> | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly readOnlyData: ReadOnlyFieldDataProvider,
    private readonly entityPairs: EntityPairService,
  ) {}

  async active() {
    await this.ensureInitializedOnce();
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
    await this.ensureInitializedOnce();
    const rows = await this.database.$queryRaw<VersionRow[]>`
      SELECT "version", "config", "createdAt" FROM "FieldSettingsVersion" WHERE "version" = ${version}
    `;
    if (!rows[0]) throw new NotFoundException('Field settings version not found');
    return serializeVersion(rows[0]);
  }

  async save(value: unknown, bitrixAccessToken: string) {
    const config = validateConfiguration(value);
    await this.ensureInitializedOnce();
    await this.validateConfiguredFields(config, bitrixAccessToken);
    const active = await this.active();
    const riskChanges = fieldRuleRiskChanges(active.config, config);
    const referencesChanged = JSON.stringify(config.references) !== JSON.stringify(active.config.references) ||
      JSON.stringify(config.dealOrderRuntime) !== JSON.stringify(active.config.dealOrderRuntime) ||
      JSON.stringify(config.productCatalogRuntime) !== JSON.stringify(active.config.productCatalogRuntime);
    if (referencesChanged) {
    const catalogs = await this.readOnlyData.catalogs(bitrixAccessToken);
    const namedCatalogs = await this.readOnlyData.referenceCatalogs(bitrixAccessToken);
    const configuredUnitSources = new Set(config.references.units.map((unit) => String(unit.bitrix24Id)));
    const configuredPriceSources = new Set(config.references.priceTypes.map((priceType) => String(priceType.bitrix24Id)));
    const productCatalogId = config.dealOrderRuntime?.bitrix24ProductCatalogId ?? null;
    if (productCatalogId && !catalogs.productCatalogs.some((candidate) => candidate.id === productCatalogId)) {
      throw new BadRequestException(`Bitrix24 product catalog ${productCatalogId} no longer exists`);
    }
    const catalogRuntimeId = config.productCatalogRuntime?.bitrix24CatalogId ?? null;
    if (catalogRuntimeId && !catalogs.productCatalogs.some((candidate) => candidate.id === catalogRuntimeId)) {
      throw new BadRequestException(`Bitrix24 product catalog ${catalogRuntimeId} no longer exists`);
    }
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
    for (const unit of config.references.units) {
      for (const id of [unit.moyskladId, ...(unit.reverseMoyskladIds ?? [])]) {
        if (id && !liveUnitIds.has(id)) throw new BadRequestException(`MySklad unit ${id} no longer exists`);
      }
    }
    for (const priceType of config.references.priceTypes) if (priceType.moyskladId && !livePriceTypeIds.has(priceType.moyskladId)) throw new BadRequestException(`MySklad price type ${priceType.moyskladId} no longer exists`);
    for (const pair of config.references.namedPairs ?? []) {
      const sourceIds = new Set(namedCatalogs[pair.kind].bitrix24.map((item) => item.id));
      const targetIds = new Set(namedCatalogs[pair.kind].moysklad.map((item) => item.id));
      if (!sourceIds.has(pair.bitrix24Id)) throw new BadRequestException(`Bitrix24 reference ${pair.bitrix24Id} no longer exists in ${pair.kind}`);
      if (pair.moyskladId && !targetIds.has(pair.moyskladId)) throw new BadRequestException(`MySklad reference ${pair.moyskladId} no longer exists in ${pair.kind}`);
      if (pair.status === 'confirmed' && !pair.moyskladId) throw new BadRequestException(`Reference ${pair.bitrix24Id} in ${pair.kind} must have a target before it is confirmed`);
    }
    const transitions = config.dealOrderRuntime?.stageTransitions;
    if (transitions) {
      const sources = new Set(namedCatalogs.dealStages.bitrix24.map(item => item.id));
      const targets = new Set(namedCatalogs.dealStages.moysklad.map(item => item.id));
      for (const pair of [...transitions.bitrix24ToMoysklad, ...transitions.moyskladToBitrix24]) {
        const custom = /^C([1-9]\d*):/.exec(pair.bitrix24StageId);
        const catalogKey = custom ? `${custom[1]}:${pair.bitrix24StageId}` : `0:${pair.bitrix24StageId}`;
        if (!sources.has(catalogKey) || !targets.has(pair.moyskladId)) throw new BadRequestException('Stage transition references must exist in the current provider catalogs');
      }
    }
    }
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
    if (riskChanges.length) {
      await writeOperationalLog(this.database, 'ADMIN', `Risky field mapping changes activated in version ${version}: ${riskChanges.join('; ')}`, String(version));
    }
    return this.version(version);
  }

  async catalogs(bitrixAccessToken: string) {
    const [live, dictionaryCatalogs, namedCatalogs] = await Promise.all([
      this.readOnlyData.catalogs(bitrixAccessToken),
      this.readOnlyData.dictionaryCatalogs(bitrixAccessToken),
      this.readOnlyData.referenceCatalogs(bitrixAccessToken),
    ]);
    const active = await this.active();
    const namedPairs = active.config.references.namedPairs ?? [];
    return {
      ...live,
      namedReferences: Object.fromEntries(Object.entries(namedCatalogs).map(([kind, catalogs]) => {
        const pairs = namedPairs.filter((pair) => pair.kind === kind);
        const sources = catalogs.bitrix24.map((source) => {
          const saved = pairs.find((pair) => pair.bitrix24Id === source.id);
          const candidates = kind === 'currencies' && source.code
            ? catalogs.moysklad.filter((candidate) => candidate.code === source.code)
            : catalogs.moysklad.filter((candidate) => normalizeReferenceLabel(candidate.label) === normalizeReferenceLabel(source.label));
          const suggestion = candidates.length === 1 ? candidates[0]! : null;
          return { source, targetId: saved?.moyskladId ?? null, targetLabel: saved?.moyskladLabel ?? null, status: saved?.status ?? 'unmapped', suggestion: saved ? null : suggestion, ambiguousSuggestions: !saved && candidates.length > 1 ? candidates : [] };
        });
        return [kind, { sources, targets: catalogs.moysklad }];
      })) as Record<NamedReferenceKind, unknown>,
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

  async fieldCatalogs(bitrixAccessToken: string, value: { entity: unknown }) {
    if (!isString(value.entity)) throw new BadRequestException('entity is required to load field metadata');
    entityTypeForFieldEntity(value.entity);
    return this.readOnlyData.fieldCatalogs(bitrixAccessToken, value.entity);
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
    const config = value.config === undefined ? active.config : validateConfiguration({
      ...active.config,
      ...(isRecord(value.config) ? value.config : {}),
      references: isRecord(value.config) && value.config.references !== undefined ? value.config.references : active.config.references,
    });
    await this.validateConfiguredFields(config, bitrixAccessToken);
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

  private async validateConfiguredFields(config: FieldSettingsConfig, bitrixAccessToken: string) {
    const destinations = new Map<string, string>();
    const reserve = (entity: string, direction: string, field: string) => {
      const key = `${canonicalClientFieldEntity(entity)}|${direction}|${field}`;
      const prior = destinations.get(key);
      if (prior && prior !== entity) throw new BadRequestException('Contact mapping aliases cannot write the same target field');
      destinations.set(key, entity);
    };
    for (const rule of config.rules) {
      if (rule.bitrix24ToMoysklad.enabled) reserve(rule.entity, 'BITRIX24_TO_MOYSKLAD', rule.targetField);
      if (rule.moyskladToBitrix24.enabled) reserve(rule.entity, 'MOYSKLAD_TO_BITRIX24', rule.sourceField);
    }
    for (const group of config.groups) reserve(group.entity, group.direction, group.targetField);
    const ruleEntities = [...config.rules, ...config.groups].map((entry) => {
      if (!isRecord(entry) || !isString(entry.entity)) throw new BadRequestException('Every mapping must use a supported entity');
      return entry.entity;
    });
    const supported = new Set(['contacts', 'contacts-companies', 'companies', 'deals-orders', 'smart-invoices', 'catalog']);
    for (const entity of ruleEntities) if (!supported.has(entity)) throw new BadRequestException(`Entity ${entity} is not supported for field mappings`);
    for (const group of config.groups) {
      if (group.entity === 'smart-invoices' && group.transform.kind !== 'join-non-empty') {
        throw new BadRequestException('Smart invoices support only join-non-empty field groups');
      }
      if (group.entity === 'smart-invoices' &&
        [group.targetField, ...group.sourceFields].some((field) => ['customerOrder', 'parentId2'].includes(field))) {
        throw new BadRequestException('Invoice order relationship fields cannot be configured as field groups');
      }
    }
    const entities = [...new Set(ruleEntities)];
    const catalogsByEntity = new Map<string, Array<{ bitrix24: FieldCandidate[]; moysklad: FieldCandidate[] }>>();
    for (const entity of entities) {
      catalogsByEntity.set(entity, [await this.readOnlyData.fieldCatalogs(bitrixAccessToken, entity)]);
    }
    const requireField = (entity: string, system: 'bitrix24' | 'moysklad', code: unknown, writable: boolean) => {
      if (!isString(code)) throw new BadRequestException('Mapping field codes must be non-empty strings');
      const protectedWriteFields = new Set(['id', 'meta', 'positions', 'payedsum', 'updated', 'created', 'owner', 'group']);
      if (writable && protectedWriteFields.has(code.toLowerCase())) throw new BadRequestException(`Field ${code} is protected and cannot be configured as a write target`);
      const catalogs = catalogsByEntity.get(entity) ?? [];
      if (!catalogs.length || catalogs.some((catalog) => {
        const candidate = catalog[system].find((field) => field.code === code);
        return !candidate || (writable && candidate.writable !== true);
      })) throw new BadRequestException(`Field ${code} is not available as a ${writable ? 'writable ' : ''}${system} field for ${entity}`);
    };
    for (const candidate of config.rules) {
      const rule = candidate as unknown as JsonRecord;
      const entity = String(rule.entity);
      if (entity === 'catalog' && rule.sourceField === 'xmlId') {
        throw new BadRequestException('Catalog xmlId is reserved for durable product-create recovery and cannot be mapped');
      }
      requireField(entity, 'bitrix24', rule.sourceField, false);
      requireField(entity, 'moysklad', rule.targetField, false);
      const forward = rule.bitrix24ToMoysklad as JsonRecord;
      const reverse = rule.moyskladToBitrix24 as JsonRecord;
      if (entity === 'catalog' && forward.enabled === true) {
        throw new BadRequestException('Bitrix24 catalog products and services are read-only; catalog writes must originate in MySklad');
      }
      if (forward.enabled === true) {
        requireField(entity, 'moysklad', rule.targetField, true);
        validateRuleCompatibility(entity, rule, 'BITRIX24_TO_MOYSKLAD', catalogsByEntity.get(entity)?.[0]);
      }
      if (reverse.enabled === true) {
        if (entity === 'catalog' && /^property\d+$/i.test(String(rule.sourceField))) {
          throw new BadRequestException('Catalog custom-property writes are not supported until the Bitrix24 property payload shape is verified');
        }
        requireField(entity, 'bitrix24', rule.sourceField, true);
        validateRuleCompatibility(entity, rule, 'MOYSKLAD_TO_BITRIX24', catalogsByEntity.get(entity)?.[0]);
      }
    }
    for (const candidate of config.groups) {
      const group = candidate as unknown as JsonRecord;
      const entity = String(group.entity);
      const b24ToMs = group.direction === 'BITRIX24_TO_MOYSKLAD';
      if (entity === 'catalog' && (b24ToMs ? (group.sourceFields as string[]).includes('xmlId') : group.targetField === 'xmlId')) {
        throw new BadRequestException('Catalog xmlId is reserved for durable product-create recovery and cannot be mapped');
      }
      if (entity === 'catalog' && b24ToMs) {
        throw new BadRequestException('Bitrix24 catalog products and services are read-only; catalog writes must originate in MySklad');
      }
      if (entity === 'catalog' && !b24ToMs && /^property\d+$/i.test(String(group.targetField))) {
        throw new BadRequestException('Catalog custom-property writes are not supported until the Bitrix24 property payload shape is verified');
      }
      for (const sourceField of group.sourceFields as string[]) requireField(entity, b24ToMs ? 'bitrix24' : 'moysklad', sourceField, false);
      requireField(entity, b24ToMs ? 'moysklad' : 'bitrix24', group.targetField, true);
      validateGroupCompatibility(entity, group, catalogsByEntity.get(entity)?.[0]);
    }
  }

  async pinEvent(eventId: string) {
    await this.ensureInitializedOnce();
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
    requireServiceNotOff?: boolean;
    nightlyLeaseToken?: string;
  }) {
    // Initial backfill scans historical events. Do it once per process, not
    // once for every webhook/nightly row; each accepted row is pinned below.
    await this.ensureInitializedOnce();
    // A nightly page can enqueue dozens of events. Renew the lease in its own
    // short statement, rather than holding SyncSetting's write lock for the
    // lifetime of each event/settings-pin transaction. The transaction still
    // checks the token and expiry under FOR SHARE before it accepts an event.
    if (input.nightlyLeaseToken) {
      const renewed = await withNightlySettingLock(this.database, tx => tx.$executeRaw`
        UPDATE "SyncSetting" SET "nightlyLeaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '60 seconds'
        WHERE "id" = 'global' AND "nightlyLeaseToken" = ${input.nightlyLeaseToken}
          AND "serviceMode" = 'on' AND "nightlyLeaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
      `);
      if (renewed !== 1) throw new Error('Nightly run lease was lost before durable enqueue');
    }
    return this.database.$transaction(async (transaction) => {
      if (input.requireServiceNotOff) {
        const mode = await transaction.$queryRaw<Array<{ serviceMode: string; nightlyLeaseToken: string | null; nightlyLeaseExpiresAt: Date | null }>>`
          SELECT "serviceMode", "nightlyLeaseToken", "nightlyLeaseExpiresAt" FROM "SyncSetting" WHERE "id" = 'global' FOR SHARE
        `;
        if (!mode[0] || mode[0].serviceMode === 'off') throw new EventIntakeDisabledError();
        if (input.nightlyLeaseToken && mode[0].serviceMode !== 'on') throw new EventIntakeDisabledError();
        if (input.nightlyLeaseToken && (mode[0].nightlyLeaseToken !== input.nightlyLeaseToken ||
            !mode[0].nightlyLeaseExpiresAt || mode[0].nightlyLeaseExpiresAt.getTime() <= Date.now())) {
          throw new Error('Nightly run lease was lost before durable enqueue');
        }
      }
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
    await this.ensureInitializedOnce();
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
    const result = this.transformFieldResult(config, entity, direction, targetField, source);
    if (!result) return null;
    return { value: result.status === 'mapped' ? result.value : null, error: result.status === 'error' ? result.reason : null, reason: result.status === 'skip' ? result.reason : null, status: result.status, transform: result.transform };
  }

  transformFieldResult(config: unknown, entity: string, direction: 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24', targetField: string, source: JsonRecord) {
    if (!isRecord(config)) return null;
    const ruleDirection = direction === 'BITRIX24_TO_MOYSKLAD' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
    const rules = Array.isArray(config.rules) ? config.rules : [];
    const sourceFieldKey = direction === 'BITRIX24_TO_MOYSKLAD' ? 'sourceField' : 'targetField';
    const targetFieldKey = direction === 'BITRIX24_TO_MOYSKLAD' ? 'targetField' : 'sourceField';
    const rule = rules.find((candidate) => isRecord(candidate) && sameClientFieldEntity(candidate.entity, entity) && candidate[targetFieldKey] === targetField);
    if (isRecord(rule)) {
      const mapping = rule[ruleDirection];
      if (isRecord(mapping) && mapping.enabled === true && isRecord(mapping.transform)) {
        const sourceField = rule[sourceFieldKey];
        const value = isString(sourceField) ? source[sourceField] : undefined;
        return applyFieldTransform(mapping.transform as unknown as FieldTransform, value);
      }
    }
    const groups = Array.isArray(config.groups) ? config.groups : [];
    const group = groups.find((candidate) => isRecord(candidate) && sameClientFieldEntity(candidate.entity, entity) && candidate.direction === direction && candidate.targetField === targetField);
    if (isRecord(group)) {
      if (!Array.isArray(group.sourceFields) || !isRecord(group.transform) || typeof group.transform.separator !== 'string') {
        return { status: 'error' as const, reason: 'transform is not supported', transform: 'unsupported' };
      }
      const fields = group.sourceFields.filter(isString);
      if (group.transform.kind === 'join-non-empty') {
        const separator = group.transform.separator;
        const values: string[] = [];
        for (const field of fields) {
          const raw = source[field];
          const parts = Array.isArray(raw) ? raw.map((entry) => isRecord(entry) ? entry.VALUE : entry) : [raw];
          for (const part of parts) {
            if (part === undefined || part === null || part === '') continue;
            if (typeof part !== 'string') return { status: 'error' as const, reason: 'join-non-empty accepts string values only', transform: 'join-non-empty' };
            const normalized = part.trim();
            if (normalized) values.push(normalized);
          }
        }
        if (values.some((value) => typeof value !== 'string')) return { status: 'error' as const, reason: 'join-non-empty accepts string values only', transform: 'join-non-empty' };
        return { status: 'mapped' as const, value: values.join(separator), transform: 'join-non-empty' };
      }
      if (group.transform.kind === 'split-non-empty' && direction === 'MOYSKLAD_TO_BITRIX24' && isString(group.transform.valueType) && group.transform.valueType.trim()) {
        const separator = group.transform.separator;
        const valueType = group.transform.valueType;
        const rawValues = fields.map((field) => source[field]);
        if (rawValues.some((raw) => raw !== undefined && raw !== null && typeof raw !== 'string')) return { status: 'error' as const, reason: 'split-non-empty accepts string values only', transform: 'split-non-empty' };
        const values = rawValues.flatMap((raw) => typeof raw === 'string' ? raw.split(separator).map((item) => item.trim()).filter(Boolean) : []);
        return { status: 'mapped' as const, value: values.map((VALUE) => ({ VALUE, VALUE_TYPE: valueType })), transform: 'split-non-empty' };
      }
      return { status: 'error' as const, reason: 'split-non-empty requires MOYSKLAD_TO_BITRIX24 and an explicit value type', transform: 'split-non-empty' };
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

  async repinEvent(eventId: string, transaction?: Prisma.TransactionClient) {
    if (transaction) {
      await this.ensureInitialized(transaction);
      return this.repinEventInTransaction(transaction, eventId);
    }
    await this.ensureInitializedOnce();
    return this.database.$transaction((tx) => this.repinEventInTransaction(tx, eventId), { isolationLevel: 'Serializable' });
  }

  private async repinEventInTransaction(transaction: Prisma.TransactionClient, eventId: string) {
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
  }

  private ensureInitializedOnce(): Promise<void> {
    if (!this.acceptanceInitialization) {
      this.acceptanceInitialization = this.ensureInitialized().catch((error) => {
        this.acceptanceInitialization = null;
        throw error;
      });
    }
    return this.acceptanceInitialization;
  }

  private async ensureInitialized(transaction?: Prisma.TransactionClient) {
    const initialConfig = JSON.stringify(DEFAULT_FIELD_SETTINGS);
    const initialize = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`
        INSERT INTO "FieldSettingsVersion" ("version", "config")
        VALUES (1, ${initialConfig}::jsonb) ON CONFLICT ("version") DO NOTHING
      `;
      await tx.$executeRaw`
        INSERT INTO "FieldSettingsState" ("id", "version") VALUES ('global', 1)
        ON CONFLICT ("id") DO NOTHING
      `;
      await tx.$executeRaw`
        INSERT INTO "InboundEventSettings" ("eventId", "settingsVersion", "pinnedAt")
        SELECT "id", 1, "receivedAt" FROM "InboundEvent"
        ON CONFLICT ("eventId") DO NOTHING
      `;
    };
    if (transaction) await initialize(transaction);
    else await this.database.$transaction(initialize, { isolationLevel: 'Serializable' });
  }
}

function compatibleCatalogScalarTypes(bitrixType: string, moyskladType: string): boolean {
  const scalarFamily = (type: string) => {
    const normalized = type.trim().toLowerCase();
    if (['string', 'text', 'varchar'].includes(normalized)) return 'string';
    if (['double', 'number', 'decimal', 'float', 'integer', 'int'].includes(normalized)) return 'number';
    if (['boolean', 'bool'].includes(normalized)) return 'boolean';
    if (['datetime', 'date'].includes(normalized)) return 'datetime';
    // B24 char can represent flags, but its metadata does not establish that
    // a particular field is Boolean; require an explicit typed transform.
    return null;
  };
  const left = scalarFamily(bitrixType);
  const right = scalarFamily(moyskladType);
  return left !== null && left === right;
}

function validateRuleCompatibility(
  entity: string,
  rule: JsonRecord,
  direction: 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24',
  catalogs: { bitrix24: FieldCandidate[]; moysklad: FieldCandidate[] } | undefined,
) {
  const sourceSystem = direction === 'BITRIX24_TO_MOYSKLAD' ? 'bitrix24' : 'moysklad';
  const targetSystem = direction === 'BITRIX24_TO_MOYSKLAD' ? 'moysklad' : 'bitrix24';
  const sourceCode = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.sourceField : rule.targetField;
  const targetCode = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.targetField : rule.sourceField;
  const source = catalogs?.[sourceSystem].find((field) => field.code === sourceCode);
  const target = catalogs?.[targetSystem].find((field) => field.code === targetCode);
  const directionsKey = direction === 'BITRIX24_TO_MOYSKLAD' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
  const configured = rule[directionsKey];
  const transform = isRecord(configured) && isRecord(configured.transform) ? configured.transform : null;
  if (!source || !target || !transform) throw new BadRequestException('Enabled field mappings require complete source and target metadata');
  if (transform.kind === 'tbd') throw new BadRequestException(`Enabled field mapping ${String(sourceCode)} → ${String(targetCode)} needs an explicit transform`);
  const sourceCardinality = source.cardinality ?? 'unknown';
  const targetCardinality = target.cardinality ?? 'unknown';
  const sourceShape = source.shape ?? inferFieldShape(source.type);
  const targetShape = target.shape ?? inferFieldShape(target.type);
  const kind = transform.kind;
  if (kind === 'price-type-uuid') {
    const exactCompanyPriceTypePair = entity === 'companies'
      && source.referenceKind === 'pricetype' && target.referenceKind === 'pricetype'
      && sourceCardinality === 'single' && targetCardinality === 'single'
      && (direction === 'BITRIX24_TO_MOYSKLAD'
        ? sourceCode === 'UF_CRM_MS_PRICE_TYPE' && targetCode === 'priceType'
        : sourceCode === 'priceType' && targetCode === 'UF_CRM_MS_PRICE_TYPE');
    if (exactCompanyPriceTypePair) return;
    throw new BadRequestException('price-type-uuid is reserved for the single company price-type field and native MoySklad priceType');
  }
  if (kind === 'copy') {
    if (source.type !== target.type || sourceShape !== targetShape || sourceCardinality === 'unknown' || sourceCardinality !== targetCardinality) {
      throw new BadRequestException(`Copy requires exact type and cardinality compatibility for ${String(sourceCode)} → ${String(targetCode)}`);
    }
    return;
  }
  if (kind === 'string-to-number' && stringTypes.has(source.type.toLowerCase()) && (integerTypes.has(target.type.toLowerCase()) || decimalTypes.has(target.type.toLowerCase()))) {
    if (transform.numberType === 'integer' && !integerTypes.has(target.type.toLowerCase()) || transform.numberType === 'decimal' && !numberTypes.has(target.type.toLowerCase())) throw new BadRequestException('string-to-number policy does not match the target numeric field type');
    return;
  }
  if (kind === 'number-to-string' && numberTypes.has(source.type.toLowerCase()) && stringTypes.has(target.type.toLowerCase())) return;
  if (kind === 'date-to-datetime' && dateTypes.has(source.type.toLowerCase()) && dateTimeTypes.has(target.type.toLowerCase())) return;
  if (kind === 'datetime-to-date' && dateTimeTypes.has(source.type.toLowerCase()) && dateTypes.has(target.type.toLowerCase())) return;
  if (kind === 'boolean-map') {
    const sourceIsBoolean = booleanTypes.has(source.type.toLowerCase());
    const targetIsBoolean = booleanTypes.has(target.type.toLowerCase());
    const expectedOutputType = typeof transform.trueValue === 'boolean';
    if (sourceIsBoolean && (targetIsBoolean ? expectedOutputType : !expectedOutputType && stringTypes.has(target.type.toLowerCase()))) return;
    if (!sourceIsBoolean && booleanTypes.has(target.type.toLowerCase()) && expectedOutputType && (stringTypes.has(source.type.toLowerCase()) || source.type.toLowerCase() === 'char')) return;
  }
  if (kind === 'enum-map') {
    if (!enumTypes.has(source.type.toLowerCase()) || !enumTypes.has(target.type.toLowerCase())) throw new BadRequestException('enum-map requires enumeration fields on both sides');
    const pairs = transform.pairs as Array<{ source: string; target: string }>;
    if (!pairs.every((pair) => source.enumOptions?.some((option) => option.id === pair.source || option.value === pair.source) && target.enumOptions?.some((option) => option.id === pair.target || option.value === pair.target))) {
      throw new BadRequestException('enum-map values must exist in the source and target field option catalogs');
    }
    return;
  }
  if (kind === 'reference-map') {
    if (!source.referenceKind || !target.referenceKind || transform.resource !== source.referenceKind) throw new BadRequestException('reference-map requires confirmed reference metadata and the exact source resource');
    return;
  }
  if (kind === 'multiple-to-single') {
    if (sourceCardinality !== 'multiple' || targetCardinality !== 'single') throw new BadRequestException('multiple-to-single requires a multiple source and a single target');
    if (transform.strategy === 'join' && (!stringTypes.has(source.type.toLowerCase()) || !stringTypes.has(target.type.toLowerCase()))) throw new BadRequestException('multiple-to-single join requires string values on both sides');
    if (source.type !== target.type && transform.strategy !== 'join') throw new BadRequestException('multiple-to-single may not change the element type');
    return;
  }
  if (kind === 'single-to-multiple') {
    if (sourceCardinality !== 'single' || targetCardinality !== 'multiple' || source.type !== target.type) throw new BadRequestException('single-to-multiple requires matching element types and explicit single/multiple cardinality');
    return;
  }
  throw new BadRequestException(`Transform ${String(kind)} is not compatible with ${String(sourceCode)} → ${String(targetCode)} for ${entity}`);
}

function validateGroupCompatibility(entity: string, group: JsonRecord, catalogs: { bitrix24: FieldCandidate[]; moysklad: FieldCandidate[] } | undefined) {
  const b24ToMs = group.direction === 'BITRIX24_TO_MOYSKLAD';
  const sources = Array.isArray(group.sourceFields) ? group.sourceFields.map((code) => catalogs?.[b24ToMs ? 'bitrix24' : 'moysklad'].find((field) => field.code === code)) : [];
  const target = catalogs?.[b24ToMs ? 'moysklad' : 'bitrix24'].find((field) => field.code === group.targetField);
  if (!target || sources.some((field) => !field)) throw new BadRequestException('Field groups require complete source and target metadata');
  if (group.transform && isRecord(group.transform) && group.transform.kind === 'join-non-empty') {
    if (!stringTypes.has(target.type.toLowerCase()) || sources.some((field) => !stringTypes.has(field!.type.toLowerCase()) && !(field!.type === 'crm_multifield' && field!.cardinality === 'multiple'))) throw new BadRequestException('join-non-empty requires string-compatible source and target fields');
    return;
  }
  if (group.transform && isRecord(group.transform) && group.transform.kind === 'split-non-empty') {
    if (!stringTypes.has(sources[0]?.type.toLowerCase() ?? '') || target.type !== 'crm_multifield') throw new BadRequestException('split-non-empty requires a string source and a Bitrix24 multifield target');
    return;
  }
  throw new BadRequestException(`Field group shape is not supported for ${entity}`);
}

const integerTypes = new Set(['integer', 'int', 'long']);
const decimalTypes = new Set(['double', 'float', 'decimal', 'number']);
const numberTypes = new Set([...integerTypes, ...decimalTypes]);
const stringTypes = new Set(['string', 'text', 'url', 'char']);
const booleanTypes = new Set(['boolean', 'bool']);
const dateTypes = new Set(['date']);
const dateTimeTypes = new Set(['datetime', 'time']);
const enumTypes = new Set(['enum', 'enumeration', 'list']);

function inferFieldShape(type: string): FieldCandidate['shape'] {
  const normalized = type.toLowerCase();
  if (normalized === 'array') return 'array';
  if (normalized === 'object') return 'object';
  return normalized && normalized !== 'unknown' ? 'scalar' : 'unknown';
}

function serializeVersion(row: VersionRow): VersionedFieldSettingsDto {
  const config = normalizePersistedConfig(row.config);
  return {
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    config,
    references: config.references,
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
  const namedPairs = validateNamedPairs(references.namedPairs ?? []) as NamedReferencePair[];
  const serviceCounterpartyId = value.serviceCounterpartyId === undefined || value.serviceCounterpartyId === null || value.serviceCounterpartyId === ''
    ? null
    : isString(value.serviceCounterpartyId) && isUuid(value.serviceCounterpartyId)
      ? value.serviceCounterpartyId
      : (() => { throw new BadRequestException('serviceCounterpartyId must be a MoySklad counterparty UUID or empty'); })();
  const dealOrderRuntime = value.dealOrderRuntime === undefined ? undefined : validateDealOrderRuntime(value.dealOrderRuntime, namedPairs);
  const productCatalogRuntime = value.productCatalogRuntime === undefined ? undefined : validateProductCatalogRuntime(value.productCatalogRuntime);
  const rules = value.rules.map(validateRule);
  const groups = value.groups.map(validateGroup);
  const childBindingError = validateChildResourceBindings(value.childResourceBindings);
  if (childBindingError) throw new BadRequestException(childBindingError);
  assertUniqueIds(rules, 'Field rule');
  assertUniqueIds(groups, 'Field group');
  return { ...value, serviceCounterpartyId, productCatalogRuntime, dealOrderRuntime, rules, groups, references: { ...references, units, priceTypes, dictionaries, namedPairs } } as FieldSettingsConfig;
}

function validateProductCatalogRuntime(value: unknown): NonNullable<FieldSettingsConfigDto['productCatalogRuntime']> {
  if (!isRecord(value)) throw new BadRequestException('productCatalogRuntime must be an object');
  const catalogId = value.bitrix24CatalogId === undefined || value.bitrix24CatalogId === null || value.bitrix24CatalogId === ''
    ? null
    : isString(value.bitrix24CatalogId) && /^\d+$/.test(value.bitrix24CatalogId)
      ? value.bitrix24CatalogId
      : (() => { throw new BadRequestException('productCatalogRuntime.bitrix24CatalogId must be a numeric catalog ID or empty'); })();
  const sectionId = value.bitrix24DefaultSectionId === undefined || value.bitrix24DefaultSectionId === null || value.bitrix24DefaultSectionId === ''
    ? null
    : isString(value.bitrix24DefaultSectionId) && /^\d+$/.test(value.bitrix24DefaultSectionId)
      ? value.bitrix24DefaultSectionId
      : (() => { throw new BadRequestException('productCatalogRuntime.bitrix24DefaultSectionId must be a numeric section ID or empty'); })();
  const allowed = ['name', 'code', 'description'] as const;
  const fields = value.moyskladFields === undefined ? ['name'] : value.moyskladFields;
  if (!Array.isArray(fields) || fields.some((field) => !allowed.includes(field as typeof allowed[number])) || new Set(fields).size !== fields.length || (catalogId && !fields.includes('name'))) {
    throw new BadRequestException('productCatalogRuntime.moyskladFields must be unique supported fields and include name when a catalog is selected');
  }
  if (sectionId && !catalogId) throw new BadRequestException('A Bitrix24 default product section requires an explicitly selected product catalog');
  return { bitrix24CatalogId: catalogId, bitrix24DefaultSectionId: sectionId, moyskladFields: fields as Array<'name' | 'code' | 'description'> };
}

function validateDealOrderRuntime(value: unknown, namedPairs: NamedReferencePair[]): NonNullable<FieldSettingsConfigDto['dealOrderRuntime']> {
  if (!isRecord(value) || typeof value.nativeOrderNumberingVerified !== 'boolean' || !Array.isArray(value.currencies) || !Array.isArray(value.stages) || !Array.isArray(value.organizations) || !Array.isArray(value.stores) || !Array.isArray(value.employees)) {
    throw new BadRequestException('dealOrderRuntime must include confirmed currency, stage, organization, store, and employee mappings');
  }
  const unmappedReferencePolicy = value.unmappedReferencePolicy;
  const unmappedStagePolicy = value.unmappedStagePolicy;
  if (unmappedStagePolicy !== undefined && unmappedStagePolicy !== 'hold' && unmappedStagePolicy !== 'preserve-and-warn') {
    throw new BadRequestException('unmappedStagePolicy must be hold or preserve-and-warn');
  }
  if (unmappedReferencePolicy !== undefined && unmappedReferencePolicy !== 'hold' && unmappedReferencePolicy !== 'confirmed-defaults') {
    throw new BadRequestException('unmappedReferencePolicy must be hold or confirmed-defaults');
  }
  const id = (candidate: unknown) => isString(candidate) && isUuid(candidate);
  const productCatalogId = value.bitrix24ProductCatalogId === undefined || value.bitrix24ProductCatalogId === null || value.bitrix24ProductCatalogId === ''
    ? null
    : isString(value.bitrix24ProductCatalogId) && /^\d+$/.test(value.bitrix24ProductCatalogId)
      ? value.bitrix24ProductCatalogId
      : (() => { throw new BadRequestException('bitrix24ProductCatalogId must be a numeric Bitrix24 catalog ID or empty'); })();
  const productSectionId = value.bitrix24DefaultProductSectionId === undefined || value.bitrix24DefaultProductSectionId === null || value.bitrix24DefaultProductSectionId === ''
    ? null
    : isString(value.bitrix24DefaultProductSectionId) && /^\d+$/.test(value.bitrix24DefaultProductSectionId)
      ? value.bitrix24DefaultProductSectionId
      : (() => { throw new BadRequestException('bitrix24DefaultProductSectionId must be a numeric Bitrix24 section ID or empty'); })();
  if (productSectionId && !productCatalogId) throw new BadRequestException('A Bitrix24 default product section requires an explicitly selected product catalog');
  const allowedProductFields = ['name', 'code', 'description'] as const;
  const moyskladProductFields = value.moyskladProductFields === undefined ? ['name'] : value.moyskladProductFields;
  if (!Array.isArray(moyskladProductFields) || moyskladProductFields.some((field) => !allowedProductFields.includes(field as typeof allowedProductFields[number])) || new Set(moyskladProductFields).size !== moyskladProductFields.length || (productCatalogId && !moyskladProductFields.includes('name'))) {
    throw new BadRequestException('moyskladProductFields must be unique supported product fields and include name when a catalog is selected');
  }
  const pairs = (items: unknown[], label: string) => {
    const seen = new Set<string>();
    return items.map((item) => {
      if (!isRecord(item) || !isString(item.bitrix24Id) || !item.bitrix24Id.trim() || !id(item.moyskladId)) throw new BadRequestException(`${label} mapping is invalid`);
      const key = item.bitrix24Id.trim();
      if (seen.has(key)) throw new BadRequestException(`${label} source mapping is duplicated`);
      seen.add(key);
      return { bitrix24Id: key, moyskladId: item.moyskladId as string };
    });
  };
  const currencies = value.currencies.map((item: unknown) => {
    if (!isRecord(item) || !isString(item.bitrix24Code) || !item.bitrix24Code.trim() || !id(item.moyskladId)) throw new BadRequestException('Currency mapping is invalid');
    return { bitrix24Code: item.bitrix24Code.trim(), moyskladId: item.moyskladId as string };
  });
  const stages = value.stages.map((item: unknown) => {
    if (!isRecord(item) || !isString(item.bitrix24StageId) || !item.bitrix24StageId.trim() || !id(item.moyskladId) || typeof item.creationEnabled !== 'boolean') throw new BadRequestException('Deal stage mapping is invalid');
    return { bitrix24StageId: item.bitrix24StageId.trim(), moyskladId: item.moyskladId as string, creationEnabled: item.creationEnabled };
  });
  let stageTransitions: NonNullable<FieldSettingsConfigDto['dealOrderRuntime']>['stageTransitions'];
  if (value.stageTransitions !== undefined) {
    if (!isRecord(value.stageTransitions)) throw new BadRequestException('Stage transitions must contain both directional maps');
    const parse = (rows: unknown, source: 'bitrix24StageId' | 'moyskladId') => {
      if (!Array.isArray(rows)) throw new BadRequestException('Stage transitions must contain both directional maps');
      const seen = new Set<string>();
      return rows.map(row => {
        if (!isRecord(row) || typeof row.bitrix24StageId !== 'string' || !/^(?:C[1-9]\d*:)?[A-Z0-9_]+$/.test(row.bitrix24StageId) || !id(row.moyskladId)) throw new BadRequestException('Stage transition is invalid');
        const pair = { bitrix24StageId: row.bitrix24StageId, moyskladId: row.moyskladId as string };
        if (seen.has(pair[source])) throw new BadRequestException('Stage transition source is duplicated in its direction');
        seen.add(pair[source]);
        return pair;
      });
    };
    stageTransitions = {
      bitrix24ToMoysklad: parse(value.stageTransitions.bitrix24ToMoysklad, 'bitrix24StageId'),
      moyskladToBitrix24: parse(value.stageTransitions.moyskladToBitrix24, 'moyskladId'),
    };
  }
  const organizations = pairs(value.organizations, 'Organization');
  const stores = pairs(value.stores, 'Store');
  const employees = pairs(value.employees, 'Employee');
  for (const [items, key, label] of [[currencies, 'bitrix24Code', 'Currency'], [stages, 'bitrix24StageId', 'Deal stage']] as Array<[Array<Record<string, unknown>>, string, string]>) {
    const seen = new Set<string>();
    for (const item of items) {
      const value = String(item[key]);
      if (seen.has(value)) throw new BadRequestException(`${label} source mapping is duplicated`);
      seen.add(value);
    }
  }
  if (!id(value.defaultOrganizationId) || !id(value.defaultStoreId) || !id(value.defaultEmployeeId) || (value.defaultProductGroupId != null && !id(value.defaultProductGroupId))) throw new BadRequestException('Default deal-order references must be UUIDs');
  const confirmed = (kind: NamedReferenceKind, sourceId: string, targetId: string) => namedPairs.some((pair) => pair.kind === kind && pair.bitrix24Id === sourceId && pair.moyskladId === targetId && pair.status === 'confirmed');
  for (const item of currencies) if (!confirmed('currencies', item.bitrix24Code, item.moyskladId)) throw new BadRequestException(`Currency ${item.bitrix24Code} must be a confirmed named reference`);
  for (const item of stages) if (!confirmedDealStageReference(item.bitrix24StageId, item.moyskladId, namedPairs)) throw new BadRequestException(`Deal stage ${item.bitrix24StageId} must resolve to one confirmed named reference`);
  if (unmappedReferencePolicy === 'confirmed-defaults') {
    const preparationStages = stages.filter((item) =>
      (item.bitrix24StageId === 'PREPARATION' || item.bitrix24StageId === '0:PREPARATION') &&
      item.creationEnabled && confirmedDealStageReference(item.bitrix24StageId, item.moyskladId, namedPairs));
    if (preparationStages.length !== 1) {
      throw new BadRequestException('confirmed-defaults requires exactly one confirmed creation-enabled PREPARATION stage');
    }
  }
  for (const item of organizations) if (!confirmed('organizations', item.bitrix24Id, item.moyskladId)) throw new BadRequestException(`Organization ${item.bitrix24Id} must be a confirmed named reference`);
  for (const item of stores) if (!confirmed('warehouses', item.bitrix24Id, item.moyskladId)) throw new BadRequestException(`Store ${item.bitrix24Id} must be a confirmed warehouse named reference`);
  for (const item of employees) if (!confirmed('employees', item.bitrix24Id, item.moyskladId)) throw new BadRequestException(`Employee ${item.bitrix24Id} must be a confirmed named reference`);
  if (!namedPairs.some((pair) => pair.kind === 'organizations' && pair.moyskladId === value.defaultOrganizationId && pair.status === 'confirmed') ||
      !namedPairs.some((pair) => pair.kind === 'warehouses' && pair.moyskladId === value.defaultStoreId && pair.status === 'confirmed') ||
      !namedPairs.some((pair) => pair.kind === 'employees' && pair.moyskladId === value.defaultEmployeeId && pair.status === 'confirmed')) {
    throw new BadRequestException('Default organization, store, and employee must be confirmed named references');
  }
  return { nativeOrderNumberingVerified: value.nativeOrderNumberingVerified, ...(unmappedReferencePolicy === undefined ? {} : { unmappedReferencePolicy }), ...(unmappedStagePolicy === undefined ? {} : { unmappedStagePolicy }), ...(stageTransitions === undefined ? {} : { stageTransitions }), bitrix24ProductCatalogId: productCatalogId, bitrix24DefaultProductSectionId: productSectionId, moyskladProductFields, defaultOrganizationId: value.defaultOrganizationId as string, defaultStoreId: value.defaultStoreId as string, defaultEmployeeId: value.defaultEmployeeId as string, defaultProductGroupId: (value.defaultProductGroupId ?? null) as string | null, currencies, stages, organizations, stores, employees };
}

function assertUniqueIds(items: unknown[], label: string) {
  const seen = new Set<string>();
  for (const item of items) {
    const id = isRecord(item) && isString(item.id) ? item.id : '';
    if (seen.has(id)) throw new BadRequestException(`${label} ID ${id} is duplicated`);
    seen.add(id);
  }
}

function validateNamedPairs(value: unknown) {
  const kinds = new Set<NamedReferenceKind>(['employees', 'currencies', 'organizations', 'warehouses', 'projects', 'dealStages']);
  if (!Array.isArray(value)) throw new BadRequestException('references.namedPairs must be an array');
  const sources = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate) || !isString(candidate.kind) || !kinds.has(candidate.kind as NamedReferenceKind) || !isString(candidate.bitrix24Id) || !isString(candidate.bitrix24Label) || !(candidate.moyskladId === null || isString(candidate.moyskladId)) || !(candidate.moyskladLabel === null || isString(candidate.moyskladLabel)) || !['suggested', 'confirmed', 'unmapped'].includes(String(candidate.status))) {
      throw new BadRequestException('Each named reference pair needs a supported kind, source, target, labels, and status');
    }
    const key = `${candidate.kind}:${candidate.bitrix24Id}`;
    if (sources.has(key)) throw new BadRequestException(`Named reference ${key} is duplicated`);
    sources.add(key);
    if (candidate.status === 'confirmed' && !candidate.moyskladId) throw new BadRequestException(`Named reference ${key} cannot be confirmed without a MySklad ID`);
    return candidate;
  });
}

function normalizeReferenceLabel(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
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

export function validateUnits(value: unknown) {
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
    if (candidate.reverseMoyskladIds !== undefined) {
      if (!targetId || !Array.isArray(candidate.reverseMoyskladIds)) throw new BadRequestException('Reverse units require a configured canonical unit and an array');
      for (const id of candidate.reverseMoyskladIds) {
        if (typeof id !== 'string' || !isUuid(id)) throw new BadRequestException('Each reverse MySklad unit must be a UUID');
        if (seenTargets.has(id)) throw new BadRequestException('A MySklad unit can only be assigned once, including reverse units');
        seenTargets.add(id);
      }
    }
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
  const criticality = validateCriticality(value.criticality);
  const bitrix24ToMoysklad = validateDirection(value.bitrix24ToMoysklad);
  const moyskladToBitrix24 = validateDirection(value.moyskladToBitrix24);
  return { ...value, bitrix24ToMoysklad, moyskladToBitrix24, criticality };
}

function validateGroup(value: unknown) {
  if (!isRecord(value) || !isString(value.id) || !isString(value.entity) || !isString(value.targetField) || !Array.isArray(value.sourceFields) || value.sourceFields.length === 0 || value.sourceFields.some((field) => !isString(field))) {
    throw new BadRequestException('Each field group needs an ID, entity, target field, and source field codes');
  }
  if (value.direction !== 'BITRIX24_TO_MOYSKLAD' && value.direction !== 'MOYSKLAD_TO_BITRIX24') {
    throw new BadRequestException('Field group direction is invalid');
  }
  if (!isRecord(value.transform) || typeof value.transform.separator !== 'string' || value.transform.separator.length === 0) {
    throw new BadRequestException('Field groups require a supported transform and separator');
  }
  if (value.transform.kind === 'split-non-empty') {
    if (value.direction !== 'MOYSKLAD_TO_BITRIX24') throw new BadRequestException('split-non-empty must target Bitrix24');
    if (!isString(value.transform.valueType) || !value.transform.valueType.trim()) throw new BadRequestException('split-non-empty requires an explicit valueType');
    if (!['contact', 'company', 'contacts', 'companies', 'contacts-companies'].includes(value.entity) || !['PHONE', 'EMAIL'].includes(value.targetField)) {
      throw new BadRequestException('split-non-empty only supports Bitrix24 company/contact PHONE or EMAIL fields');
    }
    const allowedValueTypes = value.targetField === 'PHONE'
      ? ['WORK', 'MOBILE', 'FAX', 'HOME', 'PAGER', 'MAILING', 'OTHER']
      : ['WORK', 'HOME', 'MAILING', 'OTHER'];
    if (!allowedValueTypes.includes(value.transform.valueType)) {
      throw new BadRequestException(`VALUE_TYPE ${value.transform.valueType} is not documented for Bitrix24 ${value.targetField}`);
    }
  } else if (value.transform.kind !== 'join-non-empty') throw new BadRequestException('Field group transform is unsupported');
  return { ...value, criticality: validateCriticality(value.criticality) };
}

function validateCriticality(value: unknown): 'critical' | 'optional' | 'tbd' {
  if (value === undefined) return 'tbd';
  if (value !== 'critical' && value !== 'optional' && value !== 'tbd') {
    throw new BadRequestException('Field criticality must be critical, optional, or tbd');
  }
  return value;
}

function normalizePersistedConfig(config: FieldSettingsConfigDto): FieldSettingsConfigDto {
  return {
    ...config,
    rules: config.rules.map((rule) => ({ ...rule, criticality: validateCriticality(rule.criticality) })),
    groups: config.groups.map((group) => ({ ...group, criticality: validateCriticality(group.criticality) })),
  };
}

function fieldRuleRiskChanges(before: FieldSettingsConfigDto, after: FieldSettingsConfigDto): string[] {
  const previous = new Map(before.rules.map((rule) => [rule.id, rule]));
  const next = new Map(after.rules.map((rule) => [rule.id, rule]));
  const changes: string[] = [];
  for (const [id, oldRule] of previous) {
    const newRule = next.get(id);
    if (!newRule) {
      changes.push(`removed ${oldRule.entity}:${oldRule.sourceField} → ${oldRule.targetField}`);
      continue;
    }
    if (oldRule.entity !== newRule.entity || oldRule.sourceField !== newRule.sourceField || oldRule.targetField !== newRule.targetField) {
      changes.push(`key changed ${oldRule.entity}:${oldRule.sourceField} → ${oldRule.targetField} to ${newRule.entity}:${newRule.sourceField} → ${newRule.targetField}`);
    }
    if (oldRule.bitrix24ToMoysklad.enabled !== newRule.bitrix24ToMoysklad.enabled || oldRule.moyskladToBitrix24.enabled !== newRule.moyskladToBitrix24.enabled) {
      changes.push(`direction changed for ${newRule.entity}:${newRule.sourceField} → ${newRule.targetField}`);
    }
  }
  for (const [id, newRule] of next) if (!previous.has(id)) changes.push(`added ${newRule.entity}:${newRule.sourceField} → ${newRule.targetField}`);
  const oldGroups = new Map(before.groups.map((group) => [group.id, group]));
  const newGroups = new Map(after.groups.map((group) => [group.id, group]));
  for (const [id, oldGroup] of oldGroups) {
    const newGroup = newGroups.get(id);
    if (!newGroup) {
      changes.push(`removed group ${oldGroup.entity}:${oldGroup.sourceFields.join('+')} → ${oldGroup.targetField}`);
      continue;
    }
    if (oldGroup.entity !== newGroup.entity || oldGroup.targetField !== newGroup.targetField || oldGroup.sourceFields.join('\0') !== newGroup.sourceFields.join('\0')) {
      changes.push(`group key changed ${oldGroup.entity}:${oldGroup.sourceFields.join('+')} → ${oldGroup.targetField}`);
    }
    if (oldGroup.direction !== newGroup.direction) changes.push(`group direction changed for ${newGroup.entity}:${newGroup.sourceFields.join('+')} → ${newGroup.targetField}`);
  }
  for (const [id, newGroup] of newGroups) if (!oldGroups.has(id)) changes.push(`added group ${newGroup.entity}:${newGroup.sourceFields.join('+')} → ${newGroup.targetField}`);
  if (JSON.stringify(before.childResourceBindings ?? []) !== JSON.stringify(after.childResourceBindings ?? [])) {
    changes.push('company requisite/bank child-resource bindings changed');
  }
  return changes;
}

function validateDirection(value: unknown): { enabled: boolean; transform: FieldTransform } {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !isRecord(value.transform)) {
    throw new BadRequestException('Each direction needs an enabled flag and a supported transform');
  }
  return { enabled: value.enabled, transform: validateFieldTransform(value.transform) };
}

function validateFieldTransform(value: JsonRecord): FieldTransform {
  const kind = value.kind;
  if (kind === 'copy' || kind === 'tbd' || kind === 'price-type-uuid') return { kind };
  if (kind === 'string-to-number') {
    if (!['integer', 'decimal'].includes(String(value.numberType)) || value.precision !== undefined && (!Number.isInteger(value.precision) || Number(value.precision) < 0 || Number(value.precision) > 15) ||
      value.min !== undefined && (typeof value.min !== 'number' || !Number.isFinite(value.min)) || value.max !== undefined && (typeof value.max !== 'number' || !Number.isFinite(value.max)) ||
      value.leadingZeros !== undefined && !['reject', 'allow'].includes(String(value.leadingZeros))) throw new BadRequestException('string-to-number requires a number type and valid precision/range policy');
    if (typeof value.min === 'number' && typeof value.max === 'number' && value.min > value.max) throw new BadRequestException('string-to-number minimum cannot exceed its maximum');
    return { kind, numberType: value.numberType as 'integer' | 'decimal', ...(typeof value.precision === 'number' ? { precision: value.precision } : {}), ...(typeof value.min === 'number' ? { min: value.min } : {}), ...(typeof value.max === 'number' ? { max: value.max } : {}), leadingZeros: value.leadingZeros === 'allow' ? 'allow' : 'reject' };
  }
  if (kind === 'number-to-string') {
    if (value.precision !== undefined && (!Number.isInteger(value.precision) || Number(value.precision) < 0 || Number(value.precision) > 15)) throw new BadRequestException('number-to-string precision must be an integer between 0 and 15');
    return { kind, ...(typeof value.precision === 'number' ? { precision: value.precision } : {}) };
  }
  if (kind === 'date-to-datetime') {
    if (!isString(value.timeZone)) throw new BadRequestException('date-to-datetime requires an explicit time zone');
    try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(0); } catch { throw new BadRequestException('date-to-datetime timeZone must be a valid IANA time zone'); }
    if (value.time !== undefined && (!isString(value.time) || !/^\d{2}:\d{2}:\d{2}$/.test(value.time))) throw new BadRequestException('date-to-datetime time must use HH:mm:ss');
    return { kind, timeZone: value.timeZone, ...(typeof value.time === 'string' ? { time: value.time } : {}) };
  }
  if (kind === 'datetime-to-date') {
    if (!isString(value.timeZone)) throw new BadRequestException('datetime-to-date requires an explicit time zone');
    try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(0); } catch { throw new BadRequestException('datetime-to-date timeZone must be a valid IANA time zone'); }
    return { kind, timeZone: value.timeZone };
  }
  if (kind === 'boolean-map') {
    const allowed = [true, false, 'Y', 'N', '1', '0'];
    if (!allowed.includes(value.trueValue as boolean | 'Y' | 'N' | '1' | '0') || !allowed.includes(value.falseValue as boolean | 'Y' | 'N' | '1' | '0') || value.trueValue === value.falseValue) throw new BadRequestException('boolean-map requires distinct true and false target values');
    if (typeof value.trueValue !== typeof value.falseValue) throw new BadRequestException('boolean-map true and false values must use the same target type');
    return { kind, trueValue: value.trueValue as boolean | 'Y' | 'N' | '1' | '0', falseValue: value.falseValue as boolean | 'Y' | 'N' | '1' | '0' };
  }
  if (kind === 'enum-map' || kind === 'reference-map') {
    const resource = kind === 'reference-map' ? value.resource : undefined;
    if (kind === 'reference-map' && !isString(resource)) throw new BadRequestException('reference-map requires a reference resource');
    if (!Array.isArray(value.pairs) || !value.pairs.length || value.pairs.some((pair) => !isRecord(pair) || !isString(pair.source) || !isString(pair.target))) throw new BadRequestException(`${kind} requires explicit source and target value pairs`);
    const pairs = value.pairs as Array<{ source: string; target: string }>;
    if (new Set(pairs.map((pair) => pair.source)).size !== pairs.length || new Set(pairs.map((pair) => pair.target)).size !== pairs.length) throw new BadRequestException(`${kind} pairs must be one-to-one`);
    return kind === 'enum-map' ? { kind, pairs: pairs.map(({ source, target }) => ({ source, target })) } : { kind, resource: resource as string, pairs: pairs.map(({ source, target }) => ({ source, target })) };
  }
  if (kind === 'multiple-to-single') {
    if (!['only', 'first', 'join'].includes(String(value.strategy))) throw new BadRequestException('multiple-to-single requires an explicit only, first, or join policy');
    if (value.strategy === 'join' && typeof value.separator !== 'string') throw new BadRequestException('multiple-to-single join requires an explicit separator');
    return { kind, strategy: value.strategy as 'only' | 'first' | 'join', ...(typeof value.separator === 'string' ? { separator: value.separator } : {}) };
  }
  if (kind === 'single-to-multiple') return { kind };
  throw new BadRequestException('Field transform kind is unsupported');
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
  const transformed = applyGroupTransform(group, sample, String(group.direction));
  return [{
    sampleIndex,
    field: group.targetField,
    source: Object.fromEntries(fields.map((field) => [field, sample[field] ?? null])),
    value: transformed.value,
    ...(transformed.error ? { error: transformed.error } : {}),
    direction: group.direction,
    transform: group.transform.kind,
    writes: 0,
  }];
}

function applyFieldSettings(config: unknown, entity: string, source: JsonRecord, direction: string): Record<string, { value: unknown; status: 'mapped' | 'skip' | 'error'; reason?: string; error?: string; transform: string }> {
  const result: Record<string, { value: unknown; status: 'mapped' | 'skip' | 'error'; reason?: string; error?: string; transform: string }> = {};
  if (!isRecord(config)) return result;
  const ruleDirection = direction === 'BITRIX24_TO_MOYSKLAD' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
  for (const rule of Array.isArray(config.rules) ? config.rules : []) {
    if (!isRecord(rule) || !sameClientFieldEntity(rule.entity, entity) || !isString(rule.sourceField) || !isString(rule.targetField)) continue;
    const mapping = rule[ruleDirection];
    if (!isRecord(mapping) || mapping.enabled !== true || !isRecord(mapping.transform)) continue;
    const sourceField = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.sourceField : rule.targetField;
    const targetField = direction === 'BITRIX24_TO_MOYSKLAD' ? rule.targetField : rule.sourceField;
    const value = source[sourceField];
    const transformed = applyFieldTransform(mapping.transform as unknown as FieldTransform, value);
    result[targetField] = { value: transformed.status === 'mapped' ? transformed.value : null, status: transformed.status, ...(transformed.status === 'error' ? { error: transformed.reason } : {}), ...(transformed.status === 'skip' ? { reason: transformed.reason } : {}), transform: transformed.transform };
  }
  for (const group of Array.isArray(config.groups) ? config.groups : []) {
    if (!isRecord(group) || !sameClientFieldEntity(group.entity, entity) || group.direction !== direction || !isString(group.targetField) || !Array.isArray(group.sourceFields) || !isRecord(group.transform)) continue;
    const fields = group.sourceFields.filter(isString);
    if (typeof group.transform.separator !== 'string') {
      result[group.targetField] = { value: null, status: 'error', error: 'transform is not supported', transform: String(group.transform.kind) };
      continue;
    }
    const transformed = applyGroupTransform(group, source, direction);
    result[group.targetField] = { ...transformed, status: transformed.error ? 'error' : 'mapped' };
  }
  return result;
}

function applyGroupTransform(group: JsonRecord, source: JsonRecord, direction: string): { value: unknown; error?: string; transform: string } {
  const fields = Array.isArray(group.sourceFields) ? group.sourceFields.filter(isString) : [];
  const transform = group.transform;
  if (!isRecord(transform) || typeof transform.separator !== 'string' || transform.separator.length === 0) return { value: null, error: 'transform is not supported', transform: 'unsupported' };
  if (transform.kind === 'join-non-empty') {
    const values: string[] = [];
    for (const field of fields) {
      const raw = source[field];
      const parts = Array.isArray(raw) ? raw.map((entry) => isRecord(entry) ? entry.VALUE : entry) : [raw];
      for (const part of parts) {
        if (part === undefined || part === null || part === '') continue;
        if (typeof part !== 'string') return { value: null, error: 'join-non-empty accepts string values only', transform: 'join-non-empty' };
        const normalized = part.trim();
        if (normalized) values.push(normalized);
      }
    }
    return { value: values.join(transform.separator), transform: 'join-non-empty' };
  }
  if (transform.kind === 'split-non-empty' && direction === 'MOYSKLAD_TO_BITRIX24' && isString(transform.valueType) && transform.valueType.trim()) {
    const rawValues = fields.map((field) => source[field]);
    if (rawValues.some((raw) => raw !== undefined && raw !== null && typeof raw !== 'string')) return { value: null, error: 'split-non-empty accepts string values only', transform: 'split-non-empty' };
    const values = splitValues(rawValues, transform.separator);
    return { value: values.map((VALUE) => ({ VALUE, VALUE_TYPE: transform.valueType })), transform: 'split-non-empty' };
  }
  return { value: null, error: 'split-non-empty requires MOYSKLAD_TO_BITRIX24 and an explicit value type', transform: 'split-non-empty' };
}

function splitValues(values: unknown[], separator: string) {
  return values.flatMap((raw) => raw == null ? [] : typeof raw === 'string' ? raw.split(separator).map((part) => part.trim()).filter(Boolean) : []);
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
    case 'smart-invoices': return 'INVOICE';
    case 'catalog': return 'PRODUCT';
    default: throw new BadRequestException('This entity type has no field metadata provider');
  }
}

