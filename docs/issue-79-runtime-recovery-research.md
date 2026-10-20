# Issue #79 runtime/recovery evidence

Research snapshot: 2026-10-20. This note separates verified behavior and source capabilities from implementation/production acceptance.

## Accepted runtime semantics

- Email is a runtime candidate key only after a native persisted pair lookup. Normalize Unicode NFKC and case-fold, validate a single address, search in the target's native resource scope, and accept only one unoccupied eligible result. Contact search remains within the resolved parent company or standalone scope. Multiple candidates, an occupied endpoint, duplicate/tombstone state, or conflict with a filled INN require manual review. The initial UUID inventory map remains unchanged and no historical bulk email pairing is performed.
- Settings revisions are not label changes. Existing semantic projections keep their comparison state. A changed/new enabled mapping requires both current reads, an MS-authoritative initial reconciliation, external write/readback verification, then durable state/revision. Removed mappings stop participating without clearing fields. Old queued events retain their originally accepted configuration version.
- Recovery covers supported update feeds in a rolling 24-hour window. It does not scan old archives, catch up OFF time, or claim to detect deletions omitted by a provider's update feed. Cursor advancement follows durable intake; incomplete pages are retryable and idempotent. PAUSE prevents writes without discarding already accepted events.
- The scheduler persists service-mode transitions and splits the rolling 24-hour window into On segments. OFF and PAUSE intervals are reported as skipped; pre-ledger time is labeled unknown and excluded. Each On segment has a durable provider cursor, so restart and PAUSE resume continue safely; OFF changes are never searched later. Admin recovery status exposes scheduled coverage and a read-only current-window preview. The fake-provider window test covers active records before, inside, and after multiple OFF intervals and verifies that only active slices are queried and queued.
- Live stage configuration observed read-only on 2026-10-20 contains `PREPARATION` only. The historical `UC_DZSNZ0` assembly stage is not configured and must not be treated as enabled. Service mode was OFF during that observation.

## Provider evidence

- Bitrix24's official [`crm.contact.list`](https://apidocs.bitrix24.com/api-reference/crm/contacts/crm-contact-list.html) supports filtering by email. Matching still must validate exact normalized values and preserve company/standalone scope locally.
- Bitrix24's official [catalog product list](https://apidocs.bitrix24.com/api-reference/catalog/product/catalog-product-list.html) documents bounded list pagination; the official [catalog product events overview](https://apidocs.bitrix24.com/api-reference/catalog/product/index.html) describes catalog events. Entity-specific `updatedTime` filtering for deals, smart invoices, and products must be verified before enabling those feeds.
- The official MoySklad [JSON API workbook collection paging](https://dev.moysklad.ru/workbook/tag_api.html) describes collection pages rather than returning an unbounded collection. Confirm current Remap API query/filter/order semantics for each document kind and validate `meta.limit`, `meta.offset`, `meta.size`, rows, and continuation metadata before advancing a cursor. Current documentation endpoint search was not sufficient to verify all entity-specific update filters; unsupported feeds must fail visibly, not silently complete.

## Imported audit context

This implementation was scoped with the local Issue 60 annotation audit at `C:\Projects\aerosystems\.worktrees\issue60-test-a8f863\research\issue60-annotations-audit-2026-10-20.md` and field metadata/type conversion audit at `C:\Projects\aerosystems\.worktrees\research-field-metadata\research\field-metadata-and-type-conversion-2026-10-20.md`. Their prior observations are not a substitute for current server configuration: the former described historical stage labels only, while current read-only server inspection confirms only PREPARATION configured. Their prior nightly notes described accepted-event rechecks; #79 expands acceptance to supported updated-record discovery for records never accepted through webhooks.

## Acceptance boundary

No live provider write, production setting change, webhook subscription update, or deployment was performed as part of this research. Use isolated PostgreSQL and fake provider APIs for local integration tests. Production remains OFF until root coordinates combined review and a dedicated manifest-based live test; do not process unrelated customer records.
