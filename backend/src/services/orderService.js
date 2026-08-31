import { pool, withTransaction } from '../db.js';
import { linkUnappliedEvents } from './paymentService.js';
import { ApiError } from '../errors.js';
import { logger } from '../logger.js';

function generateOrderId() {
  return `ord_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Создание заказа по SKU + линковка событий оплаты, пришедших раньше (критерий 3).
export async function createOrderWithLink({ sku, idempotencyKey = null, orderId = null }) {
  return withTransaction(pool, async (tx) => {
    // идемпотентность: повтор с тем же idempotency_key/order_id возвращает существующий заказ
    if (idempotencyKey) {
      const existing = await tx.query('SELECT * FROM orders WHERE idempotency_key=$1', [idempotencyKey]);
      if (existing.rows.length) return { order: existing.rows[0], created: false };
    }
    if (orderId) {
      const existing = await tx.query('SELECT * FROM orders WHERE order_id=$1', [orderId]);
      if (existing.rows.length) return { order: existing.rows[0], created: false };
    }

    const product = await tx.query('SELECT * FROM products WHERE sku=$1', [sku]);
    if (!product.rows.length) throw new ApiError(404, 'sku_not_found');

    const publicId = orderId || generateOrderId();
    let order;
    try {
      const res = await tx.query(
        `INSERT INTO orders (order_id, idempotency_key, amount, currency)
         VALUES ($1,$2,$3,$4)
         RETURNING *`,
        [publicId, idempotencyKey, product.rows[0].price, product.rows[0].currency],
      );
      order = res.rows[0];
    } catch (e) {
      // гонка двух одинаковых POST /orders: UNIQUE сработал, вернуть существующий
      if (e.code === '23505') {
        const existing = await tx.query(
          'SELECT * FROM orders WHERE order_id=$1 OR idempotency_key=$2 LIMIT 1',
          [publicId, idempotencyKey],
        );
        if (existing.rows.length) return { order: existing.rows[0], created: false };
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
