# Archived parent specification #1 before backlog replacement

- Captured: 2026-10-09
- State: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/1

## Original body

## Problem Statement

Действующая интеграция Bitrix24 и МойСклад не даёт нужного контроля над направлением обмена, сопоставлением записей и полей, конфликтами и наблюдаемостью. На портале уже есть дубли, а исторических заказов МойСклад может быть около 1,8 млн. При переходе на собственный сервис важно не размножить записи, не потерять состав заказов и не переписать старые данные только из-за первичной загрузки.

## Solution

Создать собственный идемпотентный двусторонний сервис синхронизации Bitrix24 и МойСклад. Предпочтительный источник при равном времени или недостаточной точности — МойСклад; по существующим парам обмен определяется изменениями отдельных полей относительно снимка. Сервис принимает события, хранит их и результаты в PostgreSQL, поддерживает восстановление после простоев, dry-прогоны и встроенную в Bitrix24 админку. Перед отключением HTMLStudio выполняются первоначальное сопоставление и проверка готовности.

## User Stories

1. Как администратор, я хочу видеть состояние обмена, чтобы понимать, работает ли сервис.
2. Как администратор, я хочу включать, ставить на паузу и выключать обмен, чтобы управлять запуском и инцидентами.
3. Как администратор, я хочу переключать каждую сущность и каждое направление отдельно, чтобы вводить обмен поэтапно.
4. Как администратор, я хочу видеть предупреждение перед включением, выключением и рискованной настройкой, чтобы понимать последствия.
5. Как администратор, я хочу видеть проверку готовности перед включением, чтобы обязательные пробелы блокировали небезопасный запуск.
6. Как администратор, я хочу работать в админке через учётную запись Bitrix24, чтобы не заводить второй логин.
7. Как сотрудник Bitrix24 без права `user.admin == true`, я не должен получать доступ к админке, чтобы настройки и данные очереди оставались защищёнными.
8. Как администратор, я хочу видеть записи по понятным названиям и ФИО, а не только по ID, чтобы разбирать пары.
9. Как администратор, я хочу настраивать соответствия полей и направления в таблице, чтобы управлять содержимым обмена.
10. Как администратор, я хочу задавать отдельные преобразования в каждом направлении, чтобы данные корректно проходили между разными моделями.
11. Как администратор, я хочу настраивать составные правила, например сборку ФИО, чтобы не ограничиваться парой одиночных полей.
12. Как администратор, я хочу настраивать соответствия пользователей, валют, организаций, складов и значений справочников, чтобы документы переносились со связями.
13. Как администратор, я хочу предварительно видеть результат преобразования на реальных парах без записи, чтобы проверять настройку.
14. Как администратор, я хочу вручную создать, разорвать или переназначить пару с историей действия, чтобы исправлять ошибки сопоставления.
15. Как администратор, я хочу видеть сомнительные автоматически выбранные пары, чтобы проверить их после выбора.
16. Как администратор, я хочу видеть случаи ручной проверки с причиной, данными обеих сторон и действием повтора, чтобы устранять блокировки.
17. Как администратор, я хочу просматривать очередь, попытки API и отдельные категории логов, чтобы понимать путь события.
18. Как разработчик, я хочу запустить dry-прогон без записи в Bitrix24 и МойСклад, чтобы проверить всю цепочку на реальных и подготовленных сценариях.
19. Как администратор, я хочу просматривать результаты dry отдельно и с явной пометкой симуляции, чтобы не путать их с рабочими операциями.
20. Как сервис, я хочу принять и сохранить событие до подтверждения вебхука, чтобы переживать сбои обработки.
21. Как сервис, я хочу повторять временные ошибки с учётом лимитов API, чтобы не терять изменения и не создавать дубли.
22. Как сервис, я хочу при недоступности одной стороны остановить только затронутые операции, чтобы остальные события продолжали приниматься.
23. Как сервис, я хочу хранить все события одной записи, но после восстановления обрабатывать её актуальное состояние один раз, чтобы не воспроизводить устаревшие изменения.
24. Как сервис, я хочу периодически получать изменения после курсора и проводить ночную сверку активных периодов, чтобы восстанавливать пропущенные события.
25. Как сервис, я хочу после полного выключения искать изменённые за время простоя записи, чтобы возобновить обмен без массового полного обхода.
26. Как сервис, я хочу сопоставить старые записи без автоматического переноса их полей, чтобы включение не переписало историю.
27. Как сервис, я хочу хранить оба первоначальных значения различающегося поля старой пары, чтобы не выдавать расхождение за согласованное состояние.
28. Как сервис, я хочу искать пару новой записи до создания второй, чтобы не плодить дубли.
29. Как сервис, я хочу сохранять одну активную пару на запись МойСклад в пределах типа сущности, чтобы адрес записи был однозначным.
30. Как сервис, я хочу исключать только связь с контактом или компанией Bitrix24 с пометкой «Дубль», чтобы оригинальная пара продолжала работать.
31. Как сервис, я хочу оценивать допустимых кандидатов по признакам сущности, заполненности, связям и использованию, чтобы автоматически выбирать основной элемент.
32. Как администратор, я хочу видеть сомнительный автовыбор уже действующей пары, чтобы проверить его, понимая, что записи могли уже измениться.
33. Как сервис, я хочу сохранять действующую пару при изменении названия, чтобы массовая правка полей не создала новые товары.
34. Как сервис, я хочу повторно искать товар из изменённого заказа и при подтверждённом отсутствии создавать его по необходимости, чтобы обмен заказа мог продолжиться.
35. Как сервис, я хочу остановить весь заказ при неподготовленной обязательной позиции и оставить комментарий с причиной в исходном документе, чтобы не переносить неполный состав.
36. Как сервис, я хочу синхронизировать сделки с заказами и их контрагентов, позиции, стадии и ответственных, чтобы документы оставались связаны.
37. Как сервис, я хочу синхронизировать счета в обе стороны, чтобы будущие изменения в Bitrix24 доходили до МойСклад.
38. Как сервис, я хочу синхронизировать поле-справочник «Услуги» сделки Bitrix24 с одноимённым полем-справочником заказа МойСклад независимо от товарных позиций, чтобы выбранное значение сохранялось без создания лишнего товара или услуги.
39. Как сервис, я хочу создавать и проводить одну полную отгрузку по настроенной стадии сделки, чтобы не возникали повторные документы.
40. Как сервис, я хочу снимать проведение при выходе из стадии и повторно проводить ту же отгрузку при возврате, чтобы состояние соответствовало текущей стадии.
41. Как сервис, я хочу проверять полный остаток МойСклад и не трогать вручную созданные или неоднозначные отгрузки, чтобы не нарушать складские операции.
42. Как сервис, я хочу помечать удалённую запись и восстанавливать обмен после её возврата без физического удаления второй записи, чтобы сохранять историю.
43. Как сервис, я хочу применять новые настройки к новым событиям и делать точечный повтор отдельно, чтобы изменение правил не запускало массовую перезапись.
44. Как администратор, я хочу видеть ошибку обязательного поля как блокировку записи, а ошибку необязательного как пропуск поля, чтобы различать тяжесть проблемы.
45. Как администратор, я хочу иметь доступ к интерфейсу при выключенном обмене, чтобы снова включить сервис.
46. Как разработчик, я хочу остановить обмен при потере БД и восстановить снимки и карты до apply, чтобы не начинать работу с пустым состоянием.

## Implementation Decisions

- Q26.66: первый запуск работает event-driven. При первом событии по исторической сделке/заказу #11 подтверждает уникальную существующую пару, #29 читает текущие обе стороны и сохраняет baseline до записи; неоднозначность уходит на ручную проверку. Параллельно #45 выполняет низкоскоростной resumable scan всех исторических ID сделок/заказов и только утверждённых matching keys, без full-field snapshots, создания пар/записей и без startup/readiness gate. Результат scan не перезаписывает ручные/подтверждённые пары или более свежий baseline.
- Логическая модель включает пары записей, настройки полей и значений с версиями, снимки синхронизируемых полей с обеих сторон, журнал событий и попыток, очередь и случаи ручной проверки. Старая пара с различающимися значениями начинает с двух несогласованных значений.
- Обмен двусторонний и настраиваемый по сущностям, направлениям и полям. Для существующей пары сравниваются изменённые поля и время записи с точностью до секунд; при равенстве или недостаточной точности выигрывает МойСклад. Перед внешней записью состояние перепроверяется. Архитектура допускает последующую смену приоритета на Bitrix24.
- Зафиксированная пара живёт по ID, а не переопределяется после изменения названия. Автоматический подбор допустимых кандидатов разделяет признаки тождества и оценку основной записи. По принятому правилу сомнительный победитель тоже сразу становится активной парой и отображается для последующей проверки; автоматического объединения или удаления нет.
- Для товаров, возникших из описанного инцидента, точное совпадение названия символ в символ — обязательное условие группы кандидатов. По двум ограниченно проверенным независимым группам поля/признаки, цены, изображения, заполненность и использование не дают универсального правила или весов для выбора. В 13 проверенных связанных строках каталога Bitrix24 (12 товаров и 1 услуга) `property108` совпал с UUID связанного ассортиментного объекта МойСклад; это кандидат ключа для проверенных связей, но выборка не доказывает его глобальную уникальность или заполненность.
- Поле «Услуги» сделки `UF_CRM_1766085949` типа `iblock_element` (`SETTINGS.IBLOCK_ID = 42`; список Bitrix24 `rest_entity` ID `42`) соответствует полю заказа МойСклад `0ad997c8-8e75-11e3-1ec9-002590a28eca` (`customentity`, справочник `f0177126-8e74-11e3-b761-002590a28eca`). Для проверенного значения `CODE` элемента списка Bitrix24 совпал с UUID значения МойСклад. Эта связь не создаёт товарную позицию; товарный состав заказа обрабатывается отдельно. В ограниченно проверенной группе «Доставка» владелец подтвердил основную пару: B24 `49580` ↔ МойСклад UI ID `1f43ca4c-8551-11e9-9ff4-315001aa3831`; существовавшую до инцидента пару B24 `564814` ↔ `cc56f579-b6ed-11eb-0a80-088b0014dc45` и две пары-дубля B24 `564820` ↔ `b3344fe6-a822-11f1-0a80-1b47004da3df`, `566672` ↔ `601596a6-a7a9-11f1-0a80-15f20032a6c0` сохранять. Этот частный выбор не задаёт универсальных критериев. По Q26.60 направление двустороннее, одиночные изменения передаются, конфликт решается в пользу МойСклад; отдельная текстовая копия услуги не создаётся. Стандартные поля `product`/`service`, метаданные и границы выборки описаны в `research/t02-products-services.md`.
- Ошибка обязательного поля блокирует запись; ошибка необязательного пропускает только это поле. Неподготовленная обязательная позиция блокирует весь заказ, включая шапку и отгрузку; причина фиксируется в ручной проверке и комментарии исходного документа.
- Состояния обмена: включено; пауза с приёмом событий без внешних записей; выключено без приёма и обработки событий, но с доступной админкой. Отдельные направления можно выключить с фиксацией пропущенных событий без будущего автоматического воспроизведения.
- События сохраняются в PostgreSQL до подтверждения вебхука и обрабатываются асинхронно. Временные ошибки повторяются; после восстановления события одной записи сводятся к чтению её текущего состояния. Ночная проверка не работает во время паузы и выключения и исключает их период.
- Q26.67: подтверждённое удаление в production v1 ставит tombstone в БД, останавливает обмен затронутой пары и сохраняет связанную запись; в Bitrix24 ставится пометка только через уже согласованное/настроенное поле, без угадывания ID. Удаление в МойСклад оставляет комментарий в таймлайне Bitrix24. Подтверждённое восстановление снимает tombstone/пометку и возобновляет ту же пару; неоднозначность — ручная проверка. Физически записи не удаляются.
- Отгрузкой управляет только актуальная настроенная стадия сделки. Один заказ — одна автоматическая полная отгрузка без частичных; перед созданием и проведением проверяются остатки и существующие документы. Промежуточные стадии из задержанных событий не воспроизводятся.
- NestJS обслуживает API и собранную React/CSS-админку. PostgreSQL хранит состояние и очередь, Prisma — основная ORM, параметризованный SQL допустим для узких операций. Сервис и БД запускаются Docker Compose; Redis и MariaDB в первой версии не требуются.
- Dry запускается разработчиком на сервере, использует отдельную схему PostgreSQL, реальные системы только для чтения и смоделированные ответы на внешние записи. Apply не читает dry-схему. Dry может работать параллельно apply.
- Админка встроена в меню Bitrix24; сервер для каждого административного действия проверяет `user.admin == true` текущего пользователя по пользовательскому токену встроенного приложения. Общий сервисный вебхук не определяет посетителя; ошибки проверки не дают доступ. Вебхуки проходят отдельную проверку подлинности. Все управления режимами находятся в настройках, а главный экран показывает состояние.
- Историю рабочих событий и попыток API хранить 30 дней, dry-данные 7 дней, последний согласованный снимок — пока существует пара, незакрытые ручные случаи — до решения. Файлы логов ротируются при 200 МБ на файл.
- По принятому решению резервные копии PostgreSQL не создаются. При потере БД обмен останавливается до повторного построения снимков и карт; это не восстанавливает утраченную историю и ручные решения.


- Для строк товарных позиций заказа: существующую однозначно связанную строку обновлять адресно по ID строки и итоговыми абсолютными значениями (включая количество), новую — добавлять отдельно; не применять delete+recreate или разрушительную замену всего списка. Если row-ID пара неоднозначна — ручная проверка. Удаление строки допускается только после однозначного сопоставления и полного чтения источника; частичная/пагинированная выдача не доказывает удаление. Это не удаляет карточку товара каталога. Подробные критерии и технические TBD — в [#16](https://github.com/Makskaii/bitrix-moysklad-sync/issues/16) и [#26](https://github.com/Makskaii/bitrix-moysklad-sync/issues/26).

## T01: проверенные поля и ограниченные факты

- В Bitrix24 проверены основные поля для исследования ключей: ID (`integer`); `NAME`/`SECOND_NAME`/`LAST_NAME` и `TITLE` (`string`, titles «Имя»/«Отчество»/«Фамилия»/«Название компании»); `PHONE`/`EMAIL` (`crm_multifield`); связи `COMPANY_ID`/`COMPANY_IDS` и `CONTACT_ID`; `ORIGINATOR_ID`/`ORIGIN_ID`/`ORIGIN_VERSION` (`string`). В МойСклад проверены ключи контрагента `id`, `syncId`, `code`, `externalCode`, `name`, `phone`, `email`, `companyType`, `contactpersons` и контактного лица `id`, `agent`, `name`, `phone`, `email`, `externalCode`. Это каталог для исследования, не полный field mapping.
- Все четыре UF Bitrix24 — `UF_CRM_1719834658`, `UF_CRM_1719834633`, `UF_CRM_1789126649744`, `UF_CRM_1789126724375` — существуют как одиночные `string`; API title равен коду, подписи портала пусты. UUID заполнен у 50/50 контактов и 50/50 компаний в смешанном ограниченном срезе. Проверка фильтров показала точное неперсональное значение «Дубль»: totals непустых и exact-value совпали (4 784 контакта, 1 582 компании). Семантика отметки остаётся принятой в требованиях: исключается только связь помеченной записи.
- Новый live-срез B24 (6 контактов, 6 компаний из первых и последних страниц) показал UUID контактной записи на `counterparty.id` в 4/6 и на `contactperson.id` в 2/6; оба contactperson ID подтверждены прямым GET. Для компаний `counterparty.id` совпал в 6/6. Точные и нормализованные имена дали одинаковые результаты: для каждого типа 0 записей с нулём кандидатов, 4 с одним, 2 со многими (максимум 6 у контакта, 7 у компании). По нормализованным имени+телефону и имени+email у контактов всё ещё оставалось по одному многокандидатному случаю (до 4); для компаний имя+телефон не давало кандидата в 5/6, имя+email оставляло один случай с двумя кандидатами. Это наблюдения выборки, не приоритет/правило выбора.
- Старый XLSX от 10.09.2026 содержал 124 838 строк / 120 153 уникальных UUID: 4 685 строк — повторные строки сверх одной на UUID, не отдельные сущности. Старые показатели 50/50 сопоставления на тип относятся к этому snapshot после дедупликации и не являются текущей API-оценкой. Ограничения выборки, маски примеров и метод нормализации приведены в [отчёте T01](research/t01-contact-company-fields.md). Глобальная уникальность, критерии/приоритеты кандидатов, пороги и полная карта синхронизации не установлены.

## Testing Decisions

Основной согласованный тестовый шов — входящее событие или плановая проверка → обработка и сопоставление → сохранённое состояние → ожидаемые вызовы внешних адаптеров. Проверять наблюдаемое поведение через сервисные входы и подменённые Bitrix24/МойСклад API, не привязываясь к внутренним методам и таблицам. В новом проекте пока нет готового набора автотестов; существующие скрипты служат примерами API-взаимодействия, а не тестовым контуром.

Проверить как минимум: повтор одного вебхука без дубля; обратное событие от собственной записи без цикла; разные поля и конфликт времени; равное время с приоритетом МойСклад; старую пару с различающимися значениями без записи при запуске; новую запись с единственным и несколькими кандидатами; активную сомнительную пару; исключённый дубль при живом оригинале; товар с повторным поиском и созданием; отказ создания товара с полной блокировкой заказа и комментарием; временную недоступность одной системы; сведение задержанных событий; паузу и полное выключение; ночную сверку; смену стадий и идемпотентную отгрузку; недостаток остатков; ручную отгрузку; soft delete/restore; изоляцию dry/apply; проверку прав админки; блокировку включения по обязательной настройке.

- [ ] Строки заказа: повтор события не применяет количество как delta повторно; существующая строка обновляется только по подтверждённой row-ID паре; повторные строки одного товара не смешиваются; новая строка добавляется; удаление переносится только при полном чтении и подтверждённой паре; частичный список и неоднозначная пара дают ручную проверку; удаление строки не удаляет карточку товара.

Локально проверять цепочку на имитациях API. Реальные вебхуки и встроенный интерфейс проверить через временный HTTPS-туннель, затем на сервере до отключения HTMLStudio. Тесты не должны записывать в боевые Bitrix24 и МойСклад, кроме отдельно согласованного контролируемого apply.

## Out of Scope

- Автоматическое объединение или физическое удаление дублей.
- Массовое создание старых записей только из-за первичной инвентаризации.
- Создание платёжных документов, заказы поставщикам, розничные продажи и автоматические действия с отгрузками отложены для первого production launch; Q26.44 допускает только чтение `payedSum`, Q26.14 выключает отгрузочные действия.
- Включение складского учёта Bitrix24 и собственный экран остатков.
- Произвольный исполняемый код в настройках преобразований.
- Массовый пересчёт прошлых событий при изменении настройки; допускается точечный повтор.
- Отдельные логины админки, переключатель dry/apply в UI и внешние уведомления об операционных инцидентах.

## T03/T04 research findings and limits

T03 завершил исследовательские критерии по документированным API, ограниченному live-срезу и примерам текущей интеграции. В отчёте зафиксированы 16 видимых настроенных пар полей «сделка → заказ», 16 строк стадия/статус и наблюдавшаяся цепочка МойСклад invoiceout → заказ покупателя → сделка Bitrix24 → смарт-счёт Bitrix24 типа 31. Это конкретные настройки и примеры отчёта [T03](https://github.com/Makskaii/bitrix-moysklad-sync/blob/main/research/t03-deals-orders-invoices.md), а не утверждённая карта всех полей или полный аудит исторических документов. Запрос счетов Bitrix24 охватывал только первую страницу; пример типа 31 не доказывает тип всех счетов. Связи проверены на отдельных примерах, а не полным обходом. В частности, контакты в показанном примере не связаны; таблица Employees mapping, инициатор/полный diff/успех всех операций и некоторые связи остаются TBD.

T04 подтвердил выбранное владельцем условие доступа к админке: сервер проверяет `user.admin == true` текущего пользователя; отдельный отдел администраторов не является условием. Исследование кандидатов пользователей, складов, организаций и валют не утверждает готовые пары: применение, глобальная полнота и неоднозначности остаются предметом проверки. Интеграционный тест пользовательского токена с положительным/отрицательным `user.admin` и fail-closed при ошибке ещё нужен. Подробности: [T04](https://github.com/Makskaii/bitrix-moysklad-sync/blob/main/research/t04-reference-access.md).

Недостающие рабочие этапы вынесены в #26 (полная карта полей), #27 (ключи и пороги автосопоставления), #28 (полный обмен контактами) и #29 (возобновляемые карты товаров и документов со снимками).

## Further Notes

Это спецификация согласованной архитектуры, а не утверждённая карта каждого поля. До реализации соответствующих обработчиков нужны отдельные тикеты на выгрузку и анализ метаданных и примеров: полный список полей, направления и преобразования; проверенные ключи и статистика конфликтов; направления обмена поля услуг и необходимость отдельной текстовой копии; тип счёта; стадии отгрузки; обязательные поля; технический путь пользовательского токена и поведение `user.admin` для admin/non-admin; точные признаки и пороги оценки кандидатов; объём и пропускная способность низкоскоростного фонового ID/key scan (#45) примерно 1,8 млн старых заказов; полные snapshots всей истории не являются условием запуска; защита секретов и персональных данных; схема HTTPS и переход с HTMLStudio. Известные коды Bitrix24: UUID контакта UF_CRM_1719834658, UUID компании UF_CRM_1719834633, пометка дубля контакта UF_CRM_1789126649744, компании UF_CRM_1789126724375, поле «Услуги» сделки UF_CRM_1766085949.

Перед рабочим включением требуется отдельно проверить, что эти зависимости закрыты. Риск принятого автовыбора: сомнительная пара может уже изменить данные до ручной проверки. Риск отсутствия резервных копий: потеря истории и длительное восстановление после сбоя БД.

## T26 field map

The published, evidence-bounded [T26 research map at merge commit c03357c](https://github.com/Makskaii/bitrix-moysklad-sync/blob/c03357cf91cb348376d043b64caf80816ca43443/research/t26-field-mapping.md) is the research baseline for this specification. Technical verification of row-ID pairing and row operations remains open in #26; the map is not a complete accepted runtime allowlist.

## Q26.11 owner decision (2026-10-06)

On clearing a critical MySklad field, restore the same field before saving state from its last saved successfully synchronized non-empty value, falling back to the corresponding current value on the confirmed Bitrix24 pair. Preserve the prior saved value until restoration. On clearing a critical Bitrix24 field, retain Q77: restore from the current MySklad value; if no admissible value exists, stop syncing the record. If both candidate sources are empty, do not invent a value and stop. Log the case, reason, restoration source, and previous/restored values under existing data-protection rules. Optional-field clearing remains governed by Q26.9; no critical fields are added by this decision.

See [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42) and [Issue #26](https://github.com/Makskaii/bitrix-moysklad-sync/issues/26), which remains open for remaining criteria.

## Q26.20 and Q26.26–Q26.32 owner decisions (2026-10-06)

- Q26.20: the deal/order “Услуги” directory field is optional; missing value does not block the document and clearing follows Q26.9. It is not a product row and does not decide criticality of other fields.
- Q26.26–Q26.29: first creation for a new deal is gated by no existing pair, mapped current stage, required-data readiness, and at least one complete valid product row. Waits are logged and retried on the next deal change. A declined new deal with no order waits until return to work; an existing confirmed pair must receive the mapped declined status. Return to work triggers automatic first creation when ready; no manual approval and no mass creation of historical deals before activation. These are owner decisions, not claims about HTMLStudio trigger behavior; declined/return stage IDs remain configurable/TBD.
- Q26.30–Q26.32: before launch, show all users from both systems with suggested matches and allow admin reassignment; warn at the top on many-to-one matches. User mapping is separate from active entity pairs for customers/products and does not generalize multiplicity. Ambiguous responsible selection uses the first target-system display name alphabetically; UI sorting/filtering cannot alter that criterion. Warning does not block launch. Equal display-name tie-break remains technical TBD; matching algorithm/quality remains in #27.

Requirements and the field map are updated in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42). Issue #26 remains open.


## Q26.33 owner decision (2026-10-06)

After launch, when a new responsible user is assigned, automatically look up the users mapping. For an existing confirmed pair/document, if no mapping exists, preserve the previously selected target-side responsible (do not replace or clear it), skip only that field, and continue other document changes under the usual rules. Log the missing mapping and preservation of the prior value. Do not infer/create a mapping from a name without verified #27 rules. First creation, where no prior target-side responsible exists, remains TBD for Q26.34. See [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42).


## Q26.34–Q26.35 owner decisions (2026-10-06)

- Q26.34: On first creation, if no responsible-user mapping exists and no prior target owner exists, use the target system’s configured default employee and log the fallback. A valid default permits creation. If the default is missing or invalid, use the existing required-configuration validation and do not invent another fallback; technically verify the target default. Q26.33’s preserve-existing-owner behavior remains unchanged.
- Q26.35: New orders originating in Bitrix24 use native MySklad numbering, not a Bitrix24 deal-ID number. Write the resulting MySklad `customerorder.name` to B24 `UF_CRM_1729757435964` (“Номер заказа МС”); B24 `TITLE` remains separate under Q26.8. The number is not a pair key; existing ID-based pairing rules remain. HTMLStudio documentation describes both numbering choices; how the Remap adapter obtains the assigned native number is still technical TBD, and omitted-name auto-numbering is not established for Remap customerorders.

Documented in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42). Issue #26 remains open.


## Q26.36 owner decision (2026-10-06)

When first creating a new Bitrix24 deal from a MySklad customer order, set B24 `TITLE` to the exact template `Заказ покупателя ` + `customerorder.name`. This applies only at initial creation: do not mass-rename old deals or overwrite later user-edited titles. B24 `UF_CRM_1729757435964` separately stores the order number under Q26.8/Q26.35. Do not infer an automatic TITLE update on later MySklad number changes; TITLE remains a separate field. Documented in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42).


Sources for Q26.35: [HTMLStudio course documentation](https://www.htmls.ru/learning/course/?COURSE_ID=5&TYPE=Y) describes the numbering choices; [MoySklad Remap 1.2 documentation](https://dev.moysklad.ru/doc/api/remap/1.2/) is the reference for technical verification and does not establish omitted-name auto-numbering for customerorders in the researched material.

## Q26.37–Q26.40 owner decisions (2026-10-06)

- Q26.37: If a manually entered B24 `OPPORTUNITY` differs from the total of the complete, ready product composition (quantity/price/discount/tax), the line-derived MySklad order total is authoritative: restore `OPPORTUNITY` and log the conflict, former manual amount, and reason. Do not redistribute the difference, add a synthetic row, or block the whole document solely on this amount. Existing field-conflict priority and row readiness Q26.23–Q26.25 remain. Minor units, taxes, rounding and API support remain technical checks. Sources: [MoySklad CustomerOrder SDK](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/CustomerOrder.md) lists `sum` as read-only; [Bitrix24 crm.deal.get](https://apidocs.bitrix24.com/api-reference/crm/deals/crm-deal-get.html) describes `OPPORTUNITY` and `IS_MANUAL_OPPORTUNITY`.
- Q26.38: Transfer deal discount field `UF_CRM_1771501013` to the distinct CustomerOrder discount attribute without recalculating or reapplying it across position discounts. Row-level discounts remain in scope; Q26.37 is unchanged. Units/meaning and transforms remain TBD.
- Q26.39: The desired direction for both delivery-address fields, tracking number, coupon, delivery-cost field, and separate discount field is bidirectional. Single-sided changes propagate; MySklad has priority for two-sided conflicts. This is a product-direction decision, not proof of API writability or transforms.
- Q26.40: This six-field information group is functionally optional, independent of API metadata `MANDATORY=N`: empty values are allowed, clearing follows Q26.9, and transform errors skip/log only that field without blocking the order. This does not extend to clients, prices, product relations, organization, store, or currency. VAT/date/payment/total fields are excluded from this decision.

Documented in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42); issue #26 remains open.


## Q26.41 owner decision (2026-10-06)

For B24 date field `UF_CRM_1730384262074` ↔ MySklad customerorder attribute “Дата доставки” `74960544-9c3d-11ef-0a80-17ac0027f1c3` (type `time`), transfer calendar-day semantics only; no time-of-day precision or new B24 datetime field is needed. This does not choose direction or functional criticality and does not automatically include the date field in Q26.39/.40. Timezone and how to write the MySklad time component remain technical TBD.


## Q26.42 owner decision (2026-10-06)

The planned receipt date pair `UF_CRM_1730384262074` ↔ MySklad customerorder attribute “Дата доставки” `74960544-9c3d-11ef-0a80-17ac0027f1c3` is bidirectional and functionally optional. Empty is allowed; clearing follows Q26.9; a transform error skips and logs only this field. Q26.41 remains: transfer calendar-day semantics only. This does not prove API writability; timezone and encoding the MySklad time component remain technical TBD.

## Q26.43 owner decision (2026-10-06)

A B24 product-row discount entered as a money amount must be converted to the equivalent MySklad position.discount percentage while preserving the final row value; a percentage discount is passed through directly. Do not silently drop a monetary discount or distribute it among rows. If it cannot be represented or the final row value cannot be preserved, the existing mandatory-field/whole-order error rule applies; no separate behavior was selected. Decimal precision, tolerance, net/gross formula, API limitations, and the specific validation algorithm remain technical TBD. This concerns row discounts and does not change Q26.38: the separate order-level discount does not recalculate rows.

Documented in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42). Issue #26 remains open.

## Q26.44 owner decision (2026-10-06)

B24 `UF_CRM_1782196830070` (“Сумма оплаты”) receives `customerorder.payedSum` only from MySklad to Bitrix24. If the B24 value is manually changed, restore the current calculated MySklad `payedSum` and log the former value and reason. Do not PUT `payedSum` or create payment documents; payments remain out of scope for v1. The official CustomerOrder schema marks `payedSum` read-only. HTMLStudio separately documents a payment-document feature configurable by payment type, amount, posting, and stages, including cumulative multiple payments; this is not a plain `payedSum` update and does not prove the feature or this exact UF mapping is enabled in the current portal. The observed UI mapping likewise is not evidence of writability.

Documented in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42). Issue #26 remains open.

## Q26.45 owner decision (2026-10-06)

The first production launch is centered on deals/customerorders and their required customers, products, responsible users, and directories. Invoice synchronization is deferred to later stages and is not a readiness blocker for that launch. Preserve Q26.12’s selected invoice entity scope for when that stage is introduced: Bitrix24 smart invoice `entityTypeId=31`, excluding legacy type 5. Keep the existing invoice tickets/research, including the type31 field map; this decision does not certify that map as runtime-verified. The invoice follow-up remains with #18. In #1, the invoice user story remains a later-stage capability rather than an initial-launch prerequisite.

Documented in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42). Issue #26 remains open.

## Q26.46–Q26.48 owner decisions (2026-10-06)

- Q26.46: B24 `UF_CRM_69491D49E57EE` (“Комментарий с сайта”) ↔ MySklad `shipmentAddressComment` is bidirectional and functionally optional; single-sided changes propagate, MySklad wins conflicts, and clearing follows Q26.9. Provenance is T03’s exact HTMLStudio UI mapping (2026-09-30), not a name inference. The 2026-09-29 journal shows a target B24 update but no round-trip/value-correctness proof. Property type and writability remain TBD.
- Q26.47: B24 `UF_CRM_1785419472892` (“Оплачено по эквайрингу”) ↔ CustomerOrder attribute `d5172d2c-8c1d-11f1-0a80-1af10010ed42` is a bidirectional, optional information field; MySklad wins conflicts. It does not create payments or change `payedSum`; API writability/transforms remain to verify.
- Q26.48: B24 `UF_CRM_1771483488` ↔ MySklad `vatEnabled`, and B24 product-row `taxRate` ↔ MySklad position `vat`, have desired bidirectional direction; propagate one-sided changes and resolve conflicts in favor of MySklad. Do not infer `vatIncluded` encoding, API writability/precision, a default VAT rate, or tax policy; verify these separately.

Documented in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42). Q26.46’s technical gaps and Q26.48 API/encoding details remain explicit; #26 remains open. Product-card price types, image scope, and the narrowly scoped money-total exception are now recorded as Q26.49–Q26.51; remaining technical checks are documented in the PR.

## Q26.49–Q26.51 owner decisions (2026-10-06)

- Q26.49: Catalog price types use explicit configurable MySklad price type ↔ Bitrix24 price type pairs. Do not auto-select by position, order, or name. Document-row prices are separate.
- Q26.50: Product-image exchange is deferred from v1; preserve existing images and do not delete them. Images are not a critical order-readiness dependency.
- Q26.51: Use MySklad data as the rounding reference for monetary order totals when available, with a narrow exception: for a B24-origin total change, if the final order total differs from current MySklad by at most RUB 0.01, preserve the B24 value and do not treat the residual as a significant mismatch/change, open manual review/error, or issue a corrective write solely for it. Keep both raw values and general event history; customerorder.sum remains read-only. This is not a per-row or other-currency tolerance, and must not mask quantity/product-link/other actual changes. Comparison/echo-loop algorithm remains technical TBD. Q26.37 otherwise remains in force.

Requirements and T26 are updated in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42). #26 remains open.

## Q26.49–Q26.51 owner decisions (2026-10-06)

- Q26.49: Catalog price types use explicit configurable MySklad price type ↔ Bitrix24 price type pairs. Do not auto-select by position, order, or name. Document-row prices are separate.
- Q26.50: Product-image exchange is deferred from v1; preserve existing images and do not delete them. Images are not a critical order-readiness dependency.
- Q26.51: Use MySklad data as the rounding reference for monetary order totals when available, with a narrow exception: for a B24-origin total change, if the final order total differs from current MySklad by at most RUB 0.01, preserve the B24 value and do not treat the residual as a significant mismatch/change, open manual review/error, or issue a corrective write solely for it. Keep both raw values and general event history; customerorder.sum remains read-only. This is not a per-row or other-currency tolerance, and must not mask quantity/product-link/other actual changes. Comparison/echo-loop algorithm remains technical TBD. Q26.37 otherwise remains in force.

Requirements and T26 are updated in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42). #26 remains open.

## Q26.52–Q26.53 owner decisions (2026-10-06)

- Q26.52: Product-card name and description have desired bidirectional direction; one-sided changes propagate and MySklad wins conflicts. Name is critical; description is functionally optional and does not block card exchange. HTML/plain-text conversion, exact API codes, and writability remain technical checks.
- Q26.53: If a required product/row unit of measure lacks a mapping, pause exchange of the entire affected order until configured, log the reason, and send it for manual review. The admin app must include a functional UOM-mapping section for both systems, with automatic matching and manual assignment/reassignment. Do not auto-create units or infer pack-to-piece factors; matching keys/precision and conversions remain TBD. Do not reuse the user-responsible alphabetical ambiguity rule for UOM.

The #10 settings/preview ticket, #15 product exchange ticket, and #16 deal/order consumer ticket are open and related; their acceptance criteria need UOM mapping UI, catalog-unit mapping, and whole-order readiness-gate coverage respectively. No new ticket is created here. Requirements and T26 are updated in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync); #26 remains open.

## Q26.52–Q26.53 owner decisions (2026-10-06)

- Q26.52: Product-card name and description have desired bidirectional direction; one-sided changes propagate and MySklad wins conflicts. Name is critical; description is functionally optional and does not block card exchange. HTML/plain-text conversion, exact API codes, and writability remain technical checks.
- Q26.53: If a required product/row unit of measure lacks a mapping, pause exchange of the entire affected order until configured, log the reason, and send it for manual review. The admin app must include a functional UOM-mapping section for both systems, with automatic matching and manual assignment/reassignment. Do not auto-create units or infer pack-to-piece factors; matching keys/precision and conversions remain TBD. Do not reuse the user-responsible alphabetical ambiguity rule for UOM.

Related open tickets needing acceptance-criteria coverage: #10 for the UOM mapping UI; #15 for product unit mapping; #16 for the order-wide consumer readiness gate. This note does not create new tickets. Requirements and T26 are updated in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync); #26 remains open.

## Q26.54–Q26.55 owner decisions (2026-10-06)

- Q26.54: The catalog price types configured as explicit pairs under Q26.49 are bidirectional; one-sided changes propagate and MySklad wins conflicts. This does not change separate product-row price rules Q26.23/.25.
- Q26.55: Do not sync catalog group/section hierarchies in v1. Preserve existing product group links; create new products in the configured default group of the target system. Group changes must not alter hard product pairs or cause duplicates. Do not choose group/default IDs for the owner; add the necessary target defaults to Required Inputs after metadata is available and owner values are supplied.

Requirements and T26 are updated in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42). #26 remains open.

## Q26.56–Q26.57 owner decisions (2026-10-06)

- Q26.56: Select only B24 `detailText` (“Детальное описание”) ↔ MySklad product/service `description`; bidirectional and optional per Q26.52. Do not pair or modify B24 `previewText`. HTML/plain-text encoding and exact API support remain technical TBD.
- Q26.57: First-release client exchange is limited to name/title, phones, email, required entity links, service pair IDs and duplicate exclusion under existing rules. Preserve existing legal/banking requisites without syncing/changing; defer exchange with the future invoice phase (#18). Do not make these requisites client-creation requirements based on this decision. Verify exact API mandatory constraints separately; Q26.57 does not establish API optionality.

Requirements and T26 are updated in [PR #42](https://github.com/Makskaii/bitrix-moysklad-sync/pull/42). Related acceptance criteria now clarify first-release scope while preserving future planned work in #12 (companies) and #28 (contacts). #26 remains open.

## Q26.58–Q26.61 owner decisions (2026-10-06)

- Q26.58: First-release product-card fields are limited to approved name, detail description, UOM, and explicitly configured catalog price types; operational pair IDs remain. Article, barcodes, weight, and other characteristics are deferred and preserved.
- Q26.59: Deal/order first-release scope is closed at the already-approved native core and discussed custom fields. Other unconfirmed fields are deferred; existing criticality, fallback, readiness, and conflict rules do not change.
- Q26.60: B24 service reference `UF_CRM_1766085949` ↔ MySklad customerorder attribute `0ad997c8-8e75-11e3-1ec9-002590a28eca` is bidirectional and optional; propagate single-sided changes and prefer MySklad on conflict. Reference only, not text copy/product row.
- Q26.61: B24 payment-method reference `UF_CRM_1766072752` ↔ MySklad customerorder attribute `f214f966-dc1a-11f0-0a80-0ef700278459` is bidirectional and optional; clear propagates; unmapped values skip/log only this field. Do not create payment documents or write `payedSum`.
- Value-pair inventory, transformations, and API support remain technical verification; decisions do not claim runtime proof.



## Q26.66–Q26.67 — launch уточнения

- Q26.66: сначала event-driven поиск/подтверждение пары и baseline для затронутой старой сделки/заказа; уникальная пара читается с обеих сторон до записи, неоднозначность — ручная проверка. Низкоскоростной фоновый #45 собирает исторические IDs и утверждённые ключи с checkpoint/resume и статистикой, но не делает full-field snapshots, не создаёт исторические записи/пары и не блокирует startup, readiness или первый обмен.
- Q26.66 не меняет приоритет МойСклад при первом состоянии/конфликте, правила дублей/эхо и запрет массового создания исторических записей. Ни фон, ни снимок не могут перезаписать существующую ручную/подтверждённую пару или более свежее runtime-состояние.
- Q26.67 включает подтверждённые soft-delete/restore flows для production v1: tombstone в БД, остановка обмена той же пары, B24-пометка только через согласованное/настроенное поле без выдумывания ID, подтверждённое восстановление снимает tombstone и продолжает ту же пару. Физическое удаление не выполняется.

## Comments

### Comment 1

T26 catalog reference decisions Q26.62–65 are recorded in [PR #44](https://github.com/Makskaii/bitrix-moysklad-sync/pull/44), commit [1bcb27e](https://github.com/Makskaii/bitrix-moysklad-sync/blob/1bcb27e38fc3e2e9f42fb73eaec300f61d763070/research/t26-field-mapping.md). This records 9 owner-approved UOM pairs, 3 intentionally unmapped B24 measures, 7 explicit catalog price-type pairs, and excluded/unpaired types to preserve. #26 remains open for broader field-map acceptance and technical row/API evidence; pair approval is not runtime persistence/write proof.




