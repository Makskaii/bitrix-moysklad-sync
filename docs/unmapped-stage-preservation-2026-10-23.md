# Existing documents: preserve unmapped stages and warn

User explicitly approved: when an existing deal/order has a stage without an exact mapping, preserve both native stages, record a visible operational warning, and continue other fields/rows. Do not invent a stage or reset an assembled/shipped order to PREPARATION.

New optional `dealOrderRuntime.unmappedStagePolicy` accepts `hold` (legacy/default) or `preserve-and-warn`. It does not alter creation eligibility, creation fallback, directional mapping tables, cancellation rules or MS conflict precedence. Known mappings still synchronize normally. Unmapped native values produce `DEAL_ORDER_STAGE_PRESERVED_UNMAPPED` in OperationalLog without updating the native-stage baseline. This is a limitation explicitly reported, not successful stage synchronization. Foreign/malformed native references, duplicate directional mappings and missing conflicting historical baselines remain held.

Server save rejects unknown policy values; UI exposes the choice and preserves it when reconstructing runtime settings. Immutable historical event settings remain unchanged; no bulk replay/reset is introduced.

Postchecks: real PostgreSQL stage12 and public HTTP settings24 passed in own local root23_side_stage_warn_test schemas stage_warn_test/issue10_test. API/test compilation and web build passed. Native metadata confirms the previously reported MS stage0cb61f8b... is «Собран/Ожидает проверки», not equivalent to the configured «Передан на сборку»; no guessed mapping added.
