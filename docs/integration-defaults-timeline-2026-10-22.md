# Defaults and timeline notices: local integration

Human authorization verified directly in chat 01a15e31-6e89-70a1-b3e7-aa79c61bca93:
«передавай на слияние», then «пусть приступает к слиянию».

Only the two requested commits were cherry-picked, not the side branch HEAD:

- `5322e25c1e31017b25c2c6994fd38c74fdc05911` → `ab3c7e3`:
  confirmed organization and RUB defaults, without numeric price conversion.
- `6f1e4d120c2dee9a0e2ca652826c6247cf58fd1e` → `74e6eb9`:
  durable deal timeline notice outbox and additive migration.

Baseline `a899172`; both applied without conflicts. Existing scheduler, assembly
creation admission and client changes were retained. No speed optimization work.

## Root verification on the combined source

Independent physical dependency tree/client:
`C:/Projects/aerosystems/.root-merge-74e6eb9-20261022`.
Prisma 6.19.3, API build and test TypeScript compilation PASS. No generation into
shared node_modules. Source was exported from the combined commit, not stale JS.

Root-owned local PostgreSQL 18 at 127.0.0.1:58343, new database
`root22_merge_side22_timeline_test`, separate notice/create_case/public_worker/
upgrade50 schemas. No live credentials; provider requests are synthetic stubs.

- Preparer unit: 15 PASS (including retained explicit assembly admission).
- Notice delivery PG: 5 PASS (concurrency, lost ACK, supersession, PAUSE).
- Order creation PG: 9 PASS (including OFF fencing/native readback).
- Public webhook/actual processor PG: 13 PASS (including echo/restart cases).
- Shared scheduler: 14 PASS; worker lease: 12 PASS.
- Mode service: 12 PASS, 1 existing failure described below.
- Total selected assertions: 80 PASS, 1 FAIL, 0 skipped/cancelled; natural exits.
- Additional migration preservation check PASS: populated synthetic schema at
  50 migrations upgraded to 51, settings/logs/pairs/events projection unchanged,
  outbox empty (no historical notice backfill).

The notice test's first launch lacked SYNC_MODE and failed at construction before
its hooks. Re-run with explicit apply and the isolated database passed all 5.

## Existing test failure, not hidden

`sync-mode.service.unit`: “deal/order provider mutation remains inside the
active-pair lifecycle lease” fails `database.$transaction is not a function`.
Independently exported and compiled baseline `a899172` reproduces the identical
failure (12 PASS / 1 FAIL). Neither the tested mode service nor that test changed
in these cherry-picks. No runtime gate/test assertion was weakened to hide it.

## Deployment boundary

Local integration is complete. No push, production migration, deployment,
settings/mode change, live comment or provider data write was performed here.
Production was not re-verified in this local integration run; last documented
runtime remains 8366b74, not this candidate. Live notices acceptance NOT RUN.

A later authorized rollout requires the new migration before starting the new
runtime and its own generated Prisma client/build, normal preservation/preflight
checks and genuine owned-event acceptance. Notice coverage is limited to the
processor paths documented in `deal-timeline-notices-2026-10-22.md`, not every
client/catalog/invoice outcome. Throughput optimization stays in the backlog.

Root-owned PG was normally stopped after checks; data/staging/evidence retained.
