import { pool, withTransaction } from '../db.js';
import { linkUnappliedEvents } from './paymentService.js';
import { applyPromocode } from './promoService.js';
import { releaseReservationTx } from './reservationService.js';
import { ApiError } from '../errors.js';
import { logger } from '../logger.js';

function generateOrderId() {
  return `ord_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Создание заказа по SKU + линковка событий оплаты, пришедших раньше (критерий 3).
//
// Семантика идемпотентности (приоритет):
//   1. `order_id` — ПЕРВИЧЕН. Если существует -> возвращается этот заказ (200),
//      переданные `sku` и `idempotency_key` игнорируются (никакого 409 из-за другого SKU).
//   2. `idempotency_key` — вторичный, применяется только когда `order_id` не передан:
//      если ключ уже существует -> возвращается этот заказ (200).
//   3. Новый `order_id` + `idempotency_key`, занятый ДРУГИМ заказом -> 409 conflict
//      (не подменяем order_id тихо).
//   4. Гонка двух одинаковых POST -> выигрывает существующий заказ (200), дубль не создаётся.
export async function createOrderWithLink({ sku, idempotencyKey = null, orderId = null, promocode = null }) {
  return withTransaction(pool, async (tx) => {
    // 1) order_id первичен
    if (orderId) {
      const existing = await tx.query('SELECT * FROM orders WHERE order_id=$1', [orderId]);
      if (existing.rows.length) return { order: existing.rows[0], created: false };
    }

    // 2) idempotency_key — вторичный (только когда order_id не задан)
    if (idempotencyKey && !orderId) {
      const existing = await tx.query('SELECT * FROM orders WHERE idempotency_key=$1', [idempotencyKey]);
      if (existing.rows.length) return { order: existing.rows[0], created: false };
    }

    // 3) order_id новый, но idempotency_key уже занят ДРУГИМ заказом -> явный конфликт 409.
    //    Проверяем до вставки: после ошибки INSERT транзакция в PG переходит в aborted-состояние
    //    и запросы в ней не выполняются.
    if (orderId && idempotencyKey) {
      const taken = await tx.query('SELECT 1 FROM orders WHERE idempotency_key=$1', [idempotencyKey]);
      if (taken.rows.length) throw new ApiError(409, 'idempotency_key_conflict');
    }

    const product = await tx.query('SELECT * FROM products WHERE sku=$1', [sku]);
    if (!product.rows.length) throw new ApiError(404, 'sku_not_found');

    const publicId = orderId || generateOrderId();
    let order;
    try {
      // savepoint ДО списания промокода: при неудачной вставке заказа откат вернёт
      // и использованный промокод (этап 4: гонки двух одинаковых POST не жгут лимит)
      await tx.query('SAVEPOINT sp_order');

      // 4) промокод: атомарное списание использования + расчёт скидки (этап 4)
      let promoCode = null;
      let discount = 0;
      if (promocode) {
        const promo = await applyPromocode(tx, promocode, product.rows[0].price);
        promoCode = promo.code;
        discount = promo.discount;
      }
      const finalAmount = Math.max(0, product.rows[0].price - discount);

      const res = await tx.query(
        `INSERT INTO orders (order_id, idempotency_key, amount, currency, promo_code, promo_discount)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [publicId, idempotencyKey, finalAmount, product.rows[0].currency, promoCode, discount],
      );
      order = res.rows[0];
    } catch (e) {
      // транзакция после ошибки aborted: откатываемся к savepoint, чтобы можно было читать
      await tx.query('ROLLBACK TO SAVEPOINT sp_order').catch(() => {});
      // UNIQUE-констрейнт сработал — это гонка двух одинаковых POST /orders
      if (e.code === '23505') {
        if (orderId) {
          const byOrder = await tx.query('SELECT * FROM orders WHERE order_id=$1', [publicId]);
          if (byOrder.rows.length) return { order: byOrder.rows[0], created: false };
          // order_id новый, но idempotency_key занят ДРУГИМ заказом -> явный конфликт
          throw new ApiError(409, 'idempotency_key_conflict');
        }
        // order_id не задан -> конфликт только по idempotency_key, это гонка
        const byKey = await tx.query('SELECT * FROM orders WHERE idempotency_key=$1', [idempotencyKey]);
        if (byKey.rows.length) return { order: byKey.rows[0], created: false };
      }
      throw e;
    }

    await tx.query(
      `INSERT INTO order_items (order_id, sku, qty, price, currency)
       VALUES ($1,$2,1,$3,$4)`,
      [order.id, sku, product.rows[0].price, product.rows[0].currency],
    );

    // линковка необработанных событий оплаты в порядке created_at, processed_at
    await linkUnappliedEvents(tx, publicId);

    logger.info({ orderId: publicId, sku, amount: product.rows[0].price }, 'order.created');
    return { order, created: true };
  });
}

export async function getOrder(publicId) {
  const res = await pool.query(
    `SELECT o.*,
            COALESCE(json_agg(json_build_object(
              'sku', oi.sku, 'qty', oi.qty, 'price', oi.price, 'currency', oi.currency
            ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.order_id = $1
     GROUP BY o.id`,
    [publicId],
  );
  return res.rows[0] || null;
}

/* =====================================================================
 * Маркетплейс-слой (2-я часть ТЗ): подтверждение брони заказом.
 * Создаётся только один заказ на бронь (защита FOR UPDATE на строке
 * reservations + частичный UNIQUE-индекс uq_orders_reservation).
 * Цена берётся на момент подтверждения (текущая цена оффера) — если товар
 * подорожал, пока лежал «в корзине», новая цена видна до оплаты.
 * ===================================================================== */
export async function createOrderFromReservation({ reservationId, promocode = null }) {
  const outcome = await withTransaction(pool, async (tx) => {
    const q = await tx.query('SELECT * FROM reservations WHERE id=$1 FOR UPDATE', [reservationId]);
    if (!q.rows.length) throw new ApiError(404, 'reservation_not_found');
    const r = q.rows[0];

    // повторное подтверждение (refresh/двойной клик) — вернуть уже созданный заказ
    if (r.status === 'confirmed') {
      const existing = await tx.query(
        'SELECT * FROM orders WHERE reservation_id=$1',
        [reservationId],
      );
      if (existing.rows.length) return { order: existing.rows[0], created: false };
    }
    if (r.status === 'cancelled') throw new ApiError(409, 'reservation_cancelled');
    if (r.status === 'expired') throw new ApiError(409, 'reservation_expired');

    // бронь истекла к моменту подтверждения — освобождаем единицу и сообщаем клиенту
    if (new Date(r.expires_at) <= new Date()) {
      await releaseReservationTx(tx, r, 'expired');
      return { outcome: 'expired', sku: r.sku };
    }

    // ЯВНЫЙ CAS active -> confirmed с проверкой дедлайна (та же ловушка, что и
    // CAS статусов заказа в этапе 1): ни одного окна между «проверили активность»
    // и «подтвердили», никакого двойного освобождения held на границе с lazy-release.
    const cas = await tx.query(
      `UPDATE reservations SET status='confirmed', updated_at=now()
       WHERE id=$1 AND status='active' AND expires_at > now()
       RETURNING id`,
      [reservationId],
    );
    if (cas.rowCount === 0) {
      // теоретическая граница истечения — перечитываем финальное состояние
      const fresh = await tx.query('SELECT * FROM reservations WHERE id=$1', [reservationId]);
      const cur = fresh.rows[0];
      if (cur && cur.status === 'confirmed') {
        const existing = await tx.query('SELECT * FROM orders WHERE reservation_id=$1', [reservationId]);
        if (existing.rows.length) return { order: existing.rows[0], created: false };
      }
      throw new ApiError(409, 'reservation_expired');
    }

    const product = await tx.query('SELECT * FROM products WHERE sku=$1', [r.sku]);
    if (!product.rows.length) throw new ApiError(404, 'sku_not_found');

    let promoCode = null;
    let discount = 0;
    if (promocode) {
      const promo = await applyPromocode(tx, promocode, product.rows[0].price);
      promoCode = promo.code;
      discount = promo.discount;
    }

    const finalAmount = Math.max(0, product.rows[0].price - discount);
    const orderId = generateOrderId();
    const res = await tx.query(
      `INSERT INTO orders (order_id, amount, currency, promo_code, promo_discount,
                           sku, pay_until, reservation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [orderId, finalAmount, product.rows[0].currency, promoCode, discount,
        r.sku, r.expires_at, r.id],
    );
    const order = res.rows[0];

    await tx.query(
      `INSERT INTO order_items (order_id, sku, qty, price, currency)
       VALUES ($1,$2,1,$3,$4)`,
      [order.id, r.sku, product.rows[0].price, product.rows[0].currency],
    );

    await tx.query(
      `UPDATE reservations SET order_id=$2, updated_at=now() WHERE id=$1`,
      [r.id, orderId],
    );

    // вебхуки могли прийти раньше заказа — применяем в детерминированном порядке
    await linkUnappliedEvents(tx, orderId);
    logger.info({ orderId, sku: r.sku, amount: finalAmount }, 'order.confirmed_from_reservation');
    return { order, created: true };
  });

  if (outcome && outcome.outcome === 'expired') {
    const { publishOffer } = await import('./live.js');
    await publishOffer(outcome.sku);
    throw new ApiError(409, 'reservation_expired');
  }
  return outcome;
}

// Отмена заказа-из-брони (кнопка «Отменить бронь» после оформления): единица возвращается.
export async function cancelMarketplaceOrder(orderId) {
  let releasedSku = null;
  const order = await withTransaction(pool, async (tx) => {
    const q = await tx.query('SELECT * FROM orders WHERE order_id=$1 FOR UPDATE', [orderId]);
    if (!q.rows.length) throw new ApiError(404, 'order_not_found');
    const o = q.rows[0];
    if (o.status !== 'created' || !o.reservation_id) throw new ApiError(409, 'cannot_cancel_order');

    await tx.query(
      `UPDATE orders SET status='expired', updated_at=now()
       WHERE id=$1 AND status='created'`,
      [o.id],
    );
    await tx.query(
      `UPDATE reservations SET status='cancelled', released_at=now(), updated_at=now()
       WHERE id=$1 AND status='confirmed'`,
      [o.reservation_id],
    );
    await tx.query(
      `UPDATE stock_mirror SET held = greatest(held - 1, 0), updated_at = now()
       WHERE sku=$1 AND held > 0`,
      [o.sku],
    );
    releasedSku = o.sku;
    return { ...o, status: 'expired' };
  });
  if (releasedSku) {
    const { publishOffer } = await import('./live.js');
    await publishOffer(releasedSku);
  }
  return order;
}
