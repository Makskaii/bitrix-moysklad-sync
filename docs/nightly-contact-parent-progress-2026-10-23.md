# Nightly contact-parent progress under temporary provider failure

Natural production attempts59/60 stopped while reading contactpersons without an HTTP status; attempt61 stopped on confirmed MS HTTP503. The contactperson feed accumulated changes across all parents and accepted none until every parent succeeded. A transient later-parent failure therefore reread all earlier parents on each natural retry.

The feed now validates all pages of one parent, durably accepts that parent's changed contact events through the ordinary immutable-settings pipeline, renews its lease, and only then records that parent as completed in a process-local set scoped by job key plus exact from/through timestamps. Failed reads or failed durable acceptance never mark a parent complete. Each retry still queries the current active parent set, so newly added parents are not lost through an index shift. Failed/remaining parents are not silently skipped.

This is not a durable scan cursor: after a process restart parents are reread, and persistent accepted-event delivery keys prevent duplicate acceptance. A new job/window uses a fresh set. No migration, mode-gate change, HTTP retry storm, skipped-provider-success claim, cursor reset, replay or manual nightly trigger is introduced. Existing missing-parent confirmation and strict pagination checks remain.

Postchecks: nightly/service/acceptance/recheck selected36 passed; API/test compilation passed. Broader run including sync-mode49 had48PASS and the previously recorded legacy mock failure (`database.$transaction is not a function`) in the unchanged mode test. No new runtime conclusion was inferred from that fixture failure. Live all-seven-segment completion remains unconfirmed.
