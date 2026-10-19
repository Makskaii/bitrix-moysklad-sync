# Issue #60 requirement-to-evidence matrix

Snapshot: combined candidate `2609d93d603665ffbd3457bd0ca1e448c57d42f2`, branch `issue-60-preflight`. Current source: GitHub #60 as expanded 2026-10-19, parent #1. Feature sources listed by the acceptance matrix are #55/#57/#61. This is a partial traceability ledger, not a full acceptance report. No row is promoted to PASS solely because code exists.

| Requirement / source | Implementation status | Verification status and evidence | Remaining evidence or blocker |
| --- | --- | --- | --- |
| #60: all handlers use the common router/worker and one event schedules one operation for its pair | Partial / shared dispatcher is present | NOT_RUN here; combined owner owns route/E2E scenarios | Isolated PostgreSQL and full event-to-operation matrix |
| #60: client pair/create; dependencies; tombstone/restore | Partial; contacts/company feature scope is not full client acceptance | NOT_RUN here | Full customer-company-contact/product dependency and lifecycle cases |
| #60: B24 deal to MS order; MS order to B24 deal; row add/update/delete; retry/echo | Implemented runtime; complete acceptance unproven | NOT_RUN here | Fake-provider and isolated PostgreSQL proof, lost-response and concurrency evidence |
| #60: invoice binding, wait for order, continuation, multiple invoices and ambiguity | Implemented runtime | NOT_RUN here | Complete fake-provider/PostgreSQL cases and live delivered webhook evidence |
| #60: boundary, pair resolution, current reads, settings version, baseline, final write/readback and journal | Partial; runtime seams exist | Unit: mode changes preserve the confirmed boundary. Full chain NOT_RUN | PostgreSQL transaction/restart evidence; scoped live chain after approval |
| #60: acceptance matrix by entity/direction/operation with implemented/disabled/TBD and evidence | Matrix present, not full | PARTIAL: [combined candidate matrix](acceptance-matrix-55-57-61.md) and [runbook](issue-60-cutover-runbook.md) | Expand to every operation and attach full test/evidence IDs |
| #60: selected-scope/direction preflight uses #56 mapping statuses and required values | Implemented for enabled entity/direction | PASS: `test:sync-mode-preflight-unit`; `test:sync-mode-unit` | Test API/read-only endpoints in combined API/browser tests and current real metadata in approved live test |
| #60: all applicable deal stage/status pairs confirmed; ambiguous stage blocks | Implemented; checks every current B24 stage and currency against confirmed active mappings/runtime | PASS: pure policy tests for missing and complete stage mappings | Reverse-direction current-state coverage and isolated DB/API evidence |
| #60: API access and webhook auth | Implemented as read-only current API probe plus source-specific configured incoming auth check | PASS in fake service unit fixture; no live API call | Combined API/browser test; live UI/auth-delivery evidence after gate |
| #60: optional references warn unless the selected operation requires them | Implemented policy; operation-required order values block | PASS: optional warnings and required order values covered by policy tests | Review concrete operations against all current field-setting contracts |
| #60: test-ON does not establish boundary; Pause/restart do not move it | Boundary remains a separate audited continuity confirmation | PASS: unit sequence On→Pause→On preserves the boundary | PostgreSQL persistence/restart check remains pending |
| #60: cutover disables HTMLStudio before Apply; stop/return preserves queue/pairs without two writers | Procedure written | NOT_RUN: [runbook](issue-60-cutover-runbook.md) | Owner-approved scoped plan and controlled operator rehearsal |
| #60: local commands, webhook matrix, map setup, journal, demo steps without secrets | Partial; commands and capability/setup limits documented | PARTIAL: runbook plus `docs/webhooks/event-engine.md`, `docs/field-settings-api.md` | Add verified browser UI/demo evidence and reconcile endpoint matrix with final test environment |
| #60 expanded: snapshot hashes and parent/feature requirements reconciled | Partial; candidate base recorded | NOT_RUN | Capture exact parent #1 and #53–#59/#61 requirement snapshots and resolve conflicts |
| #60 expanded: every requirement has source, expected result, test/procedure, actual result, evidence SHA and defect link | Partial; this ledger records group-level evidence only | NOT_RUN | Split every expanded bullet into atomic traceability rows and attach CI/local artifact IDs |
| #60 expanded: all configured standard/custom fields, metadata/title/code, dictionaries and service dictionary | Partial; separate service dictionary remains missing | NOT_RUN | Audit complete active field configuration per operation; service dictionary blocker remains open |
| #60 expanded: full build/typecheck/unit/API/browser and isolated PostgreSQL/migration/restart/transaction/concurrency/recovery/lost-response suites | Partial | PASS: build and two unit suites listed in release notes | Full combined suite; isolated PostgreSQL is blocked when Docker engine is unavailable |
| #60 expanded: all client/customer/deal/invoice/catalog/lifecycle/reliability/nightly/UI acceptance bullets | Partial or not proven | NOT_RUN | See owner-owned combined test plan; no live/DB evidence claimed here |
| #60 expanded: controlled real UI/API actions and genuine incoming provider webhooks with synthetic run-ID manifest | Not run | BLOCKED | Requires isolated PostgreSQL PASS, owner-approved scoped plan and a runtime scope filter safe for unrelated work records |
| #60 expanded: no irreversible cleanup; preserve test records and log evidence without secrets | Procedure specifies retained/archived operator disposition | NOT_RUN | No external test was performed |
| #60 completion: no mandatory BLOCKED/NOT_RUN; independent acceptance; release/runbook published | Incomplete | NOT ACCEPTED | Keep #60 open until remaining test owners provide evidence and independent review passes |

## Evidence from this slice

- Base/source snapshot: `2609d93d603665ffbd3457bd0ca1e448c57d42f2`.
- Build: `npm run build` — PASS.
- Sync mode: `npm run test:sync-mode-unit --workspace @sync/api` — PASS, 8 checks.
- Preflight policy: `npm run test:sync-mode-preflight-unit --workspace @sync/api` — PASS, 3 checks.
- Fake-provider combined/API/browser/PostgreSQL: NOT RUN in this slice; coordinate with the integration owner.
- Live provider scenarios: BLOCKED. No records, live webhook registrations, or service traffic were changed.
