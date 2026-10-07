CREATE TABLE "FieldSettingsVersion" (
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FieldSettingsVersion_pkey" PRIMARY KEY ("version")
);

CREATE TABLE "FieldSettingsState" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "version" INTEGER NOT NULL,

    CONSTRAINT "FieldSettingsState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FieldSettingsState_version_key" ON "FieldSettingsState"("version");

CREATE TABLE "InboundEventSettings" (
    "eventId" TEXT NOT NULL,
    "settingsVersion" INTEGER NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundEventSettings_pkey" PRIMARY KEY ("eventId")
);

CREATE INDEX "InboundEventSettings_settingsVersion_idx" ON "InboundEventSettings"("settingsVersion");

ALTER TABLE "FieldSettingsState"
ADD CONSTRAINT "FieldSettingsState_version_fkey"
FOREIGN KEY ("version") REFERENCES "FieldSettingsVersion"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InboundEventSettings"
ADD CONSTRAINT "InboundEventSettings_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "InboundEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InboundEventSettings"
ADD CONSTRAINT "InboundEventSettings_settingsVersion_fkey"
FOREIGN KEY ("settingsVersion") REFERENCES "FieldSettingsVersion"("version") ON DELETE RESTRICT ON UPDATE CASCADE;
