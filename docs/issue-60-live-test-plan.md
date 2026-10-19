# Issue #60 controlled live-test plan (prepared, not authorized)

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

The isolated candidate now has a schema-backed `ControlledTestAdmission` ledger and a source-admission path for the client vertical. Its event worker freshly reads the source, verifies the provider-returned native ID, exact manifest entity/system/ID/name and creation boundary, then persists the admission before proceeding. A manifest-reserved target create is permitted only with no target ID bound; the target's returned ID is then freshly read, verified against the exact synthetic name and creation window, and bound durably. A later echo/restart can use that frozen pair, but only the exact provider/native ID is allowed. Database uniqueness constraints prevent duplicate source/target bindings. A transport-level `fetch` guard is also installed only in explicit isolated test mode; it denies unknown mutation hosts and missing/mismatched target IDs. Normal runtime is not modified when the mode is off.

The fake-provider client vertical and policy tests pass locally (11 tests), including target-name override, Request-body parsing, exact target/entity enforcement, readback/bind, restart/reverse update, forged source ID, wrong/shared target IDs, concurrency, unclassified-host denial, and exact-owner-ID transport checks for invoice, deal row, catalog-price and service mutations. The provider-specific `fetch` wrapper is the final mandatory mutation boundary; legacy preflight assertions that do not yet supply an ID/entity do not authorize transport and must still pass that final manifest/entity/native-ID check. The isolated PostgreSQL admission test is present, but could not currently authenticate to the retained local test instance; it must be rerun with the local disposable-DB helper credentials. This remains an implementation candidate, not a live-ready harness: positive end-to-end event processing/admission is implemented only for the client vertical; exact transport-boundary positives are not substitutes for processor-level proofs. Deal/order, invoice, catalog, lifecycle, and timeline event admission/dispatch paths, exhaustive adapter inventory/coverage, combined integration, independent review, and live gates remain outstanding. Never enable this on the production service. No provider traffic, credentials, hook/configuration changes, deployment, or real CRM writes are authorized or performed by these tests.

## Capability/scope restrictions

| Scope | Planned test direction | Restriction |
| --- | --- | --- |
| Contacts/companies | Configured rule/group exchange and matching only within an explicitly approved, isolated synthetic manifest | Code and offline PG fake-provider tests cover configured fields/groups, baseline, pair and readback, but the full client matching/recovery matrix and live tenant behavior are not accepted. No unrelated customer records. |
| Deals/orders | Both directions only after the complete field/reference/stage preflight passes | Use synthetic test records and safe run-ID isolation; no broad event intake. |
| Invoices | Both directions only after explicit approval of the post-launch invoice stage | Parent #1 / `requirements.md` defer invoice exchange after first launch; #60 acceptance testing does not itself lift that production boundary. |
| Product/catalog cards and prices | MySklad → Bitrix24 only | B24 → MySklad product writes remain prohibited. |
| Deal service-dictionary values | Only as part of a separately approved deal/order test and its configured field mapping | Deal/order runtime supports custom service-dictionary values; the separate standalone service-dictionary feed remains unavailable. Catalog service cards are another capability. |

## Synthetic manifest format

Create a restricted, run-specific manifest only after the go/no-go gates. Store no credentials, secret URLs, auth query parameters, customer data, or tokens. The example is a schema/template and contains no real provider identifiers:

```json
{
  "runId": "LIVE-TEST-<UTC-YYYYMMDDTHHMMSSZ>-<random-suffix>",
  "owner": "<named operator>",
  "reviewer": "<independent observer>",
  "service": {
    "versionSha": "<approved combined SHA>",
    "baseUrl": "<approved non-secret service origin>",
    "windowStartUtc": "<timestamp>",
    "windowEndUtc": "<timestamp>"
  },
  "writerExclusion": {
    "htmlStudioDisabled": false,
    "backgroundProcessesReviewed": false,
    "evidenceReference": "<change record, not a secret>"
  },
  "settings": {
    "version": null,
    "scopes": [],
    "preflightEvidence": []
  },
  "records": [
    {
      "entity": "<client|deal-order|invoice|catalog-product|catalog-service>",
      "direction": "<source-to-target>",
      "name": "тест <runId> <scenario>",
      "syntheticOnly": true,
      "source": { "system": "<Bitrix24|MoySklad>", "nativeId": "<filled-after-approved-create>", "url": "<record-url>" },
      "target": { "system": "<Bitrix24|MoySklad>", "nativeId": "<filled-after-genuine-webhook>", "url": "<record-url>" },
      "pairId": "<persisted-pair-id>",
      "scenario": "<expected operation and result>",
      "before": {},
      "after": {},
      "providerEvent": { "genuineDeliveryObserved": false, "eventType": null, "correlationId": null, "receivedAtUtc": null },
      "serviceEvidence": { "queueId": null, "currentRead": null, "settingsVersion": null, "writeReadback": null, "journalReference": null },
      "disposition": "retain"
    }
  ],
  "finalConfigurationEvidence": null,
  "remainingTestRecords": []
}
```

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
