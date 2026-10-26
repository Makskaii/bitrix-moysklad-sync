# Point 6: permanent product UUID failure and ordinary correction

Completed by root alone on 21 Oct 2026, final native verification 20:01 UTC
(23:01 Moscow). Independent acceptance is pending. Point 7 has not started.

## Runtime and deployment

- Code: `7d6555963b07adce56743a53af6cbaf49ea2d62b`, committed/pushed.
- Actual primary: `bitrix-moysklad-sync.service`, ACTIVE, semantic ON,
  PID `1264503`; both `/proc/.../cwd` and actual node command line point to
  `/opt/bitrix-moysklad-sync-releases/issue79-7d65559-20261021-stage`.
- Production DB `bitrix_moysklad_sync_live_20261021/public`, config v5,
  all 50 migration checksums unchanged; no migration/config/hook changes.
- Normal PAUSE, restricted backup, immutable Linux build, native startup and
  full before/after PAUSE fingerprints passed. Health and GET/POST shell strict
  TLS 200/identical HTML/no synthetic auth reflection; anonymous admin API 403.
- All six currently enabled direction preflights passed before normal ON.
  Recovery boundary remains `2026-10-21T11:39:51.761Z`.
- Restricted evidence, server only, directory 0700/files 0600:
  `/var/lib/bitrix-moysklad-sync/production-7d65559-20261021-01`.
  Contains full PAUSE fingerprints/backup, `final-native.txt`, `final-sql.txt`.

## Cause and implementation

The actual pinned negative card `683296` still pointed to native MS UUID
`00000000-0000-0000-0000-000000000001`. A bounded authenticated GET against
the verified MS account returned **404/code 1021**. The old resolver represented
both invalid identity and transient reads with one error class; the preparer
turned it into WAITING and the event processor scheduled another failure.

Permanent missing/malformed/archived/wrong-resource/conflicting identity now
stops the **event** in MANUAL_REVIEW with no retryAfter. An event-specific
incident and safe operational log tell the user to select a correct product
through «Подбор товаров» or correct «Товары UUID», then save the deal again.
No entity-wide PairReviewCase is opened: it must not poison a corrected NEW
callback. The unattempted create operation stays WAITING, so fresh validated
input can be used without replaying the old event.

429/408/5xx/network/invalid JSON are distinct read failures. Retry-After is
retained; MS X-Lognex-Retry-After is milliseconds and the later valid deadline
wins. These preflight reads use the existing eight-failure convention; reaching
the limit gives an actionable incident, not infinite retries. 403 is an access
rejection, not a false missing-product claim. A source 404 is not called a
missing MS target. A saved pair whose exact target is absent from assortment
cannot silently lose its row and create an empty order.

An already-attempted PENDING create journal is **not** relabeled or rewritten
by this preflight classification; its pre-existing uncertain-write recovery
behavior is retained. No name fallback, pair repair, provider target creation,
auth/mode/lease/namespace/HTTPS/readback weakening was added.

## Postchecks, implementation first (no TDD)

API build and test TypeScript compilation passed. Freshly compiled JS, one own
runner, isolated local PG18/58343, own DB
`sync_root_product_identity_uuid6final_20261021_test`:

- New actual public HTTP + real preparer/resolver/create operation + PG: **15/15**.
  Missing, malformed, empty, archived, occupied, source404, corrected NEW
  callback/nonempty order/repeat, 429 deadlines/due gate/eighth failure,
  503/network/malformed JSON, 403, saved-pair missing target, immutable uncertain
  PENDING operation, OFF/no new provider reads or pair creation.
- Existing actual identity PG: **4/4**.
- Existing preparer checks: **14/14**.
- Existing public durable forward/reverse-create PG: **6/6**.
- Total selected passing checks: **39**, zero skipped/cancelled, natural exit.
  No assertion weakening/timeout increase/private invocation was used.

The unrelated legacy `pair-first-event.processor.integration` controlled
admission fake still passes 8/9: its missing stable-binding model failure was
also reproduced using the previously compiled point-5 processor. This is not
reported as an all-repository green run; the fixture/runtime admission was not
changed in point 6. Early new-harness failures were corrected fixture intake
shape and `filter[=ownerId]` parsing, followed by a clean fresh-DB run. An
overlapping earlier own failed run contaminated a trial; both naturally exited
before the final isolated passing run. No stale JS result is counted.

Local PG was stopped normally after postchecks, all test data/results retained.

## Fresh live negative, correction and repeat

Only new root-owned synthetic source entities were mutated:

- B24 card **683546**, unique XML marker `ROOT_UUID6_BAD_20261021`, property108
  equal to the pinned nonexistent UUID; no new MS product.
- Deal **138628**, owned parent company **310178**, row **887416**,
  `2 × 12.34 = 24.68 RUB`, normal NEW → PREPARATION source update.
- Genuine negative event **cmvijbi7c001k4kp3cjjd7zqi**: MANUAL_REVIEW,
  attempts **1**, `PRODUCT_UUID_TARGET_NOT_FOUND`, retryAfter null.
  Full event row remained unchanged across the watch and subsequent correction.
  Incident OPEN with field title and readable action; operation WAITING,
  attemptedAt null/no target ID, zero DEAL pairs: no empty order.
- Replaced **only this owned deal row** with existing product **50070**,
  previously selected through the picker, native MS product
  **d813b5d2-5939-11ee-0a80-1143000e2d5c**. The real catalog card, prices and
  stock were read-only dependencies. Normal row/source updates generated NEW
  genuine events, not manual receiver HTTP/replay.
- Corrected events **cmvijcy80002l4kp3vvzdix9k** and
  **cmvijcyoj002n4kp3uku175o3** succeeded, attempts **3** each.
  They had temporary/generic create retries before succeeding; they are not
  claimed to have succeeded on their first attempt. The exact transport cause
  of those intermediate generic failures is not established by this proof.
- Exactly one active DEAL pair **cmvijd4n400304kp3oo20ihsg** to native order
  **f224b62f-cd89-11f1-0a80-05e90001a56a**, create operation SUCCEEDED.
  Native order query by durable syncId returned exactly one matching order.
- Native position **f224c051-cd89-11f1-0a80-05e90001a56b**, exact product UUID,
  quantity **2**, price **1234 minor**, order sum **2468 minor**.
  Correct account and same parent counterparty
  **8c7c41a6-cd48-11f1-0a80-03be007adac8**.
- A later ordinary source save produced **cmvijephu005e4kp3bfbtwbyy**,
  SUCCEEDED/1. Same native order, position and pair, still exactly one order.
  Negative event/incident were not erased or replayed.

The helper's first new-card POST succeeded but its operator-only ACK parser
expected `product` instead of native `element`. It did **not** POST again:
exact unique XML/catalog/name readback recovered that already-created source
card, then continued. No provider card/pair was manually seeded or duplicated.

## Original repro and protected history

Old deal **138488**, card **683296**, row **887118** were NOT mutated, reset or
manually replayed. The three already-scheduled old retry events naturally
reached their existing deadlines under the new runtime and transitioned to
MANUAL_REVIEW/17, no retryAfter. Old operation remains WAITING/unattempted,
no MS target and no DEAL pair. Therefore these old event rows intentionally
changed through ordinary worker processing, not a claimed byte-invariant.

Other protected hashes remained exact:

- uncertain row887122: `3e3f830a87c9869267fc3e13cba818b0`;
- old product operation: `8762e094244b0227a34febf8c3f8b870`;
- old product event: `146995c0f156bc5c56fad1d2e4b76abb`;
- old five catalog echoes: `c580ecdbfc039cb8df0dbdbdda839e3a`;
- old invoice7992: `bf09d423f0b72cdc41b4e8fb572ce399`.

No deletion, reset, DB pair seeding, foreign hook change, old DB import or
backup export. NEW-stage holds remain visible and are not counted as successes.
This is point-6 acceptance evidence, **not** global queue/all-production PASS,
and not a title/number fix (point 7).

## Independent read-only verification

Installed helper (do not repeat mutating actions):
`/opt/bitrix-moysklad-sync-operators/production-20261021/root-product-uuid6-live-20261021.py read-target`.
Run as bms_sync via systemd-run with only the existing protected
`/etc/sysconfig/bitrix-moysklad-sync-readonly-api` EnvironmentFile reference.
It checks current ON/v5, exact owned source, active pair/durable native ID,
native account/parent/goods/price/sum/one order by syncId, old negative digest.
It prints safe IDs/booleans/event status only; no credentials or raw payload.

SQL: `/tmp/root-product-uuid6-evidence-20261021.sql`, BEGIN READ ONLY,
exact synthetic IDs and protected historical fingerprints only.
