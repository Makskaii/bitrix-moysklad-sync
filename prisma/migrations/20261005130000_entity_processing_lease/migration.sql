CREATE TABLE "InboundEntityLock" (
  "entityKey" TEXT NOT NULL,
  "ownerToken" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboundEntityLock_pkey" PRIMARY KEY ("entityKey")
);

CREATE INDEX "InboundEntityLock_leaseExpiresAt_idx"
ON "InboundEntityLock"("leaseExpiresAt");
