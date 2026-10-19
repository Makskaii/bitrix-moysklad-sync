# Combined candidate acceptance matrix (#55, #57, #61)

Candidate base: `fd9109a` (`origin/main`). Current source HEAD: `2c7b891840ebdb64ddd73ad59c79aeebc0b93721`. Feature sources: #55 `69e02a4` plus `3dc426d`, #57 `eca9737` (excluding duplicate intake commit `2db1cec`) plus `7c5b6a3`, and #61 `68bde97fb694bc047d05b8b0a2914cde6b4ab412`. This is an isolated integration candidate; it is not a production activation or cutover approval.

| Scope | Candidate coverage | Evidence still required / status |
| --- | --- | --- |
| #55 B24 smart invoices ↔ MySklad invoiceout | Entity type 31 intake; field plan/adapters; pair resolution; create/update; order binding; webhook lifecycle validation; disabled directions terminally skip. | Independent source review PASS. Fake HTTP covers exact IDs, type 31, current-read preservation, confirmed-404 tombstoning/ID retention, and no partner physical DELETE. Fresh combined-HEAD PostgreSQL schema with 35 migrations: invoice runtime 15/15 PASS, including #56 join-group mapping/baseline, MS-first wait/resume, automatic recovery, multiple invoices, and transient 503 retry. Prior contaminated schema was left untouched. |
| #57 webhook intake and direction | B24 dynamic entity 31 recognized; MySklad invoiceout and product events routed; product writes remain MySklad → B24; disabled directions terminally skip; retry/nightly accepted-event work is included. Duplicate initial generic-intake change is supplied by #55 and was not replayed. | Fresh combined-HEAD PostgreSQL reliability test 2/2 PASS, including accepted DELETE recheck across the 500-event page boundary; recovery 8/8; nightly-service unit 20/20 and accepted-event recheck 3/3. Independent source review PASS. No production webhooks or provider writes. |
| #61 product/service cards and catalog prices | MySklad product/service create/update reads and B24 card preparation; configured price types; lifecycle maps `service` to product-pair lifecycle; B24 product direction remains prohibited. | Productcards 23/23 pass, with its two PG cases skipped when `PRODUCT_TEST_DATABASE_URL` is absent; prior isolated PG product/state evidence 25/25 and metadata 16/16 passed on fresh UTF-8 schemas, all 35 migrations. New PG webhook E2E 1/1 verifies product and service create, readback, durable native-kind pair, duplicate recovery, and pre-launch skip. Disabled B24 price event is terminally skipped with zero fake provider calls. | Full catalog price/UOM update proof and MySklad price-update→B24 write test proving existing document rows are untouched remain pending. Live account acceptance remains outstanding. |
| #60 enable-time readiness | Deals/orders, invoices, products/catalog and contacts/companies report handler capability with entity-specific boundaries. Contact code supports configured rules/groups, baseline/readback, pair creation and dependencies; full acceptance remains unverified. Deal/order service-dictionary custom values use the deal/order runtime; the separate standalone service-dictionary feed is unavailable. New directions default Off (legacy contact defaults retained). Per-direction preflight enforces settings version, webhook auth, critical mappings, applicable refs/stages/currencies and product catalog/unit mappings. UI preview and PATCH use the same gate; product reverse writes remain unavailable. | HTTP route tests 14/14 and unit tests 12/12 + 4/4 pass, covering blockers/409/no mutation, successful invoice enable, stale version, disable/no-op, reverse MS-native stage/currency maps without irrelevant org/store/employee requirements, and optional vs required endpoint failures. Full browser run 13 passed/1 skipped; opt-in preview case then passed 1/1. No live writes or cutover have been performed. |
| Independent #57 review | Source review PASS for the implemented nightly, accepted-event recheck, dispatcher/intake and the new lease-fencing fix. | This confirms reviewed code slices, not all #57 acceptance criteria or live behavior. |

## Combined checks

| Check | Result |
| --- | --- |
| Build | Pass: `npm run build` (API TypeScript and web production bundle); latest run after #60 HTTP test updates succeeded. |
| Fresh baseline/recovery scenarios | Pass: `test:deal-order-baseline` 10/10 on newly migrated isolated apply/dry schemas; includes baseline reads, transient provider failures/backoff, Pause/Off, preview independence, and dry DB isolation. |
| Unit and fake HTTP intake/dispatch | Pass by slices: API unit aggregate 119/119 from the previous refresh; invoice unit 14/14; nightly service 20/20 on current HEAD; accepted recheck 3/3; sync-mode 12/12; preflight 4/4. These are separately run suites, not one aggregate API command. |
| Fake-provider end-to-end | Pass: 2 apply/dry fake-provider scenarios (prior candidate run). |
| Local isolated PostgreSQL runtime, schema and migrations | Native installed PostgreSQL 18, loopback-only temporary runtime; no Docker/service changes. Fresh UTF-8 schemas received all 35 migrations. #55 invoice 15/15 on current HEAD; #61 product/state 25/25, field-settings 16/16, and new product/service create E2E 1/1; #57 recovery 8/8 and reliability 2/2 on current HEAD; #53 configured client field sync 2/2 dry + 1/1 fake-provider apply. Baseline/recovery fresh schemas 10/10. |
| Local preview dependency injection | Pass: isolated apply and dry schema module boots without external requests |
| Nightly lifecycle | Pass: `test:nightly-service-unit` 20/20 and accepted recheck 3/3 on current HEAD; off/pause skip, no catch-up, Moscow 24h, dedupe, lease loss, independent retry and latest accepted event selection including invoice DELETE and native service events are covered with fakes |
| Browser E2E | Full run: 13 passed, 1 skipped; the skipped local-preview case was then explicitly run with `ADMIN_PREVIEW_EXPECTED=1` and passed 1/1. Combined browser cases therefore passed 14/14 across the two runs. |
| Lifecycle and provider retry regression | Included in API unit/invoice checks; invoice PostgreSQL retry and auto-recovery are included in 12/12 |
| External provider API validation | Not run; requires no live CRM/provider writes |

Passing local tests does not authorize enabling Apply, publishing, merging or production cutover. Full #60 atomic requirement mapping is tracked in [issue-60-detailed-coverage.md](issue-60-detailed-coverage.md); a run-ID manifest and gated live procedure are prepared in [issue-60-live-test-plan.md](issue-60-live-test-plan.md). Neither constitutes live-test or cutover authorization.

## Isolated PostgreSQL gate (selected suites pass; full acceptance remains open)

The earlier Docker-only plan was superseded by a safe temporary PostgreSQL 18 runtime already installed on the host, bound to loopback and using only disposable test databases/schemas. Do not alter the installed Windows service or use shared application roles/databases. Current evidence refresh: #55 invoice 15/15; #61 product/state 25/25, field-settings 16/16, new product/service create E2E 1/1; #57 recovery 8/8 and reliability 2/2 (including cross-page accepted DELETE); #53 configured client fields 2/2 dry and 1/1 fake-provider apply; baseline 10/10. All cited schemas had 35 migrations. No test schema was dropped or cleaned. Other PostgreSQL suites and full #1/#53–#61 requirement acceptance are not implied by these results. Current local test-only connection is to `127.0.0.1:58341/aerosystems_offline_acceptance_test` as the local test role; use only a new named schema and never copy the connection into source control or a report. The ignored `.env.integration.local` currently points to a different server/database and must not be treated as this runtime's helper.

Then run from the repository root (set the following process-local test variables only, with the disposable localhost URLs):

```powershell
$env:INVOICE_TEST_DATABASE_URL = '<localhost URL to sync_issue55_57_test?schema=issue55_invoices_test>'
$env:INVOICE_TEST_ISOLATED = '1'
$env:PRODUCT_TEST_DATABASE_URL = '<localhost URL to sync_issue55_57_test?schema=issue15_product_test>'
npm run test:invoices:postgres --workspace @sync/api
npm run test:productcards --workspace @sync/api

$env:DATABASE_URL = '<localhost URL to fresh sync_issue57_event_test>'
$env:ISSUE57_EVENT_RELIABILITY_POSTGRES = '1'
npm run test:event-reliability:postgres --workspace @sync/api

$env:DATABASE_URL = '<localhost URL to fresh sync_issue57_recovery_test>'
$env:ISSUE57_DB_RECOVERY_POSTGRES = '1'
npm run test:database-recovery --workspace @sync/api
```

Keep the two ISSUE57 PostgreSQL suites on distinct fresh databases: the recovery test requires empty recovery/event state. Product PostgreSQL cases are skipped unless `PRODUCT_TEST_DATABASE_URL` is set. Record each migration result and test output before reassessing acceptance. Leave the disposable container and databases intact until the operator confirms cleanup; never target an existing or production database.
