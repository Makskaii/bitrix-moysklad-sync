ALTER TABLE "DealOrderCreateOperation"
ADD COLUMN "skippedRows" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "DealOrderReverseCreateOperation"
ADD COLUMN "skippedRows" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "DealOrderReversePositionOperation"
ADD COLUMN "skipReason" TEXT;
