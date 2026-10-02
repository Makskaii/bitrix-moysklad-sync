ALTER TABLE "InboundEvent"
ADD COLUMN "externalEntityType" TEXT;

UPDATE "InboundEvent" AS event
SET "externalEntityType" = lower(COALESCE(
    (
        SELECT item #>> '{meta,type}'
        FROM jsonb_array_elements(event."payload"->'events') AS items(item)
        WHERE jsonb_typeof(item) = 'object'
        LIMIT 1
    ),
    substring((
        SELECT item #>> '{meta,href}'
        FROM jsonb_array_elements(event."payload"->'events') AS items(item)
        WHERE jsonb_typeof(item) = 'object'
        LIMIT 1
    ) FROM '/entity/([^/]+)/[^/]+/?$')
))
WHERE event."source" = 'MOYSKLAD'
  AND event."eventType" = 'UPDATE'
  AND event."externalEntityType" IS NULL
  AND jsonb_typeof(event."payload"->'events') = 'array';
