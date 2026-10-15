# Event intake and queue behavior

This service acknowledges a webhook only after its event has been durably stored in PostgreSQL. Processing runs asynchronously from the persisted event. Configure both endpoints over HTTPS and store credentials in the deployment's secret store; never include live credentials in this document, URL examples, logs, or support output.

## Endpoints

| Provider | Method and path | Authentication |
| --- | --- | --- |
| Bitrix24 | `POST /webhooks/bitrix24` | `auth.application_token` must match `BITRIX24_EVENT_APPLICATION_TOKEN`. |
| MoySklad | `POST /webhooks/moysklad/{secret}` | The path segment must match `MOYSKLAD_WEBHOOK_SECRET`. |

Set `SYNC_MODE` to `apply` or `dry` at process start. In `dry`, `DRY_DATABASE_URL` is required and selects a separate database; in `apply`, `DATABASE_URL` is used. The service rejects intake when the configured service mode is `off`. In `pause`, verified events are stored and wait for processing to resume.

Bitrix24 sends a single event envelope. The application token is removed from the stored payload. MoySklad may send an `events` array; each item is stored as its own queue event, and the service does not acknowledge the batch unless all items have been persisted. MoySklad's [webhook guide](https://github.com/moysklad/workbook-api-doc/blob/master/pages/workbook/articles/webhooks.md) documents a `requestId` query parameter and states that it remains the same on delivery retries. When supplied, the queue key combines that ID, the event's batch position, and a payload fingerprint. Neither provider's event format is assumed to have a stable delivery ID when one is absent, so each such arrival receives a unique key and is retained (at-least-once intake); this avoids incorrectly collapsing two later genuine updates that happen to have identical webhook envelopes. Downstream processing must reread current entity state and tolerate repeat processing.

Direction-disabled events are stored as terminal skips with `DIRECTION_DISABLED`. `off` returns HTTP 410 without storing the event. Authentication failures do not write events. Logs contain safe event metadata only, never the credentials or complete provider payload.

## Provider setup and verification

Register only event types whose entity direction is enabled and whose processor is implemented and enabled in the service. Configure the Bitrix24 application token and MoySklad secret independently. Do not copy the MoySklad secret into a query parameter; it belongs only in the configured path segment.

The repository does not assert which event subscriptions are currently installed in a live Bitrix24 portal or MoySklad account. Verify the account's actual subscription list and perform a controlled test delivery before enabling a direction. MoySklad documents `requestId` retry behavior, but the service still supports events without that query value through at-least-once intake. This implementation does not call either provider to configure subscriptions.

## Processing safety

Workers read current provider state before applying changes and persist event, API-attempt, retry, and review status in the selected database. Transient failures remain retryable; events requiring a human decision are held for manual review. A worker restart rediscovers persisted pending events. External API writes in `dry` are prohibited by the dry-mode runtime gates and use only the isolated dry database.

Event workers share four PostgreSQL-backed renewable slots. Each slot has an owner token; workers revalidate ownership before side-effect and completion boundaries, and client processors retain source/pair locks through those boundaries. Contact processing also locks its unresolved primary company before lookup or create, then keeps that company's pair lock after resolution. A remote API and PostgreSQL cannot participate in one atomic transaction: if a provider accepts a create just as a worker loses its lease or its response is interrupted, the request may already have taken effect. Before a client create, the event is marked `CLIENT_CREATE_IN_PROGRESS` durably; a stale marker is promoted to manual review and is never automatically re-created. A confirmed create clears the marker in the same transaction that persists its pair. Other processing retries reread current provider state and verify writes before advancing synchronization state. This residual uncertain-response window is not claimed to be exactly-once delivery.

The stored database is the source of truth for queue recovery. If it is lost, do not start `apply` against a new empty database: the former launch boundary, queue, event history, and audit cannot be reconstructed from the replacement database. Follow the controlled recovery procedure and confirm the prior boundary and pairs before re-enabling writes.

## Scope and remaining #57 work

This branch implements a reviewed safety slice, not the complete #57 feature. Client company/contact events have atomic durable claims, stale-claim recovery, source/pair leases, a persisted `On` write gate, dry-mode write prevention, and provider `Retry-After`/bounded-backoff scheduling. The four worker slots are a capacity limit; event and pair ownership is enforced separately for the client processor.

Do not subscribe unsupported lifecycle events or infer that all entities are synchronized. Client delete events, invoice routing, full deal/order dependency resolution, broad all-entity nightly reconciliation, cross-instance nightly-job leasing/catch-up, and a persisted launch-boundary recovery acknowledgement remain incomplete. The current launch does not enforce the documented lost-database recovery procedure; a replacement database must not be used for `apply` until that control is implemented and reviewed. The required end-to-end timeout/lost-response recovery matrix is also incomplete. Keep those paths disabled and treat this branch as partial until each gap has its own verified implementation and independent acceptance review.
