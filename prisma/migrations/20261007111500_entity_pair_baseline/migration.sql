CREATE TABLE "EntityPairBaseline" (
    "pairId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "settingsVersion" INTEGER NOT NULL,
    "bitrix24Values" JSONB NOT NULL,
    "moyskladValues" JSONB NOT NULL,
    "bitrix24UpdatedAt" TIMESTAMP(3),
    "moyskladUpdatedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityPairBaseline_pkey" PRIMARY KEY ("pairId")
);

CREATE INDEX "EntityPairBaseline_eventId_idx" ON "EntityPairBaseline"("eventId");
CREATE INDEX "EntityPairBaseline_capturedAt_idx" ON "EntityPairBaseline"("capturedAt");

ALTER TABLE "EntityPairBaseline"
ADD CONSTRAINT "EntityPairBaseline_pairId_fkey"
FOREIGN KEY ("pairId") REFERENCES "EntityPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;
