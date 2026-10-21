# Sequential fix 5 — early catalog import echoes, 21 October 2026

## Result

Code **5c4e66ddb5af2bb5d266358e942f5d0a0c9d4303** committed/pushed and deployed
to the actual primary, ACTIVE semantic ON, PID1262166. Exact process entrypoint
and cwd `/opt/bitrix-moysklad-sync-releases/issue79-5c4e66d-20261021-stage`.
Final native/SQL evidence at **19:33:02 UTC /22:33:02 MSK**. Configv5, six enabled
directions, boundary2026-10-21T11:39:51.761Z and all50 migration checksums intact.

Point4 was independently accepted by the checker; only point5 was assigned.
Root worked alone, implementation first as requested, postchecks afterward.
No scope expansion into document/order echo, missing-target policy6 or title7.

## Exact reproduced race

Readonly repro: `C:/Projects/aerosystems/root-product-echo-repro-20261021.sql`.
Product683354 and service683364 both had a successful durable create and active
pair, but their earlier B24 ADD remained MANUAL_REVIEW1/PRODUCT_PAIR_NOT_ACTIVE.
For example, echo cmvigzr8c00304ksf7uxeaf1d arrived18:53:15.804UTC and the pair
committed18:53:17.226UTC. Service echo arrived19:03:04.028UTC, pair19:03:05.457UTC.
Both legacy ADD payloads lacked TYPE. The handler did not inspect the pending
import journal before its unpaired path; generic matching could not establish
the missing pair during this initial window (and normal production has7 configured
price mappings, not the matcher's required single mapping).

## Narrow correction and safety

- For an unpaired authenticated B24 catalog ADD, native identity is read from
  the configured Bitrix portal, with a bounded service-kind fallback for legacy
  envelopes without TYPE. No URL from a marker/payload controls outbound requests.
- Recognizing an owned import requires a durable attempted product-create journal,
  its exact original MySklad CREATE event/native type/sourceID, frozen catalog,
  fields, UUID108 and reserved XML identity, native target ID/type/catalog,
  creation ordering, and exactly one native XML match. A marker alone is insufficient.
- Before target ID/pair is saved, the native fields must exactly match the frozen
  create payload. Conflicting/inactive/ambiguous pairs or failed origins stop.
- Operation/origin/pair are re-read in one repeatable-read database snapshot after
  provider reads, preventing a mixed pre/post-commit state from becoming an error.
- Proven pending imports park the echo for5seconds with persisted retryAfter and
  `PRODUCT_IMPORT_ECHO_WAITING`. The claim's attempt is restored atomically under
  mode/worker fences: ordinary dependency waiting neither spends failure budget
  nor erases prior real failures. Existing status scheduling gates remain in force.
- The original import worker alone creates prices and commits the pair/journal.
  Echo handling never seeds a pair, finishes a create, sends an MS write or
  creates another B24 card. Once the durable pair is confirmed, normal one-way
  authoritative processing/readback runs, with credential-free DEFERRED/RESUMED audit.
- All per-request mode/direction/lease/auth/namespace gates remain. No blanket ADD
  skip, readback relaxation, new migration, config save or replay of old held events.

## Postchecks — 60 PASS, zero skip/cancel

API build and separate test tsc PASS, fresh compiled JS/natural exits:

-39 product event/adapter/create/reconciliation/description unit+integration checks.
-8 real public Nest webhook/actual processor/own PostgreSQL tests. New coverage
  deliberately delivers both product AND service ADD before provider ADD response
  (no saved target ID), and separately during price ADD (ID saved, pair absent).
  Real scheduled recovery naturally resumes all four echo cases, with0 waiting
  attempts, no manual review, one card/pair/price and stable source UPDATE/repeat.
  Negative cases include missing journal, wrong origin/UUID/catalog/kind/fields,
  occupied target, duplicate native identities, inactive pair, failed origin/op,
  succeeded op without pair, future operation, bad auth401, transient429 scheduling
  and permanent403. No provider writes on rejected cases. A commit overlapping
  identity reads succeeds with the consistent snapshot.
  A separate lower-level own-PG fixture advances only its own test deadlines12times,
  preserving7 prior failures while waiting and proving no early provider read.
  Its local recovery timer is stopped through normal teardown; the preceding
  four public startup/scheduled-resume cases retain their real timers.
-13 shared reverse/document prerequisite PG regressions PASS, including durable
  product recovery, lost responses, pairing and existing row identity.

Disposable DB `sync_issue79_root_product_echo_20261021_test`, final schemas
`issue61_create_event_echo_root_final`/`issue54_reverse_test_echo_final`, all50
migrations, own local PG18 port58343 stopped normally afterward; evidence retained.

Earlier failed harness runs are not counted as PASS: the fake native list parser
did not handle form-encoded filters on the newly exercised read seam, and seeded
PROCESSING origin fixtures lacked a fresh processingStartedAt, causing background
recovery of fixtures. Both were corrected before the final natural-exit run.
An existing controlled-product test also failed on unchanged HEAD (12/13 baseline):
its fake DB predated stable ControlledTestSourceBinding. Only that fixture was
updated to represent the current model, preserving all assertions; production
admission code was not changed. Parent diagnostic retained in clearly marked tmp.

## Immutable rollout

Normal namespace/admin-verified PAUSE → restricted backup/full fingerprints →
immutable code build/syntax checks → primary switch/startPAUSE → exact cmdline
AND cwd verification → strictTLS health/GET/POST identical HTML/no synthetic-auth
reflection/admin403 → complete snapshot equality → operator import repin →
all6 actual preflights → normal ON. No schema/config/hooks changes for point5.

Server-only protected evidence0700/0600:
`/var/lib/bitrix-moysklad-sync/production-5c4e66d-20261021-01` contains backup,
before/after snapshots, final-native-readbacks.txt and final-owned.sql.txt.
Initial readonly final SQL used wrong log timestamp column; corrected to
occurredAt and re-run successfully. No runtime/data repair was involved.

## Genuine fresh primary acceptance

| Kind | Native MS source | Native B24 target | Active PRODUCT pair |
|---|---|---|---|
| product |d2bf0c70-cd85-11f1-0a80-183000010346|683424/type1|cmviib8b5000f4kw6jhtclf08|
| service |d50d74cf-cd85-11f1-0a80-1e3d0000b73e|683426/type7|cmviibbok000n4kw6v5o1srmv|

Both named `тест PRODUCTION-TEST-20261021-root ECHOFIX5-<kind>01`, later REV2.
Each source created once through normal MS REST → genuine MySklad CREATE and
genuine B24 ONCRMPRODUCTADD (not manual webhook delivery). One card, one MS source
by exact current code, one active native-kind pair, one succeeded create journal,
UUID108 exact MSID, catalog14/UOM9/one BASE2 price1.01RUB verified independently.

Both genuine B24 echoes actually arrived BEFORE the pair:

| Echo | Arrival UTC | Pair committed UTC | Final |
|---|---|---|---|
|cmviib6z4000c4kw68g3wi041|19:30:09.040|19:30:10.769|SUCCEEDED1|
|cmviiba2r000k4kw6oppwyk91|19:30:13.059|19:30:15.140|SUCCEEDED1|

For each, actual OperationalLog contains PRODUCT_IMPORT_ECHO_DEFERRED with the
exact original CREATE event/sourceID, then PRODUCT_IMPORT_ECHO_RESUMED with the
same final pair. ManualReviewCase count for both echoes **0**.

Normal source UPDATE then changes name, description and price101→234minor:
native same card/pair, exact new fields, **2.34RUB**, raw source description
preserved (approved emoji projection from point3). Another genuine source UPDATE
changes only its own code and retains the same description/price, proving repeat
processing leaves one card/source/pair/price and no duplicates.

| Kind | MS CREATE | MS UPDATE | MS repeat UPDATE |
|---|---|---|---|
| product |cmviib5z400094kw69om1wtkc|cmviibx7t000t4kw6kq7zookl|cmviidggl001a4kw6nza82ri2|
| service |cmviib8z4000h4kw67gapl9te|cmviibzi3000w4kw623zm03sl|cmviidips001d4kw6n74mq6vu|

All6 MS source events and2 B24 echoes **SUCCEEDED attempts1**; all native helper
checks ready=true. No customer card, stock, document, payment, foreign hook or
irreversible deletion was touched.

## Preserved old evidence and limits

No old event replay/reset/manual pairing. Before-switch and final hashes match:

- Old partial683292 operation8762e094244b0227a34febf8c3f8b870;
  old event146995c0f156bc5c56fad1d2e4b76abb.
- Old uncertain row887122:3e3f830a87c9869267fc3e13cba818b0.
- Old invoice7992:bf09d423f0b72cdc41b4e8fb572ce399.
- Five old catalog echo full rows:c580ecdbfc039cb8df0dbdbdda839e3a, still held.

This is future/fresh event acceptance, not cleanup of historical false reviews.
Document/order echo is outside scope; no all-queue/all-production-cases PASS.
Independent checker acceptance of5 pending;6–7 not started.

## Readonly verification

`/opt/bitrix-moysklad-sync-operators/production-20261021/root-product-echo-fix5-live.py read product01`
or `read service01`, as bms_sync with existing protected readonly-api EnvironmentFile.
Only READ semantics and fixed owned IDs; output contains no credentials/PII.
Server-only metadata/fences:
`/var/lib/bitrix-moysklad-sync/root-product-echo-fix5-20261021/live.json`.
**Never repeat plan/create/update/repeat mutating actions**. Runtime remains5c4e66d
even after this documentation-only commit.
