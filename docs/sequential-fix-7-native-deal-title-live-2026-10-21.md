# Point 7: full native MS order name replaces the Bitrix deal title

Root worked alone, implementation first/no TDD. Points 1–6 independently
accepted; point 7 completed in scoped production acceptance, awaiting the
independent checker. No global queue/all-production PASS is claimed.
Final native proof: **21 Oct 2026 20:18 UTC / 23:18 Moscow**.

## Diagnosis and compatible port

The bounded read-only repro on the old owned pair **138480 ↔
f114be9a-cd75-11f1-0a80-0d2d008db9e0** returned
`msNumberFieldCorrect=true, fullTitleEqualsMSName=false`, exit 2.
No old entity, held row, event or operation was repaired/replayed.

Cause: forward creation finalized only `UF_CRM_1729757435964`; it neither
updated nor verified the complete `TITLE`. The narrow contract from candidate
`a87857cacad0e469ca82c5be3c3217e9b976f77b` was inspected and ported manually
onto the current creation service, not blindly cherry-picked with its old base.

Code **d2ad711f0c99f9eb308e53a8b08684474028e48c**, committed/pushed:

- Native target ID is durably saved **before** any B24 title write, unchanged.
- Read the native created order and its actual `name`; no source title,
  synthetic number, prefix, guessed numbering or truncation substitutes it.
- Verify the exact source deal ID from the configured B24 endpoint.
- If either source field differs, one bounded gated `crm.deal.update` sets
  **both** `TITLE` and `UF_CRM_1729757435964` to that exact native string.
- Native readback must confirm **both full fields** before committing the pair
  and completing the operation. An ignored title write cannot falsely succeed.
- Lost-response recovery keeps the same durable target/syncId, payload and
  ownership/mode/lease guards. Completed repeats do not rewrite/create again.
- No reference/config/schema/hook/foreign-robot change, no runtime refactor.

## Postchecks

API build and fresh test TypeScript compile passed. Actual service/public
HTTP/isolated own PG18 checks, natural exit and zero skips/cancellations:

| Check | Passed |
|---|---:|
| Forward create service + real PG/HTTP transport | 9/9 |
| Public authenticated forward/reverse first event | 6/6 |
| Reverse create regression | 13/13 |
| Point-6 actual preparer/public processor/UUID regression | 15/15 |
| Total selected | **43/43** |

Covered: exact full title, already-correct number with a wrong title, ignored
title write/no premature pair, native Unicode/ampersand/punctuation preserved,
lost B24 UPDATE response followed by **cold service/database-client restart**
and successful readback without a second update/order, lost MS CREATE response
with same durable syncId after restart (two idempotent POST attempts, one fake
native resource), completed repeat, real PG OFF-ack barrier preventing the next
source write. The fault injections use actual services/HTTP transport and a
synthetic provider; no production network failure was injected.

The existing reverse test for a portal-generated title and lost title-update
response also passed. Previous known legacy controlled-fake 8/9 is outside this
selected set, not represented as an all-repository green run. Point-6 fixtures
were updated to retain/return TITLE so they enforce the new native contract,
not to weaken any assertion. Own local PG stopped normally/data retained.

## Actual immutable production rollout

Final runtime **d2ad711f0c99f9eb308e53a8b08684474028e48c**, not the later docs
commit. Primary `bitrix-moysklad-sync.service`, PID **1266653**, ACTIVE and
semantic **ON**, actual cwd and node command:
`/opt/bitrix-moysklad-sync-releases/issue79-d2ad711-20261021-stage`.

Normal PAUSE → protected backup/full before-after fingerprints → atomic
immutable artifact startup → strict TLS health/GET/POST 200, identical shell
without synthetic auth reflection, anonymous admin403 → all six actual
preflights PASS → normal ON. v5 config, directions, 50 migration checksums and
boundary `2026-10-21T11:39:51.761Z` preserved. No migration/config save or hook
change. Environment files referenced only, never printed/exported.

Server-only backup/evidence:
`/var/lib/bitrix-moysklad-sync/production-d2ad711-20261021-01`, 0700/0600.

## Fresh native live proof

Only the new owned synthetic deal and row were mutated. Existing company
310178 and previously picker-selected catalog product50070 were read-only
dependencies; no catalog price/stock edit or new MS target was made manually.

- B24 deal **138648**, row **887436**, synthetic name/comment marker
  `тест PRODUCTION-TEST-20261021-root FIX7-TITLE01`.
- Initial source: NEW, `2 × 12.34 = 24.68 RUB`; ordinary native source UPDATE
  moved it to PREPARATION. The normal app created MS order
  **0fd82776-cd8c-11f1-0a80-08bf0002adc2**.
- One active pair **cmvijwnbz002g4kctpg8xwdsc**, one native position
  **0fd82d99-cd8c-11f1-0a80-08bf0002adc3**.
- Genuine stage event **cmvijwi56001w4kct99a4a3mp** SUCCEEDED/1;
  source-number/title-write echo **cmvijwmlp002e4kctvd3ogk89** SUCCEEDED/2.
- Native B24 `TITLE === MS order.name` **in full**;
  UF number equals the same native name. Not merely substring/number-field
  comparison. Native query by durable syncId returns exactly one same order.
- Normal source row UPDATE changed quantity **2 → 3**, same price1234 minor;
  expected/native total **2468 → 3702 minor (37.02 RUB)**.
  Same order, pair and exact position ID; full title and number unchanged.
  Genuine callbacks **cmvijxqmb004x4kct0f22y5hb** SUCCEEDED/3 and
  **cmvijxr0u00504kctta3d6ayh** SUCCEEDED/2. A temporary pair-busy retry was
  observed and allowed to finish normally, not reset/replayed or hidden.
- Final ordinary source save repeats without a new MS order, pair or position;
  exact native name still matches the full source title and number. Genuine
  repeat **cmvijyo7j006j4kcth6qy1qop** SUCCEEDED/1. At final 20:18 UTC
  native readback, more than a minute after that save, all captured identities,
  native name, one position and 3702 minor sum still matched; helper exit0,
  ready=true. Final helper/SQL proof is retained in the protected evidence.
- Correct native MS account, parent counterparty
  **8c7c41a6-cd48-11f1-0a80-03be007adac8**, configured organization, product
  **d813b5d2-5939-11ee-0a80-1143000e2d5c**, quantity/price/amount verified.

The old NEW-stage holds remain visible; no claim that all scenario events or
all production events succeeded. No old source update was used to make the
original negative look green. Existing forward pairs are not bulk renamed.

## Read-only independent verification / protected history

Installed helper, **read-target only**:
`/opt/bitrix-moysklad-sync-operators/production-20261021/root-native-title7-live-20261021.py read-target`.
Run as bms_sync with the existing protected
`/etc/sysconfig/bitrix-moysklad-sync-readonly-api` EnvironmentFile reference.
It checks ON/v5, exact owned source, complete TITLE and number equality,
durable target, one native order by syncId, same captured order/pair/position/
native name, correct account/parent/organization/goods/price/amount, and prints
safe booleans/IDs only. Do not repeat create/stage/capture/quantity/repeat.

SQL `/tmp/root-native-title7-evidence-20261021.sql` is BEGIN READ ONLY and
scoped to the fresh owned case plus historical fingerprints. Protected hashes
remain exact: uncertain887122 `3e3f830a87c9869267fc3e13cba818b0`;
old product operation `8762e094244b0227a34febf8c3f8b870`;
old product event `146995c0f156bc5c56fad1d2e4b76abb`;
five old catalog echoes `c580ecdbfc039cb8df0dbdbdda839e3a`;
old invoice7992 `bf09d423f0b72cdc41b4e8fb572ce399`.

No replay/reset/manual pair/irreversible deletion/foreign automation or hook
change. Root automation24 remains PAUSED. The independent monitor7 remains
active until **it** verifies the last point; root has not declared independent
acceptance or disabled that monitor.
