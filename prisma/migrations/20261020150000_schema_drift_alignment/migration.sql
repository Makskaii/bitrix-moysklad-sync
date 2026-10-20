ALTER TABLE "HistoricalDealOrderMatchingRun"
  ALTER COLUMN "phase" SET DEFAULT 'KEYS';

ALTER TABLE "ClientInventoryJob"
  ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "InboundEntityLock"
  ALTER COLUMN "updatedAt" DROP DEFAULT;
