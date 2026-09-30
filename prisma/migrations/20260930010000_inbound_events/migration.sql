CREATE TABLE "InboundEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "deliveryKey" TEXT NOT NULL,
    "eventType" TEXT,
    "externalEntityId" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InboundEvent_source_deliveryKey_key" ON "InboundEvent"("source", "deliveryKey");
CREATE INDEX "InboundEvent_status_receivedAt_idx" ON "InboundEvent"("status", "receivedAt");
