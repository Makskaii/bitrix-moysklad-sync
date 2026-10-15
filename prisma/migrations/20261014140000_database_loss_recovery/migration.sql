CREATE TABLE "DatabaseRecoveryState" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "status" TEXT NOT NULL DEFAULT 'RECOVERY_REQUIRED',
    "previousLaunchBoundary" TIMESTAMP(3),
    "pairsRestored" BOOLEAN NOT NULL DEFAULT false,
    "lostEventsAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgement" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DatabaseRecoveryState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DatabaseRecoveryAudit" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "oldBoundaryAt" TIMESTAMP(3),
    "boundaryAt" TIMESTAMP(3) NOT NULL,
    "pairsRestored" BOOLEAN NOT NULL,
    "lostEventsAcknowledged" BOOLEAN NOT NULL,
    "acknowledgement" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveryStateId" TEXT NOT NULL,
    CONSTRAINT "DatabaseRecoveryAudit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DatabaseRecoveryAudit_recoveryStateId_fkey" FOREIGN KEY ("recoveryStateId") REFERENCES "DatabaseRecoveryState"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "DatabaseRecoveryAudit_occurredAt_idx" ON "DatabaseRecoveryAudit"("occurredAt");

CREATE FUNCTION reject_database_recovery_audit_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Database recovery audit entries are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DatabaseRecoveryAudit_immutable"
BEFORE UPDATE OR DELETE ON "DatabaseRecoveryAudit"
FOR EACH ROW EXECUTE FUNCTION reject_database_recovery_audit_mutation();
