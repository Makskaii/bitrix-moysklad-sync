-- Do not block webhook intake while the index is built on a live queue.
CREATE INDEX CONCURRENTLY "InboundEvent_entity_coalesce_idx"
ON "InboundEvent" ("source", "eventType", "externalEntityType", "externalEntityId", "receivedAt");
