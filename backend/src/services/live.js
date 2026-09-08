// Живая витрина (2-я часть ТЗ): in-process шина + SSE-рассылка.
// Публикация всегда выполняется ПОСЛЕ COMMIT транзакции — источник истины это БД,
// а событие лишь уведомляет уже подключённых клиентов (сверку они делают снапшотом).
// Апгрейд-путь на несколько реплик API: LISTEN/NOTIFY (Postgres) или Redis pub/sub.
import { EventEmitter } from 'node:events';
import { pool } from '../db.js';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export const LIVE_CHANNEL = 'offer';

// Перечитать состояние оффера из БД и разослать подписчикам SSE.
// available в событии — «можно купить прямо сейчас» = available - held.
export async function publishOffer(sku) {
  const res = await pool.query(
    `SELECT p.sku,
            p.price::int AS price,
            GREATEST(COALESCE(sm.available, 0) - COALESCE(sm.held, 0), 0)::int AS available,
            COALESCE(sm.held, 0)::int AS held
     FROM products p
     LEFT JOIN stock_mirror sm ON sm.sku = p.sku
     WHERE p.sku = $1`,
    [sku],
  );
  if (!res.rows.length) return null;
  const payload = { type: LIVE_CHANNEL, ts: Date.now(), ...res.rows[0] };
  bus.emit(LIVE_CHANNEL, payload);
  return payload;
}

// Демо-симулятор «живой» цены (LIVE_SIMULATE=1): мягко меняет цены случайных офферов,
// чтобы в двух открытых вкладках было видно синхронное изменение без действий оператора.
export function startLiveSimulator({
  intervalMs = 6000,
  stepPct = 0.04,
  touched = 2,
  priceMin = 50,
  log = () => {},
} = {}) {
  let timer = null;
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const tick = async () => {
    try {
      const skus = await pool.query(
        'SELECT sku, price::int AS price FROM products ORDER BY random() LIMIT $1',
        [touched],
      );
      for (const row of skus.rows) {
        const delta = Math.round(row.price * (Math.random() * 2 - 1) * stepPct);
        if (delta === 0) continue;
        const next = Math.max(priceMin, row.price + delta);
        const upd = await pool.query(
          'UPDATE products SET price=$2 WHERE sku=$1 RETURNING sku',
          [row.sku, next],
        );
        if (upd.rowCount === 1) {
          log({ sku: row.sku, price: next });
          await publishOffer(row.sku);
        }
      }
    } catch (e) {
      log({ err: e.message });
    }
  };
  timer = setInterval(() => tick().catch(() => {}), intervalMs);
  timer.unref?.();
  return stop;
}
