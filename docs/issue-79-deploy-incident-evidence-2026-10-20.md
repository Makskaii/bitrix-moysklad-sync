# Issue #79 deployment and OFF incident evidence — 2026-10-20

## Scope and disposition

This note records the reviewed native deployment and its OFF-only recovery boundary. It is not a live-acceptance report: general sync remains OFF, full nightly fixture acceptance is incomplete, and no controlled provider-write scenario is claimed as passed.

The active native release is pinned to `70b2c18c270e15baf9ae0aa3543daa13aed47ee6` at `/opt/bitrix-moysklad-sync-releases/issue79-70b2c18-20261020`, behind the `root-live-v1` symlink. The API binds to loopback (`127.0.0.1`); systemd unit `bitrix-moysklad-sync.service` is active. Read-only `/health` and strict-TLS public health/UI checks succeeded after activation. The service was watched across multiple recovery/scheduler ticks with no change to the preserved queue or worker leases.

## Preserved primary state

At the authorized OFF deployment check, the primary database remained in global `OFF`. Its queue contained 510 `MANUAL_REVIEW`, 22 `PROCESSING`, and 133 `RECEIVED` rows (665 total); status/attempt digest `44e67bbd7ac4ccba4fb46bffdef01400`. No row was reset, replayed, or cleaned up. Worker lease digest was `7da055677632417a00ad67f294bad15e`. Field settings version 4, direction flags, pairs, mode history, launch boundary, and all 49 applied migration checksums were preserved; migration digest `8b31b9123c420f1d7732036ee8aba41b`. The candidate had no migration delta relative to that 49-migration schema.

One metadata-only `SyncSetting.updatedAt` change was traced to startup recovery initialization reasserting `serviceMode='off'` without changing protected settings. It was not treated as business-configuration drift. Restricted comparison/evidence remains on the server under `/var/lib/bitrix-moysklad-sync/issue79-safeoff-watch-70b2c18-20261020-01`; this repository contains no database dump, payload, personal data, credentials, webhook URL, or secret path.

## Incident boundary and remaining limits

An earlier brief activation window was followed by a stop and read-only forensics; affected primary queue state was preserved rather than “repaired.” The exact restricted forensic artifacts are retained server-side. This public repository note intentionally does not attribute specific event rows or provider effects beyond what the restricted evidence supports.

The OFF repair is intended to prevent new background claims and provider operations after the durable OFF transition is acknowledged. Do not infer that already-in-flight provider requests can be cancelled retroactively. The production service remains OFF; the 665 pre-existing queue rows are not a processing boundary and must not be replayed by a test instance.

Fresh read-only tenant checks on 2026-10-20 found 339 MoySklad webhook subscriptions, including nine targeting this receiver host. Product CREATE, UPDATE, and DELETE subscriptions on this receiver are all disabled. Bitrix24 `event.get` returned `WRONG_AUTH_TYPE`, so its subscription registry and callback coverage remain unverified. No hook was changed. The runtime's MoySklad→Bitrix24 product-card creation path is triggered by product `CREATE`; an unpaired product `UPDATE` does not establish the target-create scenario. No provider write, subscription change, global Apply transition, or general cutover is authorized by this evidence note.

## Acceptance status

- Exact deployed code SHA: `70b2c18c270e15baf9ae0aa3543daa13aed47ee6`.
- Native service and API/UI health: verified for the OFF deployment window.
- Primary mode/queue/migration preservation: verified within the recorded OFF watch.
- Full nightly fixture suite: not accepted as passing.
- Isolated scoped live run and genuine provider callback: not run.
- Provider writes, subscription changes, replay, and general cutover: not performed.

