# Issue #79 production-history upgrade proof

This reproduces the active production database's migration history without reading or copying production data. It uses a brand-new local PostgreSQL database, pins all 25 applied production migration names and SHA-256 checksums, seeds synthetic state, applies the candidate migration set, checks that the fixtures survive, and asserts zero Prisma schema drift.

The 25 pinned files were read from the active release's `prisma/migrations`; their bytes were compared with the production files. No applied migration SQL or checksum is changed. A pending candidate migration (`20261016100000_deal_order_exchange`) is idempotent for the legacy operation/pair tables that production already has. It must stay checksum-stable after release.

## Run

Create a new disposable local database yourself, choosing a unique name that ends in `_test`. The script refuses databases with a different name, a non-loopback host, existing public relations, or an unexpected migration history. Do not reuse or drop an existing database. Example with the local PostgreSQL 18 instance:

```powershell
$db = 'sync_issue79_upgrade_20261020a_test'
$psql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
$exists = & $psql -h 127.0.0.1 -p 58341 -U postgres -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname = '$db'"
if ($exists) { throw "Refusing existing database $db" }
& $psql -h 127.0.0.1 -p 58341 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE `"$db`""
$env:DATABASE_URL = "postgresql://postgres@127.0.0.1:58341/${db}?schema=public"
$env:ISSUE79_UPGRADE_TEST_DATABASE = $db
node scripts/issue79-production-upgrade-proof.mjs
```

Never pass a production URL or credentials. The script requires `DATABASE_URL` and `ISSUE79_UPGRADE_TEST_DATABASE`, verifies the connected database name and emptiness, reconstructs the 25-migration baseline in a private OS temporary directory, seeds only synthetic settings/event/pair/cursor/operation records, applies the repository's full migrations, then verifies fixture values and `prisma migrate diff --exit-code` parity. It cleans up only its own uniquely-created temporary directory. It does not drop the database.

Expected completion is `PASS: exact production-25 upgrade preserved synthetic fixtures ...; schema drift is zero.` A failed run is not a pass. Keep failed databases for diagnosis; choose a new uniquely named `_test` database for a rerun.

## Pinned production history

The script contains the byte-level SHA-256 manifest. These exact migration folders, in production application order, must remain unchanged:

1. `20260930000000_init`
2. `20260930010000_inbound_events`
3. `20261002090000_contact_email_sync`
4. `20261002100000_contact_event_claim`
5. `20261002110000_contact_event_kind`
6. `20261002120000_sync_settings`
7. `20261002130000_sync_direction_settings`
8. `20261002140000_off_resume_cursor`
9. `20261005000000_monitoring_retention`
10. `20261005100000_event_retry_backoff`
11. `20261005120000_nightly_reconciliation`
12. `20261005130000_entity_processing_lease`
13. `20261007010000_field_settings_versions`
14. `20261007090000_entity_pair_resolution`
15. `20261007111500_entity_pair_baseline`
16. `20261007113000_entity_pair_sync_state`
17. `20261007140000_deal_order_create_operation`
18. `20261007140000_historical_inventory`
19. `20261007150000_deal_order_create_attempted_at`
20. `20261007160000_deal_order_create_lease`
21. `20261007170000_deal_order_position_pairs`
22. `20261007180000_deal_order_position_add_operations`
23. `20261008100000_historical_deal_order_matching`
24. `20261008110000_dependency_create_operation`
25. `20261008120000_deal_order_customer_pair_refs`

The migration folders absent from the original candidate are restored production SQL, not replacements or edited checksums. The script validates the active candidate copy against its pinned manifest before running the proof.
