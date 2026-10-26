# Warehouse directory maintained by the synchronization service

Status: implemented locally; not deployed or enabled in production. No provider writes were used for verification.

## Shared contract

- Bitrix list `38`, type `rest_entity`, is the existing warehouse directory.
- Its element `CODE` is the native MoySklad `store.id` UUID; `NAME` follows the current MoySklad name.
- Existing element IDs are retained, preserving company/contact/deal selections.
- The product selector consumes `CODE`, validates the UUID against its MoySklad catalog, and selects stock by that UUID. It owns no directory import.
- Updating the directory does not propagate company/contact fields into deals. It also does not create a new warehouse attribute on a MoySklad counterparty or change existing document field mappings.

## Runtime behavior

`WarehouseDirectorySyncService` is registered in the API application. It starts only when `WAREHOUSE_DIRECTORY_SYNC_ENABLED=enabled`, `SYNC_MODE=apply`, and controlled-test mode is disabled. It respects the actual database `serviceMode=on`; every provider request takes the existing service-mode gate. Writes also cross the database-recovery/external-write guard.

The worker reads complete bounded snapshots before planning writes, runs on startup and every five minutes, and performs at most five additions/renames per run. Both catalogs are capped at 1,000 elements. Requests use existing protected provider settings and the existing global MoySklad scheduler; no separate credentials are stored. HTTP redirects are rejected and requests have a ten-second deadline. HTTP 429 retry deadlines are respected by the worker.

Identity matching uses UUID only. A duplicate target UUID is held. An existing unlinked element with the same name causes a warning rather than guessed linkage. Missing and archived sources retain their Bitrix elements; no delete, reassignment, or archive mutation is implemented. Warnings contain codes/IDs, not customer data or credentials.

Adds use the provider's `ELEMENT_CODE` uniqueness. Following a lost acknowledgement, the next run reads the complete list first and adopts the same UUID if present. A competing `ERROR_ELEMENT_ALREADY_EXISTS` result is resolved by exact CODE readback. Other uncertain failures stop the run. Each completed write is verified by native element ID, UUID, and name.

`lists.element.update` replaces configured fields. The worker therefore verifies that this specific directory still has only its configured `NAME` field before writing. If custom fields are added, writes stop with `WAREHOUSE_SCHEMA_UNSUPPORTED`; preservation of those fields must be implemented before resuming.

## Rollout prerequisites

Set `WAREHOUSE_DIRECTORY_SYNC_HELD_IDS=48680,48682` for the initial rollout until their existing identities are resolved. The variable must be explicitly provided; an explicitly empty string is permitted once all holds are resolved. Never rebind them based on name alone.

Current read-only selector-agent observations: 24 Bitrix elements, 23 CODE values matching the current MS collection. Native exact GET now confirms `48680` / CODE `29798f60-4874-11f0-0a80-1b7d002e9c85` is “7_ПВЗ_Краснодар”, HTTP200, archived=true; the active “7_Краснодар” has a different UUID and must not replace it automatically. `48682` is labelled “МагнитМаркет FBO”, while native GET of its CODE `841fa146-6214-11f0-0a80-0e3a00058b40` returns “VR”, HTTP200, archived=false. Both CODEs occur once in the list. Targeted queries of the three warehouse fields found no company/contact/deal referencing either element, but that is not proof of semantic equivalence. Hold both pending owner choice. “WB FBO / Аэросистемы” has no corresponding Bitrix element.

Before production activation: resolve or retain explicit holds, verify the synchronization service's own Bitrix identity can add/update this list, prepare the immutable release/backup, and obtain the deployment window. The selector's local CODE-reading patch also needs its integration verification and rollout. No service rollout, settings save, production mode change, or live test record has been performed by this implementation.

## Verification

API build and test TypeScript compilation passed. `npm run test:warehouse-directory --workspace @sync/api` runs eleven focused checks with intercepted HTTP and no live providers: UUID rename/holds/archive, legacy collisions, create/repeat/rename identity, lost create acknowledgement, competing creation, OFF/dry/disabled/controlled guards, OFF between reads and write, changed schema/incomplete feed, native readback mismatch, duplicate UUID holds, and the five-write cap/explicit hold configuration. These checks do not prove production write permissions or a live Bitrix update's preservation behavior.

Official API contracts: [add](https://apidocs.bitrix24.ru/api-reference/lists/elements/lists-element-add.html), [update and full-field replacement](https://apidocs.bitrix24.ru/api-reference/lists/elements/lists-element-update.html), [get](https://apidocs.bitrix24.ru/api-reference/lists/elements/lists-element-get.html).
