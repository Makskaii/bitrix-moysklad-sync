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

## Rollout and native verification

Final runtime8366b744c401bcb9b79fb9b050bf67970931d346/PID1298712 ACTIVE ON; candidateaf76 was activated only PAUSED. A standalone CLI exposed that an unref'ed pacing timer could permit a zero exit before completing queued work; corrected to a referenced bounded timer and added an actual child-process completion check. Combined candidate212 selected checks passed; final correction17 targeted checks passed, zero fail/skip/cancel, natural exit. Additional assembly-admission preparer15 passed; not all-repository/client-suite acceptance.

Protected backup/full accepted-event-row fingerprints/native PID+cwd+command/TLS GET=POST/admin403 verified. Existing schema/50 checksums/hooks unchanged. All six real preflights passed. Separately human-approved assembly stage configured through the actual validated save: v5→v6, only UC_DZSNZ0 creation admission and its exact canonical confirmed reference; PREPARATION, transitions18/18,9units/7prices/all other config and boundary preserved. Mode restored by normal resume, no force.

Actual owned139044 and user139048 each naturally created one MS order after rollout: respectively311eff2c-cdf7-11f1-0a80-0c6100238cbf and35003761-cdf7-11f1-0a80-1e3d002296fa. Native reads confirm exact goods UUID/quantity/price, totals2468/51300minor, account+parent, full title and native number, one order per durable syncId and zero reverse-created deals/journals. Company170954 selected an existing ranked counterparty and persisted one pair. No root source mutation/reset/replay/manual target CREATE/pair seed in this release check. Readonly viewer initially compared gross versus net on the22% VAT user row; corrected comparison follows the native included-VAT basis, provider data never changed.

Both genuine MS CREATE/UPDATE callbacks were still RECEIVED at the last read. They arrived before pair creation, but no deferred-processing audit exists yet; full early-race/reverse callback live acceptance remains pending. Conservative pacing plus backlog can still delay work; no guarantee of zero429 under foreign account load, no sustained15-second SLA, no historical hold repair. Evidence server-only production-8366b74-20261022-01; read-only helper root22-ms-budget-native-read.cjs distinguishes functionalReady from event status.
