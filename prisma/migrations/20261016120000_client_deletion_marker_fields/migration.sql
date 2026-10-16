ALTER TABLE "SyncSetting"
  ADD COLUMN "clientDeletionMarkerFields" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "EntityPair"
  ADD COLUMN "deletionMarkerAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deletionMarkerRetryAfter" TIMESTAMP(3);
