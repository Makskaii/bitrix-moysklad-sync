CREATE TABLE "SyncDirectionSetting" (
    "id" TEXT NOT NULL,
    "entityKey" TEXT NOT NULL,
    "bitrix24ToMoysklad" BOOLEAN NOT NULL DEFAULT true,
    "moyskladToBitrix24" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncDirectionSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SyncDirectionSetting_entityKey_key" ON "SyncDirectionSetting"("entityKey");
