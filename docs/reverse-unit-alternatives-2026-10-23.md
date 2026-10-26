# Explicit reverse-only unit alternatives

User confirmed on 23 October: retain the canonical MS unit for Bitrix-to-MS exchange; accept the second MS «шт.» card as the same Bitrix measure only in MS-to-Bitrix exchange.

`references.units[].reverseMoyskladIds` is an optional list of additional native MS UOM UUIDs. `moyskladId` remains the sole canonical forward destination. No name-based matching or automatic equivalence is introduced. All canonical and additional UUIDs must be globally exclusive across measures, valid UUIDs and present in the live catalog on settings save. An alternative requires a canonical configured unit. The settings UI exposes an explicit multiple selection.

Reverse order creation, addressed row addition, catalog product creation and product-card synchronization recognize these IDs. Forward document/product mappings are not replaced. Older immutable settings versions remain unchanged; saving a new mapping alone does not replay historical events or repair PARTIAL operations.

Production diagnosis: 12 PARTIAL orders each had one UNIT_UNMAPPED row. Three addressed native product reads used UOM `402a6315-fe55-11e4-90a2-8ecb002f8f70` (шт., no native code); existing configured canonical UOM is `19f1edc0-fc42-4001-94cb-c9ec9c62ec10` (шт, code796), Bitrix measure9/code796. Equivalence is explicitly user-approved, not inferred from a missing code.

Post-implementation checks: unit/product-card17, full reverse-create real PostgreSQL15, public HTTP field-settings real PostgreSQL24: 56 passed, no skips. Fresh own local DB `root23_reverse_unit_test` on127.0.0.1:58345, schemas `issue54_reverse_test` and `issue10_test`, 51 migrations. API/test compilation and web build passed. Provider endpoints in tests are synthetic; no production business writes.

Status: local implementation only. Production deployment/settings save and addressed PARTIAL-row recovery remain separate pending steps. No existing event reset, replay, pair seeding or repeated document CREATE was performed.
