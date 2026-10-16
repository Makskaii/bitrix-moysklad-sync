ALTER TABLE "EntityPair"
  ADD COLUMN "lifecycleStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "tombstonedAt" TIMESTAMP(3),
  ADD COLUMN "tombstoneSource" TEXT,
  ADD COLUMN "tombstoneReason" TEXT,
  ADD COLUMN "deletionMarkerStatus" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  ADD COLUMN "deletionTimelineStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "deletionTimelineLeaseUntil" TIMESTAMP(3);

CREATE INDEX "EntityPair_lifecycleStatus_tombstonedAt_idx"
  ON "EntityPair"("lifecycleStatus", "tombstonedAt");
