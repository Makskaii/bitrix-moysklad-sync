ALTER TABLE "SyncSetting"
  ADD COLUMN "modeHistoryTrackedFrom" TIMESTAMP(3),
  ADD COLUMN "nightlyActiveSegments" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "nightlySegmentIndex" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nightlyCoverage" JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE "SyncModeTransition" (
  "id" TEXT NOT NULL,
  "fromMode" TEXT NOT NULL,
  "toMode" TEXT NOT NULL,
  "transitionedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SyncModeTransition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SyncModeTransition_transitionedAt_idx"
  ON "SyncModeTransition"("transitionedAt");

-- Existing transition history is incomplete. Anchor known coverage at this
-- migration boundary using the persisted mode, and disclose any older window
-- prefix as unknown instead of treating it as active.
UPDATE "SyncSetting" SET "modeHistoryTrackedFrom" = CURRENT_TIMESTAMP;
INSERT INTO "SyncModeTransition" ("id", "fromMode", "toMode", "transitionedAt")
SELECT 'mode-history-start-' || md5("id"), 'unknown', "serviceMode", CURRENT_TIMESTAMP
FROM "SyncSetting";
