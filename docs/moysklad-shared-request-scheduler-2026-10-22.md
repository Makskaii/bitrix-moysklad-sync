# Shared MS request budget — 22 October 2026

## Evidence and contract

Primary 1dde runtime returned HTTP429/code1049 for store/employee/currency reads in owned deal139044's preparation. A later bounded probe returned all five exact identities200; response headers advertised limit45/interval3000ms with remaining credits falling unevenly. This is transient/shared load, not proof that reference configuration is absent. Other independently authorized work/integrations also use this account; do not attribute every request to this process.

Official JSON API header contract: [MS source documentation](https://raw.githubusercontent.com/moysklad/api-remap-1.2-doc/master/md/_general.md). `X-Lognex-Retry-After`, `Reset` and `Retry-TimeInterval` are milliseconds; standard Retry-After is seconds or an HTTP date. The headers describe request-rate budgets, not the separate parallel-request restriction.

## Implementation

Bootstrap installs a single transport scheduler after the controlled fetch guard and before constructing runtime providers. All default direct/global and constructor-injected fetch adapters in this process share the configured MS origin/path-prefix budget. Other origins/API versions, including Bitrix, pass through unchanged. No provider authorization, business payload, namespace admission, mode fence or durable operation identity is replaced.

- Initial starts spaced at least250ms; maximum two active HTTP bodies, leaving headroom for other account users. Server-advertised slower cadence is retained.
- Near exhaustion (20% remaining credits) or HTTP429 pauses all this process's MS requests using the maximum applicable native/standard delay; fallback is the advertised window or3s. Repeated429 slows cadence; only100 successful responses gradually recover it. Values are bounded, not logged with credentials.
- FIFO pending transport queue capped100. Existing abort signals include queue wait, plus an overall12s ceiling below the mode transaction's15s bound. Expired/cancelled queued writes are removed and cannot send later. Event AsyncLocalStorage context is preserved to the final controlled guard.
- A response-body monitor releases capacity even when an adapter throws without consuming a rejected response body. Caller body/status/native URL remain available. Normalize a shared429 Retry-After without changing the body.
- Never automatically resend GET/POST/PUT/DELETE. Existing event retries and durable CREATE journals retain sole recovery authority. No schema/config/hook changes, event resets or historical replay.

This is process-wide coordination, not control over separate operator processes/foreign integrations. Sustained external load may still produce429; those responses are not successful exchange.

## Joint client selection patch

The human explicitly authorized combining44601f9 from the other chat for a single primary rollout. It applies existing usage/filled/earliest ranking to exact shared-email candidates, preserves contradictory identity/occupied endpoint/tie holds, and propagates transient usage429/503 into durable retry rather than local bursts or false missing-usage review. See `client-shared-email-selection-2026-10-22.md`.

Root's genuinely fresh isolated client DB exposed a missing durable ON setup in the test fixture (not a production regression). Added explicit ON initialization for these intended-ON public cases; all four targeted real-processor/PG checks then pass without changing assertions or runtime guards. The broader client suite's seven pre-existing A/B failures remain outside this narrow acceptance; not an all-repository PASS.

## Postchecks and live gate

Implementation first, postchecks only as requested. Scheduler13 checks include a real local HTTP server (unpaced burst gets429, paced burst all200), scoped controlled guard, cancellation, error-body drain, header/date timing, unchanged ACK/body, and no hidden POST retry. Real PostgreSQL3 cover actual gateways, bootstrap-installed shared budget, bounded queued write versus PAUSE acknowledgement and durable Retry-After. Combined selected regression and actual production verification are recorded separately when finished; do not infer a successful live order from these local fixtures.
