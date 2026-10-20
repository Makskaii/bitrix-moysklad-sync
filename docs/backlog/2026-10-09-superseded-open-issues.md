# Archive of superseded open issue drafts

Snapshot created 2026-10-09 before replacement tickets were published. This is a recoverable source archive of replaced open issue bodies and comments. Parent specification #1 is preserved separately in `2026-10-09-parent-specification-issue-1.md`. Closed issues are not included. The GitHub issues themselves are closed as superseded only after replacement tickets were created successfully.

## #10 — T09 — Настройка полей и предпросмотр

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/10

### Body

## Parent

#1

## What to build

Дать администратору возможность управлять направлением и преобразованием каждого соответствия полей с предварительным просмотром результата. Хранить версии настроек, чтобы событие сохраняло контекст правил, по которым оно было принято.

## Acceptance criteria

- [ ] Для пары полей задаются независимые направления и преобразования; сложные группы выделяются отдельно.
- [ ] Предпросмотр показывает исходные и итоговые значения без внешней записи.
- [ ] Изменения настроек сохраняются и вступают в силу сразу для новых событий; рискованные изменения сопровождаются предупреждением.
- [ ] Каждому принятому событию назначается версия настроек; обычная обработка и повтор события используют сохранённую версию, даже если текущая настройка уже изменилась.
- [ ] Пересчёт события по более новой версии возможен только отдельным точечным действием; массовое переигрывание истории не запускается.
- [ ] Версия правил и использованные преобразования видны при диагностике события/повтора.
- Provide a functional admin section for unit-of-measure mappings between Bitrix24 and MySklad: show units from both systems, automatically suggest/match pairs, and allow manual assignment and reassignment; persist configured pairs.

## Blocked by

- #9 (closed; dependency resolved).

The generic #26 blocker is removed for the scoped reference-mapping UI. The frozen approved input map and exact source are [PR #44](https://github.com/Makskaii/bitrix-moysklad-sync/pull/44), commit [1bcb27e](https://github.com/Makskaii/bitrix-moysklad-sync/blob/1bcb27e38fc3e2e9f42fb73eaec300f61d763070/research/issue-10-mapping-ui-brief.md). It contains the 9 approved UOM pairs (3 B24 measures intentionally unmapped) and 7 approved catalog price-type pairs (other listed types stay excluded/preserved). Service/payment typed references and current 46/46 + 5/5 ID coverage are recorded in the same brief.

Remaining #26 row-ID pairing and document-field write evidence are consumer gates for #16, not blockers to implementing #10's mapping and persistence UI. An order is held only if that order requires an unmapped UOM. No pack factor is inferred and no production write proof is claimed.

### Comments

_No comments._

## #11 — T10 — Автосопоставление и ручная проверка

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/11

### Body

## Parent

#1

## What to build

Создавать не более одной активной пары на тип сущности и позволять администратору разбирать сомнительные совпадения.

## Acceptance criteria

- [ ] Алгоритм использует проверенные ключи и оценку кандидатов; помеченный дубль Bitrix24 исключается без отключения связи оригинала с той же записью МойСклад.
- [ ] При сомнительном выборе активная пара и причины видны в интерфейсе и доступны для исправления вручную.
- [ ] Ни один сценарий не выполняет автоматическое слияние или удаление записей.

## Blocked by

- #2
- #9
- #10
- #27

## Q26.66 event-driven resolution

On the first event for an existing record, find/confirm one existing pair before processing. A unique confirmed pair is read from both sides and its current baseline saved before writes; ambiguous, incomplete, unverified, or unavailable cases go to manual review. Existing confirmed/manual pairs are authoritative. The background collector #45 is not a runtime dependency and must not overwrite pairs or fresh baselines. Do not invent keys/thresholds or change the approved first-state/conflict/duplicate rules.

### Comments

_No comments._

## #12 — T11 — Обмен компаниями

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/12

### Body

## Parent

#1

## What to build

Синхронизировать согласованные поля компании/контрагента в обе стороны через подтверждённую пару.

## Acceptance criteria

- [ ] Новый и изменённый контрагент обрабатываются в соответствии с правилами источника и приоритетом изменений.
- [ ] Дубли и неоднозначные пары не перезаписывают оригинал; повторная обработка не создаёт дубль.
- [ ] Сквозные сценарии с имитаторами API проверяют обе стороны.

- First-release company/client sync is limited to company title/name, phones, email, required entity links, service pair IDs and duplicate exclusion under existing rules (Q26.57). Preserve existing legal and banking requisites without syncing or changing them; defer their exchange with the future invoice phase (#18). Do not make them creation requirements based on this scope; verify exact API mandatory constraints separately. Other fields remain future scope, not removed from the roadmap.

## Blocked by

- #2
- #10
- #11

### Comments

_No comments._

## #13 — T12 — Первоначальная карта контактов и компаний

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/13

### Body

## Parent

#1

## What to build

Порционно построить пары и предварительные исходные снимки для контактов и компаний, существовавших до запуска сервиса, не создавая массово отсутствующие записи. Инвентаризация начинается после запуска раннего сборщика событий; она не должна зависеть от уже готового рабочего обмена компаниями.

## Acceptance criteria

- [ ] Загрузка возобновляется после остановки без повторного создания пар и сохраняет прогресс и результаты сопоставления.
- [ ] Для каждой найденной пары сохраняются ID, связи и значения всех выбранных для синхронизации полей с обеих сторон.
- [ ] Если исходные значения двух сторон различаются, оба сохраняются как начальное несогласованное состояние без перезаписи любой стороны.
- [ ] Ранние события используются для актуализации снимков и связей; они не превращаются при включении обмена в массовые внешние записи.
- [ ] Старые записи только сопоставляются и снимаются; отсутствие пары само по себе не создаёт новую запись.
- [ ] Неоднозначности и дубли доступны для ручной проверки.
- [ ] Первоначальная инвентаризация может выполняться до завершения T11 (#12) — готовый рабочий обмен компаниями не является предусловием.

## Blocked by

- #8
- #11
- #26
- #27

### Comments

_No comments._

## #14 — T13 — Dry-прогон первого обмена

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/14

### Body

## Parent

#1

## What to build

Показать полную цепочку будущей синхронизации без записи в реальные системы.

## Acceptance criteria

- [ ] Dry использует реальные чтения, отдельную область тестового состояния и имитирует финальные внешние записи.
- [ ] В отчёте видны событие, карта, проверки, направление, преобразования и ожидаемые API-вызовы.
- [ ] Dry включается только на стороне сервера, не переключается в UI; production-обработка игнорирует dry-события.

## Blocked by

- #9
- #10

### Comments

_No comments._

## #16 — T15 — Сделка и заказ покупателя

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/16

### Body

## Parent

#1

## What to build

Обменивать связанную сделку Bitrix24 и заказ покупателя МойСклад вместе с контрагентом, ответственным и полным составом.

## Acceptance criteria

- [ ] Новый документ создаётся один раз; старый корректно сопоставленный документ обменивается изменениями, но старые без пары не создаются массово.
- [ ] Для переноса связей используются существующие пары зависимых сущностей.
- [ ] Если обязательная позиция не разрешилась, весь заказ блокируется с явной причиной и комментарием, без частичного состава.
- [ ] Для изменения уже существующей товарной позиции при однозначно подтверждённой паре строк использовать адресное обновление по ID строки; не удалять и не создавать строку заново и не заменять весь список строк. Перед записью повторно читать текущее состояние и применять уже утверждённую общую политику конфликтов по снимку/времени; отдельный алгоритм разрешения конфликтов строк здесь не вводить.
- [ ] Изменённые значения передавать как итоговые абсолютные значения, включая количество, а не как приращение; повтор того же события не должен дважды увеличивать/уменьшать количество. Цена должна быть задана явно, 0 допустим; отсутствующая цена блокирует весь заказ по Q26.23.
- [ ] Новую позицию добавлять отдельной операцией. Если подтверждённую пару строк установить нельзя, отправлять случай на ручную проверку; не сопоставлять повторные строки только по productId и не пересоздавать молча.
- [ ] Пользовательское удаление строки переносить только при однозначной паре строки и подтверждении удаления полным чтением документа; неполная/пагинированная выдача или неоднозначность ведут к ручной проверке. Удаление строки не удаляет карточку товара каталога (Q26.24).
- [ ] Проверить повторные события, повторные строки одного товара, отдельное добавление, подтверждённое удаление и неполный источник; проверить перед записью reread при конкурентном изменении. Не предполагать поддержку поля/права/ограничение статуса документа: подтвердить по фактическому API, не делать боевых write-тестов.

- If any unit required by a product or row in an order has no configured mapping, hold the entire affected order until the pair is configured; log the reason and route it for manual review. Do not send a partial order, auto-create units, or infer conversions.

## Blocked by

- #4
- #5
- #12
- #15
- #28
- #29

## Q26.59–Q26.61 deal/order first-release scope (2026-10-06)

- Q26.59 closes the first-release deal/order scope at the already-approved native core and discussed custom fields. Other unconfirmed fields are deferred; existing criticality, fallback, readiness, and conflict rules remain unchanged.
- Q26.60: B24 `UF_CRM_1766085949` ↔ MySklad customerorder attribute `0ad997c8-8e75-11e3-1ec9-002590a28eca` (“Услуги”) is a bidirectional optional reference field, with MySklad conflict priority. Missing value does not block; clear/unmapped handling remains Q26.9/.20. It is not a product row or text copy.
- Q26.61: B24 `UF_CRM_1766072752` ↔ MySklad customerorder attribute `f214f966-dc1a-11f0-0a80-0ef700278459` (“Способ оплаты”) is bidirectional and optional; clear propagates, and unmapped values skip/log only this field. No payment documents or `payedSum` writes.
- Both references’ exact value pairs, transforms, and API support remain technical verification. Payments/invoices remain out of first-launch scope.



## Q26.66 runtime baseline boundary

For a historical deal/order first encountered by an event, use #11 to find/confirm the pair, then #29 to read current data from both sides and save the baseline before field processing. If ambiguous/unverified, route to manual review. The historical ID/key inventory child #45 is background-only and must not gate this ticket or readiness. This does not change first-pair MySklad priority, existing conflict rules, duplicate handling, echo/idempotency, or the prohibition on historical mass creation.

### Comments

#### Comment 1

The approved catalog map inputs are documented in [PR #44](https://github.com/Makskaii/bitrix-moysklad-sync/pull/44) and the [#10 dispatch brief](https://github.com/Makskaii/bitrix-moysklad-sync/blob/1bcb27e38fc3e2e9f42fb73eaec300f61d763070/research/issue-10-mapping-ui-brief.md). Q26.53 readiness applies per affected order only when a product/row actually requires an unmapped UOM; the 3 unmapped B24 units do not hold unrelated orders. Row-ID pairing/update support remains a separate manual-review gate. Approved catalog UOM pairs do not prove row.pack equivalence or production write support.

## #17 — T16 — Услуги в заказе

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/17

### Body

## Parent

#1

## Scope in v1

Поле-справочник услуг сделки Bitrix24 `UF_CRM_1766085949` ↔ поле заказа покупателя МойСклад `0ad997c8-8e75-11e3-1ec9-002590a28eca` включено в полный обмен сделки/заказа по #16 и Q26.60. Это ссылка на значение справочника; она не создаёт/изменяет товарную позицию и не требует отдельной текстовой копии.

Эта issue фиксирует границу scope, но не создаёт дублирующий обработчик вне #16. Реализация направления, значение-пары, преобразования и проверка записываемости должны пройти в составе #16/#26; 46/46 текущих ID-пар — это coverage evidence, не production write proof.

## Acceptance criteria

- [ ] #16 реализует поле в двух направлениях по Q26.60 и общей настройке направления; конфликт решается по принятому приоритету МойСклад.
- [ ] Отсутствующее значение не блокирует заказ; очистка и unmapped-value обрабатываются по Q26.9/.20.
- [ ] Обработка поля не создаёт, не изменяет и не удаляет строки товара заказа.
- [ ] Текстовая копия названия услуги не создаётся.
- [ ] Технические value pairs, transform и API support остаются подтверждаемыми фактами, а не выводятся из наличия пары или метаданных.

## Blocked by

- #16 — единая реализация сделки/заказа (поле включено в её scope).
- #26 — техническая проверка значения и API support.

### Comments

_No comments._

## #18 — T17 — Счета

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/18

### Body

## Parent

#1

## What to build

Сопоставлять существующие счета Bitrix24 и МойСклад и синхронизировать согласованные изменения по их парам.

## Acceptance criteria

- [ ] Типы счетов и связи определены по реальным данным, без предположения о классическом/смарт-счёте.
- [ ] Старые счета не создаются массово; связанные изменения проходят в обе стороны идемпотентно.

## Blocked by

- #4
- #5
- #12
- #16
- #29

### Comments

_No comments._

## #19 — T18 — Отгрузка по стадии сделки

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/19

### Body

## Parent

#1

## What to build

По согласованной стадии сделки создавать или обновлять одну полную отгрузку МойСклад при соблюдении складских ограничений и поддерживать её проведение в соответствии с текущей стадией.

## Acceptance criteria

- [ ] Перед записью проверяются остатки МойСклад; нехватка блокирует действие с причиной.
- [ ] При выходе сделки из настроенной актуальной стадии проведение связанной автоматической отгрузки снимается.
- [ ] При возврате сделки в эту стадию повторно проводится та же связанная отгрузка; новая отгрузка не создаётся.
- [ ] Повтор события и повторный переход стадии идемпотентны: в автоматическом сценарии существует не более одной полной отгрузки на заказ.
- [ ] Частичные отгрузки не входят в автоматический сценарий. Ручную или неоднозначно сопоставленную отгрузку автоматически не менять.

## Blocked by

- #4
- #5
- #16

### Comments

_No comments._

## #22 — T21 — Удаление и восстановление записи

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/22

### Body

## Parent

#1

## What to build

В production v1 обрабатывать подтверждённое удаление и восстановление любой включённой пары по Q26.67. Сохранять tombstone в БД, прекращать обмен затронутой пары и не удалять физически связанную запись во второй системе. В Bitrix24 отражать пометку только через уже согласованное/настроенное поле, если оно доступно; ID поля не угадывать.

## Acceptance criteria

- [ ] В production v1 событие или подтверждённое обнаружение удаления фиксируется как tombstone в БД; повторная доставка идемпотентна.
- [ ] После tombstone синхронизация затронутой пары останавливается; связанная запись на другой стороне физически не удаляется.
- [ ] Где запись существует в Bitrix24 и настроено уже согласованное поле пометки, оно устанавливается; отсутствующий/неподтверждённый ID поля не угадывается и явно отображается как настройка, требующая решения.
- [ ] При удалении в МойСклад в таймлайне связанной записи Bitrix24 сохраняется комментарий о причине/состоянии удаления согласно ранее согласованному правилу.
- [ ] Только подтверждённое восстановление снимает tombstone/пометку и возобновляет синхронизацию той же пары; неподтверждённое или неоднозначное восстановление идёт на ручную проверку.
- [ ] Физическое удаление записей в Bitrix24 и МойСклад не выполняется.

## Blocked by

- #8 — durable event intake.
- #11 — confirmed pair resolution.
- #12 — company/client sync.
- #15 — product sync.
- #16 — deal/order sync.
- #28 — contact/person sync.
- #20 — retries and event recovery (closed; dependency resolved).


### Comments

_No comments._

## #24 — T23 — Предпусковая проверка

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/24

### Body

## Parent

#1

## What to build

Перед включением обмена показывать готовность утверждённых ключей сопоставления, карт полей и связей, доступа и настроек, отделяя блокирующие ошибки от предупреждений.

## Acceptance criteria

- [ ] Проверка блокирует включение, если для включаемой сущности отсутствует утверждённая карта ключей или обязательные поля/связи, есть критическая техническая ошибка либо недоступна необходимая конфигурация; причина показана администратору.
- [ ] Проверка прав админки использует пользовательский токен текущего пользователя и серверно подтверждает `user.admin == true`; положительный ответ даёт доступ, `false` и ошибка проверки отказывают в доступе.
- [ ] Отсутствие необязательных соответствий и несопоставленные старые записи отображаются как предупреждения и сами по себе не блокируют включение.
- [ ] Результат проверки доступен администратору; критерии блокировки и предупреждений проверены на сценариях с обязательными пробелами, необязательными пропусками, несопоставленными старыми записями и ошибками доступа.

## Blocked by

- #2
- #3
- #4
- #5
- #10
- #11
- #20
- #23
- #26
- #27
- #29

## Q26.66 readiness boundary

Q26.66 makes pair/baseline resolution event-driven. A full historical ID/key inventory (#45) is background coverage work and does not block startup, enabling a configured entity, or readiness. Readiness still blocks missing required configuration/technical prerequisites for the enabled scope and warns about unmatched historical records.

### Comments

_No comments._

## #25 — T24 — Контролируемое переключение с HTMLStudio

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/25

### Body

## Parent

#1

## What to build

Проверить готовность нового сервиса и переключить рабочий обмен с текущей интеграции HTMLStudio без параллельных записей.

## Acceptance criteria

- [ ] До переключения готовы необходимые для включаемых сущностей карты/настройки, event-driven подтверждение пары и on-demand baseline (#11/#29); контрольные сценарии и предпусковые блокировки пройдены, спорные пары доступны оператору. Фоновый ID/key scan #45 и полные исторические snapshots не являются cutover gate.
- [ ] Полный обмен контактами первой версии завершён до переключения.
- [ ] HTMLStudio отключается до включения записей нового сервиса; параллельные записи двух интеграций исключены.
- [ ] Боевой обмен включается отдельным административным действием только после отдельного явного подтверждения именно запуска в production.
- [ ] Есть проверяемый план возврата и контроль первых событий после включения.

## Blocked by

- #13
- #14
- #15
- #16
- #20
- #21
- #22
- #23
- #24
- #26
- #27
- #28
- #29

## Q26.66 launch baseline

The launch requires tested event-driven pair confirmation and on-demand baseline initialization for historical records first encountered by the active exchange. Completion of the historical ID/key coverage scan (#45) and full-field snapshots across the historical customerorder archive are not cutover prerequisites. Invoices remain a later phase (#18).

### Comments

_No comments._

## #27 — Утвердить ключи и пороги автоматического сопоставления

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/27

### Body

## Parent

#1

## Problem

Автоматический поиск и выбор пар нужны при первоначальной загрузке и для новых записей. Требования оставляют ключи, приоритеты, статистику конфликтов и пороги сомнения на проверку данных. T01 и T02 содержат только ограниченные наблюдения; они не задают универсальных ключей или весов.

## What to determine

Для каждой сущности определить допустимые признаки кандидата отдельно от оценки, какая из нескольких допустимых записей является основной. На репрезентативных данных измерить пропуски, совпадения, неоднозначность и ложные совпадения. Сформулировать критерии уверенного/сомнительного выбора и пороги, если их можно обосновать. Не принимать неподтверждённые ключи, веса или пороги как продуктовые решения.

## Acceptance criteria

- [ ] Для контактов, компаний/контрагентов, контактных лиц, товаров/модификаций и документов описаны подходящие ключи-кандидаты и доступность данных.
- [ ] Отдельно описаны фильтрация допустимых кандидатов и выбор основной записи при нескольких допустимых кандидатах.
- [ ] Приведены объём и ограничения проверенных выборок, агрегаты уникальных/нулевых/множественных совпадений и оценка риска ложного автоматического выбора.
- [ ] Для неразрешённых сущностей или порогов явно указаны TBD и требуемый анализ; решение не выводится из малых выборок.
- [ ] Результат утверждён до реализации автосопоставления в T10; учитывает уже принятые правила о жёстких парах по ID, активной сомнительной паре с ручной проверкой и отсутствии автоматического объединения/удаления.
- [ ] Обновлены связанные спецификация и план T10 с точной ссылкой на результат.

## Inputs

- T01: #2, ограниченные проверки UUID, имён, телефонов и email.
- T02: #3, property108 как кандидат ключа проверенных товарных связей и отдельный инцидент дублей.
- requirements.md: «Сопоставление записей и полей» и «Отложено до обследования и отдельного согласования».

## Blocked by

- #2
- #3
- #26

## T26 research input

Use the published, evidence-bounded [T26 research map at merge commit c03357c](https://github.com/Makskaii/bitrix-moysklad-sync/blob/c03357cf91cb348376d043b64caf80816ca43443/research/t26-field-mapping.md) as an input. Technical verification of row-ID pairing and row operations remains open in #26; the map is not a complete accepted runtime allowlist.

## Q26.66 matching boundary

Per-event resolution must confirm a unique existing pair or return manual review; unsupported/unverified keys or ambiguous candidates never become guessed matches. The background inventory child #45 may collect only fields/keys accepted by this issue; it does not choose pairs or block runtime readiness. Keep thresholds/entities TBD if evidence is insufficient.

### Comments

_No comments._

## #28 — Полный обмен контактами и связанными контактными лицами

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/28

### Body

## Parent

#1

## Problem

T08 (#9) реализует один подтверждённый вертикальный срез контакта, а не полный обмен контактами. Остальные поля, связи и направления должны быть установлены по карте полей и правилам сопоставления; текущие исследования не позволяют предполагать их.

## What to build

Завершить двусторонний обмен контактными записями Bitrix24 и соответствующими записями МойСклад (контактные лица и/или контрагенты там, где применимо) в границах первой версии. Использовать утверждённые карту полей и ключи. Сохранить существующее поведение T08 как первый вертикальный срез, расширяя его без регрессии. Не считать контактное лицо и контрагента взаимозаменяемыми сущностями; фактическое правило выбора целевого типа должно быть установлено и согласовано.

## Acceptance criteria

- [ ] Утверждены соответствия типов записей и правила связей контакт ↔ контрагент/контактное лицо на основе реальных данных; неизвестное остаётся TBD до проверки.
- [ ] Реализованы все утверждённые поля и направления карты, преобразования и обработка множественных PHONE/EMAIL и связей, если они включены.
- [ ] Создание, обновление, повтор события и обратное событие не создают дубликатов и не образуют цикл; используется сохранённая пара.
- [ ] Неоднозначные/неполные случаи видны в ручной проверке согласно правилам спецификации.
- [ ] T08 остаётся отдельным ранним вертикальным срезом; эта задача зависит от утверждённых входных решений, а не расширяет T08 догадками.

- Within the first-release contact/client scope, sync only contact name, company title/name, phones, email, required entity links, service pair IDs and duplicate exclusion under existing rules (Q26.57). Preserve existing legal/banking data without syncing or changing it; defer its exchange with future invoice phase (#18). Do not use these requisites as client-creation requirements based on this scope; verify actual API mandatory constraints separately. Other planned fields remain future scope and are not removed from the roadmap.

## Blocked by

- #9
- #10
- #11
- #26
- #27

## T26 research input

Use the published, evidence-bounded [T26 research map at merge commit c03357c](https://github.com/Makskaii/bitrix-moysklad-sync/blob/c03357cf91cb348376d043b64caf80816ca43443/research/t26-field-mapping.md) as an input. Technical verification of row-ID pairing and row operations remains open in #26; the map is not a complete accepted runtime allowlist.

### Comments

_No comments._

## #29 — On-demand baseline для исторических пар товаров и сделок/заказов

- State at archive: open
- URL: https://github.com/Makskaii/bitrix-moysklad-sync/issues/29

### Body

## Parent

#1

## Problem

Предыдущий черновик требовал полного исторического обхода и snapshots всех полей товаров, сделок/заказов и счетов, включая оценку порядка 1,8 млн заказов. По Q26.45 счета отложены после первого production launch, а Q26.66 задаёт сначала event-driven baseline и отдельно — облегчённый исторический ID/key inventory. Полный snapshot всей истории заказов не является launch gate.

## What to build

Для существующей пары товара или сделки/заказа, впервые затронутой событием, использовать подтверждённую пару из #11, прочитать текущее состояние обеих сторон и инициализировать baseline утверждённых полей синхронизации без внешней записи. Если начальные значения различаются, сохранить обе стороны. Исторический фоновый сбор ID и approved matching keys вынесен в дочерний #45; его результат не заменяет более свежий runtime baseline и не меняет подтверждённые/ручные пары.

Не снимать все поля исторических заказов и не создавать исторические записи. Фоновое покрытие не блокирует запуск или readiness. Карты счетов и их snapshots относятся к будущему этапу #18.

## Acceptance criteria

- [ ] При первом событии по существующей паре использовать существующее/однозначно подтверждённое соответствие из #11; прочитать актуальные обе стороны и сохранить baseline утверждённых sync-полей, ID, связей и времени изменения до применения изменений.
- [ ] Если значения обеих сторон различаются, сохранить оба как начальное несогласованное состояние; построение baseline само по себе не перезаписывает системы.
- [ ] При неоднозначной, непроверенной, неполной или недоступной паре направить событие на ручную проверку; не угадывать пару и не создавать historical record.
- [ ] Существующие подтверждённые/ручные пары и ранее сохранённый runtime baseline не перезаписываются устаревшим фоновым результатом.
- [ ] Runtime не требует полного обхода архива или полных field snapshots исторических заказов; старая запись без пары не приводит к созданию записи в другой системе.
- [ ] Счета и snapshots счетов не входят в первый production launch и остаются в #18.
- [ ] Отдельный исторический ID/key collector описан в #45; он не является блокером #16 или readiness.

## Blocked by

- #8 — ранний приём событий (закрыт; зависимость выполнена).
- #11 — подтверждение пары при первом событии.
- #26 — согласованный scope полей и технические read ограничения.

Q26.66 сохраняет прежние правила первичного состояния, приоритета МойСклад, конфликтов, дублей и запрета исторического mass-create. Меняется момент инициализации baseline; фоновым историческим ID/key scan управляет отдельный #45.

### Comments

_No comments._




