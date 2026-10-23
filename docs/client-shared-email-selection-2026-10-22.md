# Deal 139048: automatic shared-email client selection

## Actual read-only reproduction

Production runtime `1dde27cfbe5716c1aa3f5c1bc66c4962ae532c24`.
The deal explicitly references Bitrix company `170954` and no contact.
A bounded invocation of the deployed `HttpClientCandidateGateway` and
`ClientRuntimeResolver` returned four unoccupied MS company candidates from
the exact normalized-email search and `MANUAL_REVIEW/AMBIGUOUS_CANDIDATES`.
The resolver stopped before calling the approved ranking function.
The same probe observed MS HTTP429 while reading usage metrics. One usage
count was unknown, not zero. No candidate was selected or paired in production.
No source fields, credentials or raw provider payloads were printed.

## Fix

- Rank multiple exact-email candidates using the existing approved ordering:
  usage descending, filled fields descending, creation time ascending.
- If exact INN or exact name+phone also matches, first intersect those matches
  with email candidates. Do not let a shared mailbox bypass stronger identity
  evidence. For contacts retain the explicit parent scope.
- Preserve holds for genuinely contradictory keys, occupied endpoints and
  unresolved equal rankings. This is not permission to merge distinct clients.
- Propagate retryable usage-read `ProviderFailure` (including 429 and 503) to
  the owning event's durable retry. Do not turn throttling into missing usage
  evidence/manual review and do not issue three immediate retries on 429.
- Retain explicit systemwide usage-endpoint-unavailable behavior and never
  invent zero usage for an unknown candidate.

## Checks

Implementation first, as requested. An original compiled resolver reproduction
returned MANUAL_REVIEW where the known earlier matching candidate should win.

- API build and test TypeScript compilation: PASS.
- `client-matching.integration` + `client-candidate.gateway.integration`:
  30 PASS, zero fail/skip.
- Actual processor/isolated PostgreSQL targeted run: 4 PASS, zero fail/skip.
  New case: four shared-email candidates, initial HTTP429, durable retry with
  Retry-After, successful ranked pair persistence, repeated resolution reuses
  exactly one pair; no MS writes and no provider field updates.
- Own PG18 at 127.0.0.1:58344, DB `side22_client53_test`, schemas
  `client53_test` and `dry_client53_test`, 50 migrations. The next-due delivery
  transition is simulated only in that isolated fixture, never in production.
- Broader legacy client-mapping suite is NOT green. A/B in the same isolated
  database: original compiled tree 22 PASS / 7 FAIL; changed tree 23 PASS /
  the same 7 FAIL. Failures concern inventory paging, lease loss during paired
  update, uncertain applied update, empty-target INN, contact-context fanout,
  recovery-blocked child update, and readback mismatch. Do not claim full
  client regression acceptance; fixture/state compatibility needs separate work.

## Production handoff

Main coordinator is concurrently implementing account-wide MS rate scheduling.
Combine this narrow patch with that reviewed runtime for a single rollout.
This patch alone does not fix every MS429 or retrospectively resume held events.
Do not reset/replay deal139048 events or seed a pair. After rollout inspect
native order/pair results of ordinary approved processing, with no silent
overwrite of existing customer cards. Live acceptance remains pending.
