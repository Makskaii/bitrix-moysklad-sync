# Historical deal/order inventory (#45)

The admin page at **Исторический каталог** manually starts or pauses the historical catalog. It stores only IDs and the approved candidate fields in `HistoricalInventoryEntry`; it does not create record pairs, choose candidates, create external records, capture sync snapshots, or gate normal service readiness. A process restart leaves the checkpoint in PostgreSQL; an administrator starts again in the UI with a fresh Bitrix24 session to resume.

The Bitrix24 deal list has a fixed 50-record page size. The MySklad page size can be set from 1 to 1,000. The default request interval is 1,000 ms; the lowest configurable interval is 500 ms, or two requests per second. The worker runs one request at a time, backs off on 429/503 and transport errors, and retains the current page cursor until its records have been saved. Metadata titles are read from the provider response; missing titles are shown as unavailable in metadata.

## Local verification

From the repository root, run:

```powershell
npm run test:historical-inventory --workspace @sync/api
```

The integration test uses a temporary loopback admin API and in-memory fake Bitrix24/MoySklad responses. It covers allowlisted persistence and metadata titles, no external writes, rate-limit retry at the same cursor, pause/resume from a checkpoint, and idempotent handling of a repeated record ID. It uses no live vendor credentials or API calls.

For a UI smoke check, start the local admin preview using the command in [RELEASE-LOCAL.md](../RELEASE-LOCAL.md), open the **Исторический каталог** page, and confirm the idle state, the manual launch and pause controls, the cursor/progress display, and the field-code/title/value/status table. Starting requires both configured upstream APIs and an active Bitrix24 administrator session; the automated test supplies only fake upstreams.

The API persistence/lease test is `npm run test:historical-inventory:postgres --workspace @sync/api`. Run it only against a fresh disposable local PostgreSQL database whose name contains `issue45_inventory`; set `HISTORICAL_INVENTORY_TEST_ISOLATED=1` and `DATABASE_URL` explicitly for that database. After validating this guard, the test itself runs `prisma migrate deploy`, verifies the #45 migration record, then checks checkpoint persistence across API restart, idempotent boundary replay, and a single active lease across two service instances. It refuses non-local hosts and a pre-existing inventory singleton.

The API behavior used here is documented by the vendors: Bitrix24 list pages use `start` in 50-record increments and return `next` [in the official deal-list API reference](https://apidocs.bitrix24.com/api-reference/crm/deals/crm-deal-list.html); the cloud request limit has a two-requests-per-second sustainable rate on plans other than Enterprise [in Bitrix24 REST API limits](https://apidocs.bitrix24.com/settings/performance/limits.html). MoySklad collection pages use `limit` up to 1,000, `offset`, and collection metadata [in the JSON API 1.2 documentation](https://dev.moysklad.ru/doc/api/remap/1.2/).
