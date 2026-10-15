CREATE TABLE "DryRunWriteProposal" (
  "id" TEXT NOT NULL,
  "eventId" TEXT,
  "provider" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "fields" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DryRunWriteProposal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DryRunWriteProposal_eventId_createdAt_idx" ON "DryRunWriteProposal"("eventId", "createdAt");
CREATE INDEX "DryRunWriteProposal_provider_entityType_entityId_createdAt_idx" ON "DryRunWriteProposal"("provider", "entityType", "entityId", "createdAt");
