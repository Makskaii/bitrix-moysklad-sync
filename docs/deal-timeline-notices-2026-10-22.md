# User-facing deal exchange notices

Scope: forward order creation success/partial result and errors surfaced by
PairFirstEventProcessor, including product UUID holds and failures for an MS
customer order with an existing active deal pair. Not a claim that every client,
product or invoice processor already publishes its own notices.

Messages are Russian, use an allow-listed explanation or safe generic fallback,
and never include raw exceptions, payloads, auth, webhook URLs or PII. A successful
creation includes the native MS order link. Product identity explanations reuse
the existing user-action policy. No automatic comments for normal stage waiting.

## Durability and safety

- Additive migration `20261022100000_deal_timeline_notices` creates only the
  DealTimelineNotice outbox. No existing events/pairs/settings are reset or
  backfilled and no historical comments are mass-posted.
- The success notice is enqueued only after durable create/pair completion.
  Error/UUID holds enqueue transactionally with their terminal/durable state.
- Deduplication is per deal/kind/reason/order: repeated callbacks and retries do
  not post the same outcome repeatedly. A different reason creates a new notice.
- Concurrent senders atomically lease one notice. Before every request, verify
  current ownership, lease time and global mode; direction rows are locked too.
- Only apply/ON with at least one deal direction enabled may send. Controlled
  diagnostic mode never runs the new background sender.
- Check the native timeline before ADD. If acknowledgement is lost, later
  readback recovers the existing exact comment instead of blindly repeating ADD.
- The full bounded page scan must complete before ADD; an incomplete scan
  postpones notification rather than risking a duplicate.
- A newer creation supersedes pending stale errors; errors arising after
  creation remain visible. Partial-row warnings are not suppressed.
- Comment failures retry only the outbox. They never replay document creation.
- Delivery currently uses one comment per outcome/reason, not a complete
  repeated-error/recovered/error-again notification state machine.

## Evidence

API build/test compilation PASS. Own PostgreSQL18/127.0.0.1:58344,
DB side22_timeline_test and separate test schemas only, 51 migrations:

- Notification delivery5 PASS: safe wording, concurrent/repeated dedup,
  lost-ack native readback, supersession vs later error, durable PAUSE.
- Actual public webhook + processor + PG13 PASS: successful CREATE enqueues
  exactly one success notification; invalid UUID atomically queues error with
  no provider CREATE; existing forward/reverse race protections still pass.
- Supporting defaults preparer15 and HTTP/PG order creation9 PASS.
- Related shared-email matching/gateway34 PASS after alignment with1dde.

All HTTP calls in local tests terminate in synthetic servers or fake transports.
No genuine production comment has been posted, and live acceptance is NOT RUN.
This requires migration/client/build and explicit coordinated deployment before
it is usable. Main's current urgent rollout must not be held up by this feature.

Handoff is explicitly ON HOLD until the user says the main coordinator has
finished. Do not message/reactivate it or autonomously deploy these changes.

## References

- Bitrix24 official `crm.timeline.comment.list` documentation:
  https://apidocs.bitrix24.ru/api-reference/crm/timeline/comments/crm-timeline-comment-list.html
- MS official counterparty field schema has no native currency field:
  https://raw.githubusercontent.com/moysklad/api-remap-1.2-doc/master/md/dictionaries/_counterparty.md

Local environment note: root node_modules is a junction. An initial generation
unexpectedly reached integration's shared generated client (additive model only);
the coordinator was immediately warned before the later user handoff hold. All
subsequent runtime tests use a physical independent client copy under
.tmp-timeline-deps/node_modules; no subsequent shared generation was performed.
