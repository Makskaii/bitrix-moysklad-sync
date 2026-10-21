CREATE TABLE IF NOT EXISTS "DealOrderCreateOperation" (
  "bitrix24DealId" TEXT NOT NULL,
  "syncId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "confirmedCustomerPairIds" JSONB NOT NULL DEFAULT '[]',
  "settingsVersion" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "moyskladOrderId" TEXT,
  "lastErrorCategory" TEXT,
  "attemptedAt" TIMESTAMP(3),
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DealOrderCreateOperation_pkey" PRIMARY KEY ("bitrix24DealId")
);
ALTER TABLE "DealOrderCreateOperation"
  ADD COLUMN IF NOT EXISTS "confirmedCustomerPairIds" JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS "DealOrderCreateOperation_syncId_key" ON "DealOrderCreateOperation"("syncId");
CREATE INDEX IF NOT EXISTS "DealOrderCreateOperation_status_updatedAt_idx" ON "DealOrderCreateOperation"("status", "updatedAt");

CREATE TABLE IF NOT EXISTS "DealOrderPositionPair" (
  "id" TEXT NOT NULL,
  "pairId" TEXT NOT NULL,
  "bitrix24ProductRowId" TEXT NOT NULL,
  "moyskladPositionId" TEXT NOT NULL,
  "bitrix24Values" JSONB NOT NULL,
  "moyskladValues" JSONB NOT NULL,
  "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DealOrderPositionPair_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DealOrderPositionPair_pairId_bitrix24ProductRowId_key" ON "DealOrderPositionPair"("pairId", "bitrix24ProductRowId");
CREATE UNIQUE INDEX IF NOT EXISTS "DealOrderPositionPair_pairId_moyskladPositionId_key" ON "DealOrderPositionPair"("pairId", "moyskladPositionId");
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'DealOrderPositionPair_pairId_fkey'
      AND conrelid = '"DealOrderPositionPair"'::regclass
  ) THEN
    ALTER TABLE "DealOrderPositionPair"
      ADD CONSTRAINT "DealOrderPositionPair_pairId_fkey"
      FOREIGN KEY ("pairId") REFERENCES "EntityPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS "DealOrderPositionAddOperation" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "DealOrderPositionAddOperation_pairId_bitrix24ProductRowId_key" ON "DealOrderPositionAddOperation"("pairId", "bitrix24ProductRowId");
CREATE INDEX IF NOT EXISTS "DealOrderPositionAddOperation_status_updatedAt_idx" ON "DealOrderPositionAddOperation"("status", "updatedAt");
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'DealOrderPositionAddOperation_pairId_fkey'
      AND conrelid = '"DealOrderPositionAddOperation"'::regclass
  ) THEN
    ALTER TABLE "DealOrderPositionAddOperation"
      ADD CONSTRAINT "DealOrderPositionAddOperation_pairId_fkey"
      FOREIGN KEY ("pairId") REFERENCES "EntityPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS "DealOrderReverseCreateOperation" (
  "moyskladOrderId" TEXT NOT NULL,
  "syncId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "settingsVersion" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "bitrix24DealId" TEXT,
  "lastErrorCategory" TEXT,
  "attemptedAt" TIMESTAMP(3),
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DealOrderReverseCreateOperation_pkey" PRIMARY KEY ("moyskladOrderId")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DealOrderReverseCreateOperation_syncId_key" ON "DealOrderReverseCreateOperation"("syncId");
CREATE INDEX IF NOT EXISTS "DealOrderReverseCreateOperation_status_updatedAt_idx" ON "DealOrderReverseCreateOperation"("status", "updatedAt");

CREATE TABLE IF NOT EXISTS "DealOrderReversePositionOperation" (
  "id" TEXT NOT NULL,
  "moyskladOrderId" TEXT NOT NULL,
  "moyskladPositionId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "bitrix24ProductRowId" TEXT,
  "lastErrorCategory" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DealOrderReversePositionOperation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DealOrderReversePositionOperation_moyskladOrderId_moyskladPositionId_key" ON "DealOrderReversePositionOperation"("moyskladOrderId", "moyskladPositionId");
CREATE INDEX IF NOT EXISTS "DealOrderReversePositionOperation_status_updatedAt_idx" ON "DealOrderReversePositionOperation"("status", "updatedAt");
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'DealOrderReversePositionOperation_moyskladOrderId_fkey'
      AND conrelid = '"DealOrderReversePositionOperation"'::regclass
  ) THEN
    ALTER TABLE "DealOrderReversePositionOperation"
      ADD CONSTRAINT "DealOrderReversePositionOperation_moyskladOrderId_fkey"
      FOREIGN KEY ("moyskladOrderId") REFERENCES "DealOrderReverseCreateOperation"("moyskladOrderId") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$migration$;
