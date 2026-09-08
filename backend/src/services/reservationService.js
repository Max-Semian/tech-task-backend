// Брони единицы товара (2-я часть ТЗ).
// Гонка за последнюю единицу решается ЗДЕСЬ и синхронно: атомарный условный
// UPDATE строки stock_mirror (available - held >= 1). Очереди здесь не нужны —
// решение должно быть мгновенным и линеаризуемым на самом ресурсе.
import { pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { logger } from '../logger.js';
import { publishOffer } from './live.js';

function genId() {
  return `res_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const isExpired = (r, at = new Date()) => new Date(r.expires_at) <= at;

// Освобождение единицы (вызывается ВНУТРИ транзакции, строка остатка уже залочена).
export async function releaseReservationTx(tx, r, status) {
  const upd = await tx.query(
    `UPDATE reservations SET status=$2, released_at=now(), updated_at=now()
     WHERE id=$1 AND status='active'`,
    [r.id, status],
  );
  await tx.query(
    `UPDATE stock_mirror SET held = greatest(held - 1, 0), updated_at = now()
     WHERE sku=$1 AND held > 0`,
    [r.sku],
  );
  return upd.rowCount;
}

function pickTtl(ttlMs) {
  const { ttlMs: def, minTtlMs } = config.reservation;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : def;
  return Math.max(minTtlMs, Math.min(ttl, 24 * 3600 * 1000));
}

// Создание брони. purchaseKey — идемпотентность (двойной клик «Купить»).
export async function createReservation({ sku, purchaseKey = null, ttlMs }) {
  const ttl = pickTtl(ttlMs);
  return withTransaction(pool, async (tx) => {
    const prod = await tx.query(
      `SELECT sku, name, price::int AS price, currency, image, seller, product_group
       FROM products WHERE sku=$1`,
      [sku],
    );
    if (!prod.rows.length) throw new ApiError(404, 'sku_not_found');
    const product = prod.rows[0];

    // 1) идемпотентность по purchase_key (до лока — быстрый путь)
    if (purchaseKey) {
      const cur = await tx.query('SELECT * FROM reservations WHERE purchase_key=$1', [purchaseKey]);
      const existing = cur.rows[0];
      if (existing) {
        if (existing.status === 'confirmed') return { reservation: existing, created: false, confirmed: true };
        if (existing.status === 'active') {
          if (!isExpired(existing)) return { reservation: existing, created: false };
          // протухла — освободить единицу и пересоздать с тем же ключом
          await releaseReservationTx(tx, existing, 'expired');
        }
      }
    }

    // 2) сериализация конкурентов на строке остатка: два запроса за последнюю
    //    единицу выстраиваются в очередь и второй увидит available-held == 0.
    await tx.query('SELECT sku FROM stock_mirror WHERE sku=$1 FOR UPDATE', [sku]);

    // 3) повторная проверка ключа ПОСЛЕ лока (конкурент мог успеть)
    if (purchaseKey) {
      const cur = await tx.query('SELECT * FROM reservations WHERE purchase_key=$1', [purchaseKey]);
      const existing = cur.rows[0];
      if (existing && existing.status === 'active' && !isExpired(existing)) {
        return { reservation: existing, created: false };
      }
      if (existing && existing.status === 'confirmed') return { reservation: existing, created: false, confirmed: true };
    }

    // 4) атомарный захват единицы
    const upd = await tx.query(
      `UPDATE stock_mirror SET held = held + 1, updated_at = now()
       WHERE sku=$1 AND available - held >= 1
       RETURNING available::int AS available, held::int AS held`,
      [sku],
    );
    if (upd.rowCount === 0) throw new ApiError(409, 'just_sold_out');

    const id = genId();
    const expiresAt = new Date(Date.now() + ttl);
    const ins = await tx.query(
      `INSERT INTO reservations (id, sku, status, purchase_key, expires_at, price)
       VALUES ($1, $2, 'active', $3, $4, $5)
       RETURNING *`,
      [id, sku, purchaseKey, expiresAt, product.price],
    );
    logger.info({ reservationId: id, sku, ttlMs: ttl }, 'reservation.created');
    return { reservation: ins.rows[0], created: true };
  });
}

async function loadOffer(tx, sku) {
  const prod = await tx.query(
    `SELECT sku, name, price::int AS price, currency, image, seller, product_group
     FROM products WHERE sku=$1`,
    [sku],
  );
  const sm = await tx.query(
    `SELECT GREATEST(COALESCE(available,0) - COALESCE(held,0), 0)::int AS available
     FROM stock_mirror WHERE sku=$1`,
    [sku],
  );
  return { ...prod.rows[0], available: sm.rows[0]?.available ?? 0 };
}

// Получение брони + ленивое освобождение на read-пути: если срок вышел,
// единица возвращается в продажу прямо здесь, не дожидаясь sweeper.
export async function getReservation(id) {
  let released = null;
  const result = await withTransaction(pool, async (tx) => {
    const q = await tx.query('SELECT * FROM reservations WHERE id=$1 FOR UPDATE', [id]);
    if (!q.rows.length) throw new ApiError(404, 'reservation_not_found');
    const r = q.rows[0];
    if (r.status === 'active' && isExpired(r)) {
      await releaseReservationTx(tx, r, 'expired');
      r.status = 'expired'; // отражаем фактическое состояние БД в ответе
      released = { sku: r.sku, id: r.id };
    }
    const offer = await loadOffer(tx, r.sku);
    return { ...r, offer };
  });
  if (released) await publishOffer(released.sku);
  return result;
}

// Явная отмена брони (до подтверждения заказом).
export async function cancelReservation(id) {
  let released = null;
  const result = await withTransaction(pool, async (tx) => {
    const q = await tx.query('SELECT * FROM reservations WHERE id=$1 FOR UPDATE', [id]);
    if (!q.rows.length) throw new ApiError(404, 'reservation_not_found');
    const r = q.rows[0];
    if (r.status !== 'active') throw new ApiError(409, `reservation_${r.status}`);
    await releaseReservationTx(tx, r, 'cancelled');
    released = { sku: r.sku, id: r.id };
    return { ...r, status: 'cancelled' };
  });
  if (released) await publishOffer(released.sku);
  return result;
}

// Альтернативные офферы «того же товара у других продавцов» (для ответа проигравшему в гонке).
export async function getAlternatives(sku, { limit = 3 } = {}) {
  const res = await pool.query(
    `SELECT p.sku, p.name, p.seller, p.price::int AS price,
            GREATEST(COALESCE(sm.available,0) - COALESCE(sm.held,0), 0)::int AS available
     FROM products p
     JOIN products self ON self.sku = $1 AND self.product_group IS NOT NULL
     LEFT JOIN stock_mirror sm ON sm.sku = p.sku
     WHERE p.product_group = self.product_group
       AND p.sku <> $1
       AND GREATEST(COALESCE(sm.available,0) - COALESCE(sm.held,0), 0) > 0
     ORDER BY p.price ASC, p.sku
     LIMIT $2`,
    [sku, limit],
  );
  return res.rows;
}
