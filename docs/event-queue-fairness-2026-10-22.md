# Event admission fairness — 22 October 2026

## Confirmed failure

With all four durable worker slots occupied, `run()` previously returned null immediately. Recovery launched up to 100 competing calls, discarded the losers, and (except invoices) did not order or advance bounded discovery. The same backlog could repeatedly beat another processor's discovery tick.

The same contention check against the old d9 compiled worker failed: 102 waiting callbacks executed zero times after capacity became available. On the new worker all 102 execute; the invoice and product lanes run within the first four queued admissions instead of after the 100-event document backlog.

Production observation at 08:08:36 UTC, before rollout: 23 Bitrix deal and 79 MS order events were RECEIVED, oldest 616/610 seconds; 12/31 due retries, oldest overdue 534/553 seconds. This is admission/backlog evidence, not proof that every provider request succeeds. Diagnostic SQL must use a session-local UTC timezone because Prisma timestamps are UTC without timezone; initial non-UTC age output was invalid and corrected, without a server timezone change.

## Change

- A bounded local queue retains work when durable slots are occupied. FIFO within each processor lane; round-robin between clients, catalog, invoices, deal/order and legacy-contact lanes. Same-event submissions share one pending result.
- At most four local executions, still gated by the original PostgreSQL four-slot semaphore shared across instances. Another instance occupying capacity causes a bounded 250ms admission poll, not an event reset or 100 simultaneous acquisition attempts.
- Up to 100 pending entries per lane, plus in-flight acquisition/execution. Overflow remains in the durable event table for later discovery. Queue state is deliberately not authoritative: cold restart rediscovers persisted work.
- Preserve the submitting AsyncLocalStorage context across deferred execution. Mode OFF/PAUSE cancels pending admission; shutdown resolves waiters without invoking their callbacks. Existing in-flight lease renewal/release and provider mode fences are unchanged.
- Client, product, deal/order and legacy-contact scans use stable id order with a rotating bounded 100-row cursor. Existing invoice cursor is retained. Future retry deadlines and terminal holds remain excluded.

No schema, config, directions, provider hooks, concurrency increase, historical event cleanup, attempts reset, manual dispatch or replay.

## Verification

Implementation-first, as requested by the user. Postchecks: API build and test compilation; 153 existing/new selected checks plus five new actual-PostgreSQL checks = 158 PASS, zero failed/skipped/cancelled, natural exit. Four public recovery paths discover the tail of 205 unchanged durable events; future retry and manual-review rows remain byte-for-byte equal. Two actual PG lease-service instances preserve queued work and the four-slot bound. Existing forward/reverse race, UUID, catalog, invoice and position checks also pass.

Local isolated PG58343 and owned test databases/schemas only; provider fixtures are local and no external writes occur in these checks. Full production/live acceptance is separate. The existing owned live deal139044 currently also has provider/reference-read failures; neither this scheduling fix nor local success constitutes a successful order-creation proof.
