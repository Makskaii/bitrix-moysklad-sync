import { Inject, Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { VersionedFieldSettingsDto } from '../field-settings/field-settings.dto';
import { CLIENT_DEPENDENCY_RESOLVER, ClientDependencyResolver } from '../clients/client-dependency-resolver';
import { isPlannedDeliveryDateMapping, normalizePlannedDeliveryDate, toMoySkladPlannedDeliveryDate, touchesPlannedDeliveryDateEndpoint } from './planned-delivery-date';
import { writeOperationalLog } from '../monitoring-log';
import { DealOrderPreparedInput } from './deal-order-create-operation.service';
import { bitrixMoneyToMoySklad } from './deal-order-money';
import { assertApplyExternalWrite } from '../external-write-guard';
import { ServiceModeNotOnError, withServiceModeOn } from '../service-mode-transaction';

const EXACT_OPTIONAL_STRING_ATTRIBUTES: Record<string, string> = {
  UF_CRM_1770062820: 'attributes.4a432000-0785-11f1-0a80-1b1000018578',
  UF_CRM_1785419472892: 'attributes.d5172d2c-8c1d-11f1-0a80-1af10010ed42',
  UF_CRM_1769687298: 'attributes.423e297a-7feb-11ef-0a80-0e7e002e09ff',
  UF_CRM_1729757856892: 'attributes.f7a9c2df-47f9-11ef-0a80-0c0c00322096',
};

export type RuntimeReferenceSettings = {
  nativeOrderNumberingVerified: boolean;
  defaultOrganizationId: string;
  defaultStoreId: string;
  defaultEmployeeId: string;
  defaultProductGroupId: string | null;
  currencies: Array<{ bitrix24Code: string; moyskladId: string }>;
  stages: Array<{ bitrix24StageId: string; moyskladId: string; creationEnabled: boolean }>;
  organizations: Array<{ bitrix24Id: string; moyskladId: string }>;
  stores: Array<{ bitrix24Id: string; moyskladId: string }>;
  employees: Array<{ bitrix24Id: string; moyskladId: string }>;
};

export type DealOrderPreparationResult =
  | { status: 'READY'; input: DealOrderPreparedInput }
  | { status: 'WAITING'; reason: string };

/** Resolves a complete create payload from the event-pinned config and persisted dependency pairs. */
@Injectable()
export class DealOrderCreationPreparer {
  constructor(
    private readonly database: DatabaseService,
    @Optional() @Inject(CLIENT_DEPENDENCY_RESOLVER) private readonly dependencies?: ClientDependencyResolver,
  ) {}

  private async providerModeGate<T>(work: () => Promise<T>): Promise<T> {
    const result = await withServiceModeOn(this.database, async () => work());
    if (!result.enabled) throw new ServiceModeNotOnError();
    return result.value;
  }

  async prepare(input: { bitrix24DealId: string; eventId: string; eventConfig: VersionedFieldSettingsDto }): Promise<DealOrderPreparationResult> {
    const references = readRuntimeReferences(input.eventConfig.config.dealOrderRuntime);
    if (!references) return { status: 'WAITING', reason: 'RUNTIME_REFERENCES_MISSING' };
    if (!references.nativeOrderNumberingVerified) return { status: 'WAITING', reason: 'NATIVE_ORDER_NUMBERING_UNVERIFIED' };

    let deal: Record<string, unknown>;
    let rows: Record<string, unknown>[];
    try {
      deal = await readBitrixDeal(input.bitrix24DealId, (work) => this.providerModeGate(work));
      rows = await readAllBitrixRows(input.bitrix24DealId, (work) => this.providerModeGate(work));
    } catch (error) {
      if (error instanceof ServiceModeNotOnError) throw error;
      return { status: 'WAITING', reason: 'SOURCE_READ_FAILED' };
    }

    if (String(deal.ID ?? '') !== input.bitrix24DealId) return { status: 'WAITING', reason: 'SOURCE_READ_FAILED' };
    const stageId = readString(deal.STAGE_ID);
    const stage = references.stages.find((candidate) => candidate.bitrix24StageId === stageId);
    if (!stage) return { status: 'WAITING', reason: 'STAGE_NOT_CONFIGURED' };
    if (!stage.creationEnabled) return { status: 'WAITING', reason: 'STAGE_NOT_READY' };
    const preparedAttributes = prepareMappedAttributes(deal, input.eventConfig.config, moyskladBase());
    if (!preparedAttributes) return { status: 'WAITING', reason: 'FIELD_MAPPING_UNSUPPORTED' };
    for (const ruleId of preparedAttributes.skippedOptionalRules) {
      await writeOperationalLog(this.database, 'EVENT', `Optional deal-order field rule ${ruleId} skipped during order creation; reason=VALUE_UNMAPPED_OR_DIRECTION_DISABLED_OR_UNSUPPORTED`, input.eventId);
    }
    const companyId = readNumericId(deal.COMPANY_ID);
    const contactId = readNumericId(deal.CONTACT_ID);
    if (rows.length > 1000) return { status: 'WAITING', reason: 'ROWS_INCOMPLETE' };

    const currencyCode = readString(deal.CURRENCY_ID);
    const currency = references.currencies.find((candidate) => candidate.bitrix24Code === currencyCode);
    if (!currency) return { status: 'WAITING', reason: 'RUNTIME_REFERENCES_MISSING' };
    const storeSource = readOptionalId(deal.UF_CRM_1732004209);
    const targetStoreId = storeSource
      ? references.stores.find((candidate) => candidate.bitrix24Id === storeSource)?.moyskladId
      : references.defaultStoreId;
    const organizationSource = readOptionalId(deal.UF_CRM_1776347243);
    const targetOrganizationId = organizationSource
      ? references.organizations.find((candidate) => candidate.bitrix24Id === organizationSource)?.moyskladId
      : references.defaultOrganizationId;
    if (!targetStoreId || !targetOrganizationId) return { status: 'WAITING', reason: 'RUNTIME_REFERENCES_MISSING' };
    const assignedBy = readOptionalId(deal.ASSIGNED_BY_ID);
    const targetEmployeeId = assignedBy
      ? references.employees.find((candidate) => candidate.bitrix24Id === assignedBy)?.moyskladId ?? references.defaultEmployeeId
      : references.defaultEmployeeId;
    const employeeFallbackUsed = !!assignedBy && !references.employees.some((candidate) => candidate.bitrix24Id === assignedBy);

    const referencesVerified = await Promise.all([
      verifyMySkladReference('organization', targetOrganizationId, (work) => this.providerModeGate(work)),
      verifyMySkladReference('store', targetStoreId, (work) => this.providerModeGate(work)),
      verifyMySkladReference('employee', targetEmployeeId, (work) => this.providerModeGate(work)),
      verifyMySkladReference('currency', currency.moyskladId, (work) => this.providerModeGate(work)),
      verifyMySkladReference('state', stage.moyskladId, (work) => this.providerModeGate(work)),
    ]).catch(() => []);
    if (referencesVerified.length !== 5 || referencesVerified.some((isValid) => !isValid)) {
      return { status: 'WAITING', reason: 'RUNTIME_REFERENCES_MISSING' };
    }

    // Invalid row identity makes every later address ambiguous. Value errors
    // are isolated to the row in the preparation pass below.
    const sourceRowIdsPreflight = new Set<string>();
    for (const row of rows) {
      const sourceRowId = readRowId(row.id);
      if (!sourceRowId) return { status: 'WAITING', reason: 'ROWS_INCOMPLETE' };
      const rowId = sourceRowId;
      if (!sourceRowId || sourceRowIdsPreflight.has(sourceRowId)) return { status: 'WAITING', reason: 'ROWS_INCOMPLETE' };
      sourceRowIdsPreflight.add(sourceRowId);
    }

    let agentCounterpartyId: string | null = null;
    let serviceCounterpartyId: string | null = null;
    const confirmedCustomerPairIds: string[] = [];
    let companyPair: import('@prisma/client').EntityPair | null = null;
    let contactPair: import('@prisma/client').EntityPair | null = null;
    if (!this.dependencies) return { status: 'WAITING', reason: 'CLIENT_DEPENDENCY_RESOLVER_UNAVAILABLE' };
    if (companyId) {
      const company = await this.dependencies.resolveForDocument({
        eventId: input.eventId, sourceSystem: 'BITRIX24', entity: 'COMPANY', sourceId: companyId,
      });
      if (company.status !== 'RESOLVED') return { status: 'WAITING', reason: company.reason };
      companyPair = company.pair;
    }
    if (contactId) {
      const contact = await this.dependencies.resolveForDocument({
        eventId: input.eventId, sourceSystem: 'BITRIX24', entity: 'CONTACT', sourceId: contactId,
        primaryCompanySourceId: companyId, optionalDependency: true,
      });
      if (contact.status === 'RESOLVED') {
        contactPair = contact.pair;
        companyPair ??= contact.companyPair;
      } else if (companyPair) {
        await this.dependencies.scheduleOptionalContactRetry({
          eventId: input.eventId, sourceSystem: 'BITRIX24', entity: 'CONTACT', sourceId: contactId,
          primaryCompanySourceId: companyId, optionalDependency: true,
        }, contact.reason, contact.status === 'RETRY' ? contact.retryAfter : undefined);
      } else {
        return { status: 'WAITING', reason: contact.reason };
      }
    }
    if (companyPair) {
      agentCounterpartyId = companyPair.moyskladId;
      confirmedCustomerPairIds.push(companyPair.id);
    } else if (!companyId && !contactId) {
      const configuredServiceCounterpartyId = input.eventConfig.config.serviceCounterpartyId;
      if (!configuredServiceCounterpartyId || !isUuid(configuredServiceCounterpartyId)) {
        return { status: 'WAITING', reason: 'SERVICE_COUNTERPARTY_NOT_CONFIGURED' };
      }
      if (!await this.dependencies.verifyServiceCounterparty(configuredServiceCounterpartyId)) {
        return { status: 'WAITING', reason: 'SERVICE_COUNTERPARTY_INVALID' };
      }
      agentCounterpartyId = configuredServiceCounterpartyId;
      serviceCounterpartyId = configuredServiceCounterpartyId;
    } else {
      return { status: 'WAITING', reason: 'CLIENT_COMPANY_COUNTERPARTY_UNRESOLVED' };
    }
    if (contactPair) confirmedCustomerPairIds.push(contactPair.id);
    if (!agentCounterpartyId || !isUuid(agentCounterpartyId)) return { status: 'WAITING', reason: 'CLIENT_PAIR_MISSING' };

    const rowsPrepared: DealOrderPreparedInput['payload']['positions'] = [];
    const sourceRowIds: string[] = [];
    const sourceRowValues: Array<Record<string, unknown>> = [];
    const sourceProductIds: string[] = [];
    const sourceMeasureCodes: number[] = [];
    const skippedRows: Array<{ sourceRowId: string; reason: string }> = [];
    const vatInclusionModes = new Set(rows.filter((row) => row.taxRate !== null && row.taxRate !== undefined).map((row) => row.taxIncluded));
    const mixedVatInclusion = vatInclusionModes.size > 1;
    const vatIncluded = vatInclusionModes.size === 1 ? vatInclusionModes.values().next().value === 'Y' : null;
    const units = input.eventConfig.config.references.units;
    for (const row of rows) {
      const sourceRowId = readRowId(row.id);
      if (!sourceRowId) return { status: 'WAITING', reason: 'ROWS_INCOMPLETE' };
      const rowId = sourceRowId;
      const productId = readNumericId(row.productId);
      const measureCode = readNumber(row.measureCode);
      const unit = measureCode === null ? null : units.find((candidate) => candidate.bitrix24Id === measureCode && candidate.status === 'configured' && candidate.moyskladId);
      const quantity = readNumber(row.quantity);
      const priceCents = toMinorUnits(row.price);
      const discountTypeId = readNumber(row.discountTypeId);
      const discountRate = readNumber(row.discountRate);
      const discountSum = readNumber(row.discountSum);
      const taxRate = row.taxRate === null ? null : readNumber(row.taxRate);
      const skipRow = async (reason: string) => {
        skippedRows.push({ sourceRowId: rowId, reason });
        await writeOperationalLog(this.database, 'EVENT', `Deal-order row ${rowId} skipped; reason=${reason}`, input.eventId);
      };
      if (!productId) { await skipRow('PRODUCT_ID_MISSING'); continue; }
      if (!measureCode || !unit?.moyskladId) { await skipRow('UNIT_UNMAPPED'); continue; }
      if (quantity === null || quantity <= 0 || priceCents === null || discountTypeId === null || discountRate === null || discountSum === null ||
          (taxRate !== null && (!Number.isInteger(taxRate) || taxRate < 0))) {
        await skipRow(priceCents === null ? 'PRICE_MISSING_OR_UNSUPPORTED' : 'ROW_VALUE_UNSUPPORTED');
        continue;
      }
      if (mixedVatInclusion && taxRate !== null) { await skipRow('MIXED_VAT_INCLUSION_NOT_REPRESENTABLE'); continue; }
      const money = bitrixMoneyToMoySklad(row);
      if (!money) {
        await skipRow('DISCOUNT_OR_VAT_TRANSFORM_UNSUPPORTED');
        continue;
      }

      let targetProductId: string | null = null;
      const productPairs = await this.database.entityPair.findMany({
        where: { entityType: 'PRODUCT', bitrix24Id: productId, active: true },
        select: { moyskladId: true },
        take: 2,
      });
      if (productPairs.length === 1 && isUuid(productPairs[0]?.moyskladId)) targetProductId = productPairs[0].moyskladId;
      else if (productPairs.length === 0) {
        const alias = await this.database.productDuplicateAlias.findUnique({ where: { duplicateBitrix24Id: productId }, select: { id: true, canonicalPairId: true } });
        const canonical = alias ? await this.database.entityPair.findFirst({ where: { id: alias.canonicalPairId, entityType: 'PRODUCT', active: true }, select: { moyskladId: true } }) : null;
        if (!canonical || !isUuid(canonical.moyskladId)) { await skipRow('PRODUCT_PAIR_MISSING'); continue; }
        targetProductId = canonical.moyskladId;
        try {
          await ensureDuplicateAliasDealComment(input.bitrix24DealId, alias!.id, productId, input.eventId, (work) => this.providerModeGate(work));
        } catch {
          await writeOperationalLog(this.database, 'ADMIN', JSON.stringify({
            type: 'PRODUCT_DUPLICATE_ALIAS_TIMELINE_COMMENT_UNAVAILABLE', aliasId: alias!.id,
            dealId: input.bitrix24DealId, duplicateBitrix24Id: productId, eventId: input.eventId,
          }), input.eventId);
        }
        await writeOperationalLog(this.database, 'EVENT', JSON.stringify({ type: 'PRODUCT_DUPLICATE_ALIAS_USED_FOR_DOCUMENT_ROW', eventId: input.eventId, dealId: input.bitrix24DealId, sourceProductId: productId }), input.eventId);
      } else { await skipRow('PRODUCT_PAIR_AMBIGUOUS'); continue; }
      const assortment = await readMoySkladAssortment(targetProductId, (work) => this.providerModeGate(work));
      if (!assortment || assortment.uomId !== unit.moyskladId) { await skipRow('PRODUCT_UNIT_MISMATCH'); continue; }

      rowsPrepared.push({
        assortment: { meta: { type: assortment.type, href: assortment.href } },
        quantity,
        price: money.price,
        discount: money.discount,
        vat: money.vat,
        vatEnabled: money.vatEnabled,
      });
      sourceRowIds.push(rowId);
      sourceRowValues.push({
        productId, measureCode, quantity, price: row.price, priceNetto: row.priceNetto,
        discountTypeId, discountRate, discountSum, taxRate, taxIncluded: row.taxIncluded,
      });
      sourceProductIds.push(productId);
      sourceMeasureCodes.push(measureCode);
    }

    const msBase = moyskladBase();
    const inputPrepared: DealOrderPreparedInput = {
      bitrix24DealId: input.bitrix24DealId,
      bitrix24CompanyId: companyId,
      bitrix24ContactId: contactId,
      confirmedCustomerPairIds,
      serviceCounterpartyId,
      eventId: input.eventId,
      settingsVersion: input.eventConfig.version,
      sourceProductIds,
      sourceRowIds,
      sourceRowValues,
      sourceMeasureCodes,
      skippedRows,
      unitMappings: units.map((unit) => ({ bitrix24Id: unit.bitrix24Id, moyskladId: unit.moyskladId, status: unit.status })),
      payload: {
        agent: { meta: { type: 'counterparty', href: msHref(msBase, `entity/counterparty/${agentCounterpartyId}`) } },
        organization: { meta: { type: 'organization', href: msHref(msBase, `entity/organization/${targetOrganizationId}`) } },
        store: { meta: { type: 'store', href: msHref(msBase, `entity/store/${targetStoreId}`) } },
        state: { meta: { type: 'state', href: msHref(msBase, `entity/customerorder/metadata/states/${stage.moyskladId}`) } },
        owner: { meta: { type: 'employee', href: msHref(msBase, `entity/employee/${targetEmployeeId}`) } },
        rate: { currency: { meta: { type: 'currency', href: msHref(msBase, `entity/currency/${currency.moyskladId}`) } } },
        positions: rowsPrepared,
        ...(vatIncluded === null ? {} : { vatIncluded }),
        ...(preparedAttributes.attributes.length ? { attributes: preparedAttributes.attributes } : {}),
        ...preparedAttributes.nativeFields,
      },
    };
    if (employeeFallbackUsed) await writeOperationalLog(this.database, 'ADMIN', 'Deal order used configured default MySklad responsible', input.bitrix24DealId);
    return { status: 'READY', input: inputPrepared };
  }
}

function prepareMappedAttributes(
  deal: Record<string, unknown>,
  config: VersionedFieldSettingsDto['config'],
  base: URL,
): { attributes: Array<{ meta: { href: string; type: 'attributemetadata'; mediaType: 'application/json' }; value: unknown }>; nativeFields: Record<string, unknown>; skippedOptionalRules: string[] } | null {
  if (config.groups.some((group) => group.entity === 'deals-orders')) return null;
  const activeRules = config.rules.filter((rule) => rule.entity === 'deals-orders' && (rule.bitrix24ToMoysklad.enabled || rule.moyskladToBitrix24.enabled));
  const targets = new Set<string>();
  const attributes: Array<{ meta: { href: string; type: 'attributemetadata'; mediaType: 'application/json' }; value: unknown }> = [];
  const nativeFields: Record<string, unknown> = {};
  const skippedOptionalRules: string[] = [];
  for (const rule of activeRules) {
    if (isQ26PaidSumRule(rule)) {
      if (!isReadOnlyQ26PaidSumRule(rule)) return null;
      continue;
    }
    const attributeId = rule.targetField.match(/^attributes\.([0-9a-f-]{36})$/i)?.[1];
    const value = deal[rule.sourceField];
    if (touchesPlannedDeliveryDateEndpoint(rule.sourceField, rule.targetField) && !isPlannedDeliveryDateMapping(rule.sourceField, rule.targetField)) return null;
    if (touchesExactOptionalStringEndpoint(rule.sourceField, rule.targetField)) {
      if (!isExactOptionalStringMapping(rule.sourceField, rule.targetField) || !rule.bitrix24ToMoysklad.enabled || rule.bitrix24ToMoysklad.transform.kind !== 'copy' ||
          !(value === null || value === undefined || value === '' || typeof value === 'string')) {
        skippedOptionalRules.push(rule.id);
        continue;
      }
      if (targets.has(attributeId!)) return null;
      targets.add(attributeId!);
      attributes.push({
        meta: { href: msHref(base, `entity/customerorder/metadata/attributes/${attributeId}`), type: 'attributemetadata', mediaType: 'application/json' },
        value: value ?? null,
      });
      continue;
    }
    if (isPlannedDeliveryDateMapping(rule.sourceField, rule.targetField)) {
      if (!rule.bitrix24ToMoysklad.enabled || rule.bitrix24ToMoysklad.transform.kind !== 'copy') {
        skippedOptionalRules.push(rule.id);
        continue;
      }
      const normalized = normalizePlannedDeliveryDate(value, 'BITRIX24');
      if (!normalized.supported) { skippedOptionalRules.push(rule.id); continue; }
      if (targets.has(attributeId!)) return null;
      targets.add(attributeId!);
      attributes.push({
        meta: { href: msHref(base, `entity/customerorder/metadata/attributes/${attributeId}`), type: 'attributemetadata', mediaType: 'application/json' },
        value: toMoySkladPlannedDeliveryDate(normalized.value),
      });
      continue;
    }
    const dictionary = config.references.dictionaries.find((entry) => entry.bitrix24Field === rule.sourceField && entry.moyskladAttributeId === attributeId);
    if (dictionary) {
      const contract = dictionary.key === 'service'
        ? ['UF_CRM_1766085949', '42', '0ad997c8-8e75-11e3-1ec9-002590a28eca', 'f0177126-8e74-11e3-b761-002590a28eca']
        : dictionary.key === 'payment-method'
          ? ['UF_CRM_1766072752', '44', 'f214f966-dc1a-11f0-0a80-0ef700278459', '0ecffb86-d8a3-11eb-0a80-0dbc000256e5']
          : null;
      if (!contract || dictionary.bitrix24Field !== contract[0] || dictionary.bitrix24ListId !== contract[1] ||
          dictionary.moyskladAttributeId !== contract[2] || dictionary.moyskladDirectoryId !== contract[3]) return null;
      if (!rule.bitrix24ToMoysklad.enabled || rule.bitrix24ToMoysklad.transform.kind !== 'copy') {
        skippedOptionalRules.push(rule.id);
        continue;
      }
      if (targets.has(attributeId!)) return null;
      let targetValue: { meta: { href: string; type: 'customentity'; mediaType: 'application/json' } } | null = null;
      if (value !== null && value !== undefined && value !== '') {
        const sourceId = typeof value === 'number' && Number.isSafeInteger(value) ? value : typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : null;
        const pair = dictionary.pairs.find((candidate) => candidate.bitrix24Id === sourceId);
        if (!pair) { skippedOptionalRules.push(rule.id); continue; }
        targetValue = { meta: { href: msHref(base, `entity/customentity/${dictionary.moyskladDirectoryId}/${pair.moyskladId}`), type: 'customentity', mediaType: 'application/json' } };
      }
      targets.add(attributeId!);
      attributes.push({
        meta: { href: msHref(base, `entity/customerorder/metadata/attributes/${attributeId}`), type: 'attributemetadata', mediaType: 'application/json' },
        value: targetValue,
      });
      continue;
    }
    if (rule.sourceField === 'UF_CRM_6926D80233F92' && rule.targetField === 'shipmentAddress') {
      if (!rule.bitrix24ToMoysklad.enabled || rule.bitrix24ToMoysklad.transform.kind !== 'copy' ||
          !(value === null || value === undefined || typeof value === 'string')) {
        skippedOptionalRules.push(rule.id);
        continue;
      }
      nativeFields.shipmentAddress = value ?? null;
      continue;
    }
    if (!rule.bitrix24ToMoysklad.enabled || rule.bitrix24ToMoysklad.transform.kind !== 'copy' || !attributeId ||
        !(value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) || targets.has(attributeId)) {
      return null;
    }
    targets.add(attributeId);
    attributes.push({
      meta: { href: msHref(base, `entity/customerorder/metadata/attributes/${attributeId}`), type: 'attributemetadata', mediaType: 'application/json' },
      value: value ?? null,
    });
  }
  return { attributes, nativeFields, skippedOptionalRules };
}

function isQ26PaidSumRule(rule: VersionedFieldSettingsDto['config']['rules'][number]): boolean {
  return rule.sourceField === 'UF_CRM_1782196830070' || rule.targetField === 'payedSum';
}
function touchesExactOptionalStringEndpoint(sourceField: string, targetField: string): boolean {
  return sourceField in EXACT_OPTIONAL_STRING_ATTRIBUTES || Object.values(EXACT_OPTIONAL_STRING_ATTRIBUTES).some((field) => field.toLowerCase() === targetField.toLowerCase());
}
function isExactOptionalStringMapping(sourceField: string, targetField: string): boolean {
  return EXACT_OPTIONAL_STRING_ATTRIBUTES[sourceField]?.toLowerCase() === targetField.toLowerCase();
}
function isReadOnlyQ26PaidSumRule(rule: VersionedFieldSettingsDto['config']['rules'][number]): boolean {
  return rule.sourceField === 'UF_CRM_1782196830070' && rule.targetField === 'payedSum' &&
    !rule.bitrix24ToMoysklad.enabled && rule.moyskladToBitrix24.enabled && rule.moyskladToBitrix24.transform.kind === 'copy';
}

type ProviderModeGate = <T>(work: () => Promise<T>) => Promise<T>;

async function readBitrixDeal(id: string, gate: ProviderModeGate): Promise<Record<string, unknown>> {
  const base = bitrixBase();
  const response = await gate(() => fetch(new URL('crm.deal.get.json', withSlash(base)), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id }),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  }));
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || body.error || !isRecord(body.result)) throw new Error('B24 deal read failed');
  return body.result;
}

async function ensureDuplicateAliasDealComment(dealId: string, aliasId: string, duplicateProductId: string, eventId: string, gate: ProviderModeGate): Promise<void> {
  const marker = `[product-duplicate-alias:${aliasId}]`;
  const base = bitrixBase();
  let complete = false;
  for (let start = 0; start < 1000;) {
    const read = await gate(() => fetch(new URL('crm.timeline.comment.list.json', withSlash(base)), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'filter[ENTITY_ID]': dealId, 'filter[ENTITY_TYPE]': 'deal', select: 'ID,COMMENT', start: String(start) }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    }));
    const body: unknown = await read.json().catch(() => null);
    if (!read.ok || !isRecord(body) || body.error || !Array.isArray(body.result)) throw new Error('B24 deal timeline read failed');
    if (body.result.some((row) => isRecord(row) && typeof row.COMMENT === 'string' && row.COMMENT.includes(marker))) return;
    const next = typeof body.next === 'number' ? body.next : null;
    if (next === null) { complete = true; break; }
    if (!Number.isInteger(next) || next <= start) throw new Error('B24 deal timeline pagination invalid');
    start = next;
  }
  if (!complete) throw new Error('B24 deal timeline pagination incomplete');
  assertApplyExternalWrite('BITRIX24', 'PRODUCT_DUPLICATE_ALIAS_TIMELINE_COMMENT');
  const comment = `${marker} Product row ${duplicateProductId} resolves to the existing canonical product. No duplicate MySklad product was created. Reference event ${eventId}.`;
  const added = await gate(() => fetch(new URL('crm.timeline.comment.add.json', withSlash(base)), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ 'fields[ENTITY_ID]': dealId, 'fields[ENTITY_TYPE]': 'deal', 'fields[COMMENT]': comment }),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  }));
  const addedBody: unknown = await added.json().catch(() => null);
  if (!added.ok || !isRecord(addedBody) || addedBody.error || (typeof addedBody.result !== 'number' && typeof addedBody.result !== 'string')) throw new Error('B24 deal timeline comment write failed');
}

async function readAllBitrixRows(id: string, gate: ProviderModeGate): Promise<Record<string, unknown>[]> {
  const base = bitrixBase();
  const all: Record<string, unknown>[] = [];
  let start = 0;
  let total: number | null = null;
  while (total === null || start < total) {
    const params = new URLSearchParams({ 'filter[=ownerType]': 'D', 'filter[=ownerId]': id, start: String(start) });
    const response = await gate(() => fetch(new URL('crm.item.productrow.list', withSlash(base)), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params,
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    }));
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(body) || body.error || !isRecord(body.result) || !Array.isArray(body.result.productRows) || typeof body.total !== 'number') {
      throw new Error('B24 product rows read failed');
    }
    const page = body.result.productRows;
    if (page.some((row) => !isRecord(row))) throw new Error('B24 product rows are incomplete');
    all.push(...page);
    total = body.total;
    start += page.length;
    if (page.length === 0 && start < total) throw new Error('B24 product-row pagination is incomplete');
    if (all.length > 1000) throw new Error('B24 product rows exceed the MySklad single-document limit');
  }
  return all;
}

async function readMoySkladAssortment(id: string, gate: ProviderModeGate): Promise<{ type: 'product'; uomId: string; href: string } | null> {
  const base = moyskladBase();
  const url = new URL('entity/assortment', withSlash(base));
  url.searchParams.set('filter', `id=${id}`);
  url.searchParams.set('limit', '2');
  const response = await gate(() => fetch(url, { method: 'GET', headers: msHeaders(), redirect: 'error', signal: AbortSignal.timeout(10_000) }));
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || !Array.isArray(body.rows) || body.rows.length !== 1 || !isRecord(body.rows[0])) throw new Error('MySklad assortment read failed');
  const row = body.rows[0];
  const type = isRecord(row.meta) ? row.meta.type : null;
  if (row.id !== id || type !== 'product' || !isRecord(row.uom) || !isUuid(row.uom.id)) return null;
  const href = isRecord(row.meta) && typeof row.meta.href === 'string' ? row.meta.href : '';
  return { type, uomId: row.uom.id, href };
}

async function verifyMySkladReference(type: 'organization' | 'store' | 'employee' | 'currency' | 'state', id: string, gate: ProviderModeGate): Promise<boolean> {
  if (!isUuid(id)) return false;
  const base = moyskladBase();
  const path = type === 'state'
    ? `entity/customerorder/metadata/states/${id}`
    : `entity/${type}/${id}`;
  const response = await gate(() => fetch(new URL(path, withSlash(base)), {
    method: 'GET', headers: msHeaders(), redirect: 'error', signal: AbortSignal.timeout(10_000),
  }));
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || body.id !== id || !isRecord(body.meta)) return false;
  return type === 'state' ? body.meta.type === 'state' : body.meta.type === type;
}

export function readRuntimeReferences(value: unknown): RuntimeReferenceSettings | null {
  if (!isRecord(value) || typeof value.nativeOrderNumberingVerified !== 'boolean' || !isUuid(value.defaultOrganizationId) || !isUuid(value.defaultStoreId) || !isUuid(value.defaultEmployeeId) ||
      !Array.isArray(value.currencies) || !Array.isArray(value.stages) || !Array.isArray(value.organizations) || !Array.isArray(value.stores) || !Array.isArray(value.employees)) return null;
  const currencies = value.currencies.filter((entry): entry is { bitrix24Code: string; moyskladId: string } =>
    isRecord(entry) && typeof entry.bitrix24Code === 'string' && /^[A-Z]{3}$/.test(entry.bitrix24Code) && isUuid(entry.moyskladId));
  const stages = value.stages.filter((entry): entry is { bitrix24StageId: string; moyskladId: string; creationEnabled: boolean } =>
    isRecord(entry) && typeof entry.bitrix24StageId === 'string' && !!entry.bitrix24StageId && isUuid(entry.moyskladId) && typeof entry.creationEnabled === 'boolean');
  const organizations = value.organizations.filter((entry): entry is { bitrix24Id: string; moyskladId: string } =>
    isRecord(entry) && typeof entry.bitrix24Id === 'string' && /^\d{1,20}$/.test(entry.bitrix24Id) && isUuid(entry.moyskladId));
  const stores = value.stores.filter((entry): entry is { bitrix24Id: string; moyskladId: string } =>
    isRecord(entry) && typeof entry.bitrix24Id === 'string' && /^\d{1,20}$/.test(entry.bitrix24Id) && isUuid(entry.moyskladId));
  const employees = value.employees.filter((entry): entry is { bitrix24Id: string; moyskladId: string } =>
    isRecord(entry) && typeof entry.bitrix24Id === 'string' && !!entry.bitrix24Id && isUuid(entry.moyskladId));
  if (currencies.length !== value.currencies.length || stages.length !== value.stages.length || organizations.length !== value.organizations.length || stores.length !== value.stores.length || employees.length !== value.employees.length) return null;
  if (new Set(currencies.map((entry) => entry.bitrix24Code)).size !== currencies.length || new Set(stages.map((entry) => entry.bitrix24StageId)).size !== stages.length ||
      new Set(organizations.map((entry) => entry.bitrix24Id)).size !== organizations.length || new Set(stores.map((entry) => entry.bitrix24Id)).size !== stores.length || new Set(employees.map((entry) => entry.bitrix24Id)).size !== employees.length) return null;
  const defaultProductGroupId = value.defaultProductGroupId === null || value.defaultProductGroupId === undefined ? null : isUuid(value.defaultProductGroupId) ? value.defaultProductGroupId : null;
  return { nativeOrderNumberingVerified: value.nativeOrderNumberingVerified, defaultOrganizationId: value.defaultOrganizationId, defaultStoreId: value.defaultStoreId, defaultEmployeeId: value.defaultEmployeeId, defaultProductGroupId, currencies, stages, organizations, stores, employees };
}

function toMinorUnits(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const decimal = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(decimal)) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function readNumber(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function readString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function readNumericId(value: unknown): string | null { const id = typeof value === 'string' || typeof value === 'number' ? String(value) : ''; return /^\d{1,20}$/.test(id) && id !== '0' ? id : null; }
function readRowId(value: unknown): string | null { const id = typeof value === 'string' || typeof value === 'number' ? String(value) : ''; return /^\d{1,20}$/.test(id) && id !== '0' ? id : null; }
function readOptionalId(value: unknown): string | null { if (value === null || value === undefined || value === '') return null; return readNumericId(value); }
function isUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function bitrixBase(): URL { return configuredBase('BITRIX24_REST_BASE_URL', true); }
function moyskladBase(): URL { return configuredBase('MOYSKLAD_API_BASE_URL', true); }
function configuredBase(name: string, localHttpAllowed: boolean): URL {
  try {
    const url = new URL(process.env[name] ?? '');
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== 'https:' && !(localHttpAllowed && local && url.protocol === 'http:'))) throw new Error();
    return url;
  } catch { throw new Error(`${name} is invalid`); }
}
function withSlash(url: URL): string { return url.href.endsWith('/') ? url.href : `${url.href}/`; }
function msHref(base: URL, path: string): string { return new URL(path, withSlash(base)).href; }
function msHeaders(): HeadersInit { const token = process.env.MOYSKLAD_API_TOKEN; if (!token) throw new Error('MySklad read token unavailable'); return { authorization: `Bearer ${token}`, accept: 'application/json' }; }
