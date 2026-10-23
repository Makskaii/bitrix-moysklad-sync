# Reverse order service rows

Three fixed stalled MS order events had no reverse-create operation. Bounded safe rotating-log inspection found repeated MS404 before operation registration. Native reads of all three orders returned200 and included service lines; two addressed service reads returned200 through entity/service and404 through entity/product. The third service line was outside the first three probed positions and was not independently read. No provider writes were used for diagnosis.

Cause: reverse order preparation read every assortment through entity/product regardless of native meta.type. Use the native product/service discriminator, verify the returned type and saved pair kind, and pass service kind into the existing durable catalog creator. Unsupported types are held per row, not treated as products. Keep legacy normalized product fixtures compatible when meta.type is absent.

Paired row reconciliation, historical row bootstrap and forward row-add also retain service identity. Existing native rows accept explicitly configured reverse UOM alternatives when validating their saved Bitrix measure; the canonical forward unit is not replaced. New forward rows still require their canonical configured unit.

Postchecks: full reverse-create PostgreSQL16 and full position-runtime PostgreSQL17 passed in own local root23_reverse_unit_test DB with synthetic providers, including mixed product/service creation, repeat without another deal, service quantity update/bootstrap, saved service reference on forward row-add and reverse-only UOM validation. API/test compilation passed. No production retry/reset/pair repair or new business record was performed for this fix.

This addresses the proven service404 pattern, not all retry categories. Transient HTTP503, company resolution, uncertain writes and unmapped stages remain separate findings.
