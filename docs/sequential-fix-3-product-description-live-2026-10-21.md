# Sequential fix 3 — product descriptions, 21 October 2026

## Result and approved policy

Implemented/pushed and deployed `34b273a46aee029ab0757fceb03f1d489c68d8f8`.
Main service is ACTIVE, semantic ON, PID1258143, exact process entrypoint and
cwd `/opt/bitrix-moysklad-sync-releases/issue79-34b273a-20261021-stage`.
Final independent native API/SQL readbacks completed at 18:57 UTC /21:57 MSK.
This closes the implementation/live evidence for **point 3 only**, pending the
separate checker's acceptance. Points 4–7 were not implemented.

The user explicitly allowed safe HTML or omission of emoji. Root selected and
announced the simpler omission policy: descriptions remain **plain text**.
Unsupported supplementary-plane emoji graphemes are omitted; all other text,
literal HTML tags, ampersands and line breaks remain. MySklad's raw source is
never rewritten. BMP symbols such as © and ♥ remain. Unsupported non-emoji
supplementary letters and malformed UTF-16 stop before CREATE with
`PRODUCT_DESCRIPTION_UNSUPPORTED_CHARACTER`; they are not silently erased.

## Actual diagnosis

Held MS product `a2e3818a-cd75-11f1-0a80-182d008e07ea`, partial B24 card683292:
source and durable frozen description were identical, 64 codepoints; native
Bitrix plain text contained only the 34-character prefix before U+1F600.
Raw UTF-8 JSON, ASCII-escaped JSON, form encoding, and raw emoji with html type
all reproduced this truncation on one separate owned inactive diagnostic card
683342. HTML entities with html type retained all text; BMP control with text
type retained the exact whole string. The provider storage cause is not proven;
no claim about Bitrix's internal database encoding is necessary.

Diagnostic card683342 remains inactive, has no MS identity/pair/prices by design,
and was left with full ordinary BMP control text/type text. No deletion.

## Implementation

- Shared grapheme-aware description projection strips complete supplementary
  emoji (including joined families, flags and skin modifiers), not arbitrary
  surrogate pairs and not the suffix after them.
- Catalog CREATE projects **after configured scalar rules**, before validation,
  journal freezing or ADD. Exact native readback remains required, as do price
  verification, UUID108 and durable pairing. Emoji-only optional CREATE text is
  omitted, allowing card/price/pair completion.
- Existing-card reconciliation compares the same projection and persists that
  projection in its baseline; repeated events do not perpetually rewrite raw
  source emoji. Null/empty descriptions have one optional empty comparison.
- Partial UPDATE defensively projects again and explicitly sends
  `detailTextType=text`; raw tags are not enabled as executable HTML. An
  emoji-only update clears stale optional text.
- Old frozen journals are not normalized in place and strict mismatch recovery
  is not disabled. Old partial cases are not repaired/replayed automatically.

Official field contract: [catalog.product.add](https://apidocs.bitrix24.com/api-reference/catalog/product/catalog-product-add.html)
documents detailText/detailTextType. Actual live writable metadata and plain-text
readback were verified; raw non-BMP support was tested directly, not assumed.

## Post-implementation checks — 45 PASS, zero skip/cancel

API build and separate test tsc PASS. Fresh compiled JS, natural exits:

- Description unit7 + adapter5 + existing card reconciliation13 + durable
  catalog CREATE1 =26 PASS.
- Real public Nest webhook + actual product processor + isolated PG:6 PASS.
  The new regression loops CREATE/baseline/UPDATE/repeat/emoji-only clear over
  beginning/middle/end/BMP/emoji-only cases, price12.34/UUID/one card+pair, source
  immutability, non-emoji rejection before partial CREATE, and unchanged old raw
  frozen payload/readback mismatch. Fake native CREATE/UPDATE deliberately
  truncates any raw supplementary character, matching the actual symptom.
- Shared reverse document prerequisites PG13 PASS, including lost response and
  durable product recovery; no document-price or goods regression.

Own local PG18 port58343, DB `sync_issue79_root_description_20261021_test`, fresh
schemas `issue61_create_event_description_root_final` and
`issue54_reverse_test_description`, all50 migrations. Cluster stopped normally;
data/results retained. Earlier missing-currency-ref and missing-syncId fixture
errors were corrected before the final successful runs; they were not PASS.

## Immutable production rollout

Normal namespace/admin-verified PAUSE → restricted backup/full snapshots →
immutable switch → start PAUSE → exact `/proc/PID/cmdline` plus cwd proof → TLS
health/GET/POST same HTML, no synthetic auth reflection, anonymous admin403 →
snapshot equality → operator import repin → all6 actual preflights → normal ON.
No schema migration, config save, direction expansion, event reset or replay.
Configv5, recovery boundary2026-10-21T11:39:51.761Z and50 checksums unchanged.

Protected server-only evidence:
`/var/lib/bitrix-moysklad-sync/production-34b273a-20261021-01` (0700/0600).
Includes backup/before+after snapshots, `final-native-readbacks.txt`, and
`final-owned.sql.txt`. Credentials were referenced through protected env files,
never copied into reports or code. Initial staging-script doubled-path typo
failed at mkdir before service/database/pointer changes; corrected before build.

## Genuine live cases on the main instance

All source records named `тест PRODUCTION-TEST-20261021-root TEXTFIX3-<case>`.
Each actual MS CREATE → B24 ADD completed with one native card, property108
matching MS ID, measure9/catalog14, one BASE2 retail price12.34RUB, one active
PRODUCT pair and SUCCEEDED durable create operation.

| Case | MS source product | B24 card | Stable pair |
|---|---|---|---|
| BEGIN | abcf43f5-cd80-11f1-0a80-07fe0092a9b2 |683354|cmvigzsbu00344ksf5ql9a9v5|
| MIDDLE | ad7cf2e8-cd80-11f1-0a80-1f6e008f2161 |683356|cmvigzxcf003i4ksfkrysp85v|
| END | af56b6b7-cd80-11f1-0a80-182d0091631c |683358|cmvih0321003q4ksfgu2iv8i3|
| BMP control | b16076e6-cd80-11f1-0a80-182d0091634e |683360|cmvih05iw003s4ksfj7x5wmsh|

Initial inputs combine Cyrillic/Ё, `& <b>literal</b>`, newline and an explicit
TAIL marker, with emoji at beginning/middle/end; BMP control has no supplementary
emoji. Both initial projected native text and unchanged raw MS text were exact.
Then every source got a new description with additional initial emoji and a
joined family at the end. Exact projected full native text, including FINAL
TAIL, was verified. Finally a fresh genuine UPDATE kept the same description
and changed only its owned code, proving repeated processing retains the same
card/pair/price/native XML identity rather than duplicating them.

All **12 MySklad source events SUCCEEDED attempts1**:

| Case | CREATE | Description UPDATE | Repeat UPDATE |
|---|---|---|---|
| BEGIN |cmvigzqhg002v4ksfyvr6mjvv|cmvih1es8003x4ksfi04m7wsq|cmvih2m6y00484ksfn3bepxu6|
| MIDDLE |cmvigzsn900364ksf2m6d51kb|cmvih1h3j003z4ksfgl0vld2h|cmvih2otj004a4ksfw0hbutrx|
| END |cmvigzv1q003c4ksfm34jsyoc|cmvih1lub00414ksfpmoac3ci|cmvih2r5r004c4ksfd173jxv4|
| BMP control |cmvigzxou003k4ksfzwc3qx00|cmvih1o4800434ksf1kqcy4kk|cmvih2tlg004e4ksf33bbycaq|

The readonly helper initially discarded Bitrix's top-level pagination total,
making its one-card assertion false despite correct native data. Only the
helper was corrected to preserve total/next; repeated exact native reads passed.
No runtime guard or provider data was changed to make that assertion pass.

## Preserved failures and honest limits

Old partial product683292/eventcmvie65lj00yd4k6763gw4cgx remained held and unchanged:
operation full-row MD5 `8762e094244b0227a34febf8c3f8b870`, event full-row MD5
`146995c0f156bc5c56fad1d2e4b76abb` equal before switch and final SQL.
Its raw source/frozen text remain full and native partial remains the same.
Old uncertain row887122 MD5 `3e3f830a87c9869267fc3e13cba818b0` and old7992 digest
`bf09d423f0b72cdc41b4e8fb572ce399` also unchanged.

Four **separate early B24 echo** ONCRMPRODUCTADD events remain MANUAL_REVIEW1 /
PRODUCT_PAIR_NOT_ACTIVE: cmvigzr8c00304ksf7uxeaf1d,
cmvigztak00394ksf4qy143sh, cmvigzwdu003f4ksf4qymrhze,
cmvigzzcm003n4ksfzhukf1wq. This is already tracked **point5**, not description
failure. It was not fixed/replayed/hidden, and no blanket all-events/queue PASS
is claimed. Unsupported characters in other fields and services live delivery
are not accepted by this description-only result.

## Independent verification (read only)

Server helper:
`/opt/bitrix-moysklad-sync-operators/production-20261021/root-product-text-fix3-live.py read begin`
(or middle/end/control), run as bms_sync with existing protected readonly-api
EnvironmentFile. Metadata is server-only
`/var/lib/bitrix-moysklad-sync/root-product-text-fix3-20261021/run.json`.
**Do not repeat plan/create/update/repeat actions**; their fences deliberately
reject duplicate mutations. No automatic next point or agent reactivation.
