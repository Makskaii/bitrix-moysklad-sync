# Combined candidate acceptance matrix (#55, #57, #61)

Candidate base: `fd9109a` (`origin/main`). Candidate feature sources: #55 `69e02a4`, #57 `eca9737` (excluding duplicate intake commit `2db1cec`), and #61 `68bde97fb694bc047d05b8b0a2914cde6b4ab412`. This is an isolated integration candidate; it is not a production activation or cutover approval.

| Scope | Candidate coverage | Evidence still required / status |
| --- | --- | --- |
| #55 B24 smart invoices ↔ MySklad invoiceout | Entity type 31 intake; field plan and adapters; pair resolution; create/update routing; invoice waits for an eligible customer order; enabled B24 and MySklad DELETE webhooks traverse HTTP intake → production dispatcher → lifecycle current-read validation; disabled directions terminally skip. | Independent review PASS; reviewer withdrew the disabled-direction DELETE finding because it conflicts with #57 terminal-skip semantics. New fake-HTTP coverage checks exact native IDs, B24 `entityTypeId=31`, current-record preservation, confirmed-404 tombstoning with IDs retained, and no partner DELETE calls. PostgreSQL runtime checks pending. |
| #57 webhook intake and direction | B24 dynamic entity 31 recognized; MySklad invoiceout and product events routed; product writes remain MySklad → B24; disabled directions terminally skip; retry/nightly accepted-event work is included. Duplicate initial generic-intake change is supplied by #55 and was not replayed. | Combined HTTP API intake/dispatch and fake-provider E2E; isolated PostgreSQL reliability, recovery and nightly checks. No production webhooks or provider writes. |
| #61 product/service cards and catalog prices | MySklad product/service create/update reads and B24 card preparation; configured price types; lifecycle maps `service` to product-pair lifecycle; B24 product direction remains prohibited. | Unit/API tests and fake-provider E2E; isolated PostgreSQL pair/lease/state checks; confirm metadata-dependent required values and provider behavior. |
| #60 enable-time readiness | Invoice, deal/order and catalog implementations expose non-null implemented scopes. The admin surface still reports deal/order and catalog `ready=false`, with direction switches shown false; the API handler wiring is documented and tested separately. | Full enable-time preflight enforcement, launch-boundary confirmation, cutover/rollback runbook and operator review remain open. Treat this combined candidate as non-production until those gates are complete. |
| Independent #57 review | Fresh review PASS for the implemented nightly, accepted-event recheck, dispatcher and intake slice (22 tests). | PostgreSQL-backed checks remain pending; review did not claim full #57 acceptance. |

## Combined checks

| Check | Result |
| --- | --- |
| Build | Pass: `npm run build` (API TypeScript and web production bundle) |
| Unit and fake HTTP intake/dispatch | Pass: 82 checks across event intake/dispatch, invoices, product cards/catalog creation, sync mode/readiness, lifecycle, provider retry and nightly/review diagnostics; includes new two-case enabled/disabled invoice lifecycle webhook suite |
| Fake-provider end-to-end | Pass: 2 apply/dry fake-provider scenarios |
| Local isolated PostgreSQL runtime, schema and migrations | Pending: Docker Desktop did not start; engine service/pipe unavailable. No database, schema, migration or role was created or modified. |
| Local preview dependency injection | Pass: isolated apply and dry schema module boots without external requests |
| Lifecycle and provider retry regression | Included in the 80 passing checks above |
| External provider API validation | Not run; requires no live CRM/provider writes |

Passing local tests does not authorize enabling Apply, publishing, merging or production cutover.

## Isolated PostgreSQL gate (not run)

Run only after Docker is started normally by the operator. Use an already-installed official PostgreSQL image if available (`docker image ls`); do not pull/install anything as part of this gate. Create one disposable container on loopback with a new throwaway role and database names `sync_issue55_57_test`, `sync_issue57_recovery_test`, and `sync_issue57_event_test`; do not point tests at any existing application database or role. For the invoice and product suites, create dedicated schemas `issue55_invoices_test` and `issue15_product_test` in `sync_issue55_57_test`. Use fresh localhost connection URLs with `?schema=<schema>` and run `npx prisma migrate deploy --schema prisma/schema.prisma` once per database/schema before tests; use the application API's documented Prisma migration history, without schema drops or resets.

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
