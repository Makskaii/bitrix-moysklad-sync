CREATE TABLE "DealOrderReverseProductOperation" (
    "moyskladProductId" TEXT NOT NULL,
    "syncId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "settingsVersion" INTEGER NOT NULL,
    "bitrix24CatalogId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "bitrix24ProductId" TEXT,
    "lastErrorCategory" TEXT,
    "attemptedAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DealOrderReverseProductOperation_pkey" PRIMARY KEY ("moyskladProductId")
);
CREATE UNIQUE INDEX "DealOrderReverseProductOperation_syncId_key" ON "DealOrderReverseProductOperation"("syncId");
CREATE INDEX "DealOrderReverseProductOperation_status_updatedAt_idx" ON "DealOrderReverseProductOperation"("status", "updatedAt");
