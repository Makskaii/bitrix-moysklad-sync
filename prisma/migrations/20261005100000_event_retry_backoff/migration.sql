ALTER TABLE "InboundEvent"
ADD COLUMN "retryAfter" TIMESTAMP(3);

CREATE INDEX "InboundEvent_status_retryAfter_idx"
ON "InboundEvent"("status", "retryAfter");

ALTER TABLE "SyncSetting"
ADD COLUMN "resumeRetryAfter" TIMESTAMP(3),
ADD COLUMN "resumeAttempts" INTEGER NOT NULL DEFAULT 0;
