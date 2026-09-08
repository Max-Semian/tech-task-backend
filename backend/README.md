# Backend — ядро магазина цифровых товаров

Тестовое задание «Бэкенд разработчик» (`../tz-backend.md`).
Ядро магазина цифровых товаров для геймеров: создание заказов по SKU, вебхук оплаты,
автоматическая выдача ключей через поставщиков-заглушки A/B с таймаутами, fallback'ом и
восстановлением. Все 5 этапов ТЗ реализованы.

---

## Стек

| Слой | Выбор |
|---|---|
| Runtime | Node.js 20 (ESM) |
| HTTP | Express 4 |
| БД | PostgreSQL 16 (Docker) — **единственный источник истины** |
| Драйвер | `pg` |
| Очередь выдачи | таблица `delivery_jobs` (transactional outbox) + `FOR UPDATE SKIP LOCKED` |
| Логи | `pino` (структурированный JSON) |
| Тесты | встроенный `node:test` |

Внешние брокеры (RabbitMQ/Kafka) **намеренно не используются**: все гарантии
exactly-once держатся на UNIQUE-констрейнтах, CAS-переходах статусов и транзакциях Postgres —
это проще и надёжнее для тестового задания.

---

## Быстрый старт

### Полный запуск в Docker (одна команда)

```bash
docker compose up -d --build    # db + app(:3000) + supplier-a/b + frontend(:8080)
```

- `db` — PostgreSQL 16 (healthcheck)
- `app` — API + фоновые воркеры выдачи/recovery; авто-сид каталога при старте (чистая БД)
- `supplier-a` / `supplier-b` — заглушки поставщиков (healthcheck по `/stock`)
- `frontend` — витрина (nginx, статические файлы `../frontend`) на **:8080**

Проверка: `curl http://127.0.0.1:3000/health`, витрина — `http://localhost:8080`.

Сценарии «в бою»:
- выдача ключа: `POST /orders` → `POST /webhook/payment` → `GET /orders/:id` (`delivered`)
- fallback: `docker compose stop supplier-a` → создать/оплатить заказ → выдача произойдёт
  через supplier-b (проверено: A — `timeout_exhausted`, B — `ok`)
- 50 параллельных вебхуков: ровно одна выдача, одна запись в `money_ledger`
- пустой остаток → `out_of_stock` → `/admin/stock/:sku/restock` + `/admin/orders/:id/redeliver`
  → `delivered` (проверено вживую)

### Локальный запуск (без Docker для приложения)

```bash
# 1) БД
docker compose up -d db          # PostgreSQL 16 на :5432 (app/app/shop)

# 2) зависимости
npm install

# 3) каталог + зеркало остатков
npm run seed

# 4) поставщики-заглушки (два процесса)
npm run supplier:a             # :4100
npm run supplier:b             # :4200

# 5) API (+ фоновые воркеры: выдача и recovery)
npm start                      # :3000
```

Проверить: `curl http://127.0.0.1:3000/health`.

---

## Тесты

```bash
npm test
```

54 теста: этап 1 (6 критериев приёмки + 1/4/5) + маркетплейс-слой этапа 2:

| Файл | Проверяет |
|---|---|
| `test/race.test.js` | **Критерий 1**: 50 параллельных вебхуков paid → ровно один факт выдачи, один ключ |
| `test/idempotency.test.js` | **Критерий 2**: повторный `event_id` = no-op; идемпотентный `idempotency_key` |
| `test/out_of_order.test.js` | **Критерий 3**: вебхук раньше заказа; детерминированный порядок событий |
| `test/timeout.test.js` | **Критерий 4**: таймаут поставщика, который выдал код → повтор не создаёт вторую выдачу |
| `test/fallback.test.js` | **Критерий 5**: A недоступен → fallback на B, выдан ровно один раз |
| `test/stock.test.js` | **Критерий 6**: пустой остаток → восстановимое состояние, redeliver после пополнения |
| `test/orders.test.js` | Этап 1: создание/чтение заказов, валидация, идемпотентность, приоритет `order_id` vs `idempotency_key`, конфликт 409 |
| `test/payment_failed.test.js` | Контракт вебхука: `status=failed` → `created → payment_failed`; повтор `event_id` = no-op; поздний `failed` после `paid` не откатывает |
| `test/reconciler.test.js` | Этап 4: сверка, ledger, линковка, admin-эндпоинты |
| `test/catalog.test.js` | Этап 5: 5000 SKU, план использует индексы, быстрое выполнение |
| `test/reservation_race.test.js` | **2-я часть, Задача 2**: N параллельных броней последней единицы → один победитель, 409 + альтернативы; двойной `purchase_key` → одна бронь |
| `test/reservation_lifecycle.test.js` | **Задачи 3+4**: expire (лениво+sweeper), CAS confirm, single-release held, оплата только до дедлайна, идемпотентность |
| `test/live_events.test.js` | **Задача 1**: SSE-события цена/остаток/restock доходят до клиента |
| `test/catalog_search.test.js` | **Задача 5**: поиск/фильтры/сортировка по 3000 офферов + EXPLAIN trgm |

Каждый тест-файл поднимает отдельную тестовую БД `shop_test_<pid>` и свои поставщики
на эфемерных портах — файлы можно гонять параллельно.

---

## Нагрузочное и A/B тестирование (Python + Playwright)

`loadtest/` — независимый от node-тестов набор на **Playwright (Python)** против запущенного стека.

```bash
python3 -m venv .venv && .venv/bin/pip install -r loadtest/requirements.txt

.venv/bin/python loadtest/ab_tests.py    # A/B-тесты поставщиков (14 проверок)
.venv/bin/python loadtest/loadtest.py 1000  # нагрузка: 1000 заказов + 1000 оплат
```

**`ab_tests.py`** — пути поставщиков A и B:
- A-путь (B остановлен) → выдаёт A; B-путь (A остановлен) → fallback на B, ровно одна выдача;
- нормальный флоу; идемпотентность `event_id`; вебхук раньше заказа.

**`loadtest.py [N]`** — N одновременных `POST /orders` + N вебхуков оплаты (Playwright async):
- перед прогоном: сброс БД, поставщики без отказов (env-оверрайд rate'ов), пополнение пула
  через `POST /admin/stock/:sku/restock` (коды делятся между A и B — без дублей);
- проверяет: все N доставлены ровно один раз, N уникальных кодов, журнал сходится,
  плюс бонус-гонка 50 параллельных вебхуков по одному заказу.

Результат прогона N=1000: создание 1000 заказов за ~2.5s (398 req/s), 1000 оплат за ~1.9s
(520 req/s), доставка 1000/1000 за ~6.5s — все проверки OK.

---

## Фуллстек: витрина (Этап 1) и промокод (Этап 4)

Витрина — чистый HTML/CSS/JS (без фреймворков), файлы в `../frontend/`:
`index.html` (витрина), `app.js` (интерактивы + флоу), `order.html` (страница статуса),
`admin.html`/`admin.js` (админка), `images/` (локальные ассеты).

### 5 обязательных интерактивов
1. **Карусель баннера** — авто-переключение, стрелки, активные точки-индикаторы.
2. **Меню «Каталог»** — открытие/закрытие по клику, закрытие кликом вне.
3. **Переключатель валют $/₸/₽** — активное состояние (пересчёт не нужен).
4. **Иконки сервисов** — плавное выделение при наведении.
5. **Карточки товаров** — подъём/тень при наведении.

### Флоу покупки
`Купить` (карточка или блок Steam) → модал с ценой → промокод (необязательно) →
`Оплатить (успех)` = `POST /orders` + `POST /orders/:id/pay {status:'paid'}` →
poll статуса → ключ выдан + ссылка на `order.html?id=...`.
`Оплатить (неуспех)` → `status:'failed'` → заказ `payment_failed`.

### Новые API-эндпоинты (фуллстек)
| Метод | Путь | Описание |
|---|---|---|
| GET | `/products` | каталог для витрины (sku, name, type, price, available) |
| POST | `/orders/:id/pay` | эмуляция оплаты `{status: paid\|failed}` → шлёт вебхук |
| POST | `/promo/validate` | проверка промокода без списания `{code, amount}` |
| POST | `/orders` | `{sku, promocode?}` — атомарное списание лимита + скидка на сервере |

### Промокоды (этап 4)
- Таблица `promocodes(code, type percent\|amount, value, currency, max_uses, used_count)`.
- Лимит соблюдается атомарно: `UPDATE promocodes SET used_count=used_count+1
  WHERE code=$1 AND used_count<max_uses RETURNING *` — под параллельными запросами
  применено **не более N раз** (тест `test/promocode.test.js`, 50 параллельных запросов → ровно 3).
- Скидку считает **только сервер**; итоговая сумма и промокод сохраняются в заказе.

### UI-тест (Playwright browser)
```bash
cd backend && .venv/bin/python loadtest/ui_smoke.py   # 13 проверок: витрина + флоу + админка
```

---

## Как воспроизвести проверку гонок

```bash
npm run race-check
```

Скрипт: создаёт заказ → шлёт **50 параллельных вебхуков «paid»** (разные `event_id`) →
обрабатывает очередь → печатает отчёт. Ожидаемый результат:

```json
{
  "order_status": "delivered",
  "successful_delivery_attempts": 1,
  "ledger_payment_entries": 1,
  "webhook_responses": { "all_200": true }
}
```

> Скрипт самодостаточен: поднимает одноразовую БД `shop_race_<pid>`, свой экземпляр
> приложения и свои заглушки поставщиков, а по завершении удаляет БД. Дев-база `shop`
> не трогается, поднятый `app` не мешает — нужен только Postgres (`docker compose up -d db`).
> Изоляция здесь обязательна: без неё воркер запущенного `app` перехватывает job через
> `FOR UPDATE SKIP LOCKED` и идёт в свои заглушки поставщиков, чей пул ключей скрипту
> не принадлежит, — и проверка падает на исправной системе.

## Как воспроизвести отказ/фолбэк поставщика

```bash
npm run supplier-failure-demo
```

Скрипт: поставщик A настроен с `errorRate=1` (всегда 5xx), B исправен →
оплачиваем заказ → в отчёте видно: A — `error` (2 попытки), B — `ok` (1), заказ `delivered`.

> Так же изолирован в одноразовой БД `shop_demo_<pid>`; дев-база не трогается.

---

## API

Полный справочник с примерами: [документация API](https://t-shell.uk/api-docs).
Машиночитаемая спека — [`openapi.yaml`](openapi.yaml) (OpenAPI 3.0.3, 11 операций);
открывается в Swagger Editor, Redoc, Postman или Insomnia без правок.


### POST `/orders` — создать заказ по SKU (Этап 1)
```json
{ "sku": "STEAM-TOPUP-500", "idempotency_key": "optional", "order_id": "optional" }
```
Семантика идемпотентности (приоритет):
1. **`order_id` — первичен**: если уже существует → `200` с этим заказом, переданные
   `sku`/`idempotency_key` **игнорируются** (никакого 409 из-за другого SKU).
2. **`idempotency_key` — вторичный**, применяется только когда `order_id` не передан:
   если ключ уже существует → `200` с этим заказом.
3. Новый `order_id` + `idempotency_key`, занятый **другим** заказом → `409
   idempotency_key_conflict` (не подменяем order_id тихо).
4. Гонка двух одинаковых POST → выигрывает существующий заказ (`200`), дубль не создаётся.

`order_id` (клиентский) позволяет воспроизвести «вебхук раньше заказа»: если событие
оплаты уже пришло, при создании оно применится автоматически.

### GET `/orders/:id` — статус заказа (Этап 1)
```json
{
  "order_id": "ord_...", "status": "delivered", "amount": 500, "currency": "RUB",
  "code": "LFXC-TNCS-BPCD", "items": [ ... ], "created_at": "...", "paid_at": "...", "delivered_at": "..."
}
```

### POST `/webhook/payment` — вебхук оплаты (контракт ТЗ)
```json
{
  "event_id": "evt_a1b2c3", "order_id": "ord_00123",
  "status": "paid", "amount": 500, "currency": "RUB",
  "created_at": "2025-01-01T12:00:00Z"
}
```
- Идемпотентен по `event_id`: повтор = `200` + `duplicate:true`, состояние не меняется.
- Отвечает быстро (`200`), выдача уходит в очередь — вебхук не блокируется на поставщике.
- `status: failed` → CAS `created → payment_failed` (симметрично).

### Admin (Этап 4)
- `GET /admin/reconciliation` — «оплачен, но не выдан» / «выдан, но не оплачен» + баланс журнала.
- `POST /admin/orders/:id/redeliver` — безопасная ручная повторная выдача (идемпотентна).
- `POST /admin/stock/:sku/restock` — пополнение остатка (добавляет ключи поставщикам и в зеркало).
- `GET /admin/ledger` — журнал денежных движений.

### Статусы заказа
`created → paid → delivering → delivered`
`created → payment_failed`
`paid → delivering → out_of_stock | delivery_failed` (восстановимые, повторная выдача безопасна)


---

## Ключевые решения

### 1. Exactly-once выдачи (критерии 1–2)
Пять независимых барьеров, каждый проверяется тестом:
1. `payment_events.event_id PRIMARY KEY` → повторный вебхук = `INSERT ... ON CONFLICT DO NOTHING` = no-op.
2. CAS-переход `UPDATE orders SET status='paid' WHERE order_id=$1 AND status='created'` —
   из 50 параллельных вебхуков выигрывает ровно один.
3. **Transactional outbox**: `delivery_jobs` вставляется в той же транзакции, что и `created→paid` —
   задача не теряется, а частичный `UNIQUE(order_id) WHERE status IN ('pending','processing')`
   гарантирует один активный job на заказ.
4. Захват job'а воркером — `FOR UPDATE SKIP LOCKED`: два воркера не возьмут один job.
5. Guard фиксации `UPDATE orders SET status='delivered', code=... WHERE status IN (...)` —
   даже повторное выполнение не создаст второй факт выдачи.

### 2. Ловушка таймаута (критерий 4)
Таймаут ≠ отказ: поставщик мог выдать код, но ответ потерялся. Поэтому:
- повтор после таймаута идёт с **тем же `request_id`**;
- заглушка-поставщик дедуплицирует по `request_id` и возвращает **тот же код**;
- `delivery_attempts.request_id UNIQUE` фиксирует это в БД.

### 3. Fallback A → B (критерий 5)
Попытки на A (повторы с бэкоффом), при исчерпании — fallback на B с новым `request_id`.
`request_id` нумеруется из `delivery_attempts` (`req_{order}-{N}`), поэтому между прогонами
выдачи (в т.ч. redeliver/recovery) id не повторяются и дедуп поставщика не возвращает устаревшие ответы.

### 4. Пустой остаток (критерий 6)
Оба поставщика ответили `out_of_stock` → заказ в `out_of_stock` (восстановимое состояние),
без падения. После пополнения (`/admin/stock/:sku/restock` + `/admin/orders/:id/redeliver`
или recovery-воркер) выдача повторяется ровно один раз.

### 5. Вебхук раньше заказа (критерий 3)
`payment_events.order_fk` nullable: событие сохраняется всегда (даже если заказа ещё нет),
ответ `200`. Линковка происходит:
- в `POST /orders` (в транзакции создания, если событие уже пришло),
- в recovery-воркере.
Порядок применения накопленных событий — `ORDER BY created_at ASC, processed_at ASC`
(бизнес-время, при равенстве — время приёма), применение через единый метод `applyPaymentEvent`.

### 6. Журнал денег, который всегда сходится (Этап 4)
`money_ledger` с `UNIQUE(order_id, entry_type)`: ровно одна запись `payment` на заказ.
Инвариант `SUM(ledger) == SUM(оплаченные заказы)` проверяется в сверке (`balance.ok`).

### 7. Каталог под нагрузкой (Этап 5)
Витрина остатков читает `stock_mirror(sku PK, available)` — денормализованный счётчик,
обновляется транзакционно при выдаче/пополнении. Точка-запрос — index lookup по PK,
фильтр витрины по типу — через `idx_products_type` (Bitmap Index Scan). Пример плана на 5000 SKU:
`Execution Time: ~14 ms`, `Bitmap Index Scan on idx_products_type`, `Index Scan using stock_mirror_pkey`.

---

## Восстановление и фоновые задачи

`src/worker.js` запускает два фоновых процесса:
- **poller очереди выдачи** — раз в `WORKER_POLL_INTERVAL_MS` (500 мс) берёт job'ы через
  `FOR UPDATE SKIP LOCKED` и выдаёт ключи;
- **recovery-воркер** — раз в `RECOVERY_INTERVAL_MS` (30 с):
  - линкует необработанные события оплаты к заказам;
  - возвращает «протухшие» job'ы в `pending` (lease: `locked_at < now() - JOB_LEASE_MS`);
  - доводит «зависшие» заказы (`paid`/`delivering` без активного job; опционально
    повторяет `out_of_stock`/`delivery_failed` после `STUCK_AFTER_MS`).

Повторная выдача всегда идемпотентна (guard-переход + дедуп по `request_id`).

---

## Маркетплейс-слой (2-я часть ТЗ)

Добавлено поверх ядра этапа 1, legacy-семантика не тронута.

- **Брони** — `POST /reservations {sku, purchase_key}`: атомарный условный `UPDATE stock_mirror
  SET held=held+1 WHERE sku=$1 AND available-held>=1`. Из параллельных запросов за последнюю
  единицу ровно один получает `201`, остальные — `409 just_sold_out` с `alternatives[]`
  (тот же `product_group` у других продавцов).
- **Подтверждение** — `POST /orders {reservation_id, promocode?}`: заказ по ТЕКУЩЕЙ цене,
  `pay_until = expires_at` брони. CAS `UPDATE reservations SET status='confirmed'
  WHERE id=$1 AND status='active' AND expires_at > now()` в той же транзакции — закрывает
  границу истечения и не даёт двух заказов на одну бронь. Legacy `POST /orders {sku}` — без изменений.
- **Учёт остатков** — `available` (пул ключей) − `held` (брони + заказы created/paid/delivering) =
  витринное «можно купить». `held` растёт при брони, падает при expire/cancel/payment_failed/delivered ровно один раз.
- **Срок жизни** — ленивое освобождение на read-пути (GET протухшей брони) + sweeper
  `expireMarketplaceHoldsOnce()` в recovery-воркере. Новый финальный статус заказа: `expired`.
- **Live** — `GET /events` (SSE): публикация ПОСЛЕ COMMIT, heartbeat 25 c. Клиент на open/reconnect
  сверяется полным `GET /products`. Через nginx-прокси — `proxy_buffering off` (см. frontend).
- **Каталог** — `products.seller`, `products.product_group`, `stock_mirror.held`, `orders.sku/pay_until`,
  `reservations`; поиск `pg_trgm` (GIN по `name`); генератор `catalogMarket.js` (детерминированный,
  тысячи офферов, пулы ключей A/B).

Новые эндпоинты: `/reservations`, `/reservations/:id`, `/reservations/:id/cancel`, `/orders/:id/cancel`,
`/orders/:id/pay` (+фактический статус в ответе), `/events`, `/admin/products/:sku/price`, расширенный `GET /products`.

### Сид маркетплейс-каталога

```bash
npm run seed-catalog-2 -- --count 3000     # или SEED_OFFERS=3000 при авто-сиде
```

---

## Переменные окружения

`DATABASE_URL`, `PORT`, `SUPPLIER_A_URL`, `SUPPLIER_B_URL`, `DELIVERY_TIMEOUT_MS`,
`DELIVERY_MAX_ATTEMPTS`, `DELIVERY_MAX_TIMEOUT_RETRIES`, `WORKER_POLL_INTERVAL_MS`,
`RECOVERY_INTERVAL_MS`, `STUCK_AFTER_MS`, `LOG_LEVEL`,
`RESERVATION_TTL_MS`, `SEED_OFFERS`, `LIVE_SIMULATE`, `CATALOG_DEFAULT_LIMIT`, `CATALOG_MAX_LIMIT`, … (см. `src/config.js`).

### `ADMIN_TOKEN` — защита админки

`/admin/*` умеет пополнять остатки и запускать повторную выдачу, поэтому наружу
её пускать нельзя. Поведение:

- **не задан** — проверка выключена. Локальный запуск и тесты работают как раньше;
  ТЗ это допускает («без авторизации или с простым токеном для админки»).
- **задан** — каждый запрос к `/admin/*` требует `Authorization: Bearer <token>`,
  иначе `401`. Токен сравнивается за постоянное время.

На публичном деплое переменная **обязательна**. Страница `admin.html` спрашивает
токен один раз и держит его в `localStorage`; при `401` очищает и просит заново.

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3000/admin/reconciliation
```

---

## Структура

```
src/
  index.js                 # запуск API + фоновые воркеры
  app.js                   # express: маршруты, 404, error-handler
  config.js                # env-конфигурация
  db.js                    # pg Pool, schema init, withTransaction
  catalog.js               # данные каталога (12 SKU) и пула ключей (50)
  routes/                  # orders, webhook, reservations, events, products, admin
  services/
    orderService.js        # создание/чтение заказов
    paymentService.js      # applyPaymentEvent (единая точка), handleWebhook, linkUnappliedEvents
    deliveryService.js     # outbox, claim (SKIP LOCKED), таймаут/повторы/fallback, фиксация
    supplierClient.js      # HTTP-клиент поставщика (fetch + AbortController)
    reconciler.js          # сверка, redeliver, recovery
    ledger.js              # money_ledger
    live.js                # SSE-шина (2-я часть)
    reservationService.js  # брони: атомарный захват, lazy release, cancel
    catalogMarket.js       # генератор каталога на тысячи офферов
    seedService.js         # авто-сид + seedMarketplaceTx
  suppliers/
    mock.js                # заглушка поставщика A/B (дедуп по request_id/order_id, rates)
    server.js              # standalone HTTP-сервер поставщика
scripts/                   # seed, race-check, supplier-failure-demo, webhook-stub, reconcile
test/                      # node:test, 54 теста
```

---

## Сколько времени ушло

Разработка ядра (этап 1) заняла **~7–8 часов** (планирование + реализация + тесты + README).

Этап 2 (маркетплейс: брони/гонка/SSE/поиск/витрина): **~2–2,5 часа активной работы**
(планирование и ревью плана — отдельно; чек-лист — `docs/PLAN-stage2.md`).
