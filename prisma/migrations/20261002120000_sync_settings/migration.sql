CREATE TABLE "SyncSetting" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "serviceMode" TEXT NOT NULL DEFAULT 'off',
    "offSince" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncSetting_pkey" PRIMARY KEY ("id")
);
