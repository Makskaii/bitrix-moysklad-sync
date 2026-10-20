# Issue #79 native systemd staged rollout and rollback

Status: preparation only. No server changes, database writes, service restarts, provider writes, webhook changes, or production queue operations are authorized by this document. Execute only after the combined review, complete migration/test acceptance, and a separate explicit rollout approval.

## Known deployment shape

- Native systemd service: `bitrix-moysklad-sync.service`.
- Active release root: `/opt/bitrix-moysklad-sync-releases/root-live-v1`.
- Native PostgreSQL on port 5432; active database `bitrix_moysklad_sync`.
- Nginx routes public 80/443 and 5015 to loopback 5015; health check was green at preparation time.
- Service configuration is held in systemd environment files under `/etc/sysconfig/`; never print, copy into the repository, or include their values in logs or evidence.
- At inspection, sync mode was OFF, production had 25 completed migrations, and the durable queue had 402 `MANUAL_REVIEW` plus 263 `RECEIVED` rows. These 665 rows are retained as-is: no replay, clearing, reset, or broad dequeue is part of this rollout.

Reconfirm all volatile facts at execution time through the approved read-only procedure. Use normal configured SSH (`ssh -o BatchMode=yes root@80.90.191.124`); do not use alternate key paths. This is native systemd, not Docker. Do not target the legacy `/opt/.../root/Aerosystems` directory.

## Preconditions and stop conditions

1. A combined candidate SHA is reviewed and accepted; full final-order fresh and exact-production-25 upgrade proofs pass; API/web build, relevant PostgreSQL suites, webhook/public HTTP tests, admin API/UI acceptance, and fake-provider tests pass. `NOT RUN` is never a pass.
2. Review the exact release diff, migrations, migration checksums, service unit, nginx routing, disk space, and systemd environment-file paths without printing any secret values.
3. Confirm healthy PostgreSQL backups/snapshot and a tested restore path. Record queue counts, migration rows/checksums, pair counts, settings/config version, systemd unit state, and current release pointer in the restricted ops log; do not export customer records or credentials.
4. Pre-stage an immutable, separately named release directory and dependencies; verify candidate SHA/build artifact before switching the release pointer. Keep the current release untouched for binary rollback.
5. Require an operator plus independent stop authority. Leave general sync mode OFF throughout deployment. If any check differs from expected, stop with the service OFF; do not improvise.

## Staged execution (future, approved operator only)

1. Announce a short maintenance window and verify the service is currently OFF. Do not change mode to Pause/On as a shortcut and do not alter inbound webhooks.
2. Capture a final read-only baseline of migration history, queue counts/statuses, pairs, current configuration version, `/health`, systemd state and release pointer. Preserve all 665 existing queue rows and all native IDs/pairs.
3. Stop only `bitrix-moysklad-sync.service`, verify it is inactive, and verify no other writer is attached to the same database. Do not stop PostgreSQL or nginx.
4. Take a fresh database backup/snapshot. Apply the reviewed additive candidate migrations using the exact reviewed release. Do not edit `_prisma_migrations`, backfill/replace checksums, rename legacy applied migration folders, or run a destructive reset. If any migration errors or drift appears, keep the service stopped and follow rollback/repair below.
5. Activate the staged release using the platform's approved atomic release-pointer procedure. Keep all existing secret environment files in place; do not expose their contents. Confirm systemd loads the intended release and starts successfully.
6. Verify `/health`, local loopback API/admin read-only endpoints, schema parity, and queue/pair/config preservation. Reconfirm that global mode remains OFF and that the 665 pre-existing queue rows remain unchanged; do not claim these rows processed.
7. Keep entity/direction switches disabled except the documented preparation scope. Configuration version 4 may enable only preparation creation for the approved mapped MySklad status `5cc9f6dc-7d61-11e9-9ff4-31500014f07a`. `UC_DZSNZ0` is missing and cannot be inferred. Verify the status UUID against the live MySklad account and confirm all mandatory references before any later activation decision.
8. The baseline migration history contains no `DatabaseRecoveryState`/`previousLaunchBoundary`. Do not derive the launch boundary from `SyncSetting.offSince` (that field records mode history only). Leave apply blocked/failclosed until an authorized administrator confirms the correct initial document boundary using the explicit continuity procedure and independent operational evidence. Deployment while OFF does not require inventing that boundary.
9. Stop after OFF-state health verification and hand back the evidence. Enabling directions, registering/changing webhooks, running live provider calls, or processing any queue requires a separate explicit scoped-live-test authorization and run plan.

## Rollback / failed rollout

- If the candidate has not started: keep the service stopped and OFF; restore the prior release pointer. Do not reverse schema migrations.
- If the candidate starts but fails health or preservation checks: stop the service immediately, keep mode OFF, restore the prior application release, and retain the migrated database for diagnosis. Additive forward-compatible migrations are not rolled back with hand-written SQL.
- If a migration partially applies or reports failure: do not edit migration history/checksums, do not mark it applied manually, and do not restart either release against an uncertain schema. Preserve PostgreSQL logs and the failed DB state; obtain a reviewed forward repair plan using a new migration after a snapshot.
- If any queue item, pair, settings version, native ID, provider call, or unexpected writer changes: stop the service, preserve all data and audit rows, and escalate to the independent stop authority. No replay, queue deletion, pair recreation, database reset, or webhook unregister is an improvised rollback.
- A database restore, if ever required, is a separately approved recovery operation requiring an explicit choice of restore point and acceptance of data-loss scope. It is not authorized by this runbook.

## Acceptance record

Record release SHA, backup/snapshot ID (not its credentials), migration names/checksums, schema-diff result, OFF mode confirmation, before/after queue counts and row-status invariance evidence, pair/config counts, health result, service unit/release pointer, operator and independent witness. Keep evidence restricted and free of secrets and customer payloads. Do not write `PASS` for any unrun step.
