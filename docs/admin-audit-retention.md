# Admin audit and operational history

Every administrative write still requires the server-side Bitrix24 `user.admin == true` check. Audited writes also resolve the current Bitrix24 user ID; if identity lookup fails, the write is refused. Local preview is isolated from the normal API and labels its audit actor `LOCAL_PREVIEW`.

Pair creation and reassignment, manual-review retry/resolve, and one-event recompute create append-only audit rows in the same database transaction as the state change. Audit rows contain the actor, action, target, reason, and bounded before/after values. The admin API exposes paged reads and no update or delete route.

Retention is applied by the server process to the database selected at startup:

- Dry-mode inbound events, API attempts, and operational logs: 7 days.
- Apply-mode inbound events, API attempts, and all operational log categories: 30 days by default. `SYNC_OPERATIONAL_RETENTION_DAYS` can set completed operational history to 1–365 days; invalid values use the 30-day default. The setting is server-side only.
- Events attached to open manual-review cases remain available for retry until the case is resolved. Open cases are retained until resolved; resolved cases are retained for 180 days.
- Admin audit rows: 365 days.
- Technical application log files rotate before a file grows beyond 200 MB.

Operational log messages and audit JSON are bounded and redact credential-shaped keys. Review diagnostics omit common credential and contact-data keys; only explicit row/field labels and old/proposed field values are returned to the admin UI.
