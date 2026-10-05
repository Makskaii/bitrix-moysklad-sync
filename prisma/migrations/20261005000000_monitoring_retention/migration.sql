CREATE TABLE "ManualReviewCase" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventType" TEXT,
    "externalEntityId" TEXT,
    "externalEntityType" TEXT,
    "reason" TEXT NOT NULL,
    "diagnostic" JSONB,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "ManualReviewCase_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ManualReviewCase_eventId_key" ON "ManualReviewCase"("eventId");
CREATE INDEX "ManualReviewCase_status_openedAt_idx" ON "ManualReviewCase"("status", "openedAt");

CREATE TABLE "ApiAttempt" (
    "id" TEXT NOT NULL,
    "eventId" TEXT,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "statusCode" INTEGER,
    "succeeded" BOOLEAN NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ApiAttempt_occurredAt_idx" ON "ApiAttempt"("occurredAt");
CREATE INDEX "ApiAttempt_provider_occurredAt_idx" ON "ApiAttempt"("provider", "occurredAt");

CREATE TABLE "OperationalLog" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "referenceId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OperationalLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OperationalLog_category_occurredAt_idx" ON "OperationalLog"("category", "occurredAt");
