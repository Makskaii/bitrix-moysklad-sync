# Proven forward-create ownership conflicts require review

## Evidence

A bounded production log audit found repeated `Customer-order pair became conflicting before persistence` for an already attempted forward operation (deal138698). The typed `DealOrderPairConflictError` was caught by the generic retry path, leading to repeated attempts instead of an actionable hold. No production pair, journal or source event was repaired by this change.

## Change

- Persist the already-proven typed conflict as operation `CONFLICT` / `PAIR_CONFLICT`, releasing only the operation's own lease.
- Preserve the frozen payload, syncId, provider target ID and existing pairs.
- A later call encountering this status throws the same typed conflict before any provider access.
- Public intake processing holds the event in `MANUAL_REVIEW` / `CUSTOMER_ORDER_PAIR_CONFLICT`, without retryAfter. It does not guess which conflicting pair is correct.
- Transient provider failures, uncertain response recovery and non-conflict failures retain their existing retry path.

## Verification

Implementation-first as requested; API build and test-TypeScript compilation passed. Dedicated local PostgreSQL18 on58345, new owned databases with51 migrations: operation suite10/10 and actual public HTTP/processor suite14/14 passed, no skips or external provider writes. Tests include first detection after a saved target exists, cold restart with zero provider calls, repeated public ADD/UPDATE holds, preservation of conflicting pairs, lost responses, native syncId ownership and OFF fences.

The existing public suite fixtures predated the deployed two-organization policy: missing organizations, loopback reference identities and absent native headers caused7 initial failures. Fixtures now provide an actual approved native reference while retaining loopback transport; expected temporary-read error is the earlier organization-read guard. No runtime filter or assertion was bypassed. Intermediate own test databases are retained; the final full suite passed14/14.

Not deployed. A separately approved maintenance window is required; no migration is needed. Production observation must establish the affected typed conflict reaches review naturally and no additional document is created. Existing conflicting pairs require a separate business repair decision, not this classification fix.
