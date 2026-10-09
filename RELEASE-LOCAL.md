# Local v1 release preview

This is a local-only preview, not a production deployment. It uses one Docker Compose project, one local PostgreSQL volume, and the explicit local-admin preview module. The UI is bound only to loopback. The service starts with `SYNC_STATE=off`, empty webhook secrets, and no external-system API credentials.

## Start and stop

Run from the repository root:

```powershell
docker compose -p release-local-admin-preview -f docker-compose.yml -f docker-compose.preview.yml up -d --build
```

Open http://127.0.0.1:5174. The web container and local preview API share the same database, so settings and active pairs shown in the UI are the ones used by that preview API. The web port is published on host loopback only. The API listens on all interfaces inside its Compose container so the web proxy can reach it, but it is not published on a host port. When running the preview API outside Compose, its bind address defaults to `127.0.0.1`; set `ADMIN_PREVIEW_BIND_HOST=0.0.0.0` only when a trusted container network needs to reach it. `ADMIN_PREVIEW=1` is set only for the dedicated `LocalPreviewModule`, never for the normal production API.

The local database uses the Compose project's named volume. To stop containers and preserve that volume:

```powershell
docker compose -p release-local-admin-preview -f docker-compose.yml -f docker-compose.preview.yml down
```

## Configuration keys

The local preview explicitly sets `SYNC_STATE=off`, `LOCAL_HEADER_EXCHANGE=0`, and `LOCAL_HEADER_EXCHANGE_READY=0`, and leaves webhook/upstream credentials empty. Header exchange is disabled in the preview. The test harness may set synthetic values only for isolated fake-HTTP testing; never copy production values into this checkout:

- `SYNC_MODE` (`apply` or `dry`)
- `SYNC_STATE` (`on`, `pause`, or `off`)
- `DRY_DATABASE_URL` (required only for `SYNC_MODE=dry`)
- `BITRIX24_EVENT_APPLICATION_TOKEN`
- `MOYSKLAD_WEBHOOK_SECRET`
- `BITRIX24_REST_BASE_URL`
- `MOYSKLAD_API_BASE_URL`
- `MOYSKLAD_API_TOKEN`
- `LOCAL_HEADER_EXCHANGE`
- `LOCAL_HEADER_EXCHANGE_READY`

Never use a production database URL or connect tests to a production API. PostgreSQL tests must use a disposable isolated database and fake HTTP upstreams.

## What works and release limits

- The local admin UI, persisted pair assignment/review, field-configuration preview, inbound event persistence, and existing contact/email exchange paths are available within their configured dependencies.
- The temporary local-only header writer is present but fail-closed: it requires preview mode, `LOCAL_HEADER_EXCHANGE=1`, a separate readiness flag `LOCAL_HEADER_EXCHANGE_READY=1`, apply mode, DB service mode on, and literal loopback fake HTTP endpoints. The checked-in preview sets both exchange flags to `0` and has blank upstream endpoints/tokens.
- Header-writer flags do not gate Q26.66's separate first-event baseline capture. In an environment that accepts a webhook for a confirmed historical deal/order pair, baseline capture reads both source documents and saves the immutable, settings-versioned baseline before field processing. This is not an external sync write. Global `off` rejects intake before any event/job or source read; `pause` accepts/persists events and permits those read-only baseline reads but no external sync writes; `SYNC_MODE=dry` writes baseline state only to the isolated dry database and makes no external sync writes.
- If the temporary writer is separately enabled against loopback fakes, deal/customer-order exchange is limited to a confirmed persisted pair, immutable bilateral baseline, and the hard-coded COMMENTS↔description mapping with readback/echo guards. This is not general field-configurable exchange, and no production vendor endpoints are safe or supported by this local feature.
- An unresolved pair, unavailable source/baseline, invalid field, unknown row identity, or missing configuration must remain held for manual review.
- Deal/customer-order creation, full-row/position exchange, and full v1 bidirectional document exchange are not claimed. This local release does not create orders or change positions, totals, paid amounts, IDs, UUID/meta/reference objects, or `TITLE`/MoySklad `name` through generic mapping.
- The checked-in preview's default `SYNC_STATE=off` prevents webhook intake; its empty credentials also prevent source API reads. Outside this preview, an accepted first event may intentionally cause two read-only baseline source calls even when the local header-writer flags are off. Do not treat a webhook acknowledgement in a test fixture as proof of document exchange.

## How to test

1. Start the preview with the command above and check the UI at `http://127.0.0.1:5174`.
2. Check container health with `docker compose -p release-local-admin-preview -f docker-compose.yml -f docker-compose.preview.yml ps`; the internal API health endpoint is available to the web container at `/health`.
3. Run the API build and unit/integration suites from the repository root. Run PostgreSQL suites only when their isolation guard points to a disposable local database.
4. Run the isolated `test:deal-order-baseline` suite with its isolated PostgreSQL DB URL overrides (`BASELINE_TEST_DATABASE_URL` and `BASELINE_DRY_TEST_DATABASE_URL`) and fake loopback upstreams. It covers public webhook → pair resolution → bilateral baseline → COMMENTS↔description updates → readback/echo no-op and gates; assert there are no create calls or row/position/total changes. If baseline/readiness or writer configuration is incomplete, expect a hold rather than success.
