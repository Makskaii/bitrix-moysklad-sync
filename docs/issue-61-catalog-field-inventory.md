# Issue #61: catalog field inventory and runtime coverage

Snapshot date: 2026-10-19. This inventory distinguishes metadata/schema evidence from semantic mapping approval. Nothing in this document creates a default mapping: operators select exact pairs in the catalog field settings UI, and only explicitly enabled `copy` mappings that pass both schemas' scalar-type/writability checks are eligible for product-card runtime writes. Catalog synchronization remains MySklad → Bitrix24 only. Prices and units use their dedicated reference-pair settings; prices are catalog prices, never document rows.

## Sources and evidence limits

- Bitrix24 product schema: `catalog.product.getFieldsByFilter` with the target information-block id; service schema: `catalog.product.service.getFieldsByFilter` with that id. The official methods expose field code, title/type, and `isReadOnly`; the inventory below reflects the read-only account metadata observed on 2026-10-19. A field being writable in that account does not establish a semantic analog.
- [Bitrix24 product field metadata method](https://apidocs.bitrix24.com/api-reference/catalog/product/catalog-product-get-fields-by-filter.html) and [service field metadata method](https://apidocs.bitrix24.com/api-reference/catalog/product/service/catalog-product-service-get-fields-by-filter.html).
- MySklad standard schemas: official [Product API model](https://raw.githubusercontent.com/moysklad/remap-1.2-java-sdk/master/docs/Product.md) and [Service API model](https://raw.githubusercontent.com/moysklad/remap-1.2-java-sdk/master/docs/Service.md). MySklad's `/entity/product/metadata` request returned HTTP 400 during the read-only check, so the standard fields below are from these published API models, not inferred from custom-attribute metadata. Account-level custom attributes must be read separately from the documented metadata attributes endpoint and remain custom candidates.
- [Issue #61](https://github.com/Makskaii/bitrix-moysklad-sync/issues/61) requires a field inventory and confirmed mappings; [issue #56](https://github.com/Makskaii/bitrix-moysklad-sync/issues/56) defines versioned field settings and operator selection. Schema similarity is only a UI suggestion, never an implicit mapping.

## Per-field semantic inventory

`Suggested` means titles/types make the pair useful to show in the UI; it is not enabled until the operator saves it. `Supported` means the generic runtime can execute an explicitly configured direct scalar copy in the allowed direction. `Dedicated` means a separately configured reference mapping is required. `Unmapped` means the API types/semantics are not a safe direct copy; this is not an omission from runtime coverage.

| Bitrix24 product field (API title shown in UI; code is fallback title) | B24 type / writable | MySklad product or service field | MS type / writable | Candidate transform and pairing state | Runtime status / reason |
|---|---|---|---|---|---|
| `name` | string / yes | `name` | string / yes | direct copy; explicit pair required | Supported through required product-name path; no default pair is created |
| `code` | string / yes | `code` | string / yes | direct copy; exact-title suggestion | Supported when explicitly enabled; reverse write only |
| `detailText` | string / yes | `description` | string / yes | direct copy; explicit pair required | Supported when explicitly enabled; reverse write only |
| `weight` | double / yes | `weight` (product only) | double / yes | exact scalar analog; explicit pair required | Supported by generic typed mapping; product only |
| `xmlId` | string / yes | `externalCode` | string / yes | identity-like labels, but unsafe to map | Reserved: `xmlId` is the durable create/recovery key and is never selectable or writable by generic mappings |
| `measure` | integer reference / yes | `uom` | object reference / yes | dedicated configured unit pair, never scalar copy | Dedicated; only approved unit-reference pairs resolve it |
| `price` / `catalog.price` rows | catalog price collection | `salePrices` | array | configured price-type and currency reference pairs | Dedicated catalog price path; never existing deal/order rows |
| `property118` (article property in observed catalog) | productproperty / yes | `article` | string / yes | no direct scalar type pairing | Unmapped: requires a separately defined extraction/transform; generic copy rejects it |
| `barcodeMulti` | char / yes | `barcodes` | array / yes | scalar/array mismatch | Unmapped: multiple-barcode collection needs a dedicated transform |
| `active` | char / yes | `archived` | boolean / yes | inverse lifecycle semantics | Unmapped: copy would invert meaning; transform is not implemented |
| `vatId` | integer reference / yes | `vat` | integer rate / yes | ID versus rate/reference mismatch | Unmapped: resolve exact VAT dictionary identity before any transform |
| `vatIncluded` | char / yes | `vatEnabled` | boolean / yes | similar label, different API semantics | Unmapped: no direct semantic equivalence established |
| `width`, `height`, `length` | double / yes | no standard counterpart | — | no exact standard analog | Unmapped; no write |
| `quantity`, `quantityReserved`, `quantityTrace`, `available` | double/char / varies | no product-card scalar analog | — | inventory/availability state | Excluded from field-copy runtime; no inventory writes |
| `detailPicture`, `previewPicture` | file / yes | `images` | array / yes | file versus image collection | Unmapped for this iteration; no image writes |
| `iblockSection`, `iblockSectionId` | list/integer / yes | `productFolder` | object / yes | hierarchy/reference mismatch | Out of scope; no group/hierarchy writes |

Reference coverage is kept separate from these field-copy rules: 9 configured unit pairs plus 3 explicitly unmapped units; 7 configured price-type pairs plus excluded/non-mapped price types. The runtime requires an exact configured pair and matching currency for a price write. No pair is inferred from a label at event time.

## Complete Bitrix24 field schema observed

The provider field selector reads the actual target product and service schemas, merges their codes, API titles (or code fallback), types, writability, and resource kind, and validates saved target fields against the selected catalog kind. These field codes are the display title fallback where the provider schema does not supply a separate localized title. Product fields were:

| Code | Type | Writable |
|---|---|---|
| `active` | char | yes |
| `available` | char | no |
| `barcodeMulti` | char | yes |
| `bundle` | char | no |
| `canBuyZero` | char | yes |
| `code` | string | yes |
| `createdBy` | integer | yes |
| `dateActiveFrom` | datetime | yes |
| `dateActiveTo` | datetime | yes |
| `dateCreate` | datetime | yes |
| `detailPicture` | file | yes |
| `detailText` | string | yes |
| `detailTextType` | string | yes |
| `height` | double | yes |
| `iblockId` | integer | yes |
| `iblockSection` | list | yes |
| `iblockSectionId` | integer | yes |
| `id` | integer | no |
| `length` | double | yes |
| `measure` | integer | yes |
| `modifiedBy` | integer | yes |
| `name` | string | yes |
| `negativeAmountTrace` | char | no |
| `previewPicture` | file | yes |
| `previewText` | string | yes |
| `previewTextType` | string | yes |
| `priceType` | char | yes |
| `property44`, `property108`, `property110`, `property112`, `property118`, `property120`, `property312`, `property314`, `property316` | productproperty | yes |
| `purchasingCurrency` | string | yes |
| `purchasingPrice` | string | yes |
| `quantity` | double | yes |
| `quantityReserved` | double | yes |
| `quantityTrace` | char | yes |
| `recurSchemeLength` | integer | yes |
| `recurSchemeType` | char | yes |
| `sort` | integer | yes |
| `subscribe` | char | yes |
| `timestampX` | datetime | yes |
| `trialPriceId` | integer | yes |
| `type` | integer | no |
| `vatId` | integer | yes |
| `vatIncluded` | char | yes |
| `weight` | double | yes |
| `width` | double | yes |
| `withoutOrder` | char | yes |
| `xmlId` | string | yes (integration-reserved) |

Service fields were:

| Code | Type | Writable |
|---|---|---|
| `active` | char | yes |
| `available` | char | yes |
| `bundle` | char | no |
| `code` | string | yes |
| `createdBy` | integer | yes |
| `dateActiveFrom` | datetime | yes |
| `dateActiveTo` | datetime | yes |
| `dateCreate` | datetime | yes |
| `detailPicture` | file | yes |
| `detailText` | string | yes |
| `detailTextType` | string | yes |
| `iblockId` | integer | yes |
| `iblockSection` | list | yes |
| `iblockSectionId` | integer | yes |
| `id` | integer | no |
| `measure` | integer | yes |
| `modifiedBy` | integer | yes |
| `name` | string | yes |
| `previewPicture` | file | yes |
| `previewText` | string | yes |
| `previewTextType` | string | yes |
| `priceType` | char | yes |
| `property44`, `property108`, `property110`, `property112`, `property118`, `property120`, `property312`, `property314`, `property316` | productproperty | yes |
| `sort` | integer | yes |
| `timestampX` | datetime | yes |
| `type` | integer | no |
| `vatId` | integer | yes |
| `vatIncluded` | char | yes |
| `xmlId` | string | yes (integration-reserved) |

Provider metadata is account/catalog specific; these lists are a dated observed snapshot, not hardcoded schema truth. Fields absent from a selected resource or not writable there are rejected at save/create time. Custom `property*` fields are exposed with live metadata but have no generic scalar mapping because their API type is `productproperty`.

## Complete MySklad standard field candidates

The field selector exposes schema-backed standard candidates with their localized display titles, codes, API type/writability, and resource from the official Product/Service models. Resource is included because some fields are product-only. `unknown` means the schema declares a structured/object-like value for which direct scalar mapping is deliberately unavailable.

| Code | API type | Writable in model | Resource | Pairing/runtime status |
|---|---|---:|---|---|
| `meta` | object | no | product/service | read-only; never a field mapping |
| `id` | uuid | no | product/service | read-only; never a field mapping |
| `accountId` | uuid | no | product/service | read-only; never a field mapping |
| `name` | string | yes | product/service | explicit direct candidate; dedicated required-name behavior |
| `code` | string | yes | product/service | explicit direct candidate |
| `externalCode` | string | yes | product/service | candidate identity field; never map to reserved `xmlId`; may only be selected with a separately confirmed non-identity B24 target |
| `article` | string | yes | product only | candidate exists; B24 observed counterpart is complex `productproperty`, so no scalar mapping |
| `description` | string | yes | product/service | explicit direct candidate with B24 `detailText` |
| `archived` | boolean | yes | product/service | no direct counterpart (`active` is inverse) |
| `vat` | integer | yes | product/service | no direct B24 target (rate versus `vatId`) |
| `vatEnabled` | boolean | yes | product/service | no direct B24 analog confirmed |
| `useParentVat` | boolean | yes | product/service | no B24 standard analog |
| `effectiveVat` | integer | no | product/service | derived/read-only |
| `effectiveVatEnabled` | boolean | no | product/service | derived/read-only |
| `discountProhibited` | boolean | yes | product/service | no exact B24 standard analog |
| `updated` | datetime | no | product/service | read-only timestamp |
| `weight` | double | yes | product only | exact scalar candidate with B24 product `weight`; generic runtime supports when selected |
| `volume` | double | yes | product only | no B24 standard analog |
| `buyPrice` | object | yes | product/service | structured purchase price; not catalog sale-price mapping |
| `salePrices` | array | yes | product/service | dedicated catalog price mapping only |
| `supplier` | object | yes | product/service | no direct scalar analog |
| `country` | object | yes | product only | reference; no direct scalar analog |
| `uom` | object | yes | product/service | dedicated unit-reference mapping only |
| `productFolder` | object | yes | product/service | hierarchy explicitly out of scope |
| `pathName` | string | no | product/service | derived hierarchy path |
| `images` | array | yes | product only | image collection explicitly deferred |
| `files` | array | yes | product/service | no B24 standard analog |
| `barcodes` | array | yes | product/service | no direct scalar mapping to `barcodeMulti` |
| `packs` | array | yes | product only | structured packaging data |
| `trackingType` | string | yes | product only | no B24 standard analog |
| `tnved` | string | yes | product only | no exact B24 standard analog |
| `paymentItemType` | string | yes | product/service | duplicate candidate entries are collapsed in API output |
| `taxSystem` | string | yes | product/service | no exact B24 standard analog |
| `attributes` | array | account-specific | product/service | custom metadata; requires custom-field schema/transform |
| `minimumStock` | object | yes | product only | structured minimum-stock setting; not a direct scalar mapping |
| `minPrice` | object | yes | product/service | structured price; not a catalog price type |
| `weighed` | boolean | yes | product only | no B24 standard analog |
| `onTap` | boolean | yes | product only | no B24 standard analog |
| `partialDisposal` | boolean | yes | product only | no B24 standard analog |
| `things` | array | yes | product only | serial-number collection; excluded |
| `syncId` | uuid | yes | product/service | no B24 standard analog |
| `ppeType` | string | yes | product only | no B24 standard analog |
| `alcoholic` | object | yes | product only | structured domain object |
| `tobacco` | boolean | no | product only | model read-only; never target |
| `variantsCount` | integer | no | product only | derived/read-only |
| `isSerialTrackable` | boolean | yes | product only | no exact B24 standard analog |
| `shared` | boolean | yes | product/service | ownership/sharing metadata, not catalog field-copy scope |
| `owner` | object | yes | product/service | reference/ownership metadata, not catalog field-copy scope |
| `group` | object | yes | product/service | reference/ownership metadata, not catalog field-copy scope |

The metadata-backed dropdown can expose these candidates for operator review, but the product runtime accepts only selected `copy` rules whose live Bitrix24 side is writable and whose two API types resolve to a supported scalar family. Custom properties remain visible metadata but are rejected by the standard scalar rule validator until a dedicated custom-field adapter exists. Object, array, productproperty, `char` (ambiguous flags), unknown, read-only, mismatched, custom, and unselected fields cannot produce a write. Zero, `false`, and empty string remain valid configured scalar values; null/absent values do not erase the destination.

## Coverage and outstanding decisions

The implementation covers configured direct scalar field pairs generically (not only the legacy three fields), keeps unit and catalog price references in dedicated paths, and durably verifies product creation/recovery against all configured scalar fields. There are no seeded/default field pairings. Unresolved mappings are limited to fields with documented semantic, type, reference, or resource uncertainty listed above; they are visible candidates with a reason, not silently treated as confirmed or as unimplemented scalar coverage.
