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

```bash
# 1) БД
docker compose up -d          # PostgreSQL 16 на :5432 (app/app/shop)

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

21 тест, покрывают все 6 критериев приёмки + этапы 1/4/5:

| Файл | Проверяет |
|---|---|
| `test/race.test.js` | **Критерий 1**: 50 параллельных вебхуков paid → ровно один факт выдачи, один ключ |
| `test/idempotency.test.js` | **Критерий 2**: повторный `event_id` = no-op; идемпотентный `idempotency_key` |
| `test/out_of_order.test.js` | **Критерий 3**: вебхук раньше заказа; детерминированный порядок событий |
| `test/timeout.test.js` | **Критерий 4**: таймаут поставщика, который выдал код → повтор не создаёт вторую выдачу |
| `test/fallback.test.js` | **Критерий 5**: A недоступен → fallback на B, выдан ровно один раз |
| `test/stock.test.js` | **Критерий 6**: пустой остаток → восстановимое состояние, redeliver после пополнения |
| `test/orders.test.js` | Этап 1: создание/чтение заказов, валидация, идемпотентность |
| `test/reconciler.test.js` | Этап 4: сверка, ledger, линковка, admin-эндпоинты |
| `test/catalog.test.js` | Этап 5: 5000 SKU, план использует индексы, быстрое выполнение |

Каждый тест-файл поднимает отдельную тестовую БД `shop_test_<pid>` и свои поставщики
на эфемерных портах — файлы можно гонять параллельно.

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

> ВАЖНО: скрипт сбрасывает схему и данные dev-базы `shop` (чистая среда).

## Как воспроизвести отказ/фолбэк поставщика

```bash
npm run supplier-failure-demo
```

Скрипт: поставщик A настроен с `errorRate=1` (всегда 5xx), B исправен →
оплачиваем заказ → в отчёте видно: A — `error` (2 попытки), B — `ok` (1), заказ `delivered`.

---

## API

### POST `/orders` — создать заказ по SKU (Этап 1)
```json
{ "sku": "STEAM-TOPUP-500", "idempotency_key": "optional", "order_id": "optional" }
```
- `201` — создан, `200` — возвращён существующий (тот же ключ/order_id).
- `order_id` (клиентский) позволяет воспроизвести «вебхук раньше заказа»: если событие
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

## Переменные окружения

`DATABASE_URL`, `PORT`, `SUPPLIER_A_URL`, `SUPPLIER_B_URL`, `DELIVERY_TIMEOUT_MS`,
`DELIVERY_MAX_ATTEMPTS`, `DELIVERY_MAX_TIMEOUT_RETRIES`, `WORKER_POLL_INTERVAL_MS`,
`RECOVERY_INTERVAL_MS`, `STUCK_AFTER_MS`, `LOG_LEVEL`, … (см. `src/config.js`).

---

## Структура

```
src/
  index.js                 # запуск API + фоновые воркеры
  app.js                   # express: маршруты, 404, error-handler
  config.js                # env-конфигурация
  db.js                    # pg Pool, schema init, withTransaction
  catalog.js               # данные каталога (12 SKU) и пула ключей (50)
  routes/                  # orders, webhook, admin
  services/
    orderService.js        # создание/чтение заказов
    paymentService.js      # applyPaymentEvent (единая точка), handleWebhook, linkUnappliedEvents
    deliveryService.js     # outbox, claim (SKIP LOCKED), таймаут/повторы/fallback, фиксация
    supplierClient.js      # HTTP-клиент поставщика (fetch + AbortController)
    reconciler.js          # сверка, redeliver, recovery
    ledger.js              # money_ledger
  suppliers/
    mock.js                # заглушка поставщика A/B (дедуп по request_id/order_id, rates)
    server.js              # standalone HTTP-сервер поставщика
scripts/                   # seed, race-check, supplier-failure-demo, webhook-stub, reconcile
test/                      # node:test, 21 тест
```

---

## Сколько времени ушло

Разработка заняла **~7–8 часов** суммарно (планирование + реализация + тесты + README).
