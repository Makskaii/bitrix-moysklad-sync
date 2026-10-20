# Issue #60 release notes

This change adds an enable-time readiness gate to the combined #55/#57/#61 candidate.

- Deals/orders, invoices, catalog and contacts/companies report implemented handler capability, while end-to-end acceptance remains a separate evidence status. Client handlers support configured field rules/groups, baseline/readback, runtime pair creation and contact dependencies. The separate standalone service-dictionary feed remains unavailable; custom service-dictionary fields inside deal/order runtime are distinct and supported.
- New entity direction rows are created Off. Existing contacts direction defaults remain compatible. Catalog direction is explicitly one-way from MySklad to Bitrix24.
- Admins can request a preflight for one entity and direction. The API performs read-only provider calls, uses the active settings version, checks webhook authentication configuration and required values, and reports safe blocker/warning text without exposing secrets. Deal stage and currency mappings are checked against the current provider catalogs; catalog selection and current unit mappings are checked for the product direction.
- Direction updates repeat the preflight on the server. A failed preflight returns a conflict and does not persist the requested enablement. The admin UI renders the returned blockers and warnings.
- Service mode On, Pause and Off do not establish or move the separately confirmed launch boundary. The boundary continuity action remains audited and leaves the service Off.

Verification performed in the isolated `issue-60-preflight` worktree at base `2609d93d603665ffbd3457bd0ca1e448c57d42f2`:

- `npm run build` — PASS.
- `npm run test:sync-mode-unit --workspace @sync/api` — PASS, 8 checks.
- `npm run test:sync-mode-preflight-unit --workspace @sync/api` — PASS, 3 checks.
- Fake-provider, full combined API/browser and isolated PostgreSQL suites — NOT RUN in this slice; tracked by the integration owner.
- Real Bitrix24/MoySklad UI/API/webhook scenarios — BLOCKED pending isolated PostgreSQL PASS and an owner-approved, record-scoped live-test plan. No live writes or production cutover were performed.

This is not full #60 acceptance. See [the cutover runbook](issue-60-cutover-runbook.md) and [the coverage matrix](issue-60-coverage-matrix.md) for current blockers and operator limits.
