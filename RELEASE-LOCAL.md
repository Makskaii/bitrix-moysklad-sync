# Local v1 release preview

This is a local-only preview, not a production deployment. It uses one Docker Compose project, one local PostgreSQL volume, and the explicit local-admin preview module. The UI is bound only to loopback. The service starts with `SYNC_STATE=off`, empty webhook secrets, and no external-system API credentials.

## Start and stop

Run from the repository root:

```powershell
docker compose -p release-local-admin-preview -f docker-compose.yml -f docker-compose.preview.yml up -d --build
```

Open http://127.0.0.1:5174. The web container and local preview API share the same database, so settings and active pairs shown in the UI are the ones used by that preview API. The preview API is not published on a host port; only the UI is reachable from the host. `ADMIN_PREVIEW=1` is set only for the dedicated `LocalPreviewModule`, never for the normal production API.

The local database uses the Compose project's named volume. To stop containers and preserve that volume:

```powershell
docker compose -p release-local-admin-preview -f docker-compose.yml -f docker-compose.preview.yml down
```

## Configuration keys

The local preview explicitly sets `SYNC_STATE=off` and leaves these webhook and upstream credentials empty. For isolated fake-HTTP integration testing only, the test harness may set synthetic values for these keys; never copy production values into this checkout:

- `SYNC_MODE` (`apply` or `dry`)
- `SYNC_STATE` (`on`, `pause`, or `off`)
- `DRY_DATABASE_URL` (required only for `SYNC_MODE=dry`)
- `BITRIX24_EVENT_APPLICATION_TOKEN`
- `MOYSKLAD_WEBHOOK_SECRET`
- `BITRIX24_REST_BASE_URL`
- `MOYSKLAD_API_BASE_URL`
- `MOYSKLAD_API_TOKEN`

Never use a production database URL or connect tests to a production API. PostgreSQL tests must use a disposable isolated database and fake HTTP upstreams.

## What works and release limits

- The local admin UI, persisted pair assignment/review, field-configuration preview, inbound event persistence, and existing contact/email exchange paths are available within their configured dependencies.
- Deal/customer-order events require a persisted confirmed pair and bilateral baseline before any eligible configured header-field update. An unresolved pair, unavailable source/baseline, invalid field, unknown row identity, or missing configuration must remain held for manual review.
- Deal/customer-order creation, full-row/position exchange, and full v1 bidirectional document exchange are not claimed. This local release does not create orders or change positions, totals, paid amounts, IDs, UUID/meta/reference objects, or `TITLE`/MoySklad `name` through generic mapping.
- The preview's default `SYNC_STATE=off` and empty credentials prevent webhook intake and external API calls. Do not treat a webhook acknowledgement in a test fixture as proof of document exchange.

## How to test

1. Start the preview with the command above and check the UI at `http://127.0.0.1:5174`.
2. Check container health with `docker compose -p release-local-admin-preview -f docker-compose.yml -f docker-compose.preview.yml ps`; the internal API health endpoint is available to the web container at `/health`.
3. Run the API build and unit/integration suites from the repository root. Run PostgreSQL suites only when their isolation guard points to a disposable local database.
4. The deal/customer-order fake-HTTP test must cover webhook → event → persisted pair resolution → bilateral baseline-before-write → configured scalar header update → readback/echo no-op, plus duplicate delivery and off/pause hold behavior. Assert there are no create calls and no changes to positions or totals. If baseline/readiness or writer configuration is incomplete, expect a hold rather than success.
