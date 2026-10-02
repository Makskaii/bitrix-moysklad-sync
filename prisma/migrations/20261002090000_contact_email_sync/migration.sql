ALTER TABLE "InboundEvent"
ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "direction" TEXT,
ADD COLUMN "snapshotRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastSuccessfulAt" TIMESTAMP(3),
ADD COLUMN "lastErrorCategory" TEXT;

CREATE TABLE "ContactPair" (
    "id" TEXT NOT NULL,
    "bitrix24ContactId" TEXT NOT NULL,
    "moyskladCounterpartyId" TEXT NOT NULL,
    "moyskladType" TEXT NOT NULL DEFAULT 'COUNTERPARTY',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ContactPair_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContactSnapshot" (
    "pairId" TEXT NOT NULL,
    "bitrix24Email" TEXT NOT NULL,
    "moyskladEmail" TEXT NOT NULL,
    "bitrix24UpdatedAt" TIMESTAMP(3) NOT NULL,
    "moyskladUpdatedAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "lastSuccessfulAt" TIMESTAMP(3),

    CONSTRAINT "ContactSnapshot_pkey" PRIMARY KEY ("pairId")
);

CREATE UNIQUE INDEX "ContactPair_bitrix24ContactId_key" ON "ContactPair"("bitrix24ContactId");
CREATE UNIQUE INDEX "ContactPair_moyskladCounterpartyId_key" ON "ContactPair"("moyskladCounterpartyId");
ALTER TABLE "ContactSnapshot" ADD CONSTRAINT "ContactSnapshot_pairId_fkey"
FOREIGN KEY ("pairId") REFERENCES "ContactPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;
