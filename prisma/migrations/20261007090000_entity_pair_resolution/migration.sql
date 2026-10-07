CREATE TABLE "EntityPair" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "bitrix24Id" TEXT NOT NULL,
    "moyskladId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EntityPair_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EntityPair_entityType_check" CHECK ("entityType" IN ('CONTACT', 'COMPANY', 'DEAL', 'PRODUCT'))
);

CREATE INDEX "EntityPair_entityType_active_createdAt_idx" ON "EntityPair"("entityType", "active", "createdAt");
CREATE INDEX "EntityPair_entityType_bitrix24Id_active_idx" ON "EntityPair"("entityType", "bitrix24Id", "active");
CREATE INDEX "EntityPair_entityType_moyskladId_active_idx" ON "EntityPair"("entityType", "moyskladId", "active");
CREATE UNIQUE INDEX "EntityPair_one_active_bitrix24_pair" ON "EntityPair"("entityType", "bitrix24Id") WHERE "active";
CREATE UNIQUE INDEX "EntityPair_one_active_moysklad_pair" ON "EntityPair"("entityType", "moyskladId") WHERE "active";

CREATE TABLE "PairReviewCase" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceEntityId" TEXT NOT NULL,
    "eventId" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "PairReviewCase_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PairReviewCase_entityType_check" CHECK ("entityType" IN ('CONTACT', 'COMPANY', 'DEAL', 'PRODUCT')),
    CONSTRAINT "PairReviewCase_sourceSystem_check" CHECK ("sourceSystem" IN ('BITRIX24', 'MOYSKLAD'))
);

CREATE INDEX "PairReviewCase_status_openedAt_idx" ON "PairReviewCase"("status", "openedAt");
CREATE INDEX "PairReviewCase_source_lookup_idx" ON "PairReviewCase"("entityType", "sourceSystem", "sourceEntityId", "status");
CREATE UNIQUE INDEX "PairReviewCase_one_open_per_source" ON "PairReviewCase"("entityType", "sourceSystem", "sourceEntityId") WHERE "status" = 'OPEN';
