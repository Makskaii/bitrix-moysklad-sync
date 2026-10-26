# Forward deal creation: confirmed defaults

User explicitly reconfirmed organization defaults and clarified currency:
the counterparty has a price type, not a currency. If source currency has no
saved mapping, use the configured RUB reference without FX conversion.

Under `unmappedReferencePolicy=confirmed-defaults` only:

- An explicitly selected but unmapped organization uses defaultOrganizationId.
- An unmapped/missing source currency uses the saved `RUB` currency mapping.
- Existing explicit mappings still take precedence. The selected native
  organization/currency must pass the same provider identity checks as before.
- Numeric source prices remain unchanged (apart from normal major→minor unit
  representation). No exchange rate or counterparty price-type inference.
- No new fallback for stages, product identity, units or client conflicts.
- Explicit `hold` retains strict behavior. Missing RUB configuration or a
  missing/unreadable selected native reference still waits safely.
- Every applied organization/currency fallback is recorded in OperationalLog.

Checks: API build/test compilation; preparer15 PASS; actual HTTP/PG create
suite9 PASS, including simultaneous unknown USD/organization/store/employee,
native default validation and price10→1000minor unchanged. Own local DB only.
No production config save, migration, mode change, provider writes or deploy.

Handoff is ON HOLD at the user's explicit request until they report that the
main coordinator has finished its current work. This is not production PASS.
