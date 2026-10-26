# MS product CREATE: source timestamp when `created` is absent

Native MySklad product cards can omit `created`. A genuine authenticated CREATE callback can still establish a post-launch creation time from `auditContext.moment`. The processor now accepts that fallback only when the native property is absent, never when a present property is null or malformed.

The stored callback must contain exactly one matching native entity ID and CREATE action. Account, product/service kind, current card identity, exact configured entity URL, and audit URL must agree. A mixed batch is matched by ID, not array position; duplicate/conflicting entries reject the fallback. The timestamp parser handles MySklad Moscow wall time explicitly and rejects invalid calendars, offsets and future timestamps. The normal launch boundary remains mandatory. UPDATE, `updated`, receipt time and the current clock never substitute for creation evidence.

Accepted provenance is recorded without credentials or business payloads. Pair reservations, per-request durable ON gates, native readback and automatic property108 UUID population remain unchanged. Previously held events are not replayed or reset.

Post-implementation checks: public authenticated HTTP → actual processor → PostgreSQL includes product/service positives, mixed batches, absent/bad audit, foreign namespace/account, duplicate identity, invalid native creation values, pre-launch records and UPDATE rejection. Other catalog price/UOM update tests retain their document-write barrier.

Provider references: [webhook contract](https://github.com/moysklad/api-remap-1.2-doc/blob/master/md/dictionaries/_webhook.md), [product contract](https://github.com/moysklad/api-remap-1.2-doc/blob/master/md/dictionaries/_product.md). The audit moment is used only for the authenticated CREATE action, not as a general product creation date.
