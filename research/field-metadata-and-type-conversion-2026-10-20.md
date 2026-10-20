# Field labels, metadata, and safe type conversion

Reviewed snapshot: a8f86391ce2ed8ee95242cea0a7c825f99155de3 (20 Oct 2026). This is source/documentation research only: no live provider calls, writes, setting changes, or deployments. I inspected the React form source; I did not run a browser rendering or interaction test.

## Why dropdown options can show codes

There are two different cases:

1. The form intentionally appends each technical field code after its title: title · code · type · writeability (plus resource/reserved status where applicable). The code is the persisted selector value and remains visible to distinguish similar labels.
2. The metadata API may itself return a code-like title, or no title. Then both the title position and code position look technical. A saved rule whose code is absent from the current metadata is rendered as a code-only fallback.

Current provider behavior:

- Contacts, companies, and deals call the matching crm.*.fields method and crm.*.userfield.list with filter[LANG]=ru. Rows are joined only by exact FIELD_NAME. The chosen userfield label is the first non-code value among EDIT_FORM_LABEL, LIST_COLUMN_LABEL, LIST_FILTER_LABEL; language maps prefer ru, ru-RU, en, then the first string. If none exists, it falls back to the CRM descriptor title/label properties, then to the code. See apps/api/src/field-settings/read-only-field-data.provider.ts:367-397,456-490.
- Official CRM field descriptors also expose an isMultiple flag (and entity/status metadata); current FieldCandidate retains only code/title/type/writable/category, so the form loses that cardinality metadata. Userfield responses separately expose MULTIPLE and enum LIST settings, but the resolver currently merges labels only. Official docs mark legacy crm.contact.fields and crm.company.fields deprecated in favor of crm.item.fields, while the current resolver still uses them for existing supported entities.
- Pagination for user-field lists is strict: repeating/non-advancing cursors, malformed rows, inconsistent totals, premature termination, or page overflow fail the catalog request rather than returning partial metadata. See bitrixUserFieldList in the same file.
- Product/service catalog fields are read from catalog.catalog.list and catalog.product.getFieldsByFilter / catalog.product.service.getFieldsByFilter. The CRM userfield label merge is not applied to property* fields; title depends on product schema, with code fallback. Smart invoices use crm.item.fields and have no separate userfield label-list method in this resolver.
- MoySklad custom labels use row.name from /entity/{resource}/metadata/attributes and code attributes.<UUID>. Standard labels come from the local per-entity table moyskladStandardFields, not a live localization lookup.
- The resolver does not synthesize human labels by parsing UF_CRM_*, property* or UUID codes. If no authoritative label exists, the technical code remains and automatic matching suppresses code/generic titles.

The earlier account-specific read-only investigation in research/issue-10-field-labels.md observed that many crm.*.fields custom-field titles equaled UF_CRM_* codes while corresponding crm.*.userfield.list labels supplied human names. Those counts are dated observations, not a current-tenant guarantee.

Official references:

- Bitrix24 crm.contact.fields: https://apidocs.bitrix24.com/api-reference/crm/contacts/crm-contact-fields.html
- Bitrix24 crm.company.fields: https://apidocs.bitrix24.com/api-reference/crm/companies/crm-company-fields.html
- Bitrix24 crm.deal.fields: https://apidocs.bitrix24.com/api-reference/crm/deals/crm-deal-fields.html
- Bitrix24 entity-specific userfield lists: https://apidocs.bitrix24.com/api-reference/crm/contacts/userfield/crm-contact-userfield-list.html ; https://apidocs.bitrix24.com/api-reference/crm/companies/userfields/crm-company-userfield-list.html ; https://apidocs.bitrix24.com/api-reference/crm/deals/user-defined-fields/crm-deal-userfield-list.html
- Bitrix24 universal CRM field schema: https://apidocs.bitrix24.com/api-reference/crm/universal/crm-item-fields.html
- Bitrix24 list pagination: https://apidocs.bitrix24.com/settings/how-to-call-rest-api/list-methods-pecularities.html
- Bitrix24 product/service schemas: https://apidocs.bitrix24.com/api-reference/catalog/product/catalog-product-get-fields-by-filter.html ; https://apidocs.bitrix24.com/api-reference/catalog/product/service/catalog-product-service-get-fields-by-filter.html
- MoySklad Remap API and official examples: https://dev.moysklad.ru/doc/api/remap/1.2/ ; https://dev.moysklad.ru/doc/api/vendor/1.0/

## Current form and runtime behavior

The UI saves field codes, never display titles. Automatic matching is a draft convenience: it separates standard/custom candidates, ignores blank/code/generic labels, requires unique normalized titles on both sides and compatible type strings, and excludes fields already used. Directions remain disabled and transforms remain tbd until explicitly selected; saving is a separate action. See apps/web/src/field-settings.tsx:118-198, 498-520, 609-640.

For catalog rules, save-time validation groups scalar type names as string, number, boolean, or datetime; it refuses char, enum, object, array, references, unknowns and catalog custom fields for generic scalar copy. Catalog B24-to-MoySklad writes are rejected. Product-card generic mapping accepts finite scalar JSON values; unit and price references use separate configured mappings. See apps/api/src/field-settings/field-settings.service.ts:218-261, 483-497 and apps/api/src/products/product-card-sync.service.ts:339-360.

For non-catalog CRM fields, validation checks that fields exist and target writability but does not perform the catalog type-family check. transformField implements copy as raw value pass-through, not a conversion engine; null/absent is treated as no value. join-non-empty stringifies non-null primitive parts, trims/drops blanks and joins them. split-non-empty stringifies/splits values and emits Bitrix-style {VALUE, VALUE_TYPE} entries only for the configured MoySklad-to-Bitrix24 direction and explicit value type. See apps/api/src/field-settings/field-settings.service.ts:222-260, 364-410.

Unresolved metadata detail: MoySklad custom candidates have writable=null because this resolver does not derive their writability. The API validator rejects writable=false; for Bitrix targets it requires writable=true, but for a MoySklad target null is not rejected by that predicate. This does not establish that every custom attribute is writable. It is an explicit validation-policy gap to decide, not proof of a particular live failure.

## Type and shape matrix

| Type/shape | Current representation/behavior | Conservative safe posture | Explicit semantics needed for conversion |
|---|---|---|---|
| String/text | Usually JSON string; copy passes unchanged. | Copy only after semantic equivalence is confirmed. Preserve numeric-looking identifiers and leading zeros as strings. | Trimming, case normalization, truncation, string↔number parsing. |
| Integer/decimal/double | Catalog validation groups all numeric type names; runtime copies raw values and product scalar comparison requires same JSON primitive type. | “Number” family is not proof of matching range, scale, units, or integral constraint. Reject invalid/non-finite values. | Decimal scale, rounding, truncation, overflow, units/currency, string parsing. |
| Date/datetime | Catalog validation treats date and datetime as one family; copy does not normalize formats/timezones. | Preserve only when date/instant and timezone semantics match. | Date-only vs instant, timezone, precision, locale parsing. |
| Boolean / flag char | Boolean types are separate; Bitrix char is deliberately not inferred as Boolean. | Boolean→Boolean only. Never rely on truthiness: \"N\" is truthy. | Explicit reversible mapping for Y/N, 1/0, or enum flags. |
| Multiple values / arrays | Official Bitrix field descriptors expose isMultiple; userfield metadata exposes MULTIPLE. Current FieldCandidate omits cardinality, and the resolver discards MULTIPLE/enum options. Product generic mapping accepts only scalars; non-catalog copy is raw. | Shape-aware adapter and matching cardinality required; do not flatten/stringify arrays or objects. | Ordering, duplicates, empty/null semantics, element type, collection endpoint. |
| Enum/list | Official B24 userfield metadata exposes list metadata (LIST / option configuration), but current resolver merges labels only, not option IDs/values or cardinality. MoySklad companyType is described as enum, with no value map created here. | Require a versioned exact source-option → target-option map; do not infer from equal labels or IDs. | New/missing option policy; unmapped value should block/hold, not substitute. |
| Reference/foreign ID | B24 IDs may be numeric/string; MoySklad references are commonly UUID/meta objects. Units, price types, named references/stages use dedicated configured mappings. | Resolve exact resource and configured mapping; verify identity. No implicit Number/String coercion or label-based guess. | Missing/duplicate/stale mapping behavior. |
| Object/nested value | MySklad references, prices, owner/group are structured; generic product scalar mapping rejects objects. | Dedicated resource adapter only. | Nested allowlist, ownership, identity, readback and transaction semantics. |
| Composite/group | join-non-empty stringifies primitive values. split-non-empty emits typed B24 multi-value entries in one direction. | Only explicit group transform with confirmed field shape; unsupported inputs mean visible error/no write. | Separator/escaping, array semantics, duplicates, value type, empty result. |
| Missing/null/empty | Simple copy does not clear on null/absence; product scalar logic preserves false and 0. | Keep null, missing, false, zero and empty string distinct. | Clearing requires explicit clear semantics and audit/review. |

The UI only offers copy and tbd for simple rules; it has no number/date/enum conversion controls. Catalog type-family validation is coarse and does not prove raw copy semantics; non-catalog simple rules do less type validation. A conservative option is exact normalized type/shape for automatic suggestions, draft-only manual mismatches, and explicitly named transforms with strict parse/range/timezone/value-map validation. Whether to migrate or tighten existing mappings is a product/data policy decision and is not made here.

## Bitrix24 product/price events and reasserting B24 from MySklad

The current implementation cannot use a Bitrix product/price event to trigger a MySklad-authoritative reassertion into Bitrix24:

- receiveBitrix24 classifies product and catalog-price events as products-variations:bitrix24ToMoysklad and unconditionally marks that direction disabled.
- ProductCardEventProcessor calls runtime.preflight('BITRIX24') before resolving the product/pair; ProductCardRuntimeService.preflight immediately returns SKIPPED_DIRECTION_DISABLED for Bitrix sources.
- The processor therefore does not resolve/read the pair or issue a MySklad-read → Bitrix-write reconciliation for that event.

This is consistent with the current issue-60 cutover runbook's stated catalog boundary (MySklad → B24 only; B24 → MySklad product writes prohibited), but it means “restore/reassert B24 from MySklad after a B24 edit” is not an implemented inbound signal path. Do not enable B24→MySklad to emulate it: that is the opposite write operation. If needed, it requires a separately modeled signal-to-MySklad-authoritative-reconciliation path and its own cycle/auth policy. Relevant code: apps/api/src/events.controller.ts:68-79,419-435; apps/api/src/products/product-card-event.processor.ts:127-145; apps/api/src/products/product-card-runtime.service.ts:41-61. Runbook: docs/issue-60-cutover-runbook.md:12.

Recognizing event names in code does not prove a tenant has installed/bound the event subscription. Official Bitrix docs say product events are registered through the application/event.bind flow and require catalog scope; price events have their own catalog event contracts. No tenant subscription was inspected here. Do not promise live delivery based on the code's event-name switch.

Official event references:

- Products: https://apidocs.bitrix24.com/api-reference/catalog/product/events/index.html and https://apidocs.bitrix24.com/api-reference/catalog/product/events/catalog-product-on-update.html
- Prices: https://apidocs.bitrix24.com/api-reference/catalog/price/index.html and https://apidocs.bitrix24.com/api-reference/catalog/price/events/catalog-price-on-update.html

## Explicit error-policy options

- Metadata failure: preserve current fail-closed behavior for malformed/paginated Bitrix userfield lists; distinguish missing label (code fallback) from incomplete/failed schema; do not fabricate labels.
- Type/shape mismatch: reject save/preview before writes or keep tbd draft-only. Never silently stringify, parse, round, flatten, or map enum/reference values by title.
- Invalid runtime value or absent mapping: surface a reason and hold/manual-review with zero external mutation. Optional/critical handling must follow explicit field policy, not a label.
- Missing/null target values: current copy does not clear. Any future clear behavior needs an explicit transform/policy.
- Enum/reference miss: no first/closest-label fallback; require exact configured map or leave unresolved.

## Evidence boundary

This is code and documentation research at the pinned SHA, not a live-provider schema check, browser QA run, mapping approval, or write test. Official documentation establishes method metadata/event contracts, not tenant-specific labels, permissions, semantic equivalence, enabled subscriptions, or successful writes. No implicit conversion or product policy is approved by this report.
