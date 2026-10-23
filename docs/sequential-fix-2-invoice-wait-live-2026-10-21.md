# Пункт2: ожидание счётом заказа — код и live-проверка

21.10.2026,21:28МСК. Выполнен только пункт2. Независимая приёмка отдельно;
пункты3–7 не начинались. RuntimeSHA:
`274d749fafcb5791bd58d70ebc9305d724c8f9c2`.

## Изменение

Только InvoiceEventProcessor и его integration suite. WAITING_FOR_ORDER
получает persistedretryAfter=now+30s. Scanner, ранний isDue и CASclaim
одинаково соблюдают срок: restart/redispatch не обходят его. Это boundedpoll,
не push: после появления пары заказа продолжение на ближайшем poll до30сек.

Успешная проверка отсутствующей зависимости не расходует attempts:
под действующим workerlease/ON-lock и условием statusPROCESSING/attempts=prior+1
атомарно сохраняются WAITING/deadline/attempts ДО собственного claim.
Прошлые реальные ошибки не сбрасываются. Ошибки429/5xx сохраняют Retry-After,
backoff и прежний MAX8. Mode/direction/identity/relationship/boundary/lease
guards не ослаблялись. Нет миграций, новых колонок, configsave, очистки истории.
Исторические heldсчётчики не объявляются исправленными и не переписываются.

## Postchecks

Implementation-first, безTDD по решению пользователя. APIbuild/testtscPASS,
realPG22/22+unit16/16=38/38, zeroSkip/Cancel, naturalexit20.78/0.40сек.

Новый publicNestHTTP→actualprocessor→PG case: два genuine-equivalent webhook
события одного счёта до заказа; attempts0/futuredeadline; timer/directredispatch
не читают API рано. Закрытие/создание Nest с той же БД сохраняет deadline.
После готовности зависимости оба события создают одну invoiceout с собственными
строками2×12.34=24.68 и точным родителем. Только в isolatedfixture срок
сдвинут в прошлое для моделирования времени, без resetstatus/attempts/leases.

Реальный syntheticHTTP429+Retry-After, затем12 обычных ожиданий сохраняют1
прошлую ошибку; следующие503 завершаются на8, как положено. Ранний retry не
читает провайдера. Прежниеgoods/create/update/add/recovery/31/пары/связи/
группы/revision/конфликтные guards прошли. Полный project suite не заявленPASS.
Только ownDBsync_root_invoice_wait_20261021_test/schemaissue55_root_wait_test,
50миграций/ownlocal58343, после тестов штатно остановлен, данные сохранены.

## Основной экземпляр

ACTIVE semanticON, PID1255879; exactcwd+/proc/PIDcmdline:
`/opt/bitrix-moysklad-sync-releases/issue79-274d749-20261021-stage`.
Configv5/карта18×18/направления/граница11:39:51.761UTC/50миграций сохранены.
ШтатнаяPAUSE/backup/immutablecutover, fingerprintsPASS, все6preflightsPASS,
строгийTLShealth/GETPOSTsameHTML200/admin403. Server-onlyevidence0700/0600:
`/var/lib/bitrix-moysklad-sync/production-274d749-20261021-01`.

## Реальный новый сценарий

Own[сделка138548](https://aerosystems.bitrix24.ru/crm/deal/details/138548/),
`тест PRODUCTION-TEST-20261021-root FIX2-WAIT01`, parent310178,
row887328/knownpickerproduct50070/1×45₽. SourceNEW, заказа ещё нет.
Создан own[счёт7994](https://aerosystems.bitrix24.ru/crm/type/31/details/7994/?categoryId=4),
его row8873302×12.34=24.68₽, не состав/цены заказа.
Обычные BitrixRESTмутации своих записей породили genuinecallbacks;
никаких ручных webhookPOST/целевыхMScreate/DBpairseed.

| Событие | До заказа | После заказа |
| --- | --- | --- |
| ADDcmvify7g6000d4k1j2vs2rtqe | WAITING/attempts0/futuredeadline | SUCCEEDED3 |
| UPDATEcmvify7q3000f4k1ji65mta48 | WAITING/attempts0/futuredeadline | SUCCEEDED1 |

Наблюдения19.4/53.8/140.0сек: обе пары0, attempts0, deadline сдвигается
примерно раз30сек (18:24:34→18:25:04→18:25:36→18:26:38UTC), не каждуюсекунду.
Через141.2сек штатная смена STAGE_ID своей сделки наPREPARATION.
События продолжились сами. ADD имел2postdependencyRETRYABLE_FAILURE с общим
INVOICE_PROVIDER_OR_PROCESSING_FAILURE, затемSUCCEEDED3; точная транспортная/
leaseпричина двух повторов не утверждается. Нормальное ожидание ни одной
попытки не потратило. На production не было replay/reset/правкиretryAfter.

Независимые nativeGET+exactexternalCodelookup:

- DEALpaircmvig1a93000x4k1jvcviljs6 → заказ
  `ed527564-cd7c-11f1-0a80-19070091b04b`,1×45=4500minor.
- INVOICEpaircmvig1pea00644k1j7zis6ats → invoiceout
  `f95ef7d8-cd7c-11f1-0a80-1174008f3a55`, externalCode7994COUNT1.
- Одна invoiceposition `f95efd63-cd7c-11f1-0a80-1174008f3a56`, qty2,
  price1234minor/sum2468minor=24.68₽, точныйproductUUID.
- ТочныйcustomerOrder, те жеagent/organization; sourceinvoice24.68, order45.
- Оба событияterminalSUCCEEDED/retryAfternull; нет ложногоMAX и дубляinvoiceout.

Старые7992events и полныйUNCERTAIN138480/887122 не изменились: соответствующие
before/finalhash совпали. Они не replay/reset/repair. Иные пункты не закрывались.

Независимая readonlyпроверка:
`/opt/bitrix-moysklad-sync-operators/production-20261021/root-invoice-wait-live.py read-target`
какbms_sync с существующими protectedEnvironmentFile references. Creatingactions
create/invoice/stage ужеfenced, не повторять. Protectedmetadata:
`/var/lib/bitrix-moysklad-sync/root-invoice-wait-20261021/ids.json`.
Локальные helper/SQL: C:/Projects/aerosystems/root-invoice-wait-live-20261021.py
и C:/Projects/aerosystems/root-invoice-wait-evidence-20261021.sql.
