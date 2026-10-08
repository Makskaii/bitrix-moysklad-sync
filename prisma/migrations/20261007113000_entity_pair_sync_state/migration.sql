CREATE TABLE "EntityPairSyncState" (
    "pairId" TEXT NOT NULL,
    "settingsVersion" INTEGER NOT NULL,
    "bitrix24Values" JSONB NOT NULL,
    "moyskladValues" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityPairSyncState_pkey" PRIMARY KEY ("pairId")
);

ALTER TABLE "EntityPairSyncState"
ADD CONSTRAINT "EntityPairSyncState_pairId_fkey"
FOREIGN KEY ("pairId") REFERENCES "EntityPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;
