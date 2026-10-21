# Product identity from deal rows

User-approved scope: resolve an existing product when its Bitrix deal row is processed. No historical catalog scan, partner-card mutation, or manual database pairing.

## Identity contract

- In this portal/catalog14, `property108` (Товары UUID) contains the native MoySklad product `id` as a plain UUID. It is NOT Bitrix `xmlId` (Внешний код).
- Read-only verification on21Oct: five sampled existing Bitrix products expose a plain UUID in `property108`; the first catalog page has50 XML_ID values in a different format. Exact Bitrix product48978→MS `product.id` equality, correct MS account, nonarchived status and available UOM were verified without printing marker values or changing cards.
- Saved active PRODUCT pairs and explicit duplicate aliases retain precedence, including after later name/price/property changes. Inactive/tombstoned/conflicting pairs are not reactivated or reassigned.
- For an unpaired document product, read the exact Bitrix card, verify catalog/type/ID, validate the single plain UUID, and GET only that exact MS product. Reject missing, malformed, absent, archived or wrong-resource targets. Do not fall back to name, price or XML_ID when identity fails.
- Save the ID pair under the existing pair advisory lock and durable global ON barrier, rechecking both endpoints and deal direction. Concurrent identical attempts converge to one pair; another card occupying the UUID is a conflict, not an automatic alias.
- Provider reads remain single bounded requests; no provider writes are performed by identity resolution. Existing row UOM/value checks still apply after identity resolution.

## Invocation and limits

The path is called during initial deal/order preparation and existing-order position reconciliation/bootstrap. This is backend processing of the row selected through «Подбор товаров», not a new hook inside that third-party picker UI. No general ON, new callback subscription or primary migration is introduced.

New MS→B24 catalog creation still owns its separate technical recovery `xmlId = MOYSKLAD_PRODUCT_<uuid>`. This change does not claim that creation automatically populates `property108`; that is separate from binding existing cards.

## Verification after implementation (not TDD)

Own local PostgreSQL DB `sync_issue79_root_product_identity_20261021_test`,50 migrations, no external provider writes:

- identity/collision/invalid-target/OFF checks:4/4;
- existing create PG:3/3;
- existing position PG:12/12;
- existing reverse-create PG:9/9;
- preparer/position unit checks:11/11;
- API build and test TypeScript compilation:PASS.

Total39 checks passed. Existing unit fixture was expanded to return actual active/lifecycle fields requested by the identity resolver; assertions were not weakened. No live deal/order acceptance or deployment is implied.
