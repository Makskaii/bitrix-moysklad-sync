CREATE TABLE "DependencyCreateOperation" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "bitrix24Id" TEXT NOT NULL,
    "targetEntityType" TEXT NOT NULL,
    "syncId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "moyskladId" TEXT,
    "attemptedAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastErrorCategory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DependencyCreateOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DependencyCreateOperation_entityType_bitrix24Id_key"
    ON "DependencyCreateOperation"("entityType", "bitrix24Id");

CREATE UNIQUE INDEX "DependencyCreateOperation_syncId_key"
    ON "DependencyCreateOperation"("syncId");

CREATE INDEX "DependencyCreateOperation_status_updatedAt_idx"
    ON "DependencyCreateOperation"("status", "updatedAt");
