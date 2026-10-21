ALTER TABLE "DealOrderCreateOperation"
ADD COLUMN "confirmedCustomerPairIds" JSONB NOT NULL DEFAULT '[]'::jsonb;
