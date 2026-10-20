CREATE TABLE "EntityPairSettingsRevision" (
    "id" TEXT NOT NULL,
    "pairId" TEXT NOT NULL,
    "fromSettingsVersion" INTEGER,
    "toSettingsVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARED',
    "semanticFingerprint" TEXT NOT NULL,
    "previousBaseline" JSONB NOT NULL,
    "currentBaseline" JSONB,
    "errorCategory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EntityPairSettingsRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EntityPairSettingsRevision_pairId_toSettingsVersion_key"
    ON "EntityPairSettingsRevision"("pairId", "toSettingsVersion");
CREATE INDEX "EntityPairSettingsRevision_status_updatedAt_idx"
    ON "EntityPairSettingsRevision"("status", "updatedAt");
ALTER TABLE "EntityPairSettingsRevision"
    ADD CONSTRAINT "EntityPairSettingsRevision_pairId_fkey"
    FOREIGN KEY ("pairId") REFERENCES "EntityPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;
