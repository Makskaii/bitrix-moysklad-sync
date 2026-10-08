CREATE TABLE "HistoricalInventoryJob" (
    "id" TEXT NOT NULL DEFAULT 'deal-order-history',
    "status" TEXT NOT NULL DEFAULT 'idle',
    "phase" TEXT NOT NULL DEFAULT 'BITRIX24',
    "bitrixStart" INTEGER NOT NULL DEFAULT 0,
    "moyskladOffset" INTEGER NOT NULL DEFAULT 0,
    "bitrixProcessed" INTEGER NOT NULL DEFAULT 0,
    "moyskladProcessed" INTEGER NOT NULL DEFAULT 0,
    "bitrixTotal" INTEGER,
    "moyskladTotal" INTEGER,
    "moyskladPageSize" INTEGER NOT NULL DEFAULT 500,
    "requestIntervalMs" INTEGER NOT NULL DEFAULT 1000,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "retryAfter" TIMESTAMP(3),
    "pauseRequested" BOOLEAN NOT NULL DEFAULT false,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "checkpointAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalInventoryJob_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "HistoricalInventoryJob" ADD COLUMN "runId" TEXT;

CREATE TABLE "HistoricalInventoryEntry" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "label" TEXT,
    "fields" JSONB NOT NULL,
    "fieldTitles" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalInventoryEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HistoricalInventoryEntry_source_externalId_key" ON "HistoricalInventoryEntry"("source", "externalId");
