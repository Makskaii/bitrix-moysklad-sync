ALTER TABLE "ManualReviewCase"
  ADD COLUMN "entityLabel" TEXT,
  ADD COLUMN "fieldTitle" TEXT,
  ADD COLUMN "previousValue" JSONB,
  ADD COLUMN "proposedValue" JSONB;

CREATE TABLE "AdminAuditEntry" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "reason" TEXT,
  "before" JSONB,
  "after" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAuditEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminAuditEntry_occurredAt_idx" ON "AdminAuditEntry"("occurredAt");
CREATE INDEX "AdminAuditEntry_actorId_occurredAt_idx" ON "AdminAuditEntry"("actorId", "occurredAt");
CREATE INDEX "AdminAuditEntry_targetType_targetId_occurredAt_idx" ON "AdminAuditEntry"("targetType", "targetId", "occurredAt");
