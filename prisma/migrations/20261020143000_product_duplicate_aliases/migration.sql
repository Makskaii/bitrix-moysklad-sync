CREATE TABLE "ProductDuplicateAlias" (
    "id" TEXT NOT NULL,
    "duplicateBitrix24Id" TEXT NOT NULL,
    "canonicalBitrix24Id" TEXT NOT NULL,
    "canonicalMoyskladId" TEXT NOT NULL,
    "canonicalPairId" TEXT NOT NULL,
    "moyskladType" TEXT NOT NULL DEFAULT 'product',
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductDuplicateAlias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductDuplicateAlias_duplicateBitrix24Id_key"
    ON "ProductDuplicateAlias"("duplicateBitrix24Id");
CREATE INDEX "ProductDuplicateAlias_canonicalPairId_createdAt_idx"
    ON "ProductDuplicateAlias"("canonicalPairId", "createdAt");
CREATE INDEX "ProductDuplicateAlias_canonicalBitrix24Id_idx"
    ON "ProductDuplicateAlias"("canonicalBitrix24Id");
CREATE INDEX "ProductDuplicateAlias_canonicalMoyskladId_idx"
    ON "ProductDuplicateAlias"("canonicalMoyskladId");
ALTER TABLE "ProductDuplicateAlias"
    ADD CONSTRAINT "ProductDuplicateAlias_canonicalPairId_fkey"
    FOREIGN KEY ("canonicalPairId") REFERENCES "EntityPair"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
