DROP INDEX "EntityPair_one_active_bitrix24_pair";
CREATE UNIQUE INDEX "EntityPair_one_active_bitrix24_non_contact"
  ON "EntityPair"("entityType", "bitrix24Id")
  WHERE "active" AND "entityType" <> 'CONTACT';
CREATE UNIQUE INDEX "EntityPair_one_active_bitrix24_contact_parent"
  ON "EntityPair"("entityType", "bitrix24Id", COALESCE("moyskladParentId", ''))
  WHERE "active" AND "entityType" = 'CONTACT';

CREATE TABLE "ClientDependencyRetry" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "sourceSystem" TEXT NOT NULL,
  "sourceEntityId" TEXT NOT NULL,
  "companySourceId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reason" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "retryAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClientDependencyRetry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClientDependencyRetry_eventId_sourceSystem_sourceEntityId_companySourceId_key"
  ON "ClientDependencyRetry"("eventId", "sourceSystem", "sourceEntityId", "companySourceId");
CREATE INDEX "ClientDependencyRetry_status_retryAfter_idx"
  ON "ClientDependencyRetry"("status", "retryAfter");
