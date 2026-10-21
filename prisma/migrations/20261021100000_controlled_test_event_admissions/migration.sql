CREATE TABLE "ControlledTestSourceBinding" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "bitrix24NativeId" TEXT,
  "moyskladNativeId" TEXT,
  "bitrix24PortalOrigin" TEXT,
  "bitrix24UserId" TEXT,
  "moyskladAccountId" TEXT,
  "sourceName" TEXT NOT NULL,
  "sourceCreatedAt" TIMESTAMP(3) NOT NULL,
  "createReservedByEventId" TEXT,
  CONSTRAINT "ControlledTestSourceBinding_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ControlledTestSourceBinding" (
  "id", "runId", "entity", "bitrix24NativeId", "moyskladNativeId",
  "bitrix24PortalOrigin", "bitrix24UserId", "moyskladAccountId", "sourceName", "sourceCreatedAt"
)
SELECT md5("runId" || chr(31) || "entity" || chr(31) || coalesce("bitrix24NativeId", '') || chr(31) || coalesce("moyskladNativeId", '')),
  "runId", "entity", "bitrix24NativeId", "moyskladNativeId",
  "bitrix24PortalOrigin", "bitrix24UserId", "moyskladAccountId", "sourceName", "sourceCreatedAt"
FROM (
  SELECT DISTINCT ON ("runId", "entity",
    CASE WHEN "sourceSystem" = 'BITRIX24' THEN "sourceNativeId" ELSE "targetNativeId" END,
    CASE WHEN "sourceSystem" = 'MOYSKLAD' THEN "sourceNativeId" ELSE "targetNativeId" END)
    "runId", "entity",
    CASE WHEN "sourceSystem" = 'BITRIX24' THEN "sourceNativeId" ELSE "targetNativeId" END AS "bitrix24NativeId",
    CASE WHEN "sourceSystem" = 'MOYSKLAD' THEN "sourceNativeId" ELSE "targetNativeId" END AS "moyskladNativeId",
    "bitrix24PortalOrigin", "bitrix24UserId", "moyskladAccountId", "sourceName", "sourceCreatedAt"
  FROM "ControlledTestAdmission"
  ORDER BY "runId", "entity",
    CASE WHEN "sourceSystem" = 'BITRIX24' THEN "sourceNativeId" ELSE "targetNativeId" END,
    CASE WHEN "sourceSystem" = 'MOYSKLAD' THEN "sourceNativeId" ELSE "targetNativeId" END,
    "admittedAt", "eventId"
) AS existing_bindings;

CREATE UNIQUE INDEX "ctl_test_source_binding_b24_uq"
  ON "ControlledTestSourceBinding"("runId", "entity", "bitrix24NativeId") WHERE "bitrix24NativeId" IS NOT NULL;
CREATE UNIQUE INDEX "ctl_test_source_binding_ms_uq"
  ON "ControlledTestSourceBinding"("runId", "entity", "moyskladNativeId") WHERE "moyskladNativeId" IS NOT NULL;

ALTER TABLE "ControlledTestAdmission" ADD COLUMN "bindingId" TEXT;
UPDATE "ControlledTestAdmission" AS admission
SET "bindingId" = md5(admission."runId" || chr(31) || admission."entity" || chr(31) ||
  coalesce(CASE WHEN admission."sourceSystem" = 'BITRIX24' THEN admission."sourceNativeId" ELSE admission."targetNativeId" END, '') || chr(31) ||
  coalesce(CASE WHEN admission."sourceSystem" = 'MOYSKLAD' THEN admission."sourceNativeId" ELSE admission."targetNativeId" END, ''));
ALTER TABLE "ControlledTestAdmission" ALTER COLUMN "bindingId" SET NOT NULL;

ALTER TABLE "ControlledTestAdmission"
  ADD CONSTRAINT "ControlledTestAdmission_binding_fkey"
  FOREIGN KEY ("bindingId") REFERENCES "ControlledTestSourceBinding"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "ctl_test_admission_source_uq";
DROP INDEX "ctl_test_admission_target_uq";
CREATE INDEX "ctl_test_admission_source_idx"
  ON "ControlledTestAdmission"("runId", "entity", "sourceSystem", "sourceNativeId");
