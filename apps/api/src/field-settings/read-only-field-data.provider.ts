import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DEFAULT_FIELD_SETTINGS } from './approved-mappings';

export type CatalogCandidate = { id: string; code: string; label: string };
export type LiveFieldCatalogs = {
  units: { bitrix24: CatalogCandidate[]; moysklad: CatalogCandidate[] };
  priceTypes: { bitrix24: CatalogCandidate[]; moysklad: CatalogCandidate[] };
  productCatalogs: CatalogCandidate[];
};
export type NamedReferenceItem = { id: string; code: string; label: string; group?: string };
export type LiveReferenceCatalogs = Record<'employees' | 'currencies' | 'organizations' | 'warehouses' | 'projects' | 'dealStages', { bitrix24: NamedReferenceItem[]; moysklad: NamedReferenceItem[] }>;
export type PairSnapshot = {
  sourceLabel: string;
  sourceValues: Record<string, unknown>;
  targetCurrent: Record<string, unknown>;
};
export type FieldEnumOption = { id: string; value: string };
export type FieldCandidate = {
  code: string;
  title: string;
  type: string;
  writable: boolean | null;
  writableEvidence?: 'provider-schema' | 'local-standard-schema' | 'unconfirmed';
  category: 'standard' | 'custom';
  cardinality?: 'single' | 'multiple' | 'unknown';
  shape?: 'scalar' | 'object' | 'array' | 'unknown';
  enumOptions?: FieldEnumOption[];
  referenceKind?: string;
  resource?: 'product' | 'service' | 'product-or-service';
  reserved?: string;
};

const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class ReadOnlyFieldDataProvider {
  async dealOrderCatalogs(bitrixAccessToken: string, direction: 'bitrix24ToMoysklad' | 'moyskladToBitrix24'): Promise<{ stages: string[]; currencies: string[] }> {
    if (direction === 'bitrix24ToMoysklad') {
      const [currencies, stages] = await Promise.all([
        this.bitrixList(bitrixAccessToken, 'crm.currency.list'),
        this.bitrixDealStages(bitrixAccessToken),
      ]);
      return { stages: stages.map((item) => item.id), currencies: currencies.map((row) => text(row.CURRENCY)).filter(Boolean) };
    }
    const [currencies, stages] = await Promise.all([
      this.moyskladList('/entity/currency'),
      this.moyskladOrderStates(),
    ]);
    return {
      stages: stages.map((row) => text(row.id)).filter(Boolean),
      currencies: currencies.map((row) => text(row.id)).filter(Boolean),
    };
  }

  async optionalDealOrderReferenceWarnings(bitrixAccessToken: string): Promise<string[]> {
    const checks: Array<[string, Promise<unknown>]> = [['projects', this.moyskladList('/entity/project')]];
    const results = await Promise.allSettled(checks.map(([, request]) => request));
    return results.flatMap((result, index) => result.status === 'rejected' ? [checks[index]![0]] : []);
  }

  async verifyRequiredDealOrderReferences(config: Record<string, unknown> | undefined): Promise<string[]> {
    const runtime = isRecord(config?.dealOrderRuntime) ? config.dealOrderRuntime : {};
    const targets: Array<{ type: 'organization' | 'store' | 'employee'; id: string; label: string }> = [
      { type: 'organization', id: text(runtime.defaultOrganizationId), label: 'default organization' },
      { type: 'store', id: text(runtime.defaultStoreId), label: 'default store' },
      { type: 'employee', id: text(runtime.defaultEmployeeId), label: 'default employee' },
    ];
    for (const [field, type, label] of [
      ['organizations', 'organization', 'organization mapping'],
      ['stores', 'store', 'store mapping'],
      ['employees', 'employee', 'employee mapping'],
    ] as const) {
      const pairs = Array.isArray(runtime[field]) ? runtime[field] : [];
      for (const pair of pairs) if (isRecord(pair) && typeof pair.moyskladId === 'string') {
        targets.push({ type, id: pair.moyskladId, label });
      }
    }
    const uniqueTargets = [...new Map(targets.filter((target) => target.id).map((target) => [`${target.type}:${target.id}`, target])).values()];
    const checks = await Promise.all(uniqueTargets.map(async (target) => {
      try {
        const record = await this.moyskladGet(`/entity/${target.type}/${encodeURIComponent(target.id)}`);
        if (isRecord(record) && record.id === target.id && isRecord(record.meta) && record.meta.type === target.type) return null;
      } catch { /* A selected value that cannot be verified is unsafe for writes. */ }
      return target.label;
    }));
    return [...new Set(checks.filter((label): label is string => label !== null))];
  }

  async productCatalogReadiness(bitrixAccessToken: string): Promise<{ units: string[]; productCatalogs: string[] }> {
    const [moyskladUnits, catalogPayload] = await Promise.all([
      this.moyskladList('/entity/uom'),
      this.bitrixCall(bitrixAccessToken, 'catalog.catalog.list', {}),
    ]);
    const catalogRoot = asRecord(catalogPayload);
    const catalogRows = Array.isArray(catalogRoot.catalogs) ? catalogRoot.catalogs : Array.isArray(catalogPayload) ? catalogPayload : [];
    return {
      units: moyskladUnits.map((row) => text(row.id)).filter(Boolean),
      productCatalogs: catalogRows.filter(isRecord).flatMap((row) => {
        const id = row.id;
        return (typeof id === 'string' || typeof id === 'number') && /^\d+$/.test(String(id)) ? [String(id)] : [];
      }),
    };
  }

  async referenceCatalogs(bitrixAccessToken: string): Promise<LiveReferenceCatalogs> {
    const [users, currencies, organizations, warehouses, projects, stages, msEmployees, msCurrencies, msOrganizations, msWarehouses, msProjects, msStates] = await Promise.all([
      this.bitrixList(bitrixAccessToken, 'user.get'),
      this.bitrixList(bitrixAccessToken, 'crm.currency.list'),
      this.bitrixListElements(bitrixAccessToken, '88'),
      this.bitrixListElements(bitrixAccessToken, '38'),
      this.bitrixListElements(bitrixAccessToken, '34'),
      this.bitrixDealStages(bitrixAccessToken),
      this.moyskladList('/entity/employee'),
      this.moyskladList('/entity/currency'),
      this.moyskladList('/entity/organization'),
      this.moyskladList('/entity/store'),
      this.moyskladList('/entity/project'),
      this.moyskladOrderStates(),
    ]);
    return {
      employees: { bitrix24: users.map((row) => named(row, row.ID, `${row.NAME ?? ''} ${row.SECOND_NAME ?? ''} ${row.LAST_NAME ?? ''}`.trim())), moysklad: msEmployees.map((row) => named(row, row.id, row.shortFio ?? row.fullName ?? `${row.name ?? ''} ${row.lastName ?? ''}`.trim())) },
      currencies: { bitrix24: currencies.map((row) => named(row, row.CURRENCY, row.FULL_NAME ?? row.FORMAT_STRING ?? row.CURRENCY)), moysklad: msCurrencies.map((row) => named(row, row.id, row.name, row.code)) },
      organizations: { bitrix24: organizations.map((row) => named(row, row.ID ?? row.id, row.NAME ?? row.name)), moysklad: msOrganizations.map((row) => named(row, row.id, row.name)) },
      warehouses: { bitrix24: warehouses.map((row) => named(row, row.ID ?? row.id, row.NAME ?? row.name)), moysklad: msWarehouses.map((row) => named(row, row.id, row.name)) },
      projects: { bitrix24: projects.map((row) => named(row, row.ID ?? row.id, row.NAME ?? row.name)), moysklad: msProjects.map((row) => named(row, row.id, row.name, row.code)) },
      dealStages: { bitrix24: stages, moysklad: msStates.map((row) => named(row, row.id, row.name)) },
    };
  }

  async catalogs(bitrixAccessToken: string): Promise<LiveFieldCatalogs> {
    const [b24Units, b24Prices, msUnits, msPrices, catalogPayload] = await Promise.all([
      this.bitrixList(bitrixAccessToken, 'catalog.measure.list'),
      this.bitrixList(bitrixAccessToken, 'catalog.priceType.list'),
      this.moyskladList('/entity/uom'),
      this.moyskladList('/context/companysettings/pricetype'),
      this.bitrixCall(bitrixAccessToken, 'catalog.catalog.list', {}),
    ]);
    const catalogRoot = asRecord(catalogPayload);
    const catalogRows = Array.isArray(catalogRoot.catalogs) ? catalogRoot.catalogs : Array.isArray(catalogPayload) ? catalogPayload : [];
    return {
      units: {
        bitrix24: b24Units.map((row) => ({ id: text(row.id), code: text(row.code ?? row.symbolIntl ?? row.symbol), label: text(row.name ?? row.title ?? row.symbolIntl ?? row.code) })),
        moysklad: msUnits.map((row) => ({ id: text(row.id), code: text(row.code), label: text(row.name ?? row.code) })),
      },
      priceTypes: {
        bitrix24: b24Prices.map((row) => ({ id: text(row.id), code: text(row.xmlId ?? row.code ?? row.name), label: text(row.name ?? row.code) })),
        moysklad: msPrices.map((row) => ({ id: text(row.id), code: text(row.externalCode ?? row.name), label: text(row.name) })),
      },
      productCatalogs: catalogRows.filter(isRecord).flatMap((row) => {
        const id = row.id;
        if (!(typeof id === 'string' || typeof id === 'number') || !/^\d+$/.test(String(id))) return [];
        return [{ id: String(id), code: String(row.code ?? id), label: String(row.name ?? row.title ?? `Каталог ${id}`) }];
      }),
    };
  }

  async dictionaryCatalogs(bitrixAccessToken: string) {
    return Promise.all(DEFAULT_FIELD_SETTINGS.references.dictionaries.map(async (dictionary) => {
      const [bitrixRows, moyskladRows] = await Promise.all([
        this.bitrixListElements(bitrixAccessToken, dictionary.bitrix24ListId),
        this.moyskladList(`/entity/customentity/${encodeURIComponent(dictionary.moyskladDirectoryId)}`),
      ]);
      return {
        key: dictionary.key,
        bitrix24: bitrixRows.map((row) => ({ id: text(row.ID ?? row.id), title: text(row.NAME ?? row.name), code: text(row.CODE ?? row.code) })),
        moysklad: moyskladRows.map((row) => ({ id: text(row.id), title: text(row.name), code: text(row.code) })),
      };
    }));
  }

  async readPair(bitrixAccessToken: string, entity: string, sourceId: string, targetId: string): Promise<PairSnapshot> {
    const contract = pairContract(entity, sourceId, targetId);
    const [source, target] = await Promise.all([
      this.bitrixCall(bitrixAccessToken, contract.bitrixMethod, contract.bitrixParams),
      this.moyskladGet(contract.moyskladPath),
    ]);
    const sourceRecord = unwrapSource(entity, source);
    return {
      sourceLabel: sourceLabel(sourceRecord),
      sourceValues: sourceRecord,
      targetCurrent: asRecord(target),
    };
  }

  async fieldCatalogs(bitrixAccessToken: string, entity: string) {
    const contract = fieldMetadataContract(entity);
    let bitrixResult: unknown;
    if (entity === 'catalog') {
      // Product field definitions are scoped to an information block. List catalog
      // metadata (not product records), then merge each catalog's schema.
      const catalogResult = await this.bitrixCall(bitrixAccessToken, 'catalog.catalog.list', {});
      const root = asRecord(catalogResult);
      const rows = Array.isArray(root.catalogs) ? root.catalogs : Array.isArray(catalogResult) ? catalogResult : [];
      const ids = [...new Set(rows.filter(isRecord).map((row) => row.id).filter((id): id is string | number => typeof id === 'string' || typeof id === 'number').map(String))];
      if (!ids.length) throw new ServiceUnavailableException('Bitrix24 returned no product catalog metadata');
      const schemas: unknown[] = [];
      for (const iblockId of ids) {
        for (const method of ['catalog.product.getFieldsByFilter', 'catalog.product.service.getFieldsByFilter']) {
          try {
            schemas.push(await this.bitrixCall(bitrixAccessToken, method, { 'filter[iblockId]': iblockId }));
          } catch (cause) {
            // Catalogs may contain only products or only services; an unavailable
            // sibling schema is not evidence that the other resource is absent.
            if (!(cause instanceof ServiceUnavailableException)) throw cause;
          }
        }
      }
      const productFields = Object.assign({}, ...schemas.map((schema) => asRecord(asRecord(schema).product)));
      const serviceFields = Object.assign({}, ...schemas.map((schema) => asRecord(asRecord(schema).service)));
      const catalogResources = new Map<string, 'product' | 'service' | 'product-or-service'>();
      for (const code of new Set([...Object.keys(productFields), ...Object.keys(serviceFields)])) {
        catalogResources.set(code, code in productFields && code in serviceFields ? 'product-or-service' : code in productFields ? 'product' : 'service');
      }
      const catalogFields = { ...serviceFields, ...productFields };
      if (!Object.keys(catalogFields).length) throw new ServiceUnavailableException('Bitrix24 returned no product or service field schemas for its catalogs');
      // The product field schema does not consistently include the actual
      // information-block property title, multiplicity, or list values. Enrich
      // only propertyNNN entries with the official property metadata APIs.
      const propertiesByCode = new Map<string, Record<string, unknown>>();
      const conflictingPropertyCodes = new Set<string>();
      for (const iblockId of ids) {
        const properties = await this.bitrixList(bitrixAccessToken, 'catalog.productProperty.list', { 'filter[iblockId]': iblockId });
        for (const property of properties) {
          const id = text(property.id);
          if (!/^\d+$/.test(id)) continue;
          const code = `property${id}`;
          const previous = propertiesByCode.get(code);
          if (previous && (text(previous.name) !== text(property.name) || text(previous.propertyType) !== text(property.propertyType) || text(previous.multiple) !== text(property.multiple))) {
            conflictingPropertyCodes.add(code);
          } else propertiesByCode.set(code, property);
        }
      }
      for (const [code, property] of propertiesByCode) {
        if (!(code in catalogFields)) continue; // Never invent a product payload field from metadata alone.
        if (conflictingPropertyCodes.has(code)) {
          catalogFields[code] = { ...asRecord(catalogFields[code]), title: '', type: 'unknown', isMultiple: undefined, isReadOnly: true };
          continue;
        }
        const propertyType = text(property.propertyType).toUpperCase();
        const type = propertyType === 'L' ? 'enumeration' : propertyType === 'N' ? 'double' : propertyType === 'S' ? 'string' : 'unknown';
        let enumOptions: Array<{ id: string; value: string }> = [];
        if (propertyType === 'L') {
          const rows = await this.bitrixList(bitrixAccessToken, 'catalog.productPropertyEnum.list', { 'filter[propertyId]': text(property.id) });
          enumOptions = rows.flatMap((row) => {
            const optionId = text(row.id);
            return optionId && typeof row.value === 'string' ? [{ id: optionId, value: row.value }] : [];
          });
        }
        catalogFields[code] = {
          ...asRecord(catalogFields[code]),
          title: text(property.name),
          type,
          isMultiple: property.multiple === 'Y' ? true : property.multiple === 'N' ? false : undefined,
          ...(enumOptions.length ? { enumOptions } : {}),
          // Property metadata proves meaning, not that this application's
          // scalar update adapter writes the provider's property payload shape.
        };
      }
      bitrixResult = { product: catalogFields };
      const bitrixUserFields = contract.bitrixUserFieldsMethod
        ? await this.bitrixUserFieldList(bitrixAccessToken, contract.bitrixUserFieldsMethod)
        : undefined;
      const bitrix24 = describeBitrixFields(bitrixResult, entity, bitrixUserFields, catalogResources).map((field) => {
        if (!/^property\d+$/i.test(field.code) || !propertiesByCode.has(field.code)) return field;
        return { ...field, writable: null, writableEvidence: 'unconfirmed' as const, reserved: 'UNSUPPORTED_PRODUCT_PROPERTY_PAYLOAD' };
      });
      const metadata = await this.moyskladGet(`${contract.moyskladResource}/metadata/attributes`);
      const attributeRows = isRecord(metadata) && Array.isArray(metadata.rows) ? metadata.rows.filter(isRecord) : [];
      const moyskladAttributes: FieldCandidate[] = attributeRows.flatMap((row) => {
        if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.type !== 'string') return [];
        const writable = typeof row.writable === 'boolean' ? row.writable : typeof row.readOnly === 'boolean' ? !row.readOnly : null;
        const enumOptions = enumerationOptions(row.enumOptions ?? row.values ?? row.list);
        return [{ code: `attributes.${row.id}`, title: row.name, type: row.type, writable, writableEvidence: writable === null ? 'unconfirmed' : 'provider-schema', category: 'custom', cardinality: cardinality(row.isMultiple ?? (row.type === 'array' ? true : false)), shape: fieldShape(row.type, row.isMultiple), ...(enumOptions.length ? { enumOptions } : {}), ...(referenceKind(row.type) ? { referenceKind: referenceKind(row.type) } : {}) }];
      });
      const moyskladStandard = moyskladStandardFields(entity);
      return { entity, bitrix24, moysklad: deduplicateFields([...moyskladStandard, ...moyskladAttributes]) };
    } else {
      bitrixResult = await this.bitrixCall(bitrixAccessToken, contract.bitrixFieldsMethod, contract.bitrixFieldsParams);
    }
    const bitrixUserFields = contract.bitrixUserFieldsMethod
      ? await this.bitrixUserFieldList(bitrixAccessToken, contract.bitrixUserFieldsMethod)
      : undefined;
    const bitrix24 = describeBitrixFields(bitrixResult, entity, bitrixUserFields);
    // MySklad standard fields are described by the official Product/Service API
    // models. Metadata's attributes endpoint contains account-specific custom
    // fields only and is separate from that standard schema.
    const metadata = await this.moyskladGet(`${contract.moyskladResource}/metadata/attributes`);
    const attributeRows = isRecord(metadata) && Array.isArray(metadata.rows) ? metadata.rows.filter(isRecord) : [];
    const moyskladAttributes: FieldCandidate[] = attributeRows.flatMap((row) => {
      if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.type !== 'string') return [];
      const writable = typeof row.writable === 'boolean' ? row.writable : typeof row.readOnly === 'boolean' ? !row.readOnly : null;
      const enumOptions = enumerationOptions(row.enumOptions ?? row.values ?? row.list);
      return [{ code: `attributes.${row.id}`, title: row.name, type: row.type, writable, writableEvidence: writable === null ? 'unconfirmed' : 'provider-schema', category: 'custom', cardinality: cardinality(row.isMultiple ?? (row.type === 'array' ? true : false)), shape: fieldShape(row.type, row.isMultiple), ...(enumOptions.length ? { enumOptions } : {}), ...(referenceKind(row.type) ? { referenceKind: referenceKind(row.type) } : {}) }];
    });
    const moyskladStandard = moyskladStandardFields(entity);
    return { entity, bitrix24, moysklad: deduplicateFields([...moyskladStandard, ...moyskladAttributes]) };
  }

  private async bitrixList(accessToken: string, method: string, extraParams: Record<string, string> = {}): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    let start = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const payload = await this.bitrixCall(accessToken, method, { ...extraParams, start, 'order[id]': 'ASC' });
      const pageRows = Array.isArray(payload) ? payload : isRecord(payload)
        ? Object.values(payload).find((value) => Array.isArray(value)) as unknown[] | undefined
        : undefined;
      if (!pageRows) throw new ServiceUnavailableException(`Bitrix24 returned an invalid ${method} catalog`);
      rows.push(...pageRows.filter(isRecord));
      if (pageRows.length < PAGE_SIZE) return rows;
      start += PAGE_SIZE;
    }
    throw new ServiceUnavailableException(`Bitrix24 ${method} catalog exceeds the supported ${MAX_PAGES * PAGE_SIZE} records; use a narrower catalog filter`);
  }

  private async bitrixDealStages(accessToken: string): Promise<NamedReferenceItem[]> {
    const categories = await this.bitrixCall(accessToken, 'crm.category.list', { entityTypeId: 2 });
    const root = asRecord(categories);
    const categoryRows = Array.isArray(root.categories) ? root.categories : Array.isArray(categories) ? categories : [];
    const pipelineRows = [{ id: '0', name: 'Основная воронка' }, ...categoryRows.filter(isRecord).map((row) => ({ id: text(row.id), name: text(row.name) }))];
    const stages: NamedReferenceItem[] = [];
    for (const pipeline of pipelineRows) {
      const entityId = pipeline.id === '0' ? 'DEAL_STAGE' : `DEAL_STAGE_${pipeline.id}`;
      const rows = await this.bitrixCall(accessToken, 'crm.status.list', { 'filter[ENTITY_ID]': entityId });
      const values = Array.isArray(rows) ? rows : isRecord(rows) && Array.isArray(rows.statuses) ? rows.statuses : null;
      if (!values) throw new ServiceUnavailableException(`Bitrix24 returned an invalid stage catalog for pipeline ${pipeline.id}`);
      for (const row of values.filter(isRecord)) {
        const statusId = text(row.STATUS_ID ?? row.STATUS);
        if (!statusId) throw new ServiceUnavailableException(`Bitrix24 returned a deal stage without an ID for pipeline ${pipeline.id}`);
        stages.push({ ...named(row, `${pipeline.id}:${statusId}`, row.NAME, statusId), group: pipeline.name });
      }
    }
    return stages;
  }

  private async bitrixUserFieldList(accessToken: string, method: string): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    const seenCursors = new Set<number>();
    const seenCodes = new Set<string>();
    let start = 0;
    let expectedTotal: number | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (seenCursors.has(start)) throw new ServiceUnavailableException(`Bitrix24 ${method} returned a repeating pagination cursor`);
      seenCursors.add(start);
      const response = await this.bitrixCallEnvelope(accessToken, method, { 'filter[LANG]': 'ru', start });
      if (!Array.isArray(response.result)) throw new ServiceUnavailableException(`Bitrix24 returned an invalid ${method} userfield list`);
      const pageRows = response.result;
      if (pageRows.some((row) => !isRecord(row) || typeof row.FIELD_NAME !== 'string' || !row.FIELD_NAME.trim())) {
        throw new ServiceUnavailableException(`Bitrix24 returned a malformed ${method} userfield row`);
      }
      if (response.total !== undefined) {
        if (!Number.isSafeInteger(response.total) || (response.total as number) < 0) {
          throw new ServiceUnavailableException(`Bitrix24 returned an invalid total for ${method}`);
        }
        if (expectedTotal !== undefined && response.total !== expectedTotal) {
          throw new ServiceUnavailableException(`Bitrix24 returned an inconsistent total for ${method}`);
        }
        expectedTotal = response.total as number;
      }
      for (const row of pageRows as Array<Record<string, unknown>>) {
        const code = (row.FIELD_NAME as string).trim();
        if (seenCodes.has(code)) throw new ServiceUnavailableException(`Bitrix24 ${method} returned a duplicate field code`);
        seenCodes.add(code);
      }
      rows.push(...pageRows as Array<Record<string, unknown>>);
      if (expectedTotal !== undefined && rows.length > expectedTotal) {
        throw new ServiceUnavailableException(`Bitrix24 returned more rows than total for ${method}`);
      }

      if (response.next === undefined) {
        if (expectedTotal !== undefined && rows.length !== expectedTotal) {
          throw new ServiceUnavailableException(`Bitrix24 omitted the next cursor before all ${method} rows were returned`);
        }
    const enumRows = rows.filter((row) => String(row.USER_TYPE_ID ?? '').toLowerCase() === 'enumeration' && !Array.isArray(row.LIST));
    const getMethod = method.replace(/\.list$/i, '.get');
    for (let index = 0; index < enumRows.length; index += 10) {
      await Promise.all(enumRows.slice(index, index + 10).map(async (row) => {
        const id = row.ID;
        if (typeof id !== 'string' && typeof id !== 'number') throw new ServiceUnavailableException(`Bitrix24 ${method} omitted an ID for an enumeration field`);
        const detail = asRecord(await this.bitrixCall(accessToken, getMethod, { ID: String(id) }));
        const field = isRecord(detail.userfield) ? detail.userfield : detail;
        if (field.FIELD_NAME !== row.FIELD_NAME || !Array.isArray(field.LIST)) {
          throw new ServiceUnavailableException(`Bitrix24 ${getMethod} returned incomplete enumeration metadata`);
        }
        row.LIST = field.LIST;
      }));
    }
    return rows;
      }
      if (!Number.isSafeInteger(response.next) || (response.next as number) <= start) {
        throw new ServiceUnavailableException(`Bitrix24 returned an invalid or non-advancing cursor for ${method}`);
      }
      if (pageRows.length === 0) throw new ServiceUnavailableException(`Bitrix24 returned an empty ${method} page with a next cursor`);
      start = response.next as number;
    }
    throw new ServiceUnavailableException(`Bitrix24 ${method} userfield list exceeds the supported ${MAX_PAGES} page limit`);
  }

  private async bitrixListElements(accessToken: string, listId: string): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    for (let page = 0, start = 0; page < MAX_PAGES; page += 1, start += PAGE_SIZE) {
      const result = await this.bitrixCall(accessToken, 'lists.element.get', {
        IBLOCK_TYPE_ID: 'rest_entity', IBLOCK_ID: listId, start,
        'SELECT[0]': 'ID', 'SELECT[1]': 'CODE', 'SELECT[2]': 'NAME',
      });
      if (!Array.isArray(result)) throw new ServiceUnavailableException(`Bitrix24 returned an invalid list ${listId}`);
      const pageRows = result.filter(isRecord);
      rows.push(...pageRows);
      if (pageRows.length < PAGE_SIZE) return rows;
    }
    throw new ServiceUnavailableException(`Bitrix24 list ${listId} exceeds the supported ${MAX_PAGES * PAGE_SIZE} records`);
  }

  private async bitrixCall(accessToken: string, method: string, params: Record<string, string | number>): Promise<unknown> {
    return (await this.bitrixCallEnvelope(accessToken, method, params)).result;
  }

  private async bitrixCallEnvelope(accessToken: string, method: string, params: Record<string, string | number>): Promise<{ result: unknown; next?: unknown; total?: unknown }> {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new ServiceUnavailableException('Bitrix24 read-only catalog provider is not configured');
    const form = new URLSearchParams({ auth: accessToken, ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])) });
    const response = await fetch(new URL(`${method}.json`, ensureSlash(base)), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => { throw new ServiceUnavailableException('Bitrix24 read-only request failed'); });
    if (!response.ok) throw new ServiceUnavailableException(`Bitrix24 read-only request failed (${response.status})`);
    const payload: unknown = await response.json().catch(() => null);
    if (!isRecord(payload) || !('result' in payload) || 'error' in payload) throw new ServiceUnavailableException('Bitrix24 rejected the read-only request');
    return { result: payload.result, next: payload.next, total: payload.total };
  }

  private async moyskladList(path: string): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    let url = new URL(path.replace(/^\//, ''), ensureSlash(process.env.MOYSKLAD_API_BASE_URL ?? 'https://api.moysklad.ru/api/remap/1.2/'));
    const visited = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const key = url.toString();
      if (visited.has(key)) throw new ServiceUnavailableException('MoySklad returned a repeating catalog page');
      visited.add(key);
      const payload = await this.moyskladGet(url.toString());
      // Unlike entity list resources, this company-settings endpoint returns
      // the price types as a bare JSON array (verified against the live API).
      const isPriceTypeCatalog = url.pathname.endsWith('/context/companysettings/pricetype');
      let pageRows: Array<Record<string, unknown>> | null = null;
      if (isPriceTypeCatalog && Array.isArray(payload)) {
        if (!payload.every(isRecord)) throw new ServiceUnavailableException('MoySklad returned an invalid catalog');
        pageRows = payload;
      } else if (isRecord(payload) && Array.isArray(payload.rows)) {
        pageRows = payload.rows.filter(isRecord);
      }
      if (!pageRows) throw new ServiceUnavailableException('MoySklad returned an invalid catalog');
      rows.push(...pageRows);
      const nextHref = isRecord(payload) && isRecord(payload.meta) && typeof payload.meta.nextHref === 'string' ? payload.meta.nextHref : '';
      if (!nextHref) return rows;
      url = new URL(nextHref);
    }
    throw new ServiceUnavailableException(`MoySklad catalog exceeds ${MAX_PAGES} pages; use a narrower catalog filter`);
  }

  private async moyskladOrderStates(): Promise<Array<Record<string, unknown>>> {
    const metadata = await this.moyskladGet('/entity/customerorder/metadata');
    if (!isRecord(metadata) || !Array.isArray(metadata.states) || metadata.states.some((state) => !isRecord(state) || !text(state.id))) {
      throw new ServiceUnavailableException('MoySklad returned invalid customer-order state metadata');
    }
    return metadata.states as Array<Record<string, unknown>>;
  }

  private async moyskladGet(path: string): Promise<unknown> {
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new ServiceUnavailableException('MoySklad read-only catalog provider is not configured');
    const url = path.startsWith('http') ? new URL(path) : new URL(path.replace(/^\//, ''), ensureSlash(base));
    const allowedOrigin = new URL(base).origin;
    if (url.origin !== allowedOrigin) throw new ServiceUnavailableException('MoySklad returned an untrusted pagination URL');
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json;charset=utf-8' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .catch(() => { throw new ServiceUnavailableException('MoySklad read-only request failed'); });
    if (!response.ok) throw new ServiceUnavailableException(`MoySklad read-only request failed (${response.status})`);
    return response.json().catch(() => { throw new ServiceUnavailableException('MoySklad returned invalid JSON'); });
  }
}

function fieldMetadataContract(entity: string): { bitrixFieldsMethod: string; bitrixFieldsParams: Record<string, string | number>; bitrixUserFieldsMethod?: string; moyskladResource: string } {
  switch (entity) {
    case 'contacts':
    case 'contacts-companies': return { bitrixFieldsMethod: 'crm.contact.fields', bitrixFieldsParams: {}, bitrixUserFieldsMethod: 'crm.contact.userfield.list', moyskladResource: 'entity/counterparty' };
    case 'companies': return { bitrixFieldsMethod: 'crm.company.fields', bitrixFieldsParams: {}, bitrixUserFieldsMethod: 'crm.company.userfield.list', moyskladResource: 'entity/counterparty' };
    case 'deals-orders': return { bitrixFieldsMethod: 'crm.deal.fields', bitrixFieldsParams: {}, bitrixUserFieldsMethod: 'crm.deal.userfield.list', moyskladResource: 'entity/customerorder' };
    case 'smart-invoices': return { bitrixFieldsMethod: 'crm.item.fields', bitrixFieldsParams: { entityTypeId: 31 }, moyskladResource: 'entity/invoiceout' };
    case 'catalog': return { bitrixFieldsMethod: 'catalog.product.getFieldsByFilter', bitrixFieldsParams: {}, moyskladResource: 'entity/product' };
    default: throw new ServiceUnavailableException('This entity type has no read-only field metadata provider');
  }
}

function moyskladStandardFields(entity: string): FieldCandidate[] {
  const fields: Record<string, Array<[string, string, string, boolean | null]>> = {
    contacts: [['name', 'Наименование', 'string', true], ['companyType', 'Тип контрагента', 'enum', true], ['legalTitle', 'Полное наименование', 'string', true], ['inn', 'ИНН', 'string', true], ['kpp', 'КПП', 'string', true], ['legalAddress', 'Юридический адрес', 'string', true], ['actualAddress', 'Фактический адрес', 'string', true], ['email', 'Электронная почта', 'string', true], ['phone', 'Телефон', 'string', true], ['code', 'Код', 'string', true], ['externalCode', 'Внешний код', 'string', true], ['description', 'Комментарий', 'string', true]],
    'contacts-companies': [['name', 'Наименование', 'string', true], ['companyType', 'Тип контрагента', 'enum', true], ['legalTitle', 'Полное наименование', 'string', true], ['inn', 'ИНН', 'string', true], ['kpp', 'КПП', 'string', true], ['legalAddress', 'Юридический адрес', 'string', true], ['actualAddress', 'Фактический адрес', 'string', true], ['email', 'Электронная почта', 'string', true], ['phone', 'Телефон', 'string', true], ['code', 'Код', 'string', true], ['externalCode', 'Внешний код', 'string', true], ['description', 'Комментарий', 'string', true]],
    companies: [['name', 'Наименование', 'string', true], ['companyType', 'Тип контрагента', 'enum', true], ['legalTitle', 'Полное наименование', 'string', true], ['inn', 'ИНН', 'string', true], ['kpp', 'КПП', 'string', true], ['legalAddress', 'Юридический адрес', 'string', true], ['actualAddress', 'Фактический адрес', 'string', true], ['email', 'Электронная почта', 'string', true], ['phone', 'Телефон', 'string', true], ['code', 'Код', 'string', true], ['externalCode', 'Внешний код', 'string', true], ['description', 'Комментарий', 'string', true]],
    'deals-orders': [['name', 'Наименование заказа', 'string', true], ['code', 'Код заказа', 'string', true], ['moment', 'Момент заказа', 'datetime', true], ['deliveryPlannedMoment', 'Плановая отгрузка/доставка', 'datetime', true], ['description', 'Комментарий', 'string', true], ['externalCode', 'Внешний код', 'string', true]],
    'smart-invoices': [['name', 'Наименование счёта', 'string', true], ['code', 'Код счёта', 'string', true], ['moment', 'Момент счёта', 'datetime', true], ['paymentPlannedMoment', 'Срок оплаты', 'datetime', true], ['description', 'Комментарий', 'string', true], ['externalCode', 'Внешний код', 'string', true]],
    catalog: [
      ['meta', 'Метаданные объекта', 'object', false], ['id', 'Идентификатор', 'uuid', false], ['accountId', 'Идентификатор учётной записи', 'uuid', false],
      ['name', 'Наименование товара / услуги', 'string', true], ['code', 'Код', 'string', true], ['externalCode', 'Внешний код', 'string', true], ['article', 'Артикул', 'string', true],
      ['description', 'Описание', 'string', true], ['archived', 'В архиве', 'boolean', true], ['vat', 'Ставка НДС', 'integer', true], ['vatEnabled', 'Учитывать НДС', 'boolean', true],
      ['useParentVat', 'Использовать ставку НДС группы', 'boolean', true], ['effectiveVat', 'Фактическая ставка НДС', 'integer', false], ['effectiveVatEnabled', 'Фактический признак НДС', 'boolean', false],
      ['discountProhibited', 'Запрет скидки', 'boolean', true], ['updated', 'Дата изменения', 'datetime', false], ['weight', 'Вес', 'double', true], ['volume', 'Объём', 'double', true],
      ['buyPrice', 'Закупочная цена', 'object', true], ['salePrices', 'Цены продажи', 'array', true], ['supplier', 'Поставщик', 'object', true], ['country', 'Страна', 'object', true],
      ['uom', 'Единица измерения', 'object', true], ['productFolder', 'Группа каталога', 'object', true], ['pathName', 'Путь группы', 'string', false], ['images', 'Изображения', 'array', true],
      ['files', 'Файлы', 'array', true], ['barcodes', 'Штрихкоды', 'array', true], ['packs', 'Упаковки', 'array', true], ['trackingType', 'Тип маркировки', 'string', true],
      ['tnved', 'Код ТН ВЭД', 'string', true], ['paymentItemType', 'Признак предмета расчёта', 'string', true], ['taxSystem', 'Налоговая система', 'string', true],
      ['attributes', 'Дополнительные поля', 'array', null], ['minimumStock', 'Неснижаемый остаток', 'object', true], ['minPrice', 'Минимальная цена', 'object', true], ['weighed', 'Весовой товар', 'boolean', true],
      ['onTap', 'Продажа на разлив', 'boolean', true], ['partialDisposal', 'Частичное выбытие', 'boolean', true], ['things', 'Серийные номера', 'array', true],
      ['syncId', 'Идентификатор синхронизации', 'uuid', true], ['ppeType', 'Тип СИЗ', 'string', true], ['alcoholic', 'Алкогольная продукция', 'object', true],
      ['tobacco', 'Табачная продукция', 'boolean', false], ['variantsCount', 'Количество модификаций', 'integer', false], ['isSerialTrackable', 'Учёт по сериям', 'boolean', true],
      ['shared', 'Общий доступ', 'boolean', true], ['owner', 'Владелец', 'object', true], ['group', 'Отдел владельца', 'object', true],
    ],
  };
  const catalogKinds: Record<string, 'product' | 'service' | 'product-or-service'> = {
    meta: 'product-or-service', id: 'product-or-service', accountId: 'product-or-service', article: 'product', weight: 'product', volume: 'product', supplier: 'product', country: 'product', images: 'product', packs: 'product', trackingType: 'product', tnved: 'product',
    alcoholic: 'product', tobacco: 'product', variantsCount: 'product', isSerialTrackable: 'product', minimumStock: 'product', weighed: 'product', onTap: 'product', partialDisposal: 'product', things: 'product', ppeType: 'product',
  };
  return (fields[entity] ?? []).map(([code, title, type, writable]) => ({ code, title, type, writable, writableEvidence: 'local-standard-schema' as const, category: 'standard' as const, cardinality: cardinality(type === 'array'), shape: fieldShape(type), ...(referenceKind(type) ? { referenceKind: referenceKind(type) } : {}), ...(entity === 'catalog' ? { resource: catalogKinds[code] ?? 'product-or-service' } : {}) }));
}

function pairContract(entity: string, sourceId: string, targetId: string): {
  bitrixMethod: string;
  bitrixParams: Record<string, string | number>;
  bitrixFieldsMethod: string;
  bitrixFieldsParams: Record<string, string | number>;
  moyskladPath: string;
} {
  const msId = encodeURIComponent(targetId);
  switch (entity) {
    case 'contacts-companies':
    case 'contacts': return { bitrixMethod: 'crm.contact.get', bitrixParams: { id: sourceId }, bitrixFieldsMethod: 'crm.contact.fields', bitrixFieldsParams: {}, moyskladPath: `entity/counterparty/${msId}` };
    case 'companies': return { bitrixMethod: 'crm.company.get', bitrixParams: { id: sourceId }, bitrixFieldsMethod: 'crm.company.fields', bitrixFieldsParams: {}, moyskladPath: `entity/counterparty/${msId}` };
    case 'deals-orders': return { bitrixMethod: 'crm.deal.get', bitrixParams: { id: sourceId }, bitrixFieldsMethod: 'crm.deal.fields', bitrixFieldsParams: {}, moyskladPath: `entity/customerorder/${msId}` };
    case 'smart-invoices': return { bitrixMethod: 'crm.item.get', bitrixParams: { entityTypeId: 31, id: sourceId }, bitrixFieldsMethod: 'crm.item.fields', bitrixFieldsParams: { entityTypeId: 31 }, moyskladPath: `entity/invoiceout/${msId}` };
    case 'catalog': return { bitrixMethod: 'catalog.product.get', bitrixParams: { id: sourceId }, bitrixFieldsMethod: 'catalog.product.getFieldsByFilter', bitrixFieldsParams: {}, moyskladPath: `entity/product/${msId}` };
    default: throw new ServiceUnavailableException('This entity type has no read-only pair provider');
  }
}

function unwrapSource(entity: string, value: unknown): Record<string, unknown> {
  const root = asRecord(value);
  if (entity === 'smart-invoices' && isRecord(root.item)) return root.item;
  if (entity === 'catalog' && isRecord(root.product)) return root.product;
  return root;
}

function describeBitrixFields(value: unknown, entity: string, userFields?: unknown, resourceByCode?: Map<string, 'product' | 'service' | 'product-or-service'>): FieldCandidate[] {
  const root = asRecord(value);
  const candidates = isRecord(root.fields) ? root.fields : isRecord(root.product) ? root.product : root;
  const localizedLabels = new Map<string, string>();
  if (userFields !== undefined && !Array.isArray(userFields)) {
    throw new ServiceUnavailableException('Bitrix24 returned an invalid userfield metadata list');
  }
  const userFieldRows = Array.isArray(userFields) ? userFields : [];
  const userFieldsByCode = new Map<string, Record<string, unknown>>();
  for (const row of userFieldRows) {
    if (!isRecord(row) || typeof row.FIELD_NAME !== 'string' || !row.FIELD_NAME.trim()) {
      throw new ServiceUnavailableException('Bitrix24 returned a malformed userfield metadata row');
    }
    const code = row.FIELD_NAME.trim();
    userFieldsByCode.set(code, row);
    const label = [row.EDIT_FORM_LABEL, row.LIST_COLUMN_LABEL, row.LIST_FILTER_LABEL]
      .map(localizedLabel)
      .find((candidate) => candidate && candidate !== code);
    if (code && label) localizedLabels.set(code, label);
  }
  return Object.entries(candidates).flatMap(([code, definition]) => {
    if (!isRecord(definition) || code === 'time' || code === 'item') return [];
    const apiTitle = [definition.title, definition.formLabel, definition.listLabel, definition.filterLabel, definition.listColumnLabel, definition.name]
      .find((label): label is string => typeof label === 'string' && label.trim().length > 0)?.trim() ?? '';
    const title = localizedLabels.get(code) ?? apiTitle;
    const userField = userFieldsByCode.get(code);
    const type = typeof userField?.USER_TYPE_ID === 'string' ? userField.USER_TYPE_ID : typeof definition.type === 'string' ? definition.type : typeof definition.userTypeId === 'string' ? definition.userTypeId : 'unknown';
    const isMultiple = typeof definition.isMultiple === 'boolean' ? definition.isMultiple : userField?.MULTIPLE === 'Y' ? true : userField?.MULTIPLE === 'N' ? false : userField ? undefined : type.toLowerCase() === 'crm_multifield' || type.toLowerCase() === 'array';
    const enumOptions = enumerationOptions(userField?.LIST ?? definition.enumOptions);
    const custom = /^UF_CRM/i.test(code) || (entity === 'catalog' && /^property\d+$/i.test(code));
    const writable = typeof definition.isReadOnly === 'boolean' ? !definition.isReadOnly : null;
    return [{ code, title, type, writable, writableEvidence: writable === null ? 'unconfirmed' : 'provider-schema', category: custom ? 'custom' : 'standard', cardinality: cardinality(isMultiple), shape: fieldShape(type, isMultiple), ...(enumOptions.length ? { enumOptions } : {}), ...(referenceKind(type) ? { referenceKind: referenceKind(type) } : {}), ...(entity === 'catalog' && resourceByCode?.has(code) ? { resource: resourceByCode.get(code)! } : {}), ...(entity === 'catalog' && code === 'xmlId' ? { reserved: 'PRODUCT_CREATE_RECOVERY_IDENTITY' } : {}) }];
  });
}

function localizedLabel(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  const label = value.ru ?? value['ru-RU'] ?? value.en ?? Object.values(value).find((candidate) => typeof candidate === 'string');
  return typeof label === 'string' ? label.trim() : '';
}

function deduplicateFields(fields: FieldCandidate[]): FieldCandidate[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    if (seen.has(field.code)) return false;
    seen.add(field.code);
    return true;
  });
}

function cardinality(value: unknown): FieldCandidate['cardinality'] {
  if (value === true || value === 'Y') return 'multiple';
  if (value === false || value === 'N') return 'single';
  return 'unknown';
}

function fieldShape(type: string, multiple?: unknown): FieldCandidate['shape'] {
  if (type.toLowerCase() === 'array' || multiple === true) return 'array';
  if (type.toLowerCase() === 'object') return 'object';
  if (type && type !== 'unknown') return 'scalar';
  return 'unknown';
}

function referenceKind(type: string): string | undefined {
  const normalized = type.trim().toLowerCase();
  if (['employee', 'crm_status', 'iblock_section', 'iblock_element', 'crm', 'counterparty', 'organization', 'store', 'project', 'currency', 'customerorder', 'invoiceout', 'customentity', 'link'].includes(normalized)) return normalized;
  return undefined;
}

function enumerationOptions(value: unknown): FieldEnumOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const id = candidate.ID ?? candidate.id;
    const optionValue = candidate.VALUE ?? candidate.value ?? candidate.name;
    if (id === undefined || (typeof optionValue !== 'string' && typeof optionValue !== 'number')) return [];
    return [{ id: String(id), value: String(optionValue) }];
  });
}

function valueType(value: unknown): string {
  if (value === null || value === undefined) return 'unknown';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

/** Labels for standard fields whose Russian meanings are documented for these resources.
 * Unknown standard fields keep their exact API code as their honest display title.
 */
function moyskladStandardFieldTitle(entity: string, code: string): string {
  const labels: Record<string, Record<string, string>> = {
    contacts: {
      name: 'Имя контрагента', companyType: 'Тип контрагента', legalTitle: 'Полное наименование',
      inn: 'ИНН', kpp: 'КПП', legalAddress: 'Юридический адрес', actualAddress: 'Фактический адрес',
      email: 'Электронная почта', phone: 'Телефон',
    },
    'contacts-companies': {
      name: 'Имя контрагента', companyType: 'Тип контрагента', legalTitle: 'Полное наименование',
      inn: 'ИНН', kpp: 'КПП', legalAddress: 'Юридический адрес', actualAddress: 'Фактический адрес',
      email: 'Электронная почта', phone: 'Телефон',
    },
    companies: {
      name: 'Имя контрагента', companyType: 'Тип контрагента', legalTitle: 'Полное наименование',
      inn: 'ИНН', kpp: 'КПП', legalAddress: 'Юридический адрес', actualAddress: 'Фактический адрес',
      email: 'Электронная почта', phone: 'Телефон',
    },
    'deals-orders': {
      name: 'Наименование заказа', code: 'Код заказа', moment: 'Момент заказа',
      deliveryPlannedMoment: 'Плановая отгрузка/доставка', state: 'Статус', sum: 'Сумма', description: 'Описание',
    },
    'smart-invoices': {
      name: 'Наименование счёта', code: 'Код счёта', moment: 'Момент счёта',
      paymentPlannedMoment: 'Срок оплаты', state: 'Статус', sum: 'Сумма', description: 'Описание',
    },
    catalog: {
      name: 'Наименование товара', code: 'Код товара', article: 'Артикул', description: 'Описание',
      externalCode: 'Внешний код', vat: 'Ставка НДС',
    },
  };
  return labels[entity]?.[code] ?? code;
}

function sourceLabel(value: unknown): string {
  const row = asRecord(value);
  const person = [row.NAME, row.LAST_NAME, row.SECOND_NAME].filter((part) => typeof part === 'string' && part.trim()).join(' ');
  if (person) return person;
  return [row.TITLE, row.name, row.PRODUCT_NAME].find((part) => typeof part === 'string' && part.trim()) as string | undefined ?? 'Без подписи';
}
function named(row: Record<string, unknown>, id: unknown, label: unknown, code?: unknown): NamedReferenceItem {
  const normalizedLabel = text(label).trim();
  return { id: text(id), code: text(code ?? id), label: normalizedLabel || text(id) };
}
function asRecord(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): string { return value === null || value === undefined ? '' : String(value); }
function ensureSlash(value: string) { return value.endsWith('/') ? value : `${value}/`; }
