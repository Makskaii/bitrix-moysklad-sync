# Combined candidate acceptance matrix (#55, #57, #61)

Candidate base: `fd9109a` (`origin/main`). Candidate feature sources: #55 `69e02a4`, #57 `eca9737` (excluding duplicate intake commit `2db1cec`), and #61 `68bde97fb694bc047d05b8b0a2914cde6b4ab412`. This is an isolated integration candidate; it is not a production activation or cutover approval.

| Scope | Candidate coverage | Evidence still required / status |
| --- | --- | --- |
| #55 B24 smart invoices ↔ MySklad invoiceout | Entity type 31 intake; field plan and adapters; pair resolution; create/update routing; invoice waits for an eligible customer order; delete event enters shared lifecycle handling. | Independent review PASS; reviewer withdrew the disabled-direction DELETE finding because it conflicts with #57 terminal-skip semantics. Remaining gap: no single enabled webhook-to-lifecycle end-to-end test; PostgreSQL runtime checks pending. |
| #57 webhook intake and direction | B24 dynamic entity 31 recognized; MySklad invoiceout and product events routed; product writes remain MySklad → B24; disabled directions terminally skip; retry/nightly accepted-event work is included. Duplicate initial generic-intake change is supplied by #55 and was not replayed. | Combined HTTP API intake/dispatch and fake-provider E2E; isolated PostgreSQL reliability, recovery and nightly checks. No production webhooks or provider writes. |
| #61 product/service cards and catalog prices | MySklad product/service create/update reads and B24 card preparation; configured price types; lifecycle maps `service` to product-pair lifecycle; B24 product direction remains prohibited. | Unit/API tests and fake-provider E2E; isolated PostgreSQL pair/lease/state checks; confirm metadata-dependent required values and provider behavior. |
| #60 enable-time readiness | Invoice, deal/order and catalog implementations expose non-null implemented scopes. The admin surface still reports deal/order and catalog `ready=false`, with direction switches shown false; the API handler wiring is documented and tested separately. | Full enable-time preflight enforcement, launch-boundary confirmation, cutover/rollback runbook and operator review remain open. Treat this combined candidate as non-production until those gates are complete. |
| Independent #57 review | Fresh review PASS for the implemented nightly, accepted-event recheck, dispatcher and intake slice (22 tests). | PostgreSQL-backed checks remain pending; review did not claim full #57 acceptance. |

## Combined checks

| Check | Result |
| --- | --- |
| Build | Pass: `npm run build` (API TypeScript and web production bundle) |
| Unit and fake HTTP intake/dispatch | Pass: 80 checks across event intake/dispatch, invoices, product cards/catalog creation, sync mode/readiness, lifecycle, provider retry and nightly/review diagnostics |
| Fake-provider end-to-end | Pass: 2 apply/dry fake-provider scenarios |
| Local isolated PostgreSQL runtime, schema and migrations | Pending: Docker Desktop did not start; engine service/pipe unavailable |
| Local preview dependency injection | Pass: isolated apply and dry schema module boots without external requests |
| Lifecycle and provider retry regression | Included in the 80 passing checks above |
| External provider API validation | Not run; requires no live CRM/provider writes |

Passing local tests does not authorize enabling Apply, publishing, merging or production cutover.
