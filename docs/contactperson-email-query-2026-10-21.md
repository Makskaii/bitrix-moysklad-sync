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
