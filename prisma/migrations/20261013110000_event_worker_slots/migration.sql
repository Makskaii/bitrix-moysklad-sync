CREATE TABLE "EventWorkerLease" (
    "slot" INTEGER NOT NULL,
    "ownerToken" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EventWorkerLease_pkey" PRIMARY KEY ("slot")
);

CREATE INDEX "EventWorkerLease_leaseExpiresAt_idx" ON "EventWorkerLease"("leaseExpiresAt");
