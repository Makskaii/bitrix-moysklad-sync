ALTER TABLE "SyncSetting"
  ADD COLUMN "nightlyBitrixEntityTypeId" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "nightlyBitrixLastId" TEXT,
  ADD COLUMN "nightlyBitrixStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "nightlyMoyskladStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "nightlyLeaseToken" TEXT,
  ADD COLUMN "nightlyLeaseExpiresAt" TIMESTAMP(3);
