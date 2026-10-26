# Company price type

User requested an editable company price-type dropdown, provider catalog maintenance, and transfer of the choice to the linked MoySklad counterparty. The selector owner handles initial selection in the product-picker application after this contract is available.

## Native configuration

Created company field `UF_CRM_MS_PRICE_TYPE`, final ID1424, marker XML_ID `MOYSKLAD_COMPANY_PRICE_TYPE`, `iblock_element`, single, editable, not mandatory, DISPLAY LIST/LIST_HEIGHT1. Label “Тип цены (МойСклад)”. Its directory is list108, type `lists`, code `BMS_PRICE_TYPES_20261026`; twelve elements store `CODE=MS priceType.id`, `NAME=current name`. Native element IDs699704–699726 were verified. The field was added to the common company card with all prior sections/fields/options retained (native comparison ignores JSON key order).

An initial empty enumeration draft ID1422 was replaced before use: its XML_IDs were visible only via `userfieldconfig.get`, requiring additional privileges from the selector. Native usage count was0, no config rule or picker deployment referenced it. Only that owned empty draft was removed, with snapshot and one-shot fences. The final directory-based contract uses the selector's existing `lists` scope and requires no scope change or new authorization.

The old company string field `UF_CRM_1722281911` (ID260) is populated on one company and remains intact. It is not in active sync mappings and the picker does not read it; no claim of global non-use is made. No field was created on contacts, since the requested primary entity is company. No legacy MS custom attributes were deleted or rewritten.

## Runtime

`CompanyPriceTypeDirectoryService`, explicitly enabled by `COMPANY_PRICE_TYPE_SYNC_ENABLED=enabled`, maintains directory108 every five minutes while semantic ON/apply, at most five mutations per pass. It verifies the field ownership marker/IBLOCK and NAME-only directory schema, uses exact native UUIDs, preserves element IDs and absent legacy variants, adds new elements and updates names. It does not modify company records or product catalog price mappings. Controlled/dry/OFF skips, per-request ON/recovery guards and Retry-After protections apply.

The client gateway reads selected element→CODE UUID through field metadata and directory108 with a bounded cache and immediate refresh on unknown element IDs. The reserved `price-type-uuid` transform is permitted only for `companies:UF_CRM_MS_PRICE_TYPE → priceType`, single-valued, verified price reference types. No type/name guessing or additional reverse mapping is enabled. Null/blank selection preserves the MS value. Native counterparty `priceType` references are serialized using the exact configured `context/companysettings/pricetype/UUID` URL and normalized by UUID for baseline/readback comparisons. A missing or contradictory native reference is rejected. CREATE and UPDATE paths both use the adapter.

One optional forward rule is required in the normal field settings. It has constant semantics independent of additions/renames in the price-type catalog, so those catalog changes do not create new settings revisions. Company events use the existing queue, pair ownership locks, settings pinning and readback. Existing customer records are not bulk backfilled by the option worker.

## Verification before rollout

API/web builds and test TypeScript passed. Eight new focused checks cover metadata/UUID validation, stable option updates, native reference encoding/readback, empty choice, actual client adapter, OFF/dry/controlled guards, incompatible mapping rejection, and intercepted-HTTP option maintenance. Five existing field-transform/group tests and15 candidate-gateway tests passed. No production value transfer or field-config save has yet been performed. Live acceptance will use an owned synthetic company/pair only.

References: [official MS Counterparty model](https://raw.githubusercontent.com/moysklad/php-remap-1.2-sdk/master/docs/Model/Counterparty.md), [official PriceType model](https://raw.githubusercontent.com/moysklad/php-remap-1.2-sdk/master/docs/Model/PriceType.md), [Bitrix list creation](https://apidocs.bitrix24.ru/api-reference/lists/lists/lists-add.html).
