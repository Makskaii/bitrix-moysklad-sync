# Пункт 1: ACK добавления товарной строки — код и live-проверка

21.10.2026,21:07МСК. Реализован только пункт1 последовательного задания.
Пункты2–7 не начинались. Независимый проверяющий принимает результат отдельно.

## Исправление и проверки

Полный runtime SHA: `718d6748327c4476555c938f4ed59ae17670bc71`.
В `DealOrderPositionRuntimeService.addRows` добавлена только строгая
нормализация ACK positionsPOST: объект или массив ровно из одного объекта,
корректный native UUID, никаких `error`/`errors`. Пустой, многоэлементный,
вложенный, повреждённый ответ остаётся неопределённым; CREATE не повторяется.
ID журналируется до проверочного GET. Проверка состава/цены/количества,
lease/mode/direction/HTTPS guards и запрет присвоения чужой строки по совпадению
значений сохранены. Глобальный HTTP-парсер не ослаблялся.

Исходный ACK старой ошибки не захвачен. Отдельный реальный POST объекта того же
endpoint в независимом прогоне подтвердил array[1]; приложение ожидало объект.
Это не утверждение, что исходный потерянный HTTP-ответ был перехвачен задним числом.
По решению пользователя работа implementation-first, безTDD; затем postchecks:

- APIbuild и testtsc PASS на фактическом новом исходнике.
- Реальный собственный PostgreSQL15/15 и unit5/5: всего20/20, zeroSkip,
  естественное завершение12.49сек. Object/array ×paid/free; rowbinding,
  повтор и следующее изменение; arrayACK+потеряreadback+единственныйPOST;
  errors/пустой/multi/неверныйID не создают связь и не повторяют CREATE.
- Сохранены проверки OFF/PAUSE, read-before-write/readback, временных ошибок
  productGET, конфликтов и прежней objectACK recovery.
- База только `sync_root_position_ack_20261021_test`,50миграций,
  собственный локальный кластер127.0.0.1:58343. Первый ошибочный запуск был
  ошибкой окружения: pg_ctl без-o поднял этот же собственный кластер на5432,
  тесты не подключились. Такой запуск не считается PASS. Кластер штатно
  перезапущен с явным58343, после успешных тестов остановлен; данные сохранены.

## Фактическая выкладка

Основной `bitrix-moysklad-sync.service`, PID1254054,
`/opt/bitrix-moysklad-sync-releases/issue79-718d674-20261021-stage`.
Проверены /proc/PID/cmdline и cwd, не только symlink/WorkingDirectory.
ACTIVE, semanticON, настройкиv5/направления/граница11:39:51.761UTC неизменны,
50миграций, миграций/новогоconfigsave не было. Все шесть действующих направлений
прошли preflight. TLShealth/GETPOSTsameHTML200/admin403 PASS.

Штатная PAUSE, backup и fingerprint-сравнения recovery/config/directions/pairs/
ранее принятыхstatus+attempts/миграций и старой UNCERTAINоперации прошли.
Серверные доказательства0700/0600:
`/var/lib/bitrix-moysklad-sync/production-718d674-20261021-01`.
Первый финальный syntaxcheck stage-скрипта ссылался на ошибочное
`position-ackpings.js` после механической замены имени. APIbuild уже завершился;
проверен реальный compiledposition-runtime до активации. Это ошибка оператора,
не дополнительное изменение runtime и не пропущенная проверка.

## Новый сквозной тест на основном экземпляре

Только собственная новая сделка
[138508](https://aerosystems.bitrix24.ru/crm/deal/details/138508/),
`тест PRODUCTION-TEST-20261021-root FIX1-ADD01`, родитель310178.
Товар50070 ранее выбран через «Подбор товаров», его карточка/остатки/цены
не менялись. В этом узком тесте sourceADD/update вызваны штатным BitrixREST;
это обычные genuine callbacks, не ручные webhook-payload. Целевой заказ/пары
созданы приложением, без ручного MScreate/seed.

Один native MSзаказ: `d4491308-cd79-11f1-0a80-03be008f65c9`.
Одна активная DEALпара: `cmvif8rn0000h4kmubwbid6u1`.

| Источник Б24 | Native строка МС | Проверенный итог |
| --- | --- | --- |
| Начальная887272 | d4491862-cd79-11f1-0a80-03be008f65ca | 1×12,34₽, не менялась |
| ПлатныйADD887276 | e5d5112f-cd79-11f1-0a80-1174008e4fbc | ADD2×7,89₽, затем3×7,89₽; тот жеID |
| БесплатныйADD887278 | f8a9d3c0-cd79-11f1-0a80-16b7008f1d7e | ADD1×0₽, затем2×0₽; тот жеID |

ПлатныйADD: событие `cmvif9aya00144kmu5z4meegn` SUCCEEDED1.
БесплатныйADD: `cmvif9zhj001i4kmumjl3sb8z` SUCCEEDED1.
Обе `DealOrderPositionAddOperation` SUCCEEDED, nativeID сохранён,
обе `DealOrderPositionPair` ссылаются точно на этиID, lastError=null.

Следующее изменение paidqty: `cmvifabum001y4kmuyogknd63` SUCCEEDED1.
Следующее изменение freeqty: `cmvifaydn00294kmuvfetiyv7` SUCCEEDED1.
Новый обычный COMMENTSrepeat: `cmvifbkzc004y4kmudl0qe93x` SUCCEEDED1.
Четыре MSUPDATE/echo тоже SUCCEEDED1: cmvif9dwb00194kmu5wjb706y,
cmvifa2ep001n4kmu1l3shwd1,cmvifadwj00224kmumh83j1z9,
cmvifazvm002c4kmuo2ho8ln8.

Финальные независимые nativeGET: ровно3позиции, те же3ID, сумма3601minor=
36,01₽. Источник тоже36,01₽. После repeat новых позиций нет.

## Что не скрыто и не исправлялось

- Старые138480/887122 и событиеcmvieijlk01764k67nza0gwbu не replay/reset.
  Исходная операция UNCERTAIN/nativeIDnull/IDENTITY_UNPROVEN осталась побайтно
  неизменной: fullrowhash до и после нового теста одинаков.
- Ранние события новой138508 на стадииNEW ожидаемо heldSTAGE_NOT_CONFIGURED:
  создание разрешено только «Обработан», это не ACKADD.
- Начальный nativeCREATEcallback заказа cmvif8r5l000d4kmuldvozidd остался
  MANUAL_REVIEW/REVERSE_DEAL_CREATE_REVIEW до окончательной фиксации прямой пары.
  Последующие sourceCREATE/UPDATE завершились, одна пара подтверждена.
  Это отдельное наблюдение раннего documentecho, НЕ закрывается данным ACKfix
  и не маскируется blanket-заявлением «все события нового документа успешны».
- Не выполнялись старые неопределённые CREATE/ручнойремонт/сменаподписок/
  действия над рабочими клиентскими документами/платежи/удаления/пункты2–7.

Репро-артефакты: `root-position-ack-live-20261021.py` и
`root-position-ack-evidence-20261021.sql` в C:/Projects/aerosystems;
защищённые IDs/fences в
`/var/lib/bitrix-moysklad-sync/root-position-ack-20261021/ids.json`.
Запускать только read для независимой проверки; creating/mutating actions
уже имеют attemptedfences и повторно не нужны.
