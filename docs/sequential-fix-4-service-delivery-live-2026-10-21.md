# Sequential fix 4 — native MySklad service delivery, 21 October 2026

## Result

Implemented on the actual primary instance, no runtime code/config change or
redeployment required. Current runtime remains
`34b273a46aee029ab0757fceb03f1d489c68d8f8`, ACTIVE semantic ON, PID1258143,
exact release/cwd `/opt/bitrix-moysklad-sync-releases/issue79-34b273a-20261021-stage`.
Configv5, 50 migrations and the existing launch boundary remain unchanged.
Final native/SQL verification: **19:04:58 UTC /22:04:58 MSK**.

The separately authorized checker accepted point3 and assigned **only point4**.
Root worked alone. Points5–7 have not been implemented or replayed.

## Cause and bounded correction

Fresh complete native webhook inventory confirmed339 total subscriptions,
9 with the exact protected existing production receiver URL; all9 enabled,
but only counterparty/customerorder/product. No service subscription.
That is the red-capable delivery diagnosis, not a claim that the service
transformation code was broken.

[Official API1.2 webhook documentation](https://raw.githubusercontent.com/moysklad/api-remap-1.2-doc/master/md/dictionaries/_webhook.md)
permits entity/document webhooks except the documented exclusions; service is
not excluded. The current processor already recognizes service CREATE/UPDATE,
uses service-specific B24 endpoints and preserves native kind in the pair.

Added **only two** native subscriptions to the exact same protected receiver
used by the existing9 owned subscriptions; no URL/token exposed in this report:

| Action | New owned webhook ID | State |
|---|---|---|
| service CREATE |c69aefb0-cd81-11f1-0a80-1ca1008f6ad1|enabled, POST|
| service UPDATE |c8ec5e55-cd81-11f1-0a80-16b70091763b|enabled, POST|

Full sorted JSON row fingerprints for **every original339 hook** were compared
before, after subscription creation and after live tests: all byte-equivalent.
Final inventory341 total/11 owned; exact delta2. No foreign/HTMLStudio changes,
no DELETE hook, no removal/disable/update of any existing hook.

Existing runtime's relevant postchecks were already run on this exact artifact
in point3: public Nest/actual processor PG6 (including service CREATE/UPDATE and
audit timestamp), durable create/recovery unit, service adapter and service price
checks, shared reverse prerequisite PG13, API build/testtsc. Combined45 PASS,
zero skip/cancel. No new runtime patch needed to make the genuine service work.

## Genuine new live service

- New MS source: `09638dfd-cd82-11f1-0a80-190700937ac0`.
- Name initially `тест PRODUCTION-TEST-20261021-root SERVICEFIX4-SERVICE01`;
  later normal source UPDATE appends ` REV2`.
- B24 **683364**, native service type7, catalog14, measure9.
- property108 equals the exact MS service ID.
- One active PRODUCT pair **cmvihce7k00e44ksfce1vmqru**, `moyskladType=service`.
- One durable create operation SUCCEEDED, target683364; exact service XML
  identity lookup returns one native card, not a product-type card or duplicate.
- Initial source101 minor units → B24 BASE2 **1.01RUB**, native readback PASS.
- Normal source UPDATE changes name, description and source sale price to234
  minor units → the **same card/pair** has exact new name/plain description and
  **2.34RUB**, one configured price. Source raw text remains unchanged.
- Another genuine UPDATE retains the same description and price, changes only
  its own code to trigger repeated processing. Same native card/pair, one price,
  no duplicate; all exact native checks PASS.

All three genuine MySklad source events **SUCCEEDED attempts1**:

| Phase | Event |
|---|---|
| CREATE |cmvihcb1v00dy4ksfcuvrvl8k|
| name/description/price UPDATE |cmvihcyv700ew4ksf1jlou2g0|
| repeat UPDATE |cmvihdojx00fu4ksfrg6gtz0o|

The source was created exactly once through normal MS REST, which triggered
native delivery by the new subscription. No manual webhook POST, target card
creation or pair seed was used. No payments, document changes or stock writes.

## Preserved records and limitations

Old service `a4d3397b-cd75-11f1-0a80-1e380090853c` was not recreated/updated:
events0/pairs0 remain, no retrospective replay/import is claimed.
Old partial product journal/event digests8762e094.../146995c0..., uncertain
row887122 digest3e3f830a... and old7992 digestbf09d423... remain unchanged.

Separate early B24 echo `cmvihcd3w00e14ksfww6gwu11` ONCRMPRODUCTADD remains
MANUAL_REVIEW1/PRODUCT_PAIR_NOT_ACTIVE. This is already tracked **point5**,
not failure of service delivery. It was not reset/hidden; no blanket all-events
or global-queue PASS claim. Deletion, existing legacy services and unsupported
directions are not accepted by this CREATE/UPDATE result.

## Readonly verification

Helper:
`/opt/bitrix-moysklad-sync-operators/production-20261021/root-service-fix4-live.py read service01`
as bms_sync with existing protected readonly-api EnvironmentFile. This performs
native MS/B24 GET semantics and exact SQL reads, printing no credentials/PII.
It returns ready=true plus native kind7/unit9/price2.34RUB and all three events.

Protected server-only evidence directory (0700/0600):
`/var/lib/bitrix-moysklad-sync/root-service-fix4-20261021`.
Contains hooks.json with original-hook fingerprints/new IDs, own live.json
with mutation fences and refs, final-native-readbacks.txt and final-sql.txt.
Hook verification additionally requires the protected webhook-auth environment;
never print the callback URL or token. **Do not repeat creating/mutating helper
actions**. New service and subscriptions are retained for normal operation.
