# Issue #60 controlled cutover runbook

Status: procedure prepared; a production cutover is not approved by this document. The combined candidate has not passed the required isolated PostgreSQL suite. Do not perform real provider writes or enable the general production flow until that evidence exists and the owner approves a scoped live-test plan.

## Capability and direction matrix

| Scope | Capability status | Direction | Required enable-time checks |
| --- | --- | --- | --- |
| Contacts and companies | Implemented handler capability: configured field rules/groups, baseline/readback, runtime pair creation and contact dependencies; end-to-end acceptance remains pending | B24 → MySklad; MySklad → B24 | Active field settings, current API reads, incoming webhook authentication, and critical field mappings. Capability status does not certify every scenario or live-provider behavior. |
| Deals and customer orders | Implemented; full end-to-end acceptance is pending | Both directions | Active runtime values; confirmed pair for every currently applicable stage and currency; native order numbering confirmation; organization, store and employee values used by the order-create API; current provider reads; incoming webhook authentication; critical field mappings. |
| Smart invoices and invoiceout | Implemented; PostgreSQL and full scenario acceptance are pending | Both directions | Active invoice settings and critical mappings; current invoice metadata reads; incoming webhook authentication. Runtime still requires the invoice to point unambiguously to a confirmed in-scope order pair. |
| Product and service cards/catalog prices | Implemented only MySklad → B24; full acceptance is pending | MySklad → B24 only | Active catalog settings, selected live B24 catalog, mapped current MySklad units, current provider reads and MySklad webhook authentication. B24 → MySklad product writes are prohibited. |
| Standalone service-dictionary feed (outside deal/order fields) | Missing | Disabled | This separate scope is not enableable. Custom service-dictionary values configured on deal/order fields are handled by the deal/order settings/runtime and are not the missing standalone feed. |

Unconfigured optional references are shown as warnings. A value required by the selected operation is a blocker (for example, order creation values, stage/currency mappings, or a product catalog/unit). The admin preflight endpoint is `GET /api/admin/sync-mode/entities/{entityKey}/preflight?direction={bitrix24ToMoysklad|moyskladToBitrix24}`. It returns a settings version, blockers and warnings without returning credentials. The subsequent direction `PATCH` repeats preflight on the server; a stale or failed check cannot silently enable the direction.

## Local verification

Run from the repository root against local dependencies:

```powershell
npm run build
npm run test:sync-mode-unit --workspace @sync/api
npm run test:sync-mode-preflight-unit --workspace @sync/api
npm run test:fake-provider-e2e --workspace @sync/api
```

PostgreSQL checks must use a fresh disposable database whose name is visibly test-only. Do not point any test at a production or shared database. Run the full candidate test list from `docs/acceptance-matrix-55-57-61.md`; a Docker-unavailable result is BLOCKED, not PASS. Unit/fake-provider results alone do not satisfy #60 acceptance.

## Separate launch boundary

Before a working launch, an administrator must use the separate database-continuity confirmation and provide the exact boundary from an independent operations record, confirm the surviving pairs, and acknowledge the limits of recoverability. This action is audited and leaves the service Off. A mode transition to On never creates or changes the boundary. Pause, Off, resume and process restart do not move it. Events for documents created before the boundary are not replayed as catch-up history. Do not use a test-ON as launch confirmation.

## Future controlled live test — currently blocked

This section becomes actionable only after all isolated PostgreSQL/schema/restart checks pass and the owner approves a written scope plan. A safe tenant-level filter for arbitrary real records has not yet been demonstrated and accepted; if the chosen environment cannot isolate the run by test IDs and prevent unrelated records from being processed, mark the live scenario BLOCKED instead of enabling a broad stream.

The approved plan must name the exact service URL/version, entity and direction switches, test window, webhook matrix, mapping version, operator, independent stop authority, and how HTMLStudio and background business processes are prevented from writing during the run. Use synthetic data only. Give every test record `тест` in its name and a unique run ID. Keep a restricted manifest of the run ID, both native IDs/URLs, pair IDs, expected changes, owner and final disposition; never store credentials or personal customer data in it.

Only ordinary UI/API-created test records and genuine provider-delivered webhooks count as live evidence. Record the queue item/correlation ID, current reads, pair and settings version, write result, readback and journal entry. A manually fabricated webhook does not prove provider delivery. Do not modify work records. Test deletion/restore only on manifest-owned records after an approved reversible procedure; no bulk or irreversible cleanup is authorized here. Keep test records or archive them under the approved operator procedure and record what remains.

## Stop and return

If any provider write, readback, pair resolution or event ownership is unexpected, set the service to Pause first. Pause retains durably accepted queue rows and stops processing; inspect the queue and audit before deciding whether to resume or go Off. Off stops intake and does not replay the Off interval. Preserve queue rows and confirmed pairs for investigation. Before returning ownership to HTMLStudio, verify the service is Off and its event intake is no longer a writer; only then restore the prior writer according to the approved plan. Never leave both writers active. Do not clear the queue, delete pairs, replay history or unregister production webhooks as an improvised rollback.

The owner must explicitly authorize any production cutover. This runbook does not publish endpoints, register live webhooks, or switch real business traffic.
