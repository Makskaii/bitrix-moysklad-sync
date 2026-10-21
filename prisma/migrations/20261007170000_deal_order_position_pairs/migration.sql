CREATE TABLE "DealOrderPositionPair" (
    "id" TEXT NOT NULL,
    "pairId" TEXT NOT NULL,
    "bitrix24ProductRowId" TEXT NOT NULL,
    "moyskladPositionId" TEXT NOT NULL,
    "bitrix24Values" JSONB NOT NULL,
    "moyskladValues" JSONB NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DealOrderPositionPair_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DealOrderPositionPair_pairId_bitrix24ProductRowId_key"
ON "DealOrderPositionPair"("pairId", "bitrix24ProductRowId");

CREATE UNIQUE INDEX "DealOrderPositionPair_pairId_moyskladPositionId_key"
ON "DealOrderPositionPair"("pairId", "moyskladPositionId");

ALTER TABLE "DealOrderPositionPair"
ADD CONSTRAINT "DealOrderPositionPair_pairId_fkey"
FOREIGN KEY ("pairId") REFERENCES "EntityPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;
