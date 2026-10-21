# Nested contactperson email lookup

Read-only live A/B on the same owned synthetic parent and email:

- `filter=email=...`: HTTP 412, MySklad code 1034.
- `search=...`: HTTP 200, complete empty result.

The linked-contact lookup now sends parent-scoped `search`, then independently
requires the exact normalized email and excludes archived records. A substring
search hit alone never forms a pair. Standalone counterparties keep their
supported email filter and individual-only constraint. Incomplete pages and
multiple exact email matches still stop; existing inactive links stay occupied.

The same endpoint's documented single-object CREATE returns a one-element array:
https://github.com/moysklad/api-remap-1.2-doc/blob/master/md/dictionaries/_counterparty.md#создать-контактное-лицо

Only nested contactperson CREATE accepts that strict single UUID acknowledgement.
Empty/multiple/malformed/error arrays and counterparty-array responses reject.
No broad response-shape relaxation or matching fallback was added.

Postchecks exercise the actual HTTP gateway, resolver, exact parent/email scope,
ambiguity/incomplete-page rejection and native CREATE acknowledgement contract.
The earlier held contact 227106 is not reset/replayed. Fresh live acceptance must
use a new owned synthetic contact and verify native child ID, parent, email and
repeat update without duplicate creation.

The fresh live contact 227114 created one nested native contact, but its configured
email was absent: the UI stores entity `contacts`, while runtime selected only
legacy `contacts-companies`. Both supported labels now resolve to CONTACT in
field selection, transformations, CREATE fields, document dependencies and
settings-revision projections. They never match COMPANY. Saving conflicting
writes across the two aliases is rejected. Persisted configuration is not rewritten.

## Live verification — 21 October, 18:42 Moscow time

Actual primary `ae67e377091a784da2a4894f14f551f3a96c1182`, configv4, modeON.
Existing owned contact227114 received a normal source email update, genuine
eventSUCCEEDED2; native MS readback matched the SAME contactperson
`63a3f849-cd64-11f1-0a80-17730087f34d`, owned parent and exact new email.

Fresh owned contact227116 created exactly one nested native contactperson
`e6ea64e2-cd65-11f1-0a80-1b480087b4f2`. Genuine ADD completedUNCHANGED1 with
active pair; independent native GET verified name, email, account, parent and
one exact email match. No target was manually created or pair seeded.
Earlier held227106 remains untouched. Final alias/config/revision publicPG8/8
and gateway14/14 passed after implementation; API build/test compilation passed.
