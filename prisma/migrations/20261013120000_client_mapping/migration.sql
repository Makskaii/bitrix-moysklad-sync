ALTER TABLE "EntityPair" ADD COLUMN "moyskladType" TEXT;
ALTER TABLE "EntityPair" ADD COLUMN "moyskladParentId" TEXT;

CREATE TABLE "ClientInventoryJob" (
  "id" TEXT NOT NULL DEFAULT 'client-map',
  "status" TEXT NOT NULL DEFAULT 'idle',
  "phase" TEXT NOT NULL DEFAULT 'BITRIX24_COMPANIES',
  "bitrix24CompanyStart" INTEGER NOT NULL DEFAULT 0,
  "bitrix24ContactStart" INTEGER NOT NULL DEFAULT 0,
  "moyskladCounterpartyOffset" INTEGER NOT NULL DEFAULT 0,
  "moyskladContactpersonParentOffset" INTEGER NOT NULL DEFAULT 0,
  "moyskladContactpersonOffset" INTEGER NOT NULL DEFAULT 0,
  "bitrix24CompanyProcessed" INTEGER NOT NULL DEFAULT 0,
  "bitrix24ContactProcessed" INTEGER NOT NULL DEFAULT 0,
  "moyskladCounterpartyProcessed" INTEGER NOT NULL DEFAULT 0,
  "moyskladContactpersonProcessed" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "pauseRequested" BOOLEAN NOT NULL DEFAULT false,
  "checkpointAt" TIMESTAMP(3),
  "leaseOwner" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClientInventoryJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClientInventoryJob_leaseUntil_idx" ON "ClientInventoryJob"("leaseUntil");

CREATE TABLE "ClientInventoryObject" (
  "id" TEXT NOT NULL,
  "system" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "nativeType" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "matchValue" TEXT,
  "parentId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reason" TEXT,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClientInventoryObject_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClientInventoryObject_system_check" CHECK ("system" IN ('BITRIX24', 'MOYSKLAD')),
  CONSTRAINT "ClientInventoryObject_entityType_check" CHECK ("entityType" IN ('COMPANY', 'CONTACT')),
  CONSTRAINT "ClientInventoryObject_nativeType_check" CHECK ("nativeType" IN ('company', 'contact', 'counterparty', 'contactperson'))
);
CREATE UNIQUE INDEX "ClientInventoryObject_system_entityType_externalId_key"
  ON "ClientInventoryObject"("system", "entityType", "externalId");
CREATE INDEX "ClientInventoryObject_system_entityType_matchValue_idx"
  ON "ClientInventoryObject"("system", "entityType", "matchValue");
CREATE INDEX "ClientInventoryObject_system_entityType_status_externalId_idx"
  ON "ClientInventoryObject"("system", "entityType", "status", "externalId");
