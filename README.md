# Локальный контур сервиса

Требуется Docker Desktop с Docker Compose. Запустить PostgreSQL, API и интерфейс можно одной командой из каталога проекта:

```sh
docker compose up --build
```

Откройте http://localhost:5173. API доступен на http://localhost:3000, а `GET /health` проверяет и API, и соединение с PostgreSQL. Prisma применяет миграцию при запуске API. Локальная БД использует только демонстрационные реквизиты и не подключается к Bitrix24 или МойСклад.

Проверка сохранения через API и повторного чтения созданной записи:

```sh
docker compose --profile test run --build --rm smoke
```

Тест создаёт одну запись с уникальным сообщением и проверяет, что API возвращает её в списке.

Проверка через браузер (форма → API → PostgreSQL → отображение после перезагрузки):

```sh
docker compose --profile test run --build --rm browser-smoke
```

Интерфейс использует относительные `/api` и `/health` адреса. Nginx проксирует их на API внутри Compose, поэтому браузеру нужен только origin интерфейса.
