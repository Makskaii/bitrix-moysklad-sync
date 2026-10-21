# Dry-проверка вебхуков сделки и заказа

Инструкция охватывает событие сделки Bitrix24 и заказа покупателя МойСклад. Процесс dry принимает событие в отдельную БД/схему из `DRY_DATABASE_URL`, читает актуальные документы и выполняет доступные зависимости и настройки в тестовой БД. Поддерживаемые write processors сохраняют proposed fields и виртуальный readback в dry БД, но не записывают изменения обратно во внешние системы. Это не переключает рабочий обмен и не заменяет HTMLStudio.

## Матрица событий

| Система | Что выбрать | HTTP endpoint нашего сервиса | Что проверяется |
| --- | --- | --- | --- |
| Bitrix24 | `ONCRMDEALADD` | `POST https://<публичный-домен>/webhooks/bitrix24` | Создание сделки |
| Bitrix24 | `ONCRMDEALUPDATE` | Тот же endpoint | Изменение сделки, включая смену стадии внутри воронки |
| Bitrix24 | `ONCRMDEALDELETE` | Тот же endpoint | Удаление сделки |
| МойСклад | сущность `customerorder`, действие `CREATE` | `POST https://<публичный-домен>/webhooks/moysklad/<секретный-путь>` | Создание заказа покупателя |
| МойСклад | сущность `customerorder`, действие `UPDATE` | Тот же endpoint | Изменение заказа покупателя |
| МойСклад | сущность `customerorder`, действие `DELETE` | Тот же endpoint | Удаление заказа покупателя |

Перечень предназначен для первичной dry-проверки этих двух типов документов, а не для всех будущих сущностей обмена. У Bitrix24 отдельное событие перехода сделки в другую воронку (`ONCRMDEALMOVETOCATEGORY`) нельзя выбрать как обычный исходящий вебхук; официальная документация указывает для него `event.bind`. Поэтому перемещение между воронками не входит в эту проверку. Смена стадии в одной воронке приходит как обычный `ONCRMDEALUPDATE`.

Источники форматов и доступных действий: [события сделок Bitrix24](https://apidocs.bitrix24.com/api-reference/crm/deals/events/index.html), [исходящие вебхуки Bitrix24](https://apidocs.bitrix24.com/local-integrations/local-webhooks.html), [вебхуки МойСклад](https://github.com/moysklad/workbook-api-doc/blob/master/pages/workbook/articles/webhooks.md). В Bitrix24 в запросе проверяется `auth.application_token`; этот объект исключается из сохраняемого тела и журналов. МойСклад добавляет `requestId`; события доставки в `events[]` сохраняются по одному, повтор доставки с тем же `requestId` не создаёт новые записи.

## Подготовка сервиса

1. Развернуть сервис по публичному HTTPS-домену с действительным сертификатом. Локальный адрес, HTTP и самоподписанный сертификат для исходящих вебхуков не подходят.
2. Передавать процессу `SYNC_MODE=dry`, `DATABASE_URL` рабочего режима и отдельный `DRY_DATABASE_URL`. Используйте отдельную disposable PostgreSQL schema или БД. Приложение откажется запускаться, если цели совпадают, включая случай с тем же сервером, БД и schema, записанной другим URL способом. Примените миграции к обоим контурам.
3. Сгенерировать случайное значение для `MOYSKLAD_WEBHOOK_SECRET` и сохранить его в менеджере секретов окружения. Подставлять его в путь webhook, не в query-параметр. Не помещать значение в репозиторий, тикет, скриншот, командную строку или журнал. До регистрации подписок настройте внешний reverse proxy так, чтобы access log не записывал секретный сегмент `/webhooks/moysklad/<secret>`; приложение этот путь в своих диагностических строках не выводит.
4. Настроить секреты запуска. Значение `BITRIX24_EVENT_APPLICATION_TOKEN` появится после создания исходящего вебхука Bitrix24; скопировать его в секреты окружения и перезапустить сервис. Токены доступа МойСклад для вызова JSON API не являются значением `MOYSKLAD_WEBHOOK_SECRET`.
5. Установить общий режим сервиса `on`, чтобы endpoint принимал доставки. Фиксированный `SYNC_MODE=dry` по-прежнему направляет события в тестовую БД и не включает запись в обе системы. При общем режиме `off` endpoint отвечает `410` и ничего не сохраняет.

## Создание подписок

### Bitrix24

1. Откройте «Разработчикам → Другое → Исходящий вебхук» в портале.
2. Укажите `https://<публичный-домен>/webhooks/bitrix24` без query-параметров.
3. Выберите ровно `OnCrmDealAdd`, `OnCrmDealUpdate`, `OnCrmDealDelete` и сохраните вебхук.
4. Bitrix24 автоматически покажет токен приложения. Сохраните его в менеджере секретов как `BITRIX24_EVENT_APPLICATION_TOKEN`, затем перезапустите сервис. Не добавляйте токен в тикет, файл или диагностический вывод.

Bitrix24 посылает POST с `event`, `data.FIELDS.ID` и `auth.application_token`. На обновлении приходит ID сделки, а не перечень изменённых полей.

### МойСклад

Подписки создаются через JSON API, учётная запись должна иметь права администратора, а тариф должен поддерживать вебхуки. Создайте три вебхука с одним и тем же секретным URL и разными действиями: `CREATE`, `UPDATE`, `DELETE`; для каждого установите `entityType: "customerorder"`. URL имеет вид `https://<публичный-домен>/webhooks/moysklad/<значение-MOYSKLAD_WEBHOOK_SECRET>`.

Пример PowerShell для создания подписок. API-токен запрашивается скрыто и остаётся только в памяти процесса; ответ API не печатается, потому что в нём содержится URL с секретом. Выполняйте этот блок в обычном административном окне PowerShell без включённой записи сессии (`Start-Transcript`). Сначала задайте в секретах развёртывания то же значение `MOYSKLAD_WEBHOOK_SECRET`.

```powershell
$secureApiToken = Read-Host 'МойСклад API access token' -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureApiToken)
$apiToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
$webhookSecret = Read-Host 'MOYSKLAD_WEBHOOK_SECRET из менеджера секретов' -AsSecureString
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($webhookSecret)
$secretValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
$publicHost = Read-Host 'Публичный HTTPS-домен сервиса, без завершающего /'
$targetUrl = "$publicHost/webhooks/moysklad/$secretValue"
$headers = @{ Authorization = "Bearer $apiToken" }
try {
  foreach ($action in @('CREATE', 'UPDATE', 'DELETE')) {
    $body = @{ url = $targetUrl; entityType = 'customerorder'; action = $action } | ConvertTo-Json
    [void](Invoke-RestMethod -Method Post -Uri 'https://api.moysklad.ru/api/remap/1.2/entity/webhook' -Headers $headers -ContentType 'application/json' -Body $body)
  }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  $apiToken = $null
  $secretValue = $null
  $targetUrl = $null
  $headers = $null
  $body = $null
}
```

Создание вебхука — это регистрация подписки, а не запись документа в систему. Входящие события МойСклад содержат `events[]` с действием и ссылкой на документ; повтор доставки сохраняет тот же `requestId`.

## Проверка и диагностика

1. Авторизуйтесь в диагностическом API учётной записью администратора Bitrix24.
2. Откройте `GET https://<публичный-домен>/api/admin/dry-webhooks` с `Authorization: Bearer <токен-пользователя-Bitrix24>`. Это служебный API с проверкой `user.admin == true`; не публикуйте его ответ.
3. В отчёте каждая из шести подписок имеет состояние `not_checked`, `event_received`, `rejected_validation` или `processing_error`. Строки событий содержат тип, время, ID события/записи, состояние и безопасную категорию ошибки. Тело webhook, токены и секретный путь в отчёт не попадают. Последние 100 отказов и ошибок приёма держатся в памяти работающего процесса; события, принятые в dry, читаются из изолированной БД.
4. Создайте или измените отдельный тестовый документ в каждой системе и проверьте `event_received`. Для проверки удаления используйте только заранее созданный одноразовый документ, без удаления рабочих сделок или заказов.
5. Удалите тестовый документ после проверки. Не повторяйте события dry в режиме apply: история dry не переигрывается при переключении.

Неверный application token/секрет даёт HTTP `401`, безопасную запись `rejected_validation` без тела запроса и без строки `InboundEvent`. Ошибка БД даёт `processing_error`; успешный приём подтверждается только после сохранения всех событий доставки. Проверка реальной доставки возможна лишь после публикации HTTPS-адреса и ручного создания подписок владельцем.

Локальные автоматические HTTP-проверки используют имитацию PostgreSQL и не обращаются к порталам:

```sh
npm ci
npm run db:generate
npm run test:events --workspace @sync/api
```
