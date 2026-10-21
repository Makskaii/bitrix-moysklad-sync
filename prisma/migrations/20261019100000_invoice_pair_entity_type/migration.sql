ALTER TABLE "EntityPair"
  DROP CONSTRAINT "EntityPair_entityType_check",
  ADD CONSTRAINT "EntityPair_entityType_check"
    CHECK ("entityType" IN ('CONTACT', 'COMPANY', 'DEAL', 'PRODUCT', 'INVOICE'));

ALTER TABLE "PairReviewCase"
  DROP CONSTRAINT "PairReviewCase_entityType_check",
  ADD CONSTRAINT "PairReviewCase_entityType_check"
    CHECK ("entityType" IN ('CONTACT', 'COMPANY', 'DEAL', 'PRODUCT', 'INVOICE'));
