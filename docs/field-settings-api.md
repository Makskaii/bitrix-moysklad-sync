# Настройки полей: API и версия

Все маршруты доступны только администратору Bitrix24. Каталоги и предпросмотр выполняют только чтение внешних систем; они не пишут в Bitrix24/МойСклад, не регистрируют вебхуки и не создают фоновые задания.

## Настройки и версии

- `GET /api/admin/field-settings` возвращает `{ version, createdAt, config, references }` активной версии.
- `GET /api/admin/field-settings/versions/:version` возвращает неизменяемую сохранённую версию.
- `PUT /api/admin/field-settings` принимает `{ config }`, проверяет состав полей по текущим каталогам, записывает новый снимок и атомарно переключает active pointer. Ответ — новый `{ version, createdAt, config, references }`.
- `config.rules[]` содержит entity, sourceField/targetField и независимые `bitrix24ToMoysklad` / `moyskladToBitrix24` с `enabled` и `transform.kind` (`copy` или `tbd`). `config.groups[]` задаёт направленный `join-non-empty` с конфигурируемым разделителем. TBD сохраняется как неразрешённое преобразование и не должно применяться обработчиком.
- `config.references.units[]` и `priceTypes[]` сохраняют все текущие исходные записи, целевой UUID или `null`, подписи и состояние. Текущая доступность целевых UUID перепроверяется по live read-only каталогу перед активацией. Повторное назначение одной целевой единицы/типа цены двум исходным запрещено.
- `config.references.dictionaries[]` хранит идентификаторы типизированного поля/справочника и явные пары значений. Утверждённые стартовые пары — данные, а не доказательство готовности записи во внешнюю систему.

История версий append-only. Приём нового события сохраняет событие и его версию одним DB-транзакционным действием. Изменение active pointer влияет только на новые события. Retry/resume читает только `InboundEventSettings.settingsVersion`; он не запрашивает активную версию. Только подтверждённый individual recompute может перепривязать одно доступное событие к текущей версии. Bulk-replay API отсутствует.

## Каталоги

`GET /api/admin/field-settings/catalogs` получает актуальные единицы и типы цен из `catalog.measure.list`, `catalog.priceType.list`, `GET entity/uom` и `GET context/companysettings/pricetype`. Интеграционные провайдеры внедряются через `ReadOnlyFieldDataProvider`; тесты подменяют их HTTP boundary. Чтение Bitrix24 использует короткоживущий admin bearer текущего запроса, МойСклад — server-side `MOYSKLAD_API_TOKEN`; ни один токен не возвращается клиенту или в диагностику.

Внешние коллекции листаются явно. Ответ включает полную коллекцию, если она укладывается в установленные 20 страниц по 50 записей; при превышении лимита или ошибке источник возвращает 503, а не тихо обрезанный список. Для более крупных справочников интерфейс должен перейти на явный cursor/page запрос.

## Безопасный предпросмотр

`POST /api/admin/field-settings/preview` принимает `{ entity, direction, pairs: [{ sourceId, targetId }], config? }`. На один запрос разрешено 1–10 пар. Сервер загружает обе записи по ID из выбранной разрешённой пары сущностей, применяет draft config (либо текущую активную) и возвращает по каждой паре читаемую подпись, исходные значения, вычисленный результат, текущее значение target, ошибки, версию и `writes: 0`. Неуспешное чтение не представляется успешным предпросмотром. Ни записи полей, ни массовые выборки, ни PII в operational logs не выполняются.

## Внешние read-only методы

- Bitrix24: `catalog.measure.list`, `catalog.priceType.list`, для чтения пар — `crm.contact.get`, `crm.deal.get`, `crm.item.get` (entity type 31), `catalog.product.get`.
- МойСклад JSON API: `GET entity/uom`, `GET context/companysettings/pricetype`, и GET ресурсов пары для `counterparty`, `customerorder`, `invoiceout`, `product`.

Контракт не подтверждает product-row ID pairing, pack factor, права записи, production activation или разрешение выполнять исходящие вебхуки.
