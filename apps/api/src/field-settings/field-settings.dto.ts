import { FieldTransform } from './field-transform';

export type UnitReference = {
  bitrix24Id: number;
  bitrix24Code: string;
  moyskladId: string | null;
  moyskladCode: string | null;
  status: 'configured' | 'unmapped';
};

export type PriceTypeReference = {
  bitrix24Id: number;
  bitrix24Code: string;
  moyskladId: string | null;
  moyskladLabel: string | null;
  status: 'configured' | 'excluded' | 'unmapped';
};

export type DictionaryReference = {
  key: string;
  bitrix24Field: string;
  bitrix24ListId: string;
  moyskladAttributeId: string;
  moyskladDirectoryId: string;
  pairs: Array<{ bitrix24Id: number; moyskladId: string }>;
};

export type NamedReferenceKind = 'employees' | 'currencies' | 'organizations' | 'warehouses' | 'projects' | 'dealStages';
export type NamedReferencePair = {
  kind: NamedReferenceKind;
  bitrix24Id: string;
  bitrix24Label: string;
  moyskladId: string | null;
  moyskladLabel: string | null;
  status: 'suggested' | 'confirmed' | 'unmapped';
};

export type FieldRuleDto = {
  id: string;
  entity: string;
  sourceField: string;
  targetField: string;
  criticality: 'critical' | 'optional' | 'tbd';
  bitrix24ToMoysklad: { enabled: boolean; transform: FieldTransform };
  moyskladToBitrix24: { enabled: boolean; transform: FieldTransform };
};

export type FieldGroupDto = {
  id: string;
  entity: string;
  direction: 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24';
  targetField: string;
  sourceFields: string[];
  criticality: 'critical' | 'optional' | 'tbd';
  transform: { kind: 'join-non-empty'; separator: string } | { kind: 'split-non-empty'; separator: string; valueType: string };
};

export type DealOrderRuntimeDto = {
  nativeOrderNumberingVerified: boolean;
  /** Explicit opt-in to safe stage/store/employee fallbacks; omitted configs retain strict behavior. */
  unmappedReferencePolicy?: 'hold' | 'confirmed-defaults';
  /** Explicitly selected Bitrix24 product catalog for the MS→B24 prerequisite path. */
  bitrix24ProductCatalogId?: string | null;
  /** Optional explicit default Bitrix24 catalog section for newly created products. */
  bitrix24DefaultProductSectionId?: string | null;
  /** MySklad product fields permitted on newly created Bitrix24 product cards. Name is mandatory. */
  moyskladProductFields?: Array<'name' | 'code' | 'description'>;
  defaultOrganizationId: string | null;
  defaultStoreId: string | null;
  defaultEmployeeId: string | null;
  defaultProductGroupId?: string | null;
  currencies: Array<{ bitrix24Code: string; moyskladId: string }>;
  stages: Array<{ bitrix24StageId: string; moyskladId: string; creationEnabled: boolean }>;
  /** Explicit existing-document transitions; independent from creation eligibility. */
  stageTransitions?: {
    bitrix24ToMoysklad: Array<{ bitrix24StageId: string; moyskladId: string }>;
    moyskladToBitrix24: Array<{ bitrix24StageId: string; moyskladId: string }>;
  };
  organizations: Array<{ bitrix24Id: string; moyskladId: string }>;
  stores: Array<{ bitrix24Id: string; moyskladId: string }>;
  employees: Array<{ bitrix24Id: string; moyskladId: string }>;
};

export type ProductCatalogRuntimeDto = {
  bitrix24CatalogId: string | null;
  bitrix24DefaultSectionId?: string | null;
  moyskladFields: Array<'name' | 'code' | 'description'>;
};

/** Explicit binding for child endpoints. IDs are selected by an operator and are never discovered/guessed by runtime. */
export type ClientChildResourceBindingDto = {
  id: string;
  entity: 'companies';
  bitrix24CompanyId: string;
  bitrix24RequisiteId: string;
  moyskladCounterpartyId: string;
  legalFields: Array<{ bitrix24Field: string; moyskladField: string }>;
  bankDetail?: { bitrix24Id: string; moyskladAccountId: string; fields: Array<{ bitrix24Field: string; moyskladField: string }> };
};

export type FieldSettingsConfigDto = {
  schemaVersion: 1;
  /** MoySklad counterparty used only when a newly created customer order has no client. */
  serviceCounterpartyId?: string | null;
  rules: FieldRuleDto[];
  groups: FieldGroupDto[];
  childResourceBindings?: ClientChildResourceBindingDto[];
  references: { units: UnitReference[]; priceTypes: PriceTypeReference[]; dictionaries: DictionaryReference[]; namedPairs?: NamedReferencePair[] };
  productCatalogRuntime?: ProductCatalogRuntimeDto;
  dealOrderRuntime?: DealOrderRuntimeDto;
} & Record<string, unknown>;

export type VersionedFieldSettingsDto = {
  version: number;
  createdAt: string;
  config: FieldSettingsConfigDto;
  references: FieldSettingsConfigDto['references'];
};
