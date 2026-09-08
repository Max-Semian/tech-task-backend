# Этап 2 — живая витрина, гонка, бронь. План + чек-лист приёмки

> Статус: **выполнено 08.09.2026**. 54/54 теста зелёные, docker compose e2e подтверждено
> (SSE через nginx, гонка за последнюю единицу, доставка). Небольшие отличия схемы от плана:
> `reservations.id` — TEXT PK (`res_…`), `purchase_key`/`order_id` текстовые, `orders.reservation_id` —
> текст + частичный UNIQUE вместо FK. Поведение совпадает с планом.

---

## Ключевые архитектурные решения

- [x] **Гонка и бронь — атомарно на Postgres**, без очереди:
  `UPDATE stock_mirror SET held = held + 1 WHERE sku=$1 AND available - held >= 1 RETURNING ...`
  Ровно один победитель при остатке 1; проигравший сразу получает `409` с альтернативами.
- [x] **Бронь — отдельный ресурс** (`reservations`), заказ создаётся при подтверждении брони по **текущей** цене. Legacy `POST /orders {sku}` из этапа 1 не меняется и не трогается.
- [x] **Учёт остатков**: `available` (физический пул) − `held` (активные брони + заказы `created/paid/delivering`) = витринное «можно купить». Инвариант «нет оплаченного заказа без товара»: выдано + `held` ≤ пул.
- [x] **Real-time**: `GET /events` (SSE) + in-process шина (EventEmitter), публикация **после COMMIT**. Heartbeat каждые ~25 с. Клиент на каждый `open`/reconnect делает полный снапшот `GET /products`. Апгрейд-путь на несколько реплик — `LISTEN/NOTIFY` → Redis pub/sub, задокументировать, не реализовывать.
- [x] **Таймеры**: ленивое освобождение на read-пути + sweeper в recovery-воркере как backstop. Expire/Cancel/`payment_failed` возвращают товар и публикуют SSE.
- [x] **Устойчивость покупки**: `purchase_key` в `sessionStorage`, идемпотентность на бэке (`UNIQUE(purchase_key)`, `reservation_id`-ссылка у заказа, существующие CAS/`event_id`), авто-опрос статуса при обрыве.
- [x] **Поиск по тысячам**: серверный `GET /products` + `pg_trgm` GIN-индекс; на клиенте debounce + `AbortController` + монотонный `seq` + URL-состояние фильтров.

---

## ⚠️ Правки по ревью (обязательны к реализации)

- [x] **nginx для `/events`**: `proxy_buffering off;` и `proxy_read_timeout` больше heartbeat-интервала (> 25 с) на `location /events`. Без этого SSE будет буферизоваться прокси в докеризованном деплое — работает в dev напрямую в Express, ломается после `docker compose up` через nginx фронта. Проверить руками: открыть вкладку через nginx-порт, а не напрямую в API-порт, и убедиться, что события доходят с задержкой < 1 c.
- [x] **Защита от двойного decrement `held`**: при подтверждении брони (`POST /orders {reservation_id}`) статус брони переводится `active → confirmed` **в той же транзакции**, что и создание заказа. Sweeper (`expireReservationsOnce()`) обязан выбирать брони строго `WHERE status='active'` — подтверждённая бронь физически не должна попадать в эту выборку повторно. Отдельно проверить: `created`-заказ с истёкшим `pay_until` освобождает `held` ровно один раз (не пересекается с release от уже-`confirmed` брони).
- [x] **Явный CAS-guard на подтверждении брони**: `UPDATE reservations SET status='confirmed' WHERE id=$1 AND status='active' AND expires_at > now() RETURNING *` — в одной транзакции с вставкой заказа. Если `UPDATE` не затронул строк → `409 reservation_expired`. Это закрывает гонку «подтверждение ровно на границе истечения TTL параллельно с lazy-release от чужого `GET /reservations/:id`».

---

## Схема (`backend/schema.sql`, идемпотентные миграции)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- products
ALTER TABLE products ADD COLUMN IF NOT EXISTS seller TEXT DEFAULT 'GameMarket';
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_group TEXT;
CREATE INDEX IF NOT EXISTS idx_products_group ON products(product_group);
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin(name gin_trgm_ops);

-- stock_mirror
ALTER TABLE stock_mirror ADD COLUMN IF NOT EXISTS held BIGINT NOT NULL DEFAULT 0;

-- orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sku TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_orders_pay_until
  ON orders(pay_until) WHERE status='created' AND pay_until IS NOT NULL;

-- reservations (новая)
CREATE TABLE IF NOT EXISTS reservations (
  id           BIGSERIAL PRIMARY KEY,
  sku          TEXT NOT NULL REFERENCES products(sku),
  status       TEXT NOT NULL DEFAULT 'active', -- active | confirmed | cancelled | expired
  purchase_key TEXT UNIQUE NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  order_id     BIGINT REFERENCES orders(id),
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reservations_status_expires
  ON reservations(status, expires_at);
```

- [x] Миграции применены, существующие таблицы этапа 1 не меняют семантику.

---

## API

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/products?q=&type=&seller=&sort=&in_stock=1&limit=&offset=` | поиск/фильтр/пагинация; `available = available−held`; `X-Total-Count`; без параметров — прежний массив (обратная совместимость) |
| `POST` | `/reservations {sku, purchase_key}` | атомарная бронь → `201 {id, expires_at, price, sku}`; повтор `purchase_key` → `200` та же бронь; нет остатка → `409 {error:'just_sold_out', alternatives:[...]}` |
| `GET` | `/reservations/:id` | состояние + ленивое освобождение при истечении |
| `POST` | `/reservations/:id/cancel` | явная отмена, возврат единицы |
| `POST` | `/orders {reservation_id, promocode?}` | подтверждение по **текущей** цене, CAS `active→confirmed` (см. правку 3), `pay_until`; `409 reservation_expired`; идемпотентен по `reservation_id`. Legacy `POST /orders {sku}` — не изменён |
| `POST` | `/orders/:id/pay` | без изменений + текущий статус заказа в ответе (для resume) |
| `POST` | `/admin/products/:sku/price` | смена цены + публикация SSE |
| `POST` | `/admin/stock/:sku/restock` | (есть) + публикация SSE |
| `GET` | `/events` | SSE-поток `{type:'offer', sku, price, available, ts}` + heartbeat |

- [x] Все эндпоинты реализованы и покрыты тестами.

---

## Бэкенд: файлы

- [x] `src/services/live.js` — EventEmitter-шина + `publishOffer(sku, patch)`
- [x] `src/routes/events.js` — SSE-хендлер
- [x] `src/services/reservationService.js` — атомарная бронь, ленивое освобождение, отмена, **CAS-подтверждение (правка 3)**
- [x] `src/routes/reservations.js`
- [x] `src/services/orderService.js` — ветка «из брони»; legacy-путь не тронут
- [x] `src/services/paymentService.js` — при `failed` освобождать `held`; оплата после истечения принята, но не применена
- [x] `src/services/deliveryService.js` — `delivered`: `available−1, held−1` одним `UPDATE` + SSE
- [x] `src/services/reconciler.js` — `expireReservationsOnce()` **со строгим `WHERE status='active'` (правка 2)**
- [x] `src/routes/products.js`, `src/routes/admin.js`, `src/app.js`, `src/config.js`
- [x] `seedService.js` + `scripts/seed-catalog-2.js` — большой каталог (тысячи офферов, продавцы, группы, пулы ключей A/B)
- [x] **nginx конфиг**: `proxy_buffering off` + увеличенный `proxy_read_timeout` на `/events` (правка 1)

## Фронтенд: файлы

- [x] `frontend/live.js` — `LiveStore`: SSE, авто-reconnect, снапшот-сверка, апдейт DOM карточек на лету
- [x] `frontend/catalog.js` — серверная пагинация/поиск/фильтры/сортировка, debounce+abort+seq, URL-состояние, `popstate`
- [x] `frontend/checkout.html` + `checkout.js` — обратный отсчёт от `expires_at`, живая цена + подтверждение при изменении, оплата успех/неуспех, отмена брони, резюм после refresh/обрыва/Back
- [x] `index.html` — карточка: продавец, «Осталось N», disabled при 0
- [x] `order.html`/`app.js` — статус `expired`, единый флоу через резервацию
- [x] `admin.html`/`.js` — смена цены

---

## Тесты

- [x] `reservation_race.test.js` — последняя единица: N параллельных броней → один победитель, остальные `409` + `alternatives`; двойной `purchase_key` → одна бронь
- [x] `reservation_lifecycle.test.js` — expire (лениво и sweeper), cancel, `payment_failed`, подтверждение по новой цене, дубль-подтверждение идемпотентен, оплата после истечения не применяется
- [x] **новый кейс**: подтверждённая (`confirmed`) бронь не попадает повторно в `expireReservationsOnce()`, `held` освобождается ровно один раз при истечении `pay_until` заказа (правка 2)
- [x] `live_events.test.js` — SSE: бронь/delivered/restock/цена → события с верными полями; heartbeat
- [x] `catalog_search.test.js` — 3000+ офферов: фильтры/поиск/сортировка/пагинация + `EXPLAIN` по trgm-индексу
- [x] Регрессия: все тесты этапа 1 остаются зелёными

---

## Чек-лист приёмки (сопоставление с ТЗ)

### Задача 1 — живая витрина
- [x] Изменение цены/наличия видно во всех открытых вкладках без перезагрузки
- [x] Остаток = 0 → кнопка «Купить» недоступна у всех сразу
- [x] Подорожание видно на checkout **до** оплаты, а не после
- [x] Работает после обновления страницы и после обрыва связи (снапшот на reconnect)

### Задача 2 — гонка за последнюю единицу
- [x] Последнюю единицу получает только один покупатель
- [x] Второй сразу видит «раскупили» + альтернативы/возврат к товару
- [x] Нет оплаченного заказа без товара из-за гонки

### Задача 3 — бронь с таймером
- [x] Видимый обратный отсчёт на странице оформления
- [x] По истечении — бронь снимается, товар возвращается в продажу у всех
- [x] Успешная оплата — таймер больше не влияет на заказ
- [x] Один товар не бронируется под два заказа одновременно

### Задача 4 — устойчивость покупки (бонус)
- [x] Двойной клик / Назад / обновление / обрыв не создают второй заказ и не задваивают оплату
- [x] После любого действия — верный статус на экране
- [x] Повторная оплата уже оплаченного заказа ничего не меняет

### Задача 5 — мгновенный поиск (бонус)
- [x] Результат обновляется по мере ввода без задержек/морганий
- [x] Устаревшие ответы не перетирают свежие
- [x] Фильтры сохраняются в URL и открываются по прямой ссылке

---

## Документация и сдача

- [x] `README.md` — запуск, демо-сценарии, решения, апгрейд-пути (`LISTEN/NOTIFY` → Redis pub/sub → CDC/Kafka; ES/Meilisearch для поиска)
- [x] `backend/README.md`, `openapi.yaml` обновлены
- [x] Ответ по форме ТЗ: ссылка/инструкция запуска, репозиторий, сценарии «живое обновление» и «гонка за последнюю единицу», фактическое время

---

## Порядок реализации и оценка времени

1. Схема + миграции — 0.5 ч
2. `reservationService` + API + sweeper (с правками 2 и 3) — 2.5 ч
3. SSE/`live.js` на бэке (с nginx-конфигом, правка 1) — 1 ч
4. Тесты гонки/брони/live — 1.5 ч
5. Каталог/поиск + seed — 1.5 ч
6. Фронтенд: live → checkout → устойчивость → поиск — 4–5 ч
7. e2e/README/docs/деплой — 1–2 ч

**Итого:** ориентировочно 12–16 ч, фактическое время зафиксировать в README.
