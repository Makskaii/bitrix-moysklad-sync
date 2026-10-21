CREATE TABLE "DealOrderPositionAddOperation" (
    "id" TEXT NOT NULL,
    "pairId" TEXT NOT NULL,
    "bitrix24ProductRowId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptedAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "moyskladPositionId" TEXT,
    "lastErrorCategory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DealOrderPositionAddOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DealOrderPositionAddOperation_pairId_bitrix24ProductRowId_key"
ON "DealOrderPositionAddOperation"("pairId", "bitrix24ProductRowId");

CREATE INDEX "DealOrderPositionAddOperation_status_updatedAt_idx"
ON "DealOrderPositionAddOperation"("status", "updatedAt");

ALTER TABLE "DealOrderPositionAddOperation"
ADD CONSTRAINT "DealOrderPositionAddOperation_pairId_fkey"
FOREIGN KEY ("pairId") REFERENCES "EntityPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;
