-- =====================================================================
-- Схема ядра магазина цифровых товаров (бэкенд)
-- PostgreSQL 16. Exactly-once и идемпотентность держатся на:
--   * UNIQUE-констрейнтах (event_id, code, request_id, order_id)
--   * CAS-переходах статусов (UPDATE ... WHERE status='...')
--   * FOR UPDATE SKIP LOCKED (захват job без гонок)
-- =====================================================================

-- Каталог товаров (Этап 1, Этап 5)
CREATE TABLE IF NOT EXISTS products (
  sku        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,                 -- topup | key | subscription | giftcard
  price      BIGINT NOT NULL,               -- целые единицы валюты (RUB)
  currency   TEXT NOT NULL DEFAULT 'RUB',
  image      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Горячий фильтр витрины по типу (Этап 5)
CREATE INDEX IF NOT EXISTS idx_products_type ON products(type);

-- Зеркало остатков для витрины (Этап 5): обновляется транзакционно при выдаче/пополнении
CREATE TABLE IF NOT EXISTS stock_mirror (
  sku        TEXT PRIMARY KEY REFERENCES products(sku),
  available  BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Заказы (Этап 1)
CREATE TABLE IF NOT EXISTS orders (
  id              BIGSERIAL PRIMARY KEY,
  order_id        TEXT NOT NULL UNIQUE,     -- публичный id "ord_00123"
  idempotency_key TEXT UNIQUE,              -- повторный POST /orders = тот же заказ
  status          TEXT NOT NULL DEFAULT 'created',
  amount          BIGINT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'RUB',
  code            TEXT,                     -- выданный ключ (при delivered)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- Позиции заказа (вменяемая схема данных)
CREATE TABLE IF NOT EXISTS order_items (
  id       BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku      TEXT NOT NULL REFERENCES products(sku),
  qty      INTEGER NOT NULL DEFAULT 1,
  price    BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB'
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- События оплаты: идемпотентность вебхука (event_id PK) + out-of-order
CREATE TABLE IF NOT EXISTS payment_events (
  event_id     TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL,               -- публичный id, может прийти раньше заказа
  status       TEXT NOT NULL,               -- paid | failed
  amount       BIGINT,
  currency     TEXT,
  created_at   TIMESTAMPTZ,                 -- бизнес-время из контракта
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  order_fk     BIGINT REFERENCES orders(id),-- nullable: линкуется позже
  applied_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_events(order_id);
-- частичный индекс: быстрый поиск необработанных событий (критерий 3, этап 4)
CREATE INDEX IF NOT EXISTS idx_payment_events_unapplied
  ON payment_events(order_id) WHERE applied_at IS NULL;

-- Попытки выдачи: дедуп запросов к поставщику (request_id UNIQUE — ловушка таймаута)
CREATE TABLE IF NOT EXISTS delivery_attempts (
  request_id TEXT PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id),
  provider   TEXT NOT NULL,                 -- A | B
  attempt    INTEGER NOT NULL,
  status     TEXT NOT NULL,                 -- ok | error | out_of_stock | timeout_exhausted
  code       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_order ON delivery_attempts(order_id);

-- Очередь выдачи: transactional outbox + атомарный захват job'а
CREATE TABLE IF NOT EXISTS delivery_jobs (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES orders(id),
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by   TEXT,
  locked_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Один активный job на заказ (защита от дублей); done-история не мешает
CREATE UNIQUE INDEX IF NOT EXISTS uq_delivery_jobs_active
  ON delivery_jobs(order_id) WHERE status IN ('pending','processing');

CREATE INDEX IF NOT EXISTS idx_delivery_jobs_next
  ON delivery_jobs(status, next_run_at) WHERE status IN ('pending','processing');

-- Журнал денежных движений (Этап 4): всегда сходится
CREATE TABLE IF NOT EXISTS money_ledger (
  id         BIGSERIAL PRIMARY KEY,
  order_id   TEXT NOT NULL,
  entry_type TEXT NOT NULL,                 -- payment (деньги пришли)
  amount     BIGINT NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'RUB',
  event_key  TEXT NOT NULL UNIQUE,          -- event_id
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ровно один платёж на заказ -> сумма журнала всегда сходится с оплаченными заказами
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_order_type ON money_ledger(order_id, entry_type);
