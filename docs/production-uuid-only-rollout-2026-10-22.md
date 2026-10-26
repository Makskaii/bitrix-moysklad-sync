# Production UUID-only rollout — 22 October

## Deployed, independently verified

- Immutable production-only commit777e543ef5ce267eb2782f6dbe10ee565b4e4582,
  parent8366b744c401bcb9b79fb9b050bf67970931d346, applies only patch17b76f4.
  Retained local branch issue-79-uuid-only-rollout; no unrelated integration HEAD.
- Artifact /opt/bitrix-moysklad-sync-releases/issue79-777e543-20261022-uuid-only,
  bitrix-moysklad-sync.service ACTIVE, PID1319399, actual cwd verified.
- Semantic ON, settings6, all six currently enabled direction preflights PASS,
  same boundary2026-10-21T11:39:51.761Z and recoveryREADY. No direction/rule edits.
- Exactly TWO compiled runtime JS files differ from previous production:
  products/document-product-identity.js and products/product-catalog-create.service.js.
  Full runtime file set otherwise identical. UI byte-preserved; schema/migrations
  identical (50), no migration command executed on production.
- Strict TLS /health200; public GET/POST identical shell/no synthetic auth echo;
  anonymous admin403. Independent post-rollout native DB/role/schema guards PASS.
- Brief normal PAUSE->stop->switch->start PAUSED->preflight->ON. No OFF interval,
  boundary change, event replay/reset, pair seed, duplicate cleanup or card edits.

## Preservation

Read-only full-row aggregate hashes of pre-existing accepted events (fixed cutoff),
PRODUCT aliases/pairs/baselines/states, document creation/position journals and
links matched across paused restart and15s watch. New incoming events excluded
only from the fixed-cutoff comparison, not dropped. Immutable settings history,
current version, direction rows, recovery and migration checksums matched after ON.
Normal exchange can now legitimately change business rows again.

Server-only restricted evidence:
/var/lib/bitrix-moysklad-sync/uuid-only-777e543-20261022-02 (0700).
Server-only full backup:
/var/lib/pgsql/uuid-only-777e543-20261022-02/production.pgdump
(0600 postgres,16527153bytes); not exported/restored. Previous release and drop-ins
retained. New override only changes WorkingDirectory/ExecStart.

Initial attempt01 stopped at a Prisma preflight error before changing mode/runtime;
read-only candidate diagnostics subsequently confirmed actual DB/schema/role,
ON/settings6/recoveryREADY. Attempt02 reached PAUSE/stop then stopped because
postgres could not read a SQL input under /root. After installing this non-secret
read-only SQL in /tmp, an explicit checked stopped-PAUSE continuation completed.
No blind rerun of mode/provider writes or snapshot overwrite after a populated
baseline. Failed evidence/logs retained, not deleted or represented as success.

## Verification scope

The exact production-only source was exported separately and compiled with its
own physical Prisma6.19.3 client for the original50-migration schema. API build,
test compilation and36 selected tests PASS (1 sharedcreate,9 new actual-PG UUID,
14 reverseorder,4 forwardidentity,8 publiccatalog),0fail/cancel/skip. New owned
PG58345 cluster/schemas only, synthetic providers; naturally stopped/data retained.
Server independently compiled the source with physical Linux dependencies and
syntax-checked every API JS before switching. No runtime hotpatch.

Post-deploy checks do NOT claim a fresh genuine order-creation acceptance run.
Existing UUID49006/682892 conflict remains a data-repair task; saved active pairs
are not silently reassigned by this preventative code fix. Separate cleanup chat
has its own human assignment and is waiting for coordinated safe repair; this
rollout did not grant a cleanup PAUSE or mutate its cards/pairs/documents.

## Prepared but still NOT deployed

1. ab3c7e3: configured organization fallback and RUB fallback for unmapped source
   currency under confirmed-defaults; numeric prices are NOT FX-converted.
2. 74e6eb9: durable Russian deal timeline outcome/error notices, deduplication
   and independent delivery retries. Requires additive migration51 and separate
   live acceptance. Coverage is specific deal paths, not every entity processor.

These are the two runtime changes already integrated after old prod8366 which
were deliberately excluded. d2c2a3b/a899172/4a079fa are test/evidence changes.

Other known unfinished work is NOT a ready undeployed fix: safe repair/removal of
existing service-created duplicates; invoice7998 discount rejection; warehouse
reverse field-copy configuration; nightly failures; deferred queue/throughput
optimization. Existing company COMMENTS/email one-way rules are intentional,
not an unconfirmed reverse-copy bug.
