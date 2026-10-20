# Issue #60 controlled live-test plan (prepared, not authorized)

Historical planning snapshot. Its environment/access blockers and runtime implementation state are not current #79 status. For current planned live scenarios, see [Issue #79 scoped live scenarios (2026-10-20)](issue-79-scoped-live-scenarios-2026-10-20.md) and the dated [Issue #79 live preflight](issue-79-live-preflight-2026-10-20.md). This file is retained as historical evidence; it is not proof that any live scenario ran.

Status: planning artifact only. No test records, provider writes, webhooks, service settings, or production traffic have been changed. This document is not permission to enable the general sync flow or perform production cutover.

## Go/no-go gates

Do not schedule live actions until all are true:

1. The final combined candidate has a clean build and passing unit/API/browser suites.
2. All applicable migrations pass on fresh disposable PostgreSQL databases and required persistence, restart, transaction, uniqueness, lease/fencing, recovery, nightly, and lost-response tests pass.
3. An independent reviewer accepts the combined candidate and the full #60 evidence matrix has no mandatory `FAIL`, `BLOCKED`, or `NOT_RUN` rows for the proposed test scope.
4. An owner/operator approves a written change window, named service version/URL, per-scope direction switches, mapping/settings version, stop authority, and the tested procedure for preventing HTMLStudio and background business processes from writing concurrently.
5. The deployed runtime can safely isolate processing to the manifest's unique run ID/test records before any event is accepted. If it cannot, stop: enabling a broad flow is not an acceptable substitute.
6. The operator confirms how each exact test record can be preserved or reversibly restored. No irreversible deletion, bulk cleanup, or deletion of dependent/foreign records is in scope.

Current gate state: **BLOCKED for live acceptance**. Offline build, fake-HTTP/browser slices, and isolated PostgreSQL test schemas have run; these do not prove tenant readiness. A read-only live inventory found the required MySklad invoiceout/service/contactperson webhook subscriptions absent or disabled, Bitrix24 event API returning `WRONG_AUTH_TYPE`, SSH public-key access denied, and no native run-ID isolation. No live-test window is requested or scheduled here; no provider configuration or records were changed.

## Local controlled-write guard implementation status

The isolated candidate now has a schema-backed `ControlledTestAdmission` ledger and a central provider transport guard. Controlled mode requires an explicitly isolated instance, apply mode, an absolute manifest path, and a dedicated local PostgreSQL database plus schema whose exact names match the manifest. The source admission path now covers client, deal/order, invoice, and catalog product/service processors: each current source read is checked against the exact entity/provider/native ID, run marker, and creation boundary before durable admission. Product and invoice target creation bind only after provider readback; deal/order create flows now thread the admitted scope and require exact marker/readback binding. Manifest-declared read-only dependencies are exact provider/entity/native-ID entries and cannot authorize writes. `direction` is enforced (`BITRIX24_TO_MOYSKLAD`, `MOYSKLAD_TO_BITRIX24`, or explicitly approved `BOTH`); source-side writeback is limited to `BOTH`. Normal runtime is unchanged when controlled mode is off.

Controlled mode also gates authenticated webhooks before durable intake and dispatch. Each manifest record intended to receive an event must list exact `allowedActions` (`CREATE` and/or `UPDATE`); absent or invalid action lists fail closed. An exact non-null source native ID is required, and a `BOTH` record needs an exact target native ID before reverse events are admitted. A null target ID may reserve a one-way target create, but never makes an inbound source wildcard. MoySklad batches are filtered per item: only exact manifest matches enter the queue and dispatch; rejected items are acknowledged with a count and no business payload so provider retries do not create a storm. All existing processor source reads/admission, creation marker, boundary, namespace, and final external-write guards still run after intake. This local gate behavior does not prove a provider callback was delivered; live scenarios remain NOT RUN until genuine callbacks are observed.

Offline evidence to date: production and test TypeScript builds pass; client/product/deal source-admission policy tests pass; fake-provider deal/order and invoice processor create paths carry the exact run marker, verify current target readback, durably bind target IDs, and exercise exact-scope echo writes after restart. The invoice processor scenario runs against a fresh schema with all 36 migrations and verifies source admission, explicit linked-order dependency reads, create/readback/bind, and a reverse `BOTH` echo through the real processor. The deal/order create path also reads six explicitly approved dependencies and persists the pair. One fake-provider lifecycle path verifies a deleted synthetic MoySklad order is current-read-confirmed, tombstoned, and annotated only on the exact bound Bitrix deal; deferred marker/timeline recovery also reconstructs scope from the durable admitted pair. The isolated PG schema has all 36 migrations and tests durable admission/binding/restart plus deal/order, invoice, and catalog product admissions. The final transport guard now requires a target-native synthetic name/description marker on CREATE requests and scopes previously unclassified MySklad reference reads to explicit dependencies. Fake-HTTP transport tests exercise exact owner IDs for invoice, deal rows, catalog prices, services, requisites, and timeline comments. The current namespace hardening work adds a manifest-pinned Bitrix24 portal origin and current principal ID plus MySklad account ID, verified at startup using read-only `user.current` and `/context/employee` calls; these identities are persisted with durable admission. Controlled provider URLs require HTTPS, except explicitly enabled loopback-only fake HTTP tests. Until this change and the remaining matrix pass fresh validation and independent review, the harness is not live-ready. The PG tests used only local PostgreSQL and fake provider responses. No live provider traffic, hooks, service settings, deployment, or real CRM writes were performed or authorized.

## Capability/scope restrictions

| Scope | Planned test direction | Restriction |
| --- | --- | --- |
| Contacts/companies | Configured rule/group exchange and matching only within an explicitly approved, isolated synthetic manifest | Code and offline PG fake-provider tests cover configured fields/groups, baseline, pair and readback, but the full client matching/recovery matrix and live tenant behavior are not accepted. No unrelated customer records. |
| Deals/orders | Both directions only after the complete field/reference/stage preflight passes | Use synthetic test records and safe run-ID isolation; no broad event intake. |
| Invoices | Both directions only after explicit approval of the post-launch invoice stage | Parent #1 / `requirements.md` defer invoice exchange after first launch; #60 acceptance testing does not itself lift that production boundary. |
| Product/catalog cards and prices | MySklad → Bitrix24 only | B24 → MySklad product writes remain prohibited. |
| Deal service-dictionary values | Only as part of a separately approved deal/order test and its configured field mapping | Deal/order runtime supports custom service-dictionary values; the separate standalone service-dictionary feed remains unavailable. Catalog service cards are another capability. |

## Synthetic manifest format

The runtime manifest is a restricted, run-specific file. Store no credentials, secret URLs, auth query parameters, customer data, or tokens. It is separate from the operator evidence ledger below. Names and provider IDs shown here are placeholders:

```json
{
  "runId": "LIVE-TEST-<UTC-YYYYMMDDTHHMMSSZ>-<random-suffix>",
  "testDatabaseName": "sync_issue60_test_<unique-suffix>",
  "testSchemaName": "issue60_test_<unique-suffix>",
  "providerNamespace": {
    "bitrix24PortalOrigin": "https://<exact-portal-host>",
    "bitrix24UserId": "<integration-principal-id>",
    "moyskladAccountId": "<account-id-from-context-employee>"
  },
  "records": [
    {
      "entity": "<client:COMPANY|client:CONTACT|deal-order|invoice|catalog-product|catalog-service>",
      "direction": "BITRIX24_TO_MOYSKLAD",
      "name": "тест <runId> <scenario>",
      "syntheticOnly": true,
      "sourceSystem": "BITRIX24",
      "sourceNativeId": "<exact-source-id-required-for-inbound-events>",
      "targetSystem": "MOYSKLAD",
      "targetNativeId": null,
      "allowedActions": ["UPDATE"],
      "createdAfterUtc": "<UTC-run-boundary>",
      "readOnlyDependencies": []
    }
  ]
}
```

The namespace values are identifiers, not credentials. Do not put API tokens,
Bitrix webhook URLs, auth headers, or secret query parameters in this file.
At controlled-mode startup, the configured Bitrix24 base origin must exactly
match the manifest and the current credentials are checked with the read-only
[`user.current`](https://apidocs.bitrix24.ru/api-reference/user/user-current.html)
method. MySklad's read-only `/context/employee` response is checked for its
stable `accountId` (not employee profile data; see the
[official Remap API guide](https://dev.moysklad.ru/doc/api/remap/1.2/)). The
verified portal/principal/account identifiers are stored on each durable
admission and must match on subsequent event processing and restart. Controlled
remote provider base URLs must use HTTPS. Plain HTTP is accepted only when the
explicit fake-provider test switch is enabled and the URL host is loopback;
that switch cannot enable remote HTTP.

`direction` is enforced, not descriptive: use `BITRIX24_TO_MOYSKLAD` or
`MOYSKLAD_TO_BITRIX24` and keep `sourceSystem`/`targetSystem` consistent.
Use `BOTH` only when this exact synthetic pair is explicitly approved for
echo updates in either direction. A one-way record cannot authorize reverse
admission or writes.

An optional `readOnlyDependencies` array may list shared parent/reference
records needed to validate a synthetic target. Each entry requires an exact
provider, entity, and native ID; it authorizes reads only, never writes.

All before/after values must be limited to synthetic fields needed to prove the scenario. Redact unrelated values. A manually posted webhook, direct creation of both provider records, or a mock API response is not evidence of genuine delivery.

## Controlled execution outline (future, after approval)

1. Record the approved SHA, settings version, exact direction list, test window, operator and independent stop authority. Capture a pre-run configuration snapshot without secrets. Keep mode Off until the window and writer exclusion are confirmed.
2. Verify both provider accounts/API access and webhook authentication using non-mutating checks. Confirm preflight per entity and direction; record blockers/warnings and abort if any selected direction is blocked or settings version changes.
3. Create only synthetic records named with `тест` and the unique run ID through ordinary provider UI/API operations approved for that scenario. Never repurpose existing work records. Do not create dependent records outside the manifest.
4. Observe genuine provider-delivered webhooks and trace each through durable queue, current reads, pair resolution, active settings version, provider mutation, readback and journal. Record exact native IDs/URLs and event/correlation IDs in the manifest without secrets.
5. Check idempotent replay/echo and expected field changes only for the approved test pair. If the runtime cannot isolate any unrelated incoming event, stop and leave the live case BLOCKED rather than broadening scope.
6. Do not test irreversible deletion. A reversible tombstone/restore test requires separate explicit approval for each manifest-owned record and a reviewed exact-ID restoration procedure. Never physically delete the partner record as a cleanup shortcut.
7. Return the service to the agreed safe state, verify the prior writer is the sole writer before handback, preserve durable queue/pairs/audit, and retain/archive test records according to operator approval. Do not auto-delete records or clear queues.
8. Have the observer reconcile manifest entries with queue, provider and journal evidence; state explicitly what test records remain. Redact logs and evidence before sharing.

Any unexpected target ID, unrelated record processing, failed readback, second writer, lost run-ID filter, provider outage, or settings drift is a stop condition. Pause first if the scope is safely controlled; otherwise use the approved emergency stop. Preserve evidence and do not improvise rollback or cleanup.
