# T26 — рабочая карта полей Bitrix24 ↔ МойСклад

Дата сводки: 2026-10-01. Статус: исследовательская карта с зафиксированными решениями владельца по части #26; не является утверждённой runtime-конфигурацией сервиса.

## Как читать карту

В документе различаются четыре вида утверждений:

- **Схема** — код, подпись и тип подтверждены официальной API-документацией или live-метаданными портала/аккаунта.
- **Настроено в HTMLStudio** — пара прочитана в UI 2026-09-30. Это подтверждает сохранённую настройку направления B24 → МойСклад, но не заполненность, успешность или полноту фактической передачи.
- **Наблюдалось** — ограниченная безопасная выборка/журнал подтверждает только указанный факт. Это не универсальная карта и не основание для автоматического выбора.
- **TBD** — нет достаточных доказательств направления, преобразования, обязательности или эквивалентности; требуется указанный способ проверки и/или решение владельца.

**Статус согласования:** владелец подтвердил часть продуктовых решений #26; они отмечены ниже как решения, а не как технически проверенные возможности API. Остальные направления, техническая записываемость, преобразования, критичность и отдельные scope-вопросы остаются TBD. Это локальный исследовательский inventory, не утверждённая runtime-карта. AC5 остаётся pending; не считать его выполненным.

### Подтверждённые решения владельца по #26

| Вопрос | Принятое решение | Оставшаяся техническая проверка/граница |
| --- | --- | --- |
| Q26.1 — пары контактов | Существующие жёсткие пары не менять. Новый контакт B24 при наличии связанной компании сопоставлять с `contactperson` у контрагента этой компании; без компании создавать отдельного контрагента. | Проверить запись соответствующих связей и объектов в API до реализации; существующие пары остаются авторитетными. |
| Q26.2 — несколько компаний | При нескольких компаниях использовать только явно выбранную основную компанию. Если primary не задана или её пара не найдена — ручная проверка, без угадывания. | Подтвердить источник primary в B24 и чтение полного списка связей для сценария. |
| Q26.3 — несколько телефонов/email | Передавать все значения в одно строковое поле МойСклад через разделитель. | Разделитель и обратное преобразование выбрать после технической проверки; конкретное значение не утверждено. |
| Q26.4 — ФИО, время и пары | ФИО собирать/разбирать автоматически согласно выбранному порядку частей; пользователь может вручную исправить ошибки в B24. Двусторонний конфликт разрешать по времени последних записей с секундной точностью; при равенстве сохранять значение МойСклад. Ручные правки считаются обычным изменением; переименование не меняет жёсткую пару. | Механизм защиты от эхо-событий/циклических записей требует технической проверки. |
| Q26.5 — порядок ФИО | `LAST_NAME NAME SECOND_NAME` («Фамилия Имя Отчество»), пропускать пустые части; существующие записи массово не переформатировать. | Проверить реализацию сборки/разбора, не менять старые значения массово. |
| Q26.6 — минимум данных нового контакта | Новый контакт можно создать только с ФИО, без телефона и email. Одно лишь полное имя не является основанием автоматически выбрать существующую пару. | Остальные правила поиска/выбора и критичность полей TBD. |
| Q26.7 — заказ | Scope первой версии включает все 16 существующих HTMLStudio custom mappings и уже согласованные стандартные поля. | Для каждого поля отдельно подтвердить направление и преобразование, включая возможность записи; read-only/computed свойства не считать автоматически двусторонними. |
| Q26.8 — номер заказа | MS `name` соответствует B24 `UF_CRM_1729757435964` («Номер заказа МС»); B24 `TITLE` — отдельное поле. | Направление, формат и техническая записываемость каждого поля проверить отдельно. |
| Q26.9 — очистка | Очистка необязательного синхронизируемого поля передаётся на другую сторону с приоритетом времени записи. | Правила очистки обязательных полей остаются TBD. |
| Q26.10 — отдельное поле «Услуги» | Синхронизировать только значение справочника `UF_CRM_1766085949` ↔ атрибут `customentity` заказа; отдельную текстовую копию названия услуги не создавать и в товарные позиции не превращать. | Технически подтвердить направление и преобразование самого справочного значения. |

**Граница полноты AC1 этой версии:** охват — (a) все 16 пар сделка→заказ, видимые в HTMLStudio, и все доступные стандартные header/position candidates для deal, smart invoice 31, customerorder и invoiceout; (b) все ключевые идентификационные/связные поля T01 контактов/компаний; (c) каталожные candidate fields и schema rows T02. Полные API-схемы не равны sync scope: пары, направление, преобразование и functional requiredness для каждого candidate определены только где прямо показаны, иначе TBD/out of scope до решения владельца. Таблицы ниже и приложения T01/T02/T03/T04 составляют документированный field inventory, а не утверждение, что каждый API property входит в синхронизацию. Не выведенные в новую карту стандартные поля API не считаются mapping. Наличие поля в схеме само по себе не включает его в обмен. API `MANDATORY=N` не равна функциональной обязательности. Критичные поля/связи остаются TBD согласно Q75/requirements.md.

| First-version entity pair | Field coverage in this report | Explicitly not inferred |
| --- | --- | --- |
| B24 contact ↔ MS counterparty/contactperson | T01 identifier fields, names, phone/email, contact-company relations, UUID/origin/duplicate flags; Q26.1–Q26.6 define the selected new-contact model and data rules | Other portal UF absent from T01 catalog; field directions/writability and technical transforms still require verification |
| B24 company ↔ MS counterparty | T01 title, phone/email, contact relation, UUID/origin/duplicate flags | Other portal UF absent from T01 catalog; no field directions or global key claim |
| B24 deal ↔ MS customerorder | All 16 observed HTMLStudio custom mappings plus already-agreed standard fields are in first-version scope | Per-field directions, transforms, and writability require technical confirmation; read-only/computed properties are not presumed bidirectional; no inferred state IDs/triggers or mandatory set |
| B24 smart invoice 31 ↔ MS invoiceout | Schema-relevant header/relationship candidates; invoice position schema; three UI status pairs in T03 | Legacy invoice type 5 inclusion, unmapped fields, links/directions/mandatory set TBD |
| B24 catalog product/service ↔ MS product/service/variant | Full 54 B24 catalog fields enumerated below; complete MS standard product/service fields and custom attribute schema inventory referenced from T02; product-row fields fully enumerated above | No product-card directions/allowlist or global `property108` rule; exact MS product attribute pairings TBD |
| Deal service reference ↔ customerorder custom attribute | Exact B24 UF/list ↔ MS attribute/dictionary pair separated from product positions | Reverse direction and reference-value transformation require technical confirmation; Q26.10 fixes the text-copy decision: no separate copy |
| Reference values (employees, stores, organizations, currency, states, customentity values) | Candidate object field codes/types and all available observed links in T03/T04 | No universal value map, missing-item policy, or entity-specific functional requiredness is asserted |

## Сводка сущностей и доказательств направлений

| Сущность первой версии | Подтверждённая схема/настройка | Что доказано о направлении | Главные границы |
| --- | --- | --- | --- |
| Контакт B24 ↔ контрагент или контактное лицо МойСклад | T01 подтвердил поля-кандидаты и ограниченные соответствия UUID; Q26.1 выбрал модель новых контактов по primary company | Правила для новых контактов согласованы; field directions/writability и echo prevention требуют технической проверки | Существующие жёсткие пары не менять; выбор объекта новых записей не меняет этот ключ |
| Компания B24 ↔ контрагент МойСклад | T01 подтвердил поля-кандидаты и 6/6 UUID→`counterparty.id` в малой выборке | Направления конкретных полей и текущий поток не установлены | Малая смещённая выборка; нет полной карты пар/конфликтов |
| Сделка B24 ↔ заказ `customerorder` | 16 custom pairs прочитаны в UI HTMLStudio; Q26.7 включает их и согласованные стандартные поля в scope первой версии | UI-настройки показывают B24 → МС; направления/трансформации каждой пары и writable свойства требуют отдельной технической проверки | Read-only/computed свойства не становятся двусторонними по умолчанию; функциональная обязательность TBD |
| Smart invoice B24 (`entityTypeId=31`) ↔ `invoiceout` | Наблюдалась одна цепочка через `invoiceout.customerOrder`, UUID сделки и `parentId2`/`xmlId`; таблица дополнительных полей HTMLStudio для счетов пуста | `exportInvoice=1`, `importInvoice=1`; field-level mapping не установлен | Тип 31 наблюдался; legacy invoice тип 5 нельзя считать отсутствующим; `xmlId` как постоянное правило не утверждён |
| Товары/услуги каталога и строки документов | B24 `property108` совпал с UUID ассортимента МС в 13 строках; видимые UI строки заказов передают признак «Товары» | Для UI-мэппинга товара отдельного направления передачи конкретных полей не доказано | Ключ `property108` только кандидат; цены, количество, модификации и прочие поля не картированы |
| Поле-справочник «Услуги» сделки/заказа | B24 поле `UF_CRM_1766085949` ↔ атрибут заказа МС `0ad997c8-8e75-11e3-1ec9-002590a28eca`, справочник `f0177126-8e74-11e3-b761-002590a28eca` | Эта пара видна в настройках B24 → МС и в журнале обновления сделки B24; причинность/обратное направление не доказаны | Решение Q26.10: передаётся только справочное значение; без текстовой копии и независимо от строк товаров |
| Связанные справочники: сотрудники, склады, организации, валюты, значения | Источники и часть списков/кандидатов прочитаны T03/T04 | В T03 есть настройки заказа `store`/`organization`; общего field-level потока значений нет | Большинство пар — кандидаты по `CODE=UUID`, но не подтверждены как универсальные/обязательные |

## Контакты и компании

T01 — каталог полей для идентификации/поиска кандидатов, не настройка обмена. API-подписи B24 для известных полей подтверждены live schema; у пользовательских UUID/дублей title равен коду UF, портальные подписи пустые. Имена и значения записей в этой карте не приводятся.

| Сущность | Bitrix24: код — title — тип | МойСклад: код — название API/SDK — тип | Направление | Преобразование/связь | Обязательность | Статус и следующий шаг |
| --- | --- | --- | --- | --- | --- | --- |
| Контакт | `NAME` — Имя — `string`; `SECOND_NAME` — Отчество — `string`; `LAST_NAME` — Фамилия — `string` | `name` — Наименование — `string` у `counterparty`; `name` — Имя — `string` у `contactperson` | Направления отдельно подтвердить технически | Автосборка/разбор `LAST_NAME NAME SECOND_NAME`, пустые части пропускаются; новое лицо с одним ФИО допустимо. Существующие пары не меняются при переименовании; fullname-alone не выбирает пару | TBD; mandatory-clearing TBD | Решение Q26.1, Q26.4–Q26.6; проверить формат/запись и защиту от эхо-событий |
| Контакт | `PHONE` — Телефон — множественное `crm_multifield` | `phone` — Телефон — `string` у `counterparty` и `contactperson` | Направления отдельно подтвердить технически | Все значения в одной строке МС через разделитель; разделитель и обратное преобразование TBD | TBD; mandatory-clearing TBD | Решение Q26.3; выбрать формат после технической проверки |
| Контакт | `EMAIL` — E-mail — множественное `crm_multifield` | `email` — E-mail — `string` у `counterparty` и `contactperson` | Направления отдельно подтвердить технически | Все значения в одной строке МС через разделитель; разделитель и обратное преобразование TBD | TBD; mandatory-clearing TBD | Решение Q26.3; выбрать формат после технической проверки |
| Контакт → компания | `COMPANY_ID` — Компания — `crm_company`; `COMPANY_IDS` — Компании — `crm_company` (множественное) | `agent` — Контрагент/родитель — ссылка `object` у `contactperson`; `contactpersons` — Контактные лица — коллекция у `counterparty` | Primary company → `contactperson` контрагента; без компании — standalone `counterparty` | При нескольких компаниях использовать явно выбранную основную; если primary не определена или не сопоставлена — ручная проверка без угадывания | TBD | Решения Q26.1–Q26.2; технически проверить источник primary и запись links |
| Контакт: идентификатор пары | `UF_CRM_1719834658` — title совпадает с кодом, назначение проекта «UUID» — одиночный `string` | `id` — ID — UUID (`string`) у `counterparty` **или** `contactperson` | Не объявлять синхронизируемым; направление сохранения UUID TBD | Сравнение UUID-формы без преобразования — кандидат на ключ жёсткой пары | TBD | В малой выборке UUID указывал на `counterparty.id` 4/6 и `contactperson.id` 2/6. Жёсткие существующие пары не менять; правила UUID для новых связей и более широкая проверка остаются TBD |
| Контакт: внешний ключ | `ORIGINATOR_ID` — Внешний источник — `string`; `ORIGIN_ID` — Идентификатор элемента во внешнем источнике — `string`; `ORIGIN_VERSION` — Версия оригинала — `string` | `syncId` — ID синхронизации — UUID (`string`); `code` — Код — `string`; `externalCode` — Внешний код — `string` | TBD | Не равнять между собой: разные понятия/коды; кандидатные ключи нужно сравнить с существующей UUID UF | TBD | Типы подтверждены T01, но широкого live-сопоставления и активной настройки нет; проверить уникальность и заполненность |
| Контакт: флаг исключённой связи | `UF_CRM_1789126649744` — title совпадает с кодом, проектная подпись «Дубль» — одиночный `string` | Соответствующего поля синхронизации нет | Не передавать в МС по текущему требованию | Значение `Дубль` исключает только связь этой B24 записи; оригинал остаётся активным | Условие обработки уже утверждено; не поле готовности | Портальное поле и точное неперсональное значение проверены T01; это служебное условие пары, не карта контрагентского атрибута |
| Компания | `TITLE` — Название компании — `string` | `name` — Наименование — `string` у `counterparty` | TBD в обоих направлениях | Возможное прямое строковое отображение; правило сравнения/нормализации и записи не утверждено | TBD | Схемы подтверждены T01; 6/6 малой выборки UUID совпали с counterparty, но это не определяет поле или поток |
| Компания | `PHONE` — Телефон — множественное `crm_multifield` | `phone` — Телефон — `string` | TBD в обоих направлениях | Выбор одного/нескольких телефонов и формат TBD | TBD | См. T01; телефон не давал кандидата в 5/6 компаний выборки |
| Компания | `EMAIL` — E-mail — множественное `crm_multifield` | `email` — E-mail — `string` | TBD в обоих направлениях | Выбор одного/нескольких email TBD | TBD | См. T01; малые кандидаты не устанавливают правила |
| Компания → контакт | `CONTACT_ID` — Контакт — `crm_contact` (множественная связь) | `contactpersons` — Контактные лица — коллекция ссылок; `agent` — Контрагент — parent link у contactperson | TBD | Связь может иметь разную кардинальность; соответствие конкретных B24 контактов contactpersons не доказано | TBD | Проверить полный список связей B24 и contactpersons в МС; не смешивать с самостоятельной парой компании↔контрагент |
| Компания: идентификатор пары | `UF_CRM_1719834633` — title совпадает с кодом, назначение проекта «UUID» — одиночный `string` | `id` — ID — UUID (`string`) у `counterparty` | Не объявлять синхронизируемым; направление сохранения UUID TBD | Сравнение UUID-формы без преобразования — кандидат на ключ пары | TBD | В малой выборке совпал с `counterparty.id` 6/6; глобальная уникальность/все пары не установлены |
| Компания: внешний ключ | `ORIGINATOR_ID` — Внешний источник — `string`; `ORIGIN_ID` — Идентификатор элемента во внешнем источнике — `string`; `ORIGIN_VERSION` — Версия оригинала — `string` | `syncId` — ID синхронизации — UUID (`string`); `code` — Код — `string`; `externalCode` — Внешний код — `string` | TBD | Кандидаты, не эквивалентности | TBD | Не использовать как ключ без проверки по всей карте пар |
| Компания: флаг исключённой связи | `UF_CRM_1789126724375` — title совпадает с кодом, проектная подпись «Дубль» — одиночный `string` | Соответствующего поля синхронизации нет | Не передавать в МС по текущему требованию | Исключается только связь помеченной B24 компании | Условие обработки утверждено; не поле готовности | Портальное поле/значение проверены T01; поведение задаёт requirements.md |

Для `counterparty.companyType` T01 подтвердил API тип enum (JSON `string`) и варианты, включающие `legal`, `entrepreneur`, `individual`; преобразование к типу B24 контакта/компании и направления TBD. Не использовать `companyType` как доказательство готовой классификации записей.

## Сделка и заказ покупателя

### 16 строк настройки HTMLStudio: сделка B24 → заказ МойСклад

Перечень ниже целиком прочитан в таблице настройки HTMLStudio 2026-09-30. В каждом ряду указано **только** наблюдавшееся направление конфигурации B24 → МС. Типы/имена атрибутов МС — из live metadata `customerorder` T03, если это `attribute`; стандартные поля опознаны по API. Текущий поток МС → B24 не подтверждён отдельно для каждого поля.

| Bitrix24: поле UI — код — type | МойСклад: поле UI/API — код — type | Направление | Преобразование/связь значений | Обязательность | Основание / что выяснить |
| --- | --- | --- | --- | --- | --- |
| Адрес доставки — `UF_CRM_6926D80233F92` — API title=код; `string`, single, metadata mandatory=N | Адрес доставки — `shipmentAddress` — `String` | Настроено B24 → МС | Прямая адресная строка предполагается UI-парой; формат/разложение TBD | Functional TBD | UI mapping T03; схема UF получена новым schema-only запросом; стандартное поле по CustomerOrder SDK |
| Трек-номер — `UF_CRM_1729757856892` — API title=код; `string`, single, metadata mandatory=N | Трек номер — attribute `f7a9c2df-47f9-11ef-0a80-0c0c00322096` — `text` | Настроено B24 → МС | Кандидат string↔text; проверить длину/формат | Functional TBD | UI + customerorder metadata T03; фактическое API name — «Трек номер» |
| Плановая дата получения — `UF_CRM_1730384262074` — API title=код; `date`, single, metadata mandatory=N | Дата доставки — attribute `74960544-9c3d-11ef-0a80-17ac0027f1c3` — `time` | Настроено B24 → МС | Представление даты/часовой пояс TBD | Functional TBD | Новая UF schema + customerorder metadata T03 |
| Склад — `UF_CRM_1732004209` — API title=код; `iblock_element`, single, metadata mandatory=N, IBLOCK_ID=38 | Склад — `store` — `Store` object | Настроено B24 → МС | B24 list `rest_entity` 38: кандидат `CODE=UUID` ↔ store ID; не складской учёт B24 | Functional TBD | Новая UF schema, UI/T04; 23/23 кандидатов в ограниченной выборке; per-order usage TBD |
| Способ оплаты — `UF_CRM_1766072752` — API title=код; `iblock_element`, single, metadata mandatory=N, IBLOCK_ID=44 | Способ оплаты. — attribute `f214f966-dc1a-11f0-0a80-0ef700278459` — `customentity` | Настроено B24 → МС | Соответствия значений списков TBD | Functional TBD | Новая UF schema + customerorder metadata; ID списка 44 получен новым schema query, значения не читались |
| Услуги — `UF_CRM_1766085949` — `iblock_element` | Услуги — attribute `0ad997c8-8e75-11e3-1ec9-002590a28eca` — `customentity`; справочник `f0177126-8e74-11e3-b761-002590a28eca` | Настроено B24 → МС; в журнале наблюдалось целевое обновление сделки B24 | `CODE` элемента B24 ↔ UUID значения справочника МС наблюдалось в 5 значениях; синхронизируется только справочное значение, без текстовой копии и без product position | TBD | Решение Q26.10; направление и преобразование самого значения требуют технической проверки; не смешивать с product rows |
| Организация — `UF_CRM_1776347243` — API title=код; `iblock_element`, single, metadata mandatory=N, IBLOCK_ID=88 | Организация — `organization` — `Organization` object | Настроено B24 → МС | B24 list `rest_entity` 88: кандидат `CODE=UUID` ↔ organization ID | Functional TBD | Новая UF schema, UI/T04; 8/8 кандидатных совпадений в выборке; per-order usage TBD |
| Номер заказа МС — `UF_CRM_1729757435964` — API title=код; `string`, single, metadata mandatory=N | Наименование заказа — `name` — `String` | Scope пары согласован; настройка HTMLStudio наблюдалась B24 → МС | MS `name` ↔ B24 `UF_CRM_1729757435964` («Номер заказа МС»); B24 `TITLE` независимо | Functional TBD | Решение Q26.7–Q26.8; направления/формат и writable/read-only свойства проверить технически |
| Учитывать НДС — `UF_CRM_1771483488` — API title=код; `boolean`, single, metadata mandatory=N | Учитывать НДС — `vatEnabled` — `Boolean` | Настроено B24 → МС | Boolean↔boolean возможно; конкретные значения и обратная запись TBD | Functional TBD | Новая UF schema + customerorder SDK model |
| Сумма оплаты — `UF_CRM_1782196830070` — API title=код; `double`, single, metadata mandatory=N | Оплачено — `payedSum` — `Double` | Настроено B24 → МС | Валюта/точность/агрегирование платежей TBD | Functional TBD | Новая UF schema + customerorder SDK model |
| Комментарий с сайта — `UF_CRM_69491D49E57EE` — API title=код; `string`, single, metadata mandatory=N | Комментарий адреса доставки — `shipmentAddressComment` — **type TBD** | Настроено B24 → МС | Семантическая эквивалентность TBD | Functional TBD | UI mapping T03; поле отсутствует в опубликованной модели CustomerOrder SDK, live стандартная field schema не получена |
| Адрес СДЭК — `UF_CRM_1769687298` — API title=код; `string`, single, metadata mandatory=N | Адрес доставки — attribute `423e297a-7feb-11ef-0a80-0e7e002e09ff` — `text` | Настроено B24 → МС | Адресное значение; формат/многострочность TBD | Functional TBD | Новая UF schema + customerorder metadata T03 |
| Стоимость доставки ТЕХ — `UF_CRM_1771399978` — API title=код; `double`, single, metadata mandatory=N | Стоимость доставки — attribute `765c7a65-9c3d-11ef-0a80-036a00277c8f` — `double` | Настроено B24 → МС | Валюта/точность/налог TBD | Functional TBD | Новая UF schema + customerorder metadata T03 |
| Скидка. — `UF_CRM_1771501013` — API title=код; `double`, single, metadata mandatory=N | Скидка покупателя — attribute `0c42242c-1f28-11ef-0a80-0666005fec51` — `double` | Настроено B24 → МС | Процент или сумма и база расчёта TBD | Functional TBD | Новая UF schema + customerorder metadata T03 |
| Купон — `UF_CRM_1770062820` — API title=код; `string`, single, metadata mandatory=N | Промокод — attribute `4a432000-0785-11f1-0a80-1b1000018578` — `string` | Настроено B24 → МС | String↔string; нормализация TBD | Functional TBD | UI label «Купон», фактическое API name атрибута «Промокод» (T03) |
| Оплачено по эквайрингу — `UF_CRM_1785419472892` — API title=код; `string`, single, metadata mandatory=N | Оплачено по эквайрингу — attribute `d5172d2c-8c1d-11f1-0a80-1af10010ed42` — `string` | Настроено B24 → МС | Семантика/формат строки TBD | Functional TBD | Новая UF schema + customerorder metadata T03 |

Новая schema-only сверка B24: `crm.deal.userfield.list` (17 выбранных UF), `crm.deal.fields` (143 поля, релевантные code/title/type), `crm.item.fields(entityTypeId=31,useOriginalUfNames=Y)` (140 полей smart invoice), `crm.item.productrow.fields` (22 поля) и `catalog.product.getFieldsByFilter(filter.iblockId=14)` (54 поля). UF userfield title labels были пустыми, API title в `crm.deal.fields` у UF равен коду. Для всех 17 UF `MULTIPLE=N`, `MANDATORY=N`; эти технические значения не определяют функциональную критичность.

### Документ, позиции и связи заказа

| Объект/связь | Bitrix24: код — title — type | МойСклад: код — name — type | Направление и преобразование | Обязательность / статус |
| --- | --- | --- | --- | --- |
| ID/пара сделки-заказа | `UF_CRM_1719836973` — title равен коду — `string`, одиночное (на одной сделке) | `id` — ID — UUID `string`; имя/номер `name` — Наименование заказа — `String` | В одном примере UF содержало UUID заказа; причинность записи поля не доказана. UUID является ключом пары в этом примере, не доказанным сквозным mapping-полем | Функционально обязательная связь пары в примере; глобальная применимость UF и write direction TBD |
| Заголовок | `TITLE` — Название — `string` | `name` — Наименование — `String` | UI поле `name` отдельно настроено через UF «Номер заказа МС»; TITLE↔name как отдельная пара не наблюдалась | TBD |
| Компания/контрагент | `COMPANY_ID` — Компания — `crm_company` | `agent` — Контрагент — ссылка `Agent` (в примере `counterparty`) | В одном заказе UUID связанной B24 компании совпал с `agent.id`; автоматическое полевая карта и направление не установлены | Проверить type/key и требуется ли для каждой сделки; TBD |
| Контакты | `CONTACT_ID` — Контакт — `crm_contact`; `CONTACT_IDS` — Контакты — `crm_contact` | `agent`/`contactpersons` — связи объекта `Agent` и его contactpersons; заказ сам не предоставляет доказанное прямое поле контактного лица в выборке | Однозначная связь не установлена; в двух примерах B24 контакты пусты | TBD; сверить обе стороны на наполненных заказах |
| Ответственный/владелец | `ASSIGNED_BY_ID` — Ответственный — `user` | `owner` — Владелец (сотрудник) — `Employee` object | T04 не нашёл утверждённую пару ID; в проверенной цепочке имена/внешний код не совпали | Functional TBD; требуется выбор/проверка таблицы Employees mapping |
| Стадия/статус | `STAGE_ID` — Стадия сделки — `crm_status`; портал имеет 18 статусов `DEAL_STAGE` (коды перечислены в T03) | `state` — Статус заказа — `State` object | UI содержит 16 выбранных пар стадий/статусов; направление входа/выхода флагами не задаётся как field mapping; коды статусов МС для всех пар не собраны | Текущая UI-конфигурация наблюдалась, не утверждённый триггер сервиса. Решение по значениям/готовности TBD |
| Валюта | `CURRENCY_ID` — Валюта — `crm_currency` | `rate.currency` — Валюта курса — часть объекта `CurrencyRate` (`currency` — ссылка Currency) | Возможный mapping код/ссылка; направление и value-map TBD | Functional TBD; фактический order currency не выводится из наличия поля |
| Сумма | `OPPORTUNITY` — Сумма — `double` | `sum` — Сумма заказа в установленной валюте — `Double` (read-only); `payedSum` — Сумма входящих платежей — `Double` (read-only) | Три значения имеют разную семантику; active mapping только `payedSum` из UF в отдельной таблице. `sum` не считать write-target без подтверждения | Functional TBD |
| Строки товаров | `crm.deal.productrows.get`/`crm.item.productrow.*`; товар `catalog.product` (ID `integer`, name/code/xmlId `string`, `property108` `productproperty`) | `positions` — Позиции — `CustomerOrderPositionList`; строка содержит ссылку `assortment` на `product`/`service`/`variant` | В 13 строках `property108` ровно один раз совпало с UUID assortment. Направление состава, поля количества/цены/скидки/единицы и преобразования неизвестны | Для данного сервиса обязательная позиция не может остаться неготовой: весь заказ блокируется по approved requirements. Как обязательные поля строки TBD |
| Товар/ассортимент: ключ | B24 `property108` — «Товары UUID» — `productproperty` (каталог ID 14 по выборочному запросу) | `id` — ID — UUID `string` для `product`, `service`, `variant` | Наблюдавшееся сравнение B24 свойства с ID ассортиментного объекта; не доказывает уникальность/заполненность вне 100 элементов и 13 строк | Кандидат пары, не активная конфигурация. Проверить весь каталог на дубли/пустые/разные типы |
| Склад/организация | UF сделки из таблицы выше (`rest_entity` list 38/88, точные B24 types TBD) | `store`/`organization` — ссылки на Store/Organization | `CODE=UUID` кандидаты; в 4 связанных парах T02 совпадения наблюдались. Не равнять list 38 со складским API B24 | Проверить документы и все значения; required TBD |
| Отдельное поле «Услуги» | Строка отдельной таблицы выше | Отдельный customerorder attribute | Значение списка не является `positions`; в одной проверенной паре одновременно были товарные строки и значение поля услуги | Проверенный владелец считает пару нужной; обязательность и оба направления всё ещё TBD |

Текущая настройка стадий заказа содержит 16 строк (названия B24 → подписи состояний МС): Новый→принят; Обработан→обработан; Комплектация→комплектация; Согласован→согласован; Подтвержден→подтвержден; Завершено→выполнен; Не успешно→отменен; Передан на сборку→Передан на сборку; На сборке→На сборке; Собран без расхождений→Собран без расхождений; Собран с расхождениями→Собран с расхождениями; Частично укомплектован→Частично укомплектован; Готов к выдаче→Готов к выдаче; Передан на доставку→Передан на доставку; Доставлено→Доставлен; Отменен покупателем→Отменен. UI также показывал для каждой строки переключатели резервирования, отгрузки, оплаты и товаров; флаги приведены в T03. Названия статусов МС нельзя без live-ссылок превратить в UUID/ID состояния.

## Счета

В T03 наблюдалась одна цепочка `invoiceout → customerOrder → B24 deal → smart invoice entityTypeId=31`. В той цепочке `invoiceout.customerOrder` ссылался на заказ, `parentId2` — на сделку, а `xmlId` smart invoice совпал с ID `invoiceout`. Это единичное подтверждение существующей связи, не универсальное правило записи ID. Первая страница smart invoices содержала записи типа 31; legacy type 5 не доказан как отсутствующий глобально. В UI HTMLStudio активны оба направления счетов, таблица дополнительных полей счета пуста, настроены только три статуса.

| Связь/поле | Bitrix24: код — title — type | МойСклад: код — название — type | Направление/преобразование | Обязательность и статус |
| --- | --- | --- | --- | --- |
| Тип объекта B24 | `entityTypeId=31` — smart invoice; схема включает `id`, `title`, `accountNumber`, `stageId`, `categoryId`, `companyId`, `contactIds`, `assignedById`, `parentId2`, `begindate`, `closedate`, `opportunity`, `currencyId` с типами в T03 | `invoiceout` | Текущий образец типа 31; legacy type 5 API `crm.invoice.*` документирован, использование глобально TBD | Владелец должен подтвердить целевой тип для всей карты/новых счетов |
| Идентификатор пары счета | `xmlId` — Внешний код — `string` (31); `UF_CRM_67332F00DD696` — «Сделка UUID» — `string` (31), candidate field | `id` — ID — UUID `string` | В одном примере `xmlId == invoiceout.id`; пользовательское поле «Сделка UUID» не подтверждено как ID счета | Запись/направление и обязательность TBD; проверить несколько legacy/новых счетов и UI mapping |
| Связь со сделкой | `parentId2` — Сделка — `crm_entity` | Через `invoiceout.customerOrder` к заказу, затем сделка↔заказ | В одной цепочке `parentId2` ссылался на ту же сделку, а `customerOrder` на заказ; прямое эквивалентное поле на MS не установлено | Не делать прямую запись без правила владельца; проверить полные связи на выборке |
| Номер/название | `accountNumber` — Номер счёта — `string`; `title` — Название — `string` | `name` — Наименование счёта — `String` | Отдельное значение для этих полей в таблице UI не настроено/не наблюдалось | TBD |
| Компания/контрагент | `companyId` — Компания — `crm_company`; `contactId` — Контакт — `crm_contact`; `contactIds` — Контакты — `crm_contact`; `assignedById` — Ответственный — `user` | `agent` — Контрагент — `Agent`; `owner` — Владелец — `Employee` | Схемы объектов существуют, сопоставления пользователей/контрагентов не утверждены | TBD; проверить разнообразные записи и справочные пары |
| Статус | `stageId` — Стадия — `crm_status` | `state` — Статус — `State` | HTMLStudio UI: «Отправлен клиенту»→«отправлен», «Оплачен»→«договор+», «Новый»→«Новый» | UI наблюдение; ID значений, направление и правило будущего сервиса TBD |
| Строки счёта | `crm.item.productrow.*`, `ownerType=SI` | `positions` — Позиции — `InvoiceOutPositionList` | В одной цепочке обе стороны имели по одной строке с одинаковой ссылкой на ассортимент и количеством; field mapping цены/количества/НДС не исследован | Требуется отдельная выборка; состав и все critical поля TBD |
| Сумма/валюта/даты | `opportunity` — Сумма — `double`; `currencyId` — Валюта — `crm_currency`; `begindate` — Дата выставления — `date`; `closedate` — Срок оплаты — `date` | Документ `invoiceout` поддерживает стандартные свойства суммы/валюты/дат; точный текущий field mapping не наблюдался | TBD; не выводить по названию/API | TBD, владелец выбирает даты/валютный источник и правила округления |
| Счёт ↔ заказ | B24 smart invoice связана с deal через `parentId2`; в sample строка product row совпала с deal | `customerOrder` — Заказ покупателя — `CustomerOrder` | В T03 у одной пары `expand=invoicesOut` вернул 0; другой точечный связанный счет найден через выборку. Полная кратность неизвестна | Проверить 1:N и правила создания; не считать поле обязательным до решения |

T03 сообщает: `invoiceout` имеет live `customerOrder` и `invoicesOut`/`customerOrder` в моделях API; у `invoiceout` custom attributes в полученном metadata были 0. Это не значит, что у документа нет стандартных полей. В smart-invoice UI нет таблицы дополнительных полей; следовательно, отображения имени/суммы/компании/ответственного за пределами системных полей остаются TBD.

## Товары, услуги и модификации

### Строки товаров отдельно от справочника услуг

T02 подтверждает, что B24 `property108` («Товары UUID», API тип `productproperty`) совпадал с UUID assortment в 13 строках четырёх связанных заказов; одна строка МС была типа `service`, остальные 12 — `product`. В одном заказе присутствовали одновременно товарные позиции и отдельное значение поля «Услуги». Поэтому `property108`/`positions.assortment` и `UF_CRM_1766085949`/customentity атрибут — разные отношения.

| Сущность/поле | Bitrix24: код — title — type | МойСклад: код — название — type | Направление/преобразование | Обязательность / статус |
| --- | --- | --- | --- | --- |
| Каталожная запись: ID | `id` — Идентификатор — `integer` | `id` — Идентификатор — UUID `string` | Не является sync mapping; служебный ID каждой системы | Обязательность записи — система; поле готовности TBD |
| Название | `name` — Наименование — `string` | `name` — Наименование — `string` | UI field mapping товара не найден; сравнение названия символ в символ требуется только в описанном сценарии поиска дубля товара | Direction/required mapping TBD |
| Ключ кандидата | `property108` — Товары UUID — `productproperty` | `id` — ID ассортиментного объекта — UUID `string` | Наблюдаемое содержимое property108 сопоставлялось с ID `product`, `service` или `variant` в 13 строках; rule of value conversion appears UUID but not global validation | Кандидат, не утверждённый mapping; проверять покрытие/дубли по полному каталогу |
| Доп. ключи | `code` — Символьный код — `string`; `xmlId` — Внешний код — `string` | `code` — Код товара/услуги — `string`; `externalCode` — Внешний код — `string`; `syncId` — ID синхронизации — `string` | Нет наблюдаемого соответствия. Не считать xmlId равным ID: 13 строк не совпали по `xmlId` со ссылкой позиции | TBD |
| Описание | `detailText` — Описание — `string`; `previewText` — Описание для анонса — `string` | `description` — Описание — `string` | Не включено в подтверждённый mapping | TBD |
| Цена | `catalog.price.*` — фактическая схема и title должны быть получены для каталога — API representation TBD | `salePrices`/`buyPrice`/`minPrice` — Цены — array/object (SDK model) | Валюта, тип цены, скидка, налог и направление не установлены | TBD; проверить портальные price types и репрезентативные позиции |
| НДС | `vatId` — Идентификатор НДС — `integer`; `vatIncluded` — НДС включён — `char` (T02 catalog schema) | `vat`, `vatEnabled`, `effectiveVat`, `effectiveVatEnabled` — НДС — integer/number/boolean по модели SDK | Возможные разные модели; нет поля mapping/конверсии | TBD |
| Единицы/количество/вес | `measure` — Единица измерения — `integer`; `quantity`, `quantityReserved` — double; `weight`, `width`, `height`, `length` — double в live catalog schema T02 | `uom` — Единица измерения — object; `weight` — number; `volume` — number | Позиционная quantity отдельно от остатка; стандартизованная мера/округление не установлены | TBD; складской учёт B24 не включается |
| Изображения | `detailPicture`, `previewPicture` — Картинки — `file`; T02 schema | `images` — Изображения — object; SDK product; карточка service могла не содержать это свойство | Бинарные файлы не запрашивались; mapping нет | Функциональная обязательность TBD |
| Группа/категория | `iblockSection`, `iblockSectionId` — Разделы — `list`/`integer`; `iblockId` — инфоблок — `integer` | `productFolder` — группа каталога — object; `pathName` — наименование группы — string | Конкретные разделы и соответствия не установлены | TBD |
| Тип/вариации | `type` — Тип товара — `integer`; каталог предоставляет услуги/наборы/вариации (точные типы см. API/T02) | `product`, `service`, `variant` — разные типы assortment; product SDK содержит `variantsCount` | Типы B24↔МС и модификация к варианту не сопоставлены | TBD; сверить виды каталога и типы реально используемых документов |
| Строка сделки/заказа | B24 `crm.item.productrow.*`; полная доступная схема ниже | `positions` — позиции заказа/счёта; доступные поля моделей ниже | Кандидатные аналоги не означают утверждённый field mapping; 13 UUID-связей — ограниченная выборка | Неподготовленная обязательная позиция блокирует заказ по requirements; функциональная обязательность полей строки TBD |

#### Доступные схемы строк заказа и счёта (полная таблица кандидатов)

Bitrix24 `crm.item.productrow.fields` вернул 22 поля. `required` ниже — требование API создания строки, не критичность/обязательность синхронизации. У МойСклад схемы строк подтверждены моделями официального SDK (не live-проекцией конкретных документов). Сопоставления в последнем столбце — только типо-семантические кандидаты; направления и функциональная обязательность каждого поля TBD.

| Роль | Bitrix24 code — API title — type | МойСклад customerorder position: code — API name — type | МойСклад invoiceout position: code — API name — type | Кандидат/граница |
| --- | --- | --- | --- | --- |
| Строка ID | `id` — ID — integer (read-only) | `id` — ID — UUID | `id` — ID — UUID | Системный идентификатор, не переносить без правила |
| Владелец ID | `ownerId` — ID владельца — integer (required, immutable) | — | — | MS позиция вложена в документ; эквивалентного scalar owner field не указан в SDK модели |
| Тип владельца | `ownerType` — Тип владельца — string (required, immutable) | — | — | B24 discriminator; не переносить |
| Товар/ассортимент ID | `productId` — Товар — integer (required) | `assortment` — Ассортимент — `ProductMarker` object | `assortment` — Ассортимент — `Assortment` object | B24 `productproperty` `property108` → MS UUID `assortment.id` наблюдалось на 13 строках; не эквивалент `productId` без lookup |
| Название товара | `productName` — Название товара — string | `assortment` — Ассортимент — object reference | `assortment` — Ассортимент — object reference | Отдельного позиции `name` в моделях строки нет; name читается у связанного assortment |
| Цена | `price` — Цена — double | `price` — Цена — Double | `price` — Цена — Double | MS сумма хранится в minor currency units по API; точный пересчёт/округление для B24 TBD |
| Цена без налога со скидкой | `priceExclusive` — Цена без налога со скидкой — double (read-only) | `price` — Цена — Double | `price` — Цена — Double | Прямой эквивалент не доказан; B24 derived value |
| Цена NETTO | `priceNetto` — PRICE_NETTO — double (read-only) | `price` — Цена — Double | `price` — Цена — Double | UI title буквальный API title; семантический mapping TBD |
| Цена BRUTTO | `priceBrutto` — PRICE_BRUTTO — double (read-only) | `price` — Цена — Double | `price` — Цена — Double | UI title буквальный API title; семантический mapping TBD |
| Количество | `quantity` — Количество — double | `quantity` — Количество — Double | `quantity` — Количество — Double | Наименование/тип совпадает; направление/точность TBD |
| Вид скидки | `discountTypeId` — Тип скидки — integer | `discount` — Скидка — Double (%) | `discount` — Скидка — Double (%) | Сопоставление кодов/процентов не установлено |
| Скидка % | `discountRate` — Величина скидки — double | `discount` — Скидка — Double (%) | `discount` — Скидка — Double (%) | Тип-семантический кандидат; правила диапазона TBD |
| Сумма скидки | `discountSum` — Сумма скидки — double | `discount` — Скидка — Double (%) | `discount` — Скидка — Double (%) | MS модель процента, не суммы; прямого эквивалента нет |
| Налоговая ставка | `taxRate` — Налог — double | `vat` — НДС — Integer; `vatEnabled` — НДС включён — Boolean | `vat` — НДС — Integer; `vatEnabled` — НДС включён — Boolean | Единицы/ставки и значения проверить; direction TBD |
| Название налога | `taxName` — TAX_NAME — string | `vat` — НДС — Integer | `vat` — НДС — Integer | Строкового эквивалента модели строки не указано |
| Налог включён | `taxIncluded` — Налог включен в цену — char | `vatEnabled` — НДС включён — Boolean | `vatEnabled` — НДС включён — Boolean | Кандидат по смыслу, преобразование char↔Boolean TBD |
| Флаг настройки | `customized` — Изменен — char | — | — | B24 технический флаг, аналога в моделях строк нет |
| Код единицы измерения | `measureCode` — Код единицы измерения — integer | `pack` — Упаковка — `Pack` object | `pack` — Упаковка — `Pack` object | Код/справочник упаковок нуждается в lookup; не прямая пара |
| Единица измерения | `measureName` — Единица измерения — string | `pack` — Упаковка — `Pack` object | `pack` — Упаковка — `Pack` object | Name pack может быть кандидатом, правила множеств/кратности TBD |
| Сортировка | `sort` — Сортировка — integer | — | — | Позиция списка/порядок в документе отдельно не подтверждён моделью; не mapping |
| Тип строки | `type` — TYPE — integer (read-only) | `assortment` — Ассортимент — object discriminator/meta | `assortment` — Ассортимент — object discriminator/meta | Проверить B24 enum↔MS мета-типы product/service/variant |
| Склад строки | `storeId` — STORE_ID — integer (read-only) | `stock` — Остатки по позициям — `PositionStock` | — | Customerorder stock — складская информация; не полевой аналог без подтверждения |
| Резерв | — | `reserve` — Резерв — Double | — | Только CustomerOrderPosition; нет B24 productrow field-аналогии |
| Отгружено | — | `shipped` — Отгружено — Double | — | Только CustomerOrderPosition; не найден прямой B24 productrow analogue |
| Упаковка | — | `pack` — Упаковка — `Pack` object | `pack` — Упаковка — `Pack` object | Связанный справочник; ID/значения и передача TBD |
| Складская позиция | — | `stock` — Остатки по позициям — `PositionStock` | — | Только модель customerorder position; read semantics, не field mapping |
| Налоговая система | — | `taxSystem` — Налоговая система — String | — | Только в модели customerorder position; B24 эквивалент не найден |
| Account ID | — | `accountId` — ID учётной записи — UUID | `accountId` — ID учётной записи — UUID | Системное поле, не mapping |

#### Стандартные поля шапки заказа и счёта — доступные кандидаты

В таблице перечислены поля, уже обсуждавшиеся как потенциально сопоставляемые/важные в T03, с API title и типом. Для Bitrix24 типы подтверждены `crm.deal.fields` / `crm.item.fields(entityTypeId=31,useOriginalUfNames=Y)`; для МойСклад — SDK модели `CustomerOrder` и `InvoiceOut`, не новыми запросами аккаунта. Схема поля не подтверждает направление или необходимость.

| Роль | B24 deal: code — title — type | B24 smart invoice 31: code — title — type | MS customerorder: API name — title/semantics — type | MS invoiceout: API name — title/semantics — type |
| --- | --- | --- | --- | --- |
| Идентификатор | `ID` — ID — integer | `id` — ID — integer | `id` — ID — UUID String | `id` — ID — UUID String |
| Название/номер | `TITLE` — Название — string | `title` — Название — string; `accountNumber` — Номер счёта — string | `name` — Наименование заказа — String; `code` — Код — String | `name` — Наименование счёта — String; `code` — Код — String |
| Внешний код | `ORIGIN_ID` — Идентификатор элемента во внешнем источнике — string; `ORIGINATOR_ID` — Внешний источник — string; `XML_ID` — Внешний код — string | `xmlId` — Внешний код — string | `externalCode` — Внешний код — String; `syncId` — ID синхронизации — UUID | `externalCode` — Внешний код — String; `syncId` — ID синхронизации — UUID |
| Даты | `BEGINDATE` — Дата начала — date; `CLOSEDATE` — Дата завершения — date | `begindate` — Дата выставления — date; `closedate` — Срок оплаты — date | `moment` — Момент — String; `deliveryPlannedMoment` — Плановая отгрузка/доставка — String | `moment` — Момент — String; `paymentPlannedMoment` — Плановая оплата — String |
| Сумма | `OPPORTUNITY` — Сумма — double | `opportunity` — Сумма — double | `sum` — Сумма — Double (read-only); `payedSum` — Оплачено — Double; `shippedSum` — Отгружено — Double; `reservedSum` — Зарезервировано — Double; `invoicedSum` — Выставлено в счет — Double | `sum` — Сумма — Double (read-only); `payedSum` — Оплачено — Double; `shippedSum` — Отгружено — Double |
| Валюта | `CURRENCY_ID` — Валюта — crm_currency | `currencyId` — Валюта — crm_currency | `rate.currency` — Валюта курса — Currency reference внутри `CurrencyRate` | `rate.currency` — Валюта курса — Currency reference внутри `CurrencyRate` |
| Компания/контрагент | `COMPANY_ID` — Компания — crm_company | `companyId` — Компания — crm_company | `agent` — Контрагент — Agent reference | `agent` — Контрагент — Agent reference |
| Контакт | `CONTACT_ID` — Контакт — crm_contact; `CONTACT_IDS` — Контакты — crm_contact | `contactId` — Контакт — crm_contact; `contactIds` — Контакты — crm_contact | `agent` — Контрагент — Agent reference (контактного поля документа в модели не установлено) | `agent` — Контрагент — Agent reference (контактного поля документа в модели не установлено) |
| Ответственный | `ASSIGNED_BY_ID` — Ответственный — user | `assignedById` — Ответственный — user | `owner` — Владелец — Employee reference | `owner` — Владелец — Employee reference |
| Организация/склад | `UF_CRM_1776347243` — API title=код — iblock_element; `UF_CRM_1732004209` — API title=код — iblock_element | `companyId` — Компания — crm_company (другой смысл); специальные UF схемой 31 не выявлены | `organization` — Организация — Organization reference; `store` — Склад — Store reference | `organization` — Организация — Organization reference; `store` — Склад — Store reference |
| Статус | `STAGE_ID` — Стадия сделки — crm_status | `stageId` — Стадия — crm_status | `state` — Статус — State reference | `state` — Статус — State reference |
| Связь заказ/счёт | связь B24 deal↔invoice зависит от универсальных relations | `parentId2` — Сделка (parent relation) — crm_entity | `invoicesOut` — Исходящие счета — InvoiceOut collection | `customerOrder` — Заказ покупателя — CustomerOrder reference |
| Применён/проведён | — | — | `applicable` — Проведён — Boolean | `applicable` — Проведён — Boolean |
| НДС документа | — | — | `vatEnabled` — Учитывать НДС — Boolean; `vatIncluded` — НДС включён — Boolean; `vatSum` — Сумма НДС — Double | `vatEnabled` — Учитывать НДС — Boolean; `vatIncluded` — НДС включён — Boolean; `vatSum` — Сумма НДС — Double |
| Адрес отгрузки | UF `UF_CRM_6926D80233F92` — API title=код — string | отдельный field candidate не подтверждён | `shipmentAddress` — Адрес отгрузки — String; `shipmentAddressFull` — Полный адрес — Address object | в просмотренной модели InvoiceOut прямой аналог не установлен |
| Пояснение отгрузки | UF `UF_CRM_69491D49E57EE` — API title=код — string | — | `shipmentAddressComment` UI-совпадение из T03; type не подтверждён live/SDK, поэтому type TBD | — |
| Проект/состояние | — | — | `project` — Проект — Project reference; `group` — Отдел — Group reference; `taxSystem` — Налоговая система — String | `project` — Проект — Project reference; `group` — Отдел — Group reference; `taxSystem` — Налоговая система — String |
| Файлы/метки | — | — | `files` — Файлы — FileList; `printed` — Напечатан — Boolean; `published` — Опубликован — Boolean; `shared` — Доступен по ссылке — Boolean | `files` — Файлы — FileList; `printed` — Напечатан — Boolean; `published` — Опубликован — Boolean; `shared` — Доступен по ссылке — Boolean |

Для MS в перечисленных SDK моделях стандартный тип API property обычно дан в Java title-case (`String`, `Double`, `Boolean`) и object/list class; это тип модели, а не доказательство фактической заполняемости. `shipmentAddressComment` пока подтверждён только текущей настройкой/именем поля из отчёта T03, его схема — TBD.

Для возможных товаров и услуг стандартные API поля и модели перечислены в T02: `product`/`service` common `id`, `accountId`, `name`, `meta`, `code`, `description`, `vat`, `vatEnabled`, `effectiveVat`, `effectiveVatEnabled`, `productFolder`, `minPrice`, `buyPrice`, `salePrices`, `uom`, `barcodes`, `files`; `product` имеет дополнительные свойства, `service` — свой набор. МойСклад metadata товара предоставляет account-specific custom attribute ID/name/type; это схема, не список заполненных значений. Полная schema catalog B24 (оба полученных каталога) также находится в T02. Ничто из этого само по себе не доказывает, какие свойства синхронизируются. Дополнительные поля товарной карточки ↔ B24 properties: **TBD**, проверить поля каталога и действующий field mapping HTMLStudio.

**Полный доступный inventory схемы каталога Bitrix24 (54 fields, catalog schema from T02), с кандидатом/границей на стороне МойСклад.** Направление, преобразование и функциональная обязательность для всех строк TBD, кроме диагностически наблюдавшегося `property108`↔`assortment.id`; эта связь не объявлена runtime mapping. «Нет кандидата» означает, что равнозначное свойство не найдено в стандартных моделях T02, а не что поле запрещено к передаче.

| B24 code — API title — type | МойСклад candidate: code — name — type | Статус/граница |
| --- | --- | --- |
| `active` — Активность — char | `archived` — Архивный — boolean (обратный смысл, не прямой mapping) | TBD |
| `available` — Доступность к покупке — char | — | Нет кандидата в общей модели; TBD/out of scope до решения |
| `barcodeMulti` — Уникальные штрихкоды для каждого экземпляра — char | `barcodes` — Штрихкоды — array | Только кандидат, структура/множество TBD |
| `bundle` — Наличие набора — char | — | Нет подтверждённого аналога; TBD |
| `canBuyZero` — Разрешение покупки при отсутствии товара — char | — | Нет подтверждённого аналога; TBD |
| `code` — Символьный код — string | `code` — Код — string | Candidate; направление/uniqueness TBD |
| `createdBy` — Кто создал — integer | `owner` — Владелец — object | Семантика автора/владельца не равна без проверки; TBD |
| `dateActiveFrom` — DATE_ACTIVE_FROM — datetime | — | Нет подтверждённого аналога; TBD |
| `dateActiveTo` — DATE_ACTIVE_TO — datetime | — | Нет подтверждённого аналога; TBD |
| `dateCreate` — Дата создания — datetime | `created` — Создан — string datetime (SDK document; product candidate not подтверждён) | Требуется подтвердить поддерживаемость product property; TBD |
| `detailPicture` — Детальная картинка — file | `images` — Изображения — object | Candidate; вложенные файлы не читались и не картированы |
| `detailText` — Детальное описание — string | `description` — Описание — string | Candidate; правила HTML/текста TBD |
| `detailTextType` — Тип детального описания — string | — | Нет кандидата; TBD |
| `height` — Высота — double | — | Нет точечного dimension property у MS product модели T02; TBD |
| `iblockId` — Идентификатор инфоблока — integer | — | B24 schema/catalog discriminator; не переносить как property |
| `iblockSection` — Разделы — list | `productFolder` — Группа каталога — object | Candidate relation; lookup/cardinailty TBD |
| `iblockSectionId` — Основной раздел — integer | `productFolder` — Группа каталога — object | Candidate relation; ID systems differ; TBD |
| `id` — Идентификатор — integer | `id` — Идентификатор — UUID string | System IDs differ; use only as pair key if owner approves |
| `length` — Длина — double | — | No direct length property in T02 MS model; TBD |
| `measure` — Единица измерения — integer | `uom` — Единица измерения — object | Candidate relation/lookup; TBD |
| `modifiedBy` — Кто изменил — integer | `updated` — Последнее обновление — string datetime; `owner` — Владелец — object | No direct editor/user analog; TBD |
| `name` — Наименование — string | `name` — Наименование — string | Candidate; direction/duplicate matching TBD |
| `negativeAmountTrace` — NEGATIVE_AMOUNT_TRACE — char | — | Inventory/stock behavior explicitly outside requirements; out of scope |
| `previewPicture` — Картинка анонса — file | `images` — Изображения — object | No separate preview role confirmed; TBD |
| `previewText` — Описание для анонса — string | `description` — Описание — string | Candidate only; separate semantics TBD |
| `previewTextType` — Тип описания для анонса — string | — | No candidate; TBD |
| `priceType` — Тип оплаты — char | `salePrices` — Цены продажи — array | Not known as same dimension; TBD |
| `purchasingCurrency` — Валюта закупочной цены — string | `buyPrice.currency` — Валюта закупочной цены — nested reference (SDK model) | Candidate; exact response shape and conversion TBD |
| `purchasingPrice` — Закупочная цена — string | `buyPrice` — Закупочная цена — object | Candidate; currency/minor units/rounding TBD |
| `quantity` — Доступное количество — double | — | Inventory quantity excluded by requirements; out of scope |
| `quantityReserved` — Зарезервированное количество — double | — | Inventory/reservation outside catalog sync scope; document-row reserve separately TBD |
| `quantityTrace` — Режим количественного учета — char | — | No catalog mapping; inventory feature out of scope |
| `recurSchemeLength` — Длина периода оплаты — integer | — | No candidate; TBD/out of scope |
| `recurSchemeType` — Единица времени периода оплаты — char | — | No candidate; TBD/out of scope |
| `sort` — Индекс сортировки — integer | — | No mapped ordering property identified; TBD |
| `subscribe` — Разрешение подписки на товар — char | — | No candidate; TBD/out of scope |
| `timestampX` — Дата изменения — datetime | `updated` — Последнее обновление — string datetime | Candidate, date/time conversion TBD |
| `trialPriceId` — Товар для пробной оплаты — integer | — | No candidate; TBD/out of scope |
| `type` — Тип товара — integer | `product`/`service`/`variant` — type-specific endpoints/metadata | Candidate discriminator; B24 enum values and mapping need verification |
| `vatId` — Идентификатор НДС — integer | `vat` — НДС % — integer | Candidate; ID-vs-rate semantics need lookup; TBD |
| `vatIncluded` — НДС включен в цену — char | `vatEnabled` — Учитывать НДС — boolean; `effectiveVatEnabled` — Фактический НДС — boolean | Semantics not yet proven equivalent; TBD |
| `weight` — Вес — double | `weight` — Вес — number (product model) | Candidate; units/precision TBD |
| `width` — Ширина — double | — | No direct width property in T02 model; TBD |
| `withoutOrder` — Продление без оформления заказа — char | — | No candidate; TBD/out of scope |
| `xmlId` — Внешний код — string | `externalCode` — Внешний код — string; `syncId` — ID синхронизации — string | Not established equivalent; 13 rows do not support xmlId equality; TBD |
| `property44` — Картинка — productproperty | `images` — Изображения — object | Candidate custom B24 property, no mapping observed; TBD |
| `property108` — Товары UUID — productproperty | `id` — ID — UUID string | UUID equality observed in 13 position rows only; global coverage/uniqueness TBD |
| `property110` — маркет — productproperty | MS custom `attributes[]` — дополнительное поле, type account-specific | ID/name/type counterpart not established; TBD |
| `property112` — Склад ТЕХ — productproperty | — | No mapping; B24 field label alone does not make it a warehouse API property |
| `property118` — Артикул МС — productproperty | `article` — Артикул — string (product SDK) | Candidate by label only; value equality/direction not tested |
| `property120` — Внешний код ТЕХ — productproperty | `externalCode` — Внешний код — string | Candidate by label only; do not equate without validation |
| `property312` — ID товара на Авито — productproperty | — | No candidate; out of scope unless owner adds external marketplace sync |
| `property314` — ID товара на Авито — productproperty | — | No candidate; out of scope unless owner adds external marketplace sync |
| `property316` — ID товара на Авито — productproperty | — | No candidate; out of scope unless owner adds external marketplace sync |

МойСклад product/service standard fields and 39 account-specific `product/metadata/attributes` are inventoried by code, API name and type in T02 (sections «МойСклад и оставшиеся пробелы»); product/service-only standard fields are also listed there. Среди 39 attributes отдельные B24 counterparts/направления не установлены. До явного allowlist от Product owner весь набор custom attributes имеет статус `TBD — не mapping`; Integration implementer сверяет metadata IDs/names/types и затем строит двустороннюю таблицу без значений записей. Новый запрос `/entity/product/metadata` подтвердил именно число 39 и факт наличия схемы, но названия/типы определений в этом ответе этой картой не перезапрашивались; строки имен/типов являются T02 (2026-09-28) evidence.

## Справочник «Услуги» сделки/заказа (отдельная пара)

| Bitrix24: code — title — type | МойСклад: code — фактическое имя — type | Направление | Преобразование/значение | Обязательность | Доказательство/граница |
| --- | --- | --- | --- | --- | --- |
| `UF_CRM_1766085949` — «Услуги» (в UI; API title — сам код) — `iblock_element`, одиночное по `crm.deal.userfield.list` | `0ad997c8-8e75-11e3-1ec9-002590a28eca` — «Услуги» — `customentity`; `customEntityMeta` → `f0177126-8e74-11e3-b761-002590a28eca` | В HTMLStudio UI настроено B24 → МС; журнал для конкретной пары показал целевое обновление сделки B24 с полем «Услуги». Обратное направление не установлено | Для пяти прочитанных значений `CODE` списка B24 совпал с UUID значения списка МС; Q26.10 подтверждает только синхронизацию справочного значения, без текстовой копии и независимо от строк товаров | TBD | T02/T03 live schema, 5 значений, 1 sample order with 9 product lines. Направление и преобразование самого значения требуют технической проверки |

Поле справочника никогда не трактовать как `positions.assortment` или автоматическое создание товара/услуги в строках. В T02 группа «Доставка» содержит отдельную пару владельца, включая две исторические записи/две инцидентные пары, ID которых должны сохраняться; это пример конкретной группы, не общий критерий выбора дублей.

## Связанные значения: пользователи, склады, организации, валюты, справочники

| Справочник/отношение | Bitrix24: код — title — type | МойСклад: код — название — type | Кандидат соответствия/направление | Готовность |
| --- | --- | --- | --- | --- |
| Ответственный | Сделка `ASSIGNED_BY_ID` / smart invoice `assignedById` — Ответственный — `user` | Документ `owner` — Владелец — `Employee` object | Кандидаты пользователей↔сотрудников имеются; в одном sample display names и `externalCode` не дали пары. Направление/конкретные ID TBD | Functional обязательность TBD; требуется mapping и проверка назначений |
| Склад заказа | Deal UF `UF_CRM_1732004209` — API title=UF code; `iblock_element`, single, IBLOCK_ID=38 | `store` — Склад — `Store` object | Кандидат `CODE=UUID`; 23/23 совпадений на ограниченном наборе, один B24 list item без кандидата; UI B24→МС | Functional requiredness TBD; проверить usage всех значений и одиночное исключение |
| Организация | Deal UF `UF_CRM_1776347243` — API title=UF code; `iblock_element`, single, IBLOCK_ID=88 | `organization` — Организация — `Organization` object | Кандидат `CODE=UUID`; 8/8 в ограниченной выборке; UI B24→МС | Functional requiredness TBD; не связывать с CRM company |
| Валюта | Deal `CURRENCY_ID` / smart invoice `currencyId` — Валюта — `crm_currency` | `rate.currency` — Валюта курса — вложенная ссылка в `CurrencyRate`; `salePrices` — Цены продажи — array/object | B24 code↔MS currency candidate mapping; у MS code 643 есть два объекта. `salePrices` относится к каталогу, не к валюте документа | Order/invoice value mapping и requiredness TBD |
| Способ оплаты и прочие custom entities | Deal UF `UF_CRM_1766072752` (способ оплаты) и `UF_CRM_1766085949` (услуги); B24 list/field type подтверждать по каждому | Customerorder attributes `f214...` payment method (`customentity`), `0ad...` service (`customentity`) | Нужны отдельные таблицы значений; только `CODE=UUID` для услуги наблюдалось в 5 значениях | Направления/списки/обязательность прочих соответствий TBD |
| Стадии | `STAGE_ID`/`stageId` — `crm_status` | `state` — `State` object | UI таблицы стадии для заказа/счёта в T03; полные IDs всех MS state и стабильность кодов не сверялись | Требуется решение, какие стадии участвуют в сервисе, отдельно от текущих настроек HTMLStudio |

T04 подтверждает выбранное владельцем правило доступа `user.admin == true` текущего пользователя; оно **не является** полевой связью сотрудника МС. Складское поле B24 — пользовательский список 38, а не `catalog.store.list`. Организации — список 88, не список CRM-компаний. Для кандидатов пользователей/складов/организаций/валют нельзя превращать совпадение email, ФИО или `CODE` в утверждённую пару без подтверждения.

## Происхождение схем и свежесть доказательств

Новое read-only чтение metadata API на 2026-09-30 (ответы схемы, без сохранения значений записей):

- Bitrix24 `crm.deal.userfield.list`: 17 полей; зафиксированы `FIELD_NAME`, API `EDIT_FORM_LABEL`/title, `USER_TYPE_ID`, множественность, `MANDATORY`, а для iblock element — `SETTINGS.IBLOCK_ID`. Все перечисленные UF single и API `MANDATORY=N`. Значения списков не запрашивались этим вызовом.
- Bitrix24 `crm.deal.fields`: схема 143 стандартных полей сделки; таблицы выше используют поля-кандидаты этой схемы.
- Bitrix24 `crm.item.fields` с `entityTypeId=31`, `useOriginalUfNames=Y`: схема 140 smart invoice полей; в таблице приведены только relevant candidates, а не все 140.
- Bitrix24 `crm.item.productrow.fields`: схема из 22 полей приведена построчно выше. Документация API: [crm.item.productrow.fields](https://apidocs.bitrix24.com/api-reference/crm/universal/product-rows/crm-item-productrow-fields.html).
- Bitrix24 `catalog.product.getFieldsByFilter` с `iblockId=14`: 54 поля каталога. Полный код-title-type перечень продукта уже содержится в T02; строки каталожных полей выше являются выбором кандидатов из этой схемы.
- МойСклад `GET /entity/customerorder/metadata` с `Accept: application/json;charset=utf-8`: HTTP 200; root metadata sections `meta`, `attributes`, `states`, `createShared`; schema содержит 66 customerorder custom attribute definitions. Только схема: ни значения атрибутов/справочников, ни обязательность каждого из 66 полей в эту карту не выгружены.
- МойСклад `GET /entity/invoiceout/metadata` с тем же Accept: HTTP 200; custom attributes schema count 0. Ноль относится к user-defined attributes в metadata, а не к стандартным свойствам `invoiceout`.
- МойСклад `GET /entity/product/metadata` с тем же Accept: HTTP 200; schema содержит 39 custom attribute definitions. Это не перечень заполненных значений.
- Сами стандартные schemas `CustomerOrder`, `InvoiceOut`, `CustomerOrderPosition`, `InvoiceOutPosition`, каталог контактов/компаний и product/service взяты из перечисленных официальных SDK/API-документов и прежних T01–T04, а не из новых live schema ответов. Особенно `shipmentAddressComment`: имя/настройка в T03, но тип отдельно не подтверждён.

Предыдущие T01–T04 подтверждают прочитанные ранее live-метаданные, интерфейсные настройки и ограниченные безопасные выборки. Не переносить выборочные counts/совпадения в утверждения о полноте или покрытии аккаунта; PII и значения полей в документ не записывались.

## Критичность, готовность и решения владельца

Утверждённое правило Q75: перед включением сущности проверяются только её критичные поля и связи; отсутствие необязательных соответствий показывает предупреждение. Если обязательное поле не преобразуется, запись блокируется и случай виден для ручной проверки. Для товарного состава неподготовленная обязательная позиция блокирует весь заказ, включая шапку и отгрузку. При этом конкретный перечень критичных полей/связей по сущностям пока не утверждён: **каждая строка таблиц выше имеет функциональную обязательность `TBD`**, кроме уже описанного поведения флага «Дубль» и блокады неподготовленной обязательной позиции.

Оставшиеся продуктовые решения владельца/эксперта, без которых карту нельзя объявить утверждённой:

1. Контакты: определить критичные поля/связи и поведение очистки обязательных полей; подтвердить техническую реализацию направлений, разделителя для множественных PHONE/EMAIL, обратного разбора и защиты от эхо-обновлений. Жёсткие существующие пары остаются без изменений.
2. Заказы: для включённых custom и согласованных стандартных полей подтвердить техническую записываемость, направления и преобразования по каждому полю; определить критичные поля/связи и обязательные очистки. Провести техническую проверку стандартных полей и UI-настроек, включая даты, суммы, скидки, адресный комментарий и `name`.
3. Статусы/триггеры: решить, наследуются ли в новом сервисе существующие пары стадий и флаги отгрузки/резервирования/оплаты/товаров; утвердить набор этапов первой версии.
4. Счета: охватить только smart invoice 31 или также legacy 5; утвердить связь счёт↔заказ↔сделка, направления и критичные поля/статусы.
5. Каталог и строки: выбрать бизнес-поля и направления; утвердить правила ключа `property108`↔`assortment.id`, используемые категории product/service/variant, а также критичность строк и значений.
6. Справочники/отдельное поле услуг: утвердить пары и направления employee/store/organization/currency/payment-method. Для услуги scope зафиксирован как значение справочника без текстовой копии и без product position; технически проверить направление и преобразование.
7. Для всех сущностей: определить функционально критичные поля и связи для готовности, а также поведение при очистке mandatory-полей; Q26.9 уже задаёт распространение очистки необязательного синхронизируемого поля по времени записи.

### TBD: проверка и ответственные

В этом разделе «Product owner» означает владельца требований/проекта, который утверждает scope и бизнес-смысл; «data owner» — владелец соответствующего портала/справочника, который подтверждает значение и связи. Если роли у проекта совмещены, согласование всё равно требуется явно. «Integration implementer» отвечает за техническую read-only проверку и фиксацию доказательства, но не принимает продуктовое решение вместо владельца.

| TBD-класс | Конкретная проверка/доказательство | Кто принимает решение | Кто выполняет проверку |
| --- | --- | --- | --- |
| Направление активных 16 полей заказа | Сопоставить текущие настройки HTMLStudio с журналом нескольких безопасных операций без вывода значений; отдельно проверить настройки нового сервиса и двусторонние сценарии на тестовом dry | Product owner | Integration implementer; data owners обеих систем подтверждают семантику |
| Функциональная mandatory/criticality | Для каждого поля утвердить поведение на пустом значении: block или warning; соотнести с Q75 и обязательностью из API отдельно | Product owner | Integration implementer фиксирует значения схемы, не решает criticality |
| Контактная модель и ключи пары | Read-only выборка по типам контрагентов, UUID UF против `counterparty.id`/`contactperson.id`, кардинальность links; свести агрегаты без PII | Product owner для выбора модели; data owner подтверждает идентичность/связи | Integration implementer |
| Товарная карточка и каталожные атрибуты | Сверить полный portal schema/property list и полный MS metadata schema с явным allowlist; проверить присутствие ключа `property108` и связи на строках ограниченной обезличенной выборки | Product owner выбирает поля/направления; data owner подтверждает бизнес-смысл пользовательских атрибутов | Integration implementer выполняет read-only schema/sample checks |
| Строки и цены/скидки/НДС/единицы | Проверить API документацию и структурные значения безопасных строк, валютные minor units и lookup единиц; затем утвердить преобразования и точность | Product owner утверждает семантику/округление | Integration implementer сверяет схемы и готовит примеры без PII |
| Стадии и триггеры | Получить все account-specific state IDs/refs read-only; сверить UI mapping, trigger flags и requirements; составить конечную таблицу ID | Product owner | Integration implementer + data owner стадий |
| Типы/связи invoice | Read-only определить использование smart invoice 31 и legacy 5, связность invoiceout↔customerorder↔deal на стратифицированных записях без идентификаторов/PII в отчёте | Product owner | Integration implementer + data owner счетов |
| Reference/customentity значения | Сверить все используемые значения списков и справочников через schema/ID-only exports; установить кандидаты и несопоставленные элементы без публикации названий/персональных значений | Product owner утверждает связь и отсутствие/блокирующее поведение | Integration implementer; соответствующий data owner |

### AC5: внешние зависимости и статус публикации

| Требование | Нынешнее состояние | Осталось до выполнения |
| --- | --- | --- |
| Ссылка в parent Issue #1 на утверждённую карту | Issue #1 упоминает/ссылается на дочернюю #26; ссылки на файл карты нет | После owner approval root добавляет точный permalink к опубликованному файлу/коммиту в #1 |
| Зависимые Issues #27–#29 | По независимой проверке: все три открыты и ссылаются на #26; #27 указывает #26 как вход, #28/#29 требуют утверждённую карту. Ни один не ссылается на опубликованный файл/permalink карты. | После approval root добавляет permalink утверждённой версии в те issue, где это требуется, затем проверяет перекрёстные ссылки |
| Утверждение карты | Не получено; этот файл рабочий draft | Product owner подтверждает scope, directions, transforms, requiredness и remaining TBD; root проводит review |
| Публикация артефакта | Не выполнена; файл локальный и uncommitted | После approvals root решает публикацию/commit по согласованному Git-порядку и затем обновляет внешние ссылки |

Проверки без продуктового решения: получить дополнительные схемы типизированных smart invoice полей и каталогов при необходимости; сделать стратифицированные обезличенные read-only выборки связей для всех типов документов и проверить фактические настройки по нескольким парам; прочитать IDs/типы значений status и custom entities; не сохранять PII, payload, денежные/контактные значения в этом отчёте. В текущем live schema чтении получены типы 17 UF сделки (включая 16 строк настройки и UUID связи), их одиночность и `MANDATORY=N`; эта техническая метадата не утверждает функциональную обязательность.

## Источники и границы доказательств

- Проектные решения и границы: [`requirements.md`](../requirements.md), родительская спецификация [Issue #1](https://github.com/Makskaii/bitrix-moysklad-sync/issues/1), текущая задача [Issue #26](https://github.com/Makskaii/bitrix-moysklad-sync/issues/26).
- Контакты/компании: [T01](t01-contact-company-fields.md); документация Bitrix24 [crm.contact.fields](https://apidocs.bitrix24.ru/api-reference/crm/contacts/crm-contact-fields.html), [crm.company.fields](https://apidocs.bitrix24.ru/api-reference/crm/companies/crm-company-fields.html), [Bitrix24 contact userfields](https://apidocs.bitrix24.ru/api-reference/crm/contacts/userfield/crm-contact-userfield-list.html), [company userfields](https://apidocs.bitrix24.ru/api-reference/crm/companies/userfields/crm-company-userfield-list.html), [МойСклад JSON API 1.2 counterparty](https://github.com/moysklad/api-remap-1.2-doc/blob/master/md/dictionaries/_counterparty.md).
- Товары/услуги: [T02](t02-products-services.md); Bitrix24 [catalog product](https://apidocs.bitrix24.com/api-reference/catalog/product/index.html), [product catalog data types](https://apidocs.bitrix24.com/api-reference/catalog/data-types.html), [product fields](https://apidocs.bitrix24.com/api-reference/catalog/product/catalog-product-get-fields-by-filter.html); [МойСклад JSON API 1.2](https://dev.moysklad.ru/doc/api/remap/1.2/) и официальные SDK models, перечисленные в T02.
- Сделки/счета/текущий HTMLStudio UI: [T03](t03-deals-orders-invoices.md); Bitrix24 [deal fields](https://apidocs.bitrix24.com/api-reference/crm/deals/crm-deal-fields.html), [smart invoices](https://apidocs.bitrix24.com/api-reference/crm/universal/invoice.html), [product row fields](https://apidocs.bitrix24.com/api-reference/crm/universal/product-rows/crm-item-productrow-fields.html); МойСклад SDK [CustomerOrder](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/CustomerOrder.md), [InvoiceOut](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/InvoiceOut.md), [CustomerOrderPosition](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/CustomerOrderPosition.md), [InvoiceOutPosition](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/InvoiceOutPosition.md), [State](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/State.md).
- Справочники: [T04](t04-reference-access.md); Bitrix24 [user.get](https://apidocs.bitrix24.com/api-reference/user/user-get.html), [crm.currency.list](https://apidocs.bitrix24.com/api-reference/crm/currency/crm-currency-list.html); МойСклад SDK [Employees](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/EmployeesApi.md), [Stores](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/StoresApi.md), [Organizations](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/OrganizationsApi.md), [Currencies](https://github.com/moysklad/remap-1.2-java-sdk/blob/master/docs/CurrenciesApi.md).
- Ограничения штатной интеграции: [native-integration.md](native-integration.md). Публичная документация HTMLStudio описывает функции и модель интеграции, но не заменяет текущий UI-срез настроек или фактическую историю записи.

В карту не включены PII, значения персональных пользовательских полей, полные API payloads, секреты и credentials. Новых внешних записей не выполнялось. Направления, типы/обязательность там, где они отмечены TBD, нельзя считать утверждёнными по факту одного примера или наличия API.
