ALTER TABLE "HistoricalInventoryJob"
ADD COLUMN "inventoryRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "HistoricalDealOrderMatchingRun" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "phase" TEXT NOT NULL DEFAULT 'BITRIX24',
    "bitrixCursor" TEXT,
    "moyskladCursor" TEXT,
    "bitrixProcessed" INTEGER NOT NULL DEFAULT 0,
    "moyskladProcessed" INTEGER NOT NULL DEFAULT 0,
    "bitrixTotal" INTEGER NOT NULL,
    "moyskladTotal" INTEGER NOT NULL,
    "inventoryCheckpointAt" TIMESTAMP(3) NOT NULL,
    "inventoryRevision" INTEGER NOT NULL,
    "bitrixInventoryMaxUpdate" TIMESTAMP(3),
    "moyskladInventoryMaxUpdate" TIMESTAMP(3),
    "inventoryFingerprint" TEXT NOT NULL,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "applyStatus" TEXT NOT NULL DEFAULT 'not_started',
    "applyCursor" TEXT,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "applyError" TEXT,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HistoricalDealOrderMatchingRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HistoricalDealOrderMatchingRun_status_createdAt_idx"
ON "HistoricalDealOrderMatchingRun"("status", "createdAt");
CREATE INDEX "HistoricalDealOrderMatchingRun_leaseUntil_idx"
ON "HistoricalDealOrderMatchingRun"("leaseUntil");

CREATE TABLE "HistoricalDealOrderDuplicateKey" (
    "runId" TEXT NOT NULL,
    "keyValue" TEXT NOT NULL,
    "recordCount" INTEGER NOT NULL,
    CONSTRAINT "HistoricalDealOrderDuplicateKey_pkey" PRIMARY KEY ("runId", "keyValue"),
    CONSTRAINT "HistoricalDealOrderDuplicateKey_runId_fkey" FOREIGN KEY ("runId") REFERENCES "HistoricalDealOrderMatchingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "HistoricalDealOrderMatchResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceEntityId" TEXT NOT NULL,
    "linkedEntityId" TEXT,
    "category" TEXT NOT NULL,
    "keyValue" TEXT,
    "sourceLabel" TEXT,
    "linkedLabel" TEXT,
    "keyFieldCode" TEXT NOT NULL,
    "keyFieldTitle" TEXT,
    "applyStatus" TEXT NOT NULL DEFAULT 'not_applicable',
    "pairId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HistoricalDealOrderMatchResult_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HistoricalDealOrderMatchResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "HistoricalDealOrderMatchingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HistoricalDealOrderMatchResult_sourceSystem_check" CHECK ("sourceSystem" IN ('BITRIX24', 'MOYSKLAD'))
);

CREATE UNIQUE INDEX "HistoricalDealOrderMatchResult_runId_sourceSystem_sourceEntityId_key"
ON "HistoricalDealOrderMatchResult"("runId", "sourceSystem", "sourceEntityId");
CREATE INDEX "HistoricalDealOrderMatchResult_runId_category_id_idx"
ON "HistoricalDealOrderMatchResult"("runId", "category", "id");
CREATE INDEX "HistoricalDealOrderMatchResult_runId_linkedEntityId_idx"
ON "HistoricalDealOrderMatchResult"("runId", "linkedEntityId");
