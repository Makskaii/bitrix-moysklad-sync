# Lifecycle durable-mode gate evidence

## Scope

This change gates lifecycle recovery scans and claims, current-state provider
reads, tombstone writes, marker/timeline operations, restore provider calls, and
their durable status updates on the global `SyncSetting.serviceMode === 'on'`
row. Each provider operation is individually gated; a helper callback must not
chain multiple provider requests or wrap a recovery batch. The lifecycle HTTP
adapters use `AbortSignal.timeout(10_000)` and the shared mode transaction uses
a 15-second transaction timeout.

## Timeout observation

A local PostgreSQL 18 probe held a synthetic provider promise past the
15-second Prisma interactive transaction timeout. The transaction timeout did
not cancel the pending JavaScript callback: the queued lifecycle event remained
`PROCESSING` while the provider promise was unresolved. Therefore transaction
timeout is not treated as cancellation of JavaScript or of a request already
sent to a provider.

The regression test now models the supported transport contract instead: the
synthetic fetch honors its supplied 10-second abort signal, the event becomes
retryable without a second provider call, and a later durable retry completes
the same exact pair once. A separate PostgreSQL race test queues OFF while one
bounded provider request is active; after OFF commits, the next independently
gated lifecycle step is refused. Recovery resumes only after ON and stale-claim
eligibility.

## Operational interpretation

OFF acknowledgment cannot recall a provider request that started before the
mode transition. It prevents new claims and new provider operations after the
transition commits. In-flight work remains observable in its durable processing
state and is eligible for normal stale-claim recovery after service mode returns
to ON. Tests use synthetic provider responses and a dedicated local test
schema; they do not establish provider delivery or production activation.
