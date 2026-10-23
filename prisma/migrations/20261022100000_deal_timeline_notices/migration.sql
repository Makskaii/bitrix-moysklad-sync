CREATE TABLE "DealTimelineNotice" (
  "id" TEXT NOT NULL,
  "dedupKey" TEXT NOT NULL,
  "bitrix24DealId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "reason" TEXT,
  "moyskladOrderId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "retryAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "commentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DealTimelineNotice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DealTimelineNotice_dedupKey_key" ON "DealTimelineNotice"("dedupKey");
CREATE INDEX "DealTimelineNotice_status_retryAfter_idx" ON "DealTimelineNotice"("status", "retryAfter");
