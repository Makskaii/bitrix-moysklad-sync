CREATE TABLE "DealOrderCreateOperation" (
    "bitrix24DealId" TEXT NOT NULL,
    "syncId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "settingsVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "moyskladOrderId" TEXT,
    "lastErrorCategory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealOrderCreateOperation_pkey" PRIMARY KEY ("bitrix24DealId")
);

CREATE UNIQUE INDEX "DealOrderCreateOperation_syncId_key" ON "DealOrderCreateOperation"("syncId");
CREATE INDEX "DealOrderCreateOperation_status_updatedAt_idx" ON "DealOrderCreateOperation"("status", "updatedAt");
