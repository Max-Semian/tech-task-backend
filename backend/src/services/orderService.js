import { pool, withTransaction } from '../db.js';
import { linkUnappliedEvents } from './paymentService.js';
import { applyPromocode } from './promoService.js';
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
