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

export type FieldRuleDto = {
  id: string;
  entity: string;
  sourceField: string;
  targetField: string;
  bitrix24ToMoysklad: { enabled: boolean; transform: { kind: 'copy' | 'tbd' } };
  moyskladToBitrix24: { enabled: boolean; transform: { kind: 'copy' | 'tbd' } };
};

export type FieldGroupDto = {
  id: string;
  entity: string;
  direction: 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24';
  targetField: string;
  sourceFields: string[];
  transform: { kind: 'join-non-empty'; separator: string };
};

export type FieldSettingsConfigDto = {
  rules: FieldRuleDto[];
  groups: FieldGroupDto[];
  references: { units: UnitReference[]; priceTypes: PriceTypeReference[]; dictionaries: DictionaryReference[] };
} & Record<string, unknown>;

export type VersionedFieldSettingsDto = {
  version: number;
  createdAt: Date;
  config: FieldSettingsConfigDto;
  references: FieldSettingsConfigDto['references'];
};
