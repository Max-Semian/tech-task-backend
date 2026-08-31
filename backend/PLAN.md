# План реализации — Бэкенд (ядро магазина цифровых товаров)

> Трекинг выполнения по этапам. Обновляется по мере реализации.
> ТЗ: `../tz-backend.md`

## Стек (финальный)

- Node.js 20 (ESM) + Express 4 + `pg` + `pino` (структурированные логи)
- PostgreSQL 16 (Docker)
- Очередь выдачи: таблица `delivery_jobs` (transactional outbox) + `FOR UPDATE SKIP LOCKED`
- Без внешних брокеров (RabbitMQ/Kafka) — все гарантии держатся на UNIQUE-констрейнтах и транзакциях Postgres
- Тесты: встроенный `node:test` (без фреймворков)

## Статусы этапов

- [x] **Этап 0 — Инфраструктура**
  - [x] Структура каталога `backend/`
  - [x] `docker-compose.yml` (PostgreSQL 16)
  - [x] `package.json` (express, pg, pino; npm-скрипты)
  - [x] `schema.sql` — вся схема + индексы (в т.ч. Этап 5)
  - [x] `src/catalog.js` — данные каталога (12 SKU) и пула ключей (48)
  - [x] `scripts/seed.js` — продукты + stock_mirror

- [x] **Этап 1 — Ядро API** (обязательный)
  - [x] `POST /orders` (по SKU, идемпотентный ключ, опциональный order_id + линковка событий)
  - [x] `GET /orders/:id` (статус, код, items, тайминги; 404)
  - [x] `POST /webhook/payment` (идемпотентно по event_id, CAS created→paid, outbox, 200 OK)
  - [x] **Единая точка применения события** `applyPaymentEvent(orderId, event)` в
        `src/services/paymentService.js` — используется и вебхуком, и линковкой в `POST /orders`,
        и reconciler'ом: CAS + outbox-job + ledger не разъезжаются
  - [x] Корректные статусы: created → paid → delivering → delivered (+ ветки сбоев)
  - [x] Тест `test/orders.test.js`

- [x] **Этап 2 — Exactly-once под гонками** (обязательный, ключевой)
  - [x] `event_id UNIQUE` → повтор вебхука = no-op
  - [x] CAS `UPDATE orders SET status='paid' WHERE status='created'` — из 50 выигрывает один
  - [x] Outbox `delivery_jobs` в той же транзакции (не теряется)
  - [x] Guard фиксации выдачи `WHERE status IN (...)` — ровно один факт
  - [x] **`stock_mirror` обновляется транзакционно**: декремент `available-1` в ТОЙ ЖЕ
        транзакции фиксации выдачи (guard delivered), инкремент при restock — зеркало не
        разъезжается с реальным остатком под гонками
  - [x] `scripts/race-check.js` — 50 параллельных вебхуков
  - [x] Тест `test/race.test.js`

- [x] **Этап 3 — Устойчивые интеграции + ловушка таймаута** (желательный)
  - [x] Заглушки поставщиков A/B (`src/suppliers/mock.js`): errorRate/timeoutRate настраиваемые
  - [x] Дедуп по `request_id` (повтор возвращает тот же код)
  - [x] Таймаут ≠ отказ: повтор с тем же request_id после таймаута
  - [x] Повторы с бэкоффом + fallback A→B
  - [x] `delivery_attempts.request_id UNIQUE`
  - [x] `scripts/supplier-failure-demo.js`
  - [x] Тесты `timeout.test.js`, `fallback.test.js`, `stock.test.js`

- [x] **Этап 4 — Сверка, наблюдаемость, восстановление** (бонус)
  - [x] pino-логи по платежам и выдаче
  - [x] `GET /admin/reconciliation` — «оплачен, не выдан» / «выдан, не оплачен»
  - [x] `POST /admin/orders/:id/redeliver` — безопасная повторная выдача
  - [x] `POST /admin/stock/:sku/restock` — пополнение остатка
  - [x] Recovery worker — доводка «зависших» заказов + возврат протухших job'ов (lease)
  - [x] `money_ledger` — всегда сходится (UNIQUE order_id+entry_type)
  - [x] Тест `test/reconciler.test.js`

- [x] **Этап 5 — Каталог под нагрузкой** (бонус)
  - [x] `stock_mirror(sku PK, available)` — O(1) чтение остатков
  - [x] Индекс `products(type)` + объяснение плана (index scan)
  - [x] **`scripts/seed-bench.js`** — синтетический каталог на масштаб (тысячи+ SKU,
        `npm run seed-bench -- --count 10000`), источник данных для `catalog.test.js`
        и EXPLAIN в README
  - [x] `EXPLAIN`-проверка в `test/catalog.test.js` + пояснение в README

- [x] **Завершение**
  - [x] `README.md` (запуск, тесты, воспроизведение гонок/отказов, записка по решениям)
  - [x] Фактическое время в README
  - [x] Все тесты зелёные: `npm test`

## Критерии приёмки (сопоставление)

1. [ x] 50 параллельных вебхуков «оплачено» по заказу → ровно один факт выдачи (`race.test.js`)
2. [ x] Повторный вебхук с тем же `event_id` ничего не меняет (`idempotency.test.js`)
3. [ x] Вебхук вне порядка / раньше заказа → обработано корректно (`out_of_order.test.js`)
4. [ x] Таймаут поставщика, который выдал код → повтор не создаёт вторую выдачу (тот же request_id) (`timeout.test.js`)
5. [ x] Поставщик A недоступен → fallback на B, товар выдан ровно один раз (`fallback.test.js`)
6. [ x] Пустой остаток → восстановимое состояние, без падения (`stock.test.js`)

## Ключевые решения (кратко)

1. **Идемпотентность вебхука** — `payment_events.event_id PRIMARY KEY`, `INSERT ... ON CONFLICT DO NOTHING`.
2. **Exactly-once выдачи** — CAS-переходы статусов (`UPDATE ... WHERE status='...'`) + guard фиксации:
   только первый выигравший переход засчитывается; повтор — no-op.
3. **Ловушка таймаута** — при таймауте повтор идёт с тем же `request_id`; поставщик обязан вернуть
   тот же код (дедуп по `request_id`). Таймаут ≠ отказ.
4. **Очередь выдачи** — transactional outbox в той же транзакции, что и `created→paid`:
   job не теряется; захват job'а через `FOR UPDATE SKIP LOCKED`; один активный job на заказ
   (частичный уникальный индекс).
5. **Out-of-order вебхук** — `payment_events.order_fk` nullable; событие сохраняется, линковка
   в `POST /orders` и reconciler в порядке `created_at, processed_at`.
6. **Журнал денег** — `money_ledger` с `UNIQUE(order_id, entry_type)`: один платёж на заказ,
   сумма журнала всегда сходится с оплаченными заказами.
7. **Каталог под нагрузкой** — `stock_mirror` с PK по sku + индекс по типу: чтение витрины O(1)/O(n) малым
   скан; без агрегатов по сотням тысяч строк.


План закрывает все критерии приёмки, финальный стек оправдан (transactional outbox вместо брокеров — то, что и обсуждали). Три момента, которые стоит явно вписать в чек-лист до старта, иначе всплывут по ходу реализации:

**1. `applyPaymentEvent` как общий сервисный метод — потерялся из чек-листа.** Обсуждали это в прошлый раз (чтобы `/webhook/payment` и линковка в `POST /orders` не разошлись в логике CAS+outbox). В текущем плане оба пункта в Этапе 1 расписаны раздельно, явной общей функции нет. Добавьте пункт `src/services/paymentService.js: applyPaymentEvent(orderId)` в Этап 1 — иначе велик риск дублировать логику вставки outbox-job в двух местах.

**2. `stock_mirror` не привязан к транзакции выдачи в Этапе 2.** В Этапе 5 `stock_mirror(sku, available)` заявлен как источник для витрины, но его обновление (декремент при резервации ключа, инкремент при restock) нигде явно не значится в чек-листе Этапа 2/4. Если обновлять его отдельным запросом вне транзакции `FOR UPDATE SKIP LOCKED`-захвата ключа — он разъедется с реальным остатком при гонках. Добавьте явно: `UPDATE stock_mirror SET available = available - 1 WHERE sku=$1` в той же транзакции, что и захват ключа в Этапе 2.

**3. Для Этапа 5 нужен отдельный синтетический сид на масштаб.** `scripts/seed.js` грузит 12 SKU / 48 ключей — реального каталога из задания. На таком объёме планировщик Postgres просто сделает seq scan, и `EXPLAIN` не покажет index-only scan вообще (задание прямо говорит "тысячи+ SKU"). Нужен отдельный скрипт (например `scripts/seed-bench.js`) на несколько тысяч синтетических SKU + ключей именно для `catalog.test.js` и объяснения плана в README — иначе тест этапа 5 формально есть, а по факту не демонстрирует то, что должен.

С этими тремя добавлениями план полный и без слепых зон — можно запускать Этап 0.