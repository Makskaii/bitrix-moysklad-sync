# Recovery after loss of the apply database

PostgreSQL backups are not enabled. If the apply database is lost, its inbound queue, snapshots, audit rows, and manual decisions cannot be guaranteed to return. The service must not treat a recreated empty database as a new launch.

The `DatabaseRecoveryState` row and its matching `DatabaseRecoveryAudit` record are continuity evidence. The migration creates the tables but deliberately inserts no trusted state. Before the API begins listening, startup closes the apply write gate and checks both records. If either is absent or invalid, the persisted service mode is changed to `off`; webhook intake returns service unavailable and apply provider writes fail closed. If PostgreSQL itself is unavailable or the recovery schema cannot be read, bootstrap fails before opening the HTTP listener.

An administrator can inspect `GET /api/admin/sync-mode/database-recovery`. Recovery requires `POST /api/admin/sync-mode/database-recovery/confirm` with all of the following:

- `previousLaunchBoundary`: the exact ISO timestamp from the independent operations record;
- `pairsRestored: true`: declaration that pairs were restored from exact external IDs/UUIDs and ambiguous pairs were handled manually;
- `lostEventsAcknowledged: true`: declaration that database-only events, snapshots, audit, and manual decisions may be permanently lost;
- `acknowledgement`: a 20–1000 character explanation of the source record and accepted loss.

The existing `AdminAccessGuard` must verify `user.admin == true`; the recovery action also reads `user.current` and stores the verified Bitrix24 user ID. State change and append-only audit entry are committed together. The audit records who acted, when, the previously stored and confirmed launch boundaries, pair restoration, event-loss acknowledgement, and rationale. A duplicate confirmation cannot replace the acknowledged boundary.

Recovery confirmation leaves service mode `off`. An administrator must make the separate confirmed mode transition to `on`. No pair reconstruction, historical scan, queue synthesis, or downtime replay is started by recovery. While the service is paused, events continue to be durably stored; they are processed only after an explicit resume and only from surviving rows.

For deal/order events, processing also enforces the confirmed launch boundary against the upstream document creation timestamp (`DATE_CREATE` in Bitrix24, `created` in MoySklad). A surviving or newly received event for a document created before that boundary is terminally skipped before pair resolution; it is not replayed just because delivery happens after Apply is enabled. If the boundary or source creation time cannot be verified, the event is held for manual review (transient provider failures remain retryable).

An intact database with a valid recovery state and matching audit resumes using its persisted mode. A missing, malformed, or audit-mismatched state is treated as untrusted and held `off` until recovery is confirmed.
