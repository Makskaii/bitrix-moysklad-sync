# Reverse product UUID reuse — 22 October

## Confirmed defect

Reverse order788387e0-cd61-11f1-0a80-02e50040671b created B24product682892
from MSproductc55079c2-1afe-11e9-9109-f8fc000364c6 on21Oct15:09:58Z.
The successful create journal and active AUTO pair prove our provenance.
The picker now finds both49006 and682892 by UUID108 and correctly refuses an
arbitrary choice, but inaccurately labels the conflict XML_ID. This patch does
not edit the separate picker application or repair its existing card data.

## Change

The shared ProductCatalogCreateService (reverse order prerequisite and catalog
CREATE) checks exact UUID108 within the configured catalog/native endpoint
before ADD. One active correctly typed card is reserved in the existing durable
journal, read back again, and bound under the pair advisory lock and semantic
ON guard. Reuse makes no provider card/price writes; identity linking does not
apply initial prices/name/defaults to an existing working card.

Multiple matches, inactive identities, occupied/inactive pairs, duplicate aliases,
invalid or incomplete provider replies stop for review. No first/oldest/name or
article fallback. Saved pairs remain authoritative at normal callers; this is
not permission to switch existing pairs to a different card.

New journal JSON records the lookup version and an ADD-attempt fence BEFORE
network. A read-only failed lookup can recover after explicit data repair; an
uncertain ADD cannot adopt a different legacy card. Existing old journal
recovery markers and frozen fields/prices remain unchanged. A persisted reuse
reservation can safely resume after interruption. Adopted-card callbacks cannot
masquerade as acknowledgements of a different product ADD.

Forward document UUID linking now respects a pending reverse product reservation,
preventing the two local directions from racing to different target identities.
No schema migration is needed for these changes.

## Verification

Implementation first, then postchecks per human's no-TDD instruction. Solo root;
no agents. API build/test TypeScript compilation and diff whitespace checks pass.
Independent physical dependencies/Prisma6.19.3 in .root-merge-74e6eb9-20261022;
no shared Prisma generation. New owned local PG18 cluster127.0.0.1:58345,
root_product_identity_duplicate_20261022_test, isolated fresh schemas; existing
public catalog suite uses its explicitly allowlisted synthetic database on the
same owned cluster. No real provider writes in tests.

- Shared create/retry unit:1 PASS (product/service legacy reuse, no price/card
  overwrite, duplicate/inactive guards, lost ADD and price acknowledgements).
- New actual-PG UUID reuse suite:9 PASS (concurrency, forward reservation,
  interrupted reuse recovery, OFF, uncertain-ADD refusal, identity provenance).
- Reverse order actual-PG suite:14 PASS including full order->legacy UUID
  reuse->addressed product row, repeat, lost acknowledgements and OFF boundaries.
- Existing forward document identity actual-PG suite:4 PASS.
- Public catalog webhook/actual processor PG suite:8 PASS, natural exit57.65s.
- Final total36 PASS /0 failed /0 cancelled /0 skipped. Local PG stopped
  normally afterward; its data/evidence retained.

One scoped production read verified the actual catalog.product.list filter
{iblockId:14,property108:UUID}: exactly49006 and682892, total2, correct type/catalog.
Official method schema consulted through Bitrix24 docs connector:
https://apidocs.bitrix24.ru/api-reference/catalog/product/catalog-product-list.html

## Rollout and existing duplicate repair

LOCAL ONLY until explicit rollout. Do not deploy the whole integration HEAD:
it includes separately merged defaults/timeline changes not yet on8366 prod.
This fix itself does not require the timeline migration.

Existing682892/49006 and all other live cards, active pairs, aliases, journals,
documents and hooks were NOT changed. A separate human-assigned chat inventories
service-created duplicates and document usages. Do not delete active paired
cards before a canonical-reference/lifecycle/recovery-safe repair plan. Product
deletion callbacks must not tombstone/archive the canonical MSproduct. No manual
pair seed, queue replay/reset or destructive cleanup is part of this patch.
