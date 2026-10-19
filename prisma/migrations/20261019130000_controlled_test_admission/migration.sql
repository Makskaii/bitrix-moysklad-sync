CREATE TABLE "ControlledTestAdmission" (
  "eventId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "sourceSystem" TEXT NOT NULL,
  "sourceNativeId" TEXT NOT NULL,
  "targetSystem" TEXT NOT NULL,
  "targetNativeId" TEXT,
  "sourceName" TEXT NOT NULL,
  "sourceCreatedAt" TIMESTAMP(3) NOT NULL,
  "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ControlledTestAdmission_pkey" PRIMARY KEY ("eventId"),
  CONSTRAINT "ControlledTestAdmission_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "InboundEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ctl_test_admission_source_uq"
  ON "ControlledTestAdmission"("runId", "entity", "sourceSystem", "sourceNativeId");
CREATE UNIQUE INDEX "ctl_test_admission_target_uq"
  ON "ControlledTestAdmission"("runId", "entity", "targetSystem", "targetNativeId");
