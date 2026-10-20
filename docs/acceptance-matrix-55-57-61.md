# Combined candidate acceptance matrix (#55, #57, #61)

Candidate base: `fd9109a` (`origin/main`). Candidate source and integration-test snapshot: `50e80f0b53a197085b8d300975004d69d765d4d5`. This is an isolated integration candidate, not a production activation or cutover approval.

| Scope | Offline evidence on this candidate | Remaining status |
| --- | --- | --- |
| #55 invoiceout lifecycle | Invoice unit suite 14/14. Fresh PostgreSQL schema, all 35 migrations, invoice runtime 16/16; separate invoice grouping/recovery scenario 12/12 on its own fresh schema. Covers type-31 intake, pair/order identity, join-group mapping, MS-first wait/resume, multiple invoices, automatic recovery, transient 503 retry, terminal skip, current-read preservation, confirmed absence handling, and no physical partner DELETE. | External webhook subscription inventory and live provider acceptance are NOT RUN; current read-only provider inventory shows the required live configuration is absent/disabled. |
| #57 intake, retry, nightly recheck | Event reliability PostgreSQL 2/2 on fresh migrated schema, including accepted DELETE recheck across the 500-event page boundary. Recovery 8/8. Nightly service units 20/20 and accepted recheck 3/3. Lease-fencing reliability PostgreSQL 1/1, repeated for three runs; these are three runs of one test, not three test cases. | No production webhook or provider write. Live acceptance NOT RUN. |
| #61 product/service cards and catalog updates | Product-card suite 28/28 with explicit isolated PostgreSQL opt-in; fresh schema/all 35 migrations. Product persistence/recovery cases included. Fresh product/service webhook E2E 2/2: dispatcher→card create/readback→durable native-kind pair, duplicate recovery and pre-launch skip; plus MS product UPDATE→B24 configured UOM/price write/readback, preservation of unconfigured price type, and unchanged seeded document row/no document-write calls. Lifecycle PG 3/3 also verifies native product/service identity handling and conservative HTTP-200 absence classification. | Live provider acceptance NOT RUN. Product B24→MS direction remains unsupported by design. |
| #60 enable-time preflight (related gate) | HTTP route tests cover real preview/PATCH gate: blockers/409/no mutation, successful invoice enable after repaired fake fixture, stale settings version, disable/no-op, reverse-native stage/currency mapping, and optional vs required endpoint errors. UI preview shares the gate. Browser coverage: 13 passed/1 expected skip in default mode, then the mutually exclusive preview scenario passed 1/1 when explicitly enabled (14 scenarios passed across both runs). | Controlled live acceptance remains BLOCKED/NOT RUN. Read-only inventory found required provider setup unavailable; no live CRM writes, webhook changes, global Apply enablement, or cutover were performed. |

## Combined checks

| Check | Result |
| --- | --- |
| Build | `npm run build` PASS after current source fixes. |
| API unit inventory | 124/124 PASS after compiling API test TypeScript. Additional focused suites: invoices 14/14; clients 25/25; sync-mode 12/12; preflight 4/4; nightly service 20/20; accepted recheck 3/3; lifecycle 14/14. Counts are per suite and are not additive where suites overlap. |
| PostgreSQL migrations | Each cited test schema was freshly created for the suite and received all 35 migrations. Databases were disposable local test databases on installed PostgreSQL 18 bound to loopback; no shared/production DB was used. |
| Baseline/recovery | Fresh isolated apply/dry baseline scenarios 10/10; recovery suite 8/8. |
| Browser E2E | 13 passed, 1 expected mode-exclusive skip; explicit run of skipped preview scenario 1/1. No browser was used for live provider interaction. |
| Fake-provider client sync | Configured client field sync: dry 2/2 and fake-provider apply 1/1. |
| External provider validation | NOT RUN. |

## Safe local PostgreSQL test contract

The temporary PostgreSQL 18 runtime is loopback-only. Test execution used only fresh, disposable databases and isolated schemas; never point these suites at an existing application database. The product suite now requires explicit `PRODUCT_TEST_ISOLATED=1`, a loopback URL, an allowed disposable database name, and its dedicated schema. It rejects missing opt-in, non-loopback, shared `/sync`, and public targets before connecting. The ignored `.env.integration.local` points elsewhere and is not valid test configuration for this runtime. Do not put connection strings or credentials in source control or reports.

Successful offline checks do not authorize enabling Apply, publishing, merging, production cutover, live CRM writes, or webhook subscription changes. The full atomic #60 trace and controlled live plan remain tracked in [issue-60-detailed-coverage.md](issue-60-detailed-coverage.md) and [issue-60-live-test-plan.md](issue-60-live-test-plan.md); those documents are not evidence that the live test ran.

## Issue #79 runtime/recovery acceptance (work in progress)

| Slice | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Runtime email candidate lookup | Resolver/gateway focused tests cover normalized company and contact email, name mismatch, parent scope, shared/occupied candidates and conflicting keys. Initial UUID inventory behavior remains separate. | Add/complete public webhook HTTP → persisted resolution/pair → fake external readback trace; isolated PostgreSQL, restart/race and secret-safe diagnostic checks. |
| Settings revisions/rebase | Requirement is recorded in [runtime/recovery evidence](issue-79-runtime-recovery-research.md). | Not yet implemented/accepted across deal/order fields, headers, rows/totals and invoices. Require pair-lock, revision audit, old-event pinning, partial-write recovery and safe MS-authoritative readback. |
| Scheduled recovery | Requirements and current server constraints documented. | Not yet accepted as discovery for supported never-intaken deal/order/invoice/catalog updates. Verify each provider filter and pagination contract, >1000 behavior, cursor restart, retry, OFF/PAUSE, exact entity type 31, idempotency and truthful deletion limitations. |
| Production setup | Read-only inspection: service OFF; PREPARATION configured; UC_DZSNZ0 absent. | No production changes or live acceptance performed by this branch. Root coordinates deployment and dedicated test manifest after combined review. |
