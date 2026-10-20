ALTER TABLE "DealOrderCreateOperation"
ADD COLUMN "leaseToken" TEXT,
ADD COLUMN "leaseUntil" TIMESTAMP(3);
