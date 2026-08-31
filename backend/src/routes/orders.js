import { Router } from 'express';
import { createOrderWithLink, getOrder } from '../services/orderService.js';
import { ApiError } from '../errors.js';

export const ordersRouter = Router();

function serializeOrder(o) {
  return {
    order_id: o.order_id,
    status: o.status,
    amount: Number(o.amount),
    currency: o.currency,
    code: o.code || null,
    items: o.items,
    created_at: o.created_at,
    paid_at: o.paid_at,
    delivered_at: o.delivered_at,
  };
}

// POST /orders — создание заказа по SKU (Этап 1)
// body: { sku, idempotency_key?, order_id? } — order_id позволяет восстановить
// сценарий «вебхук пришёл раньше заказа» и служит идемпотентностью клиента.
ordersRouter.post('/', async (req, res, next) => {
  try {
    const { sku, idempotency_key, order_id } = req.body || {};
    if (!sku || typeof sku !== 'string') throw new ApiError(400, 'sku_required');
    const { order, created } = await createOrderWithLink({
      sku,
      idempotencyKey: idempotency_key || null,
      orderId: order_id || null,
    });
    const full = await getOrder(order.order_id);
    res.status(created ? 201 : 200).json(serializeOrder(full));
  } catch (e) {
    next(e);
  }
});

// GET /orders/:id — статус заказа (Этап 1)
ordersRouter.get('/:id', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) throw new ApiError(404, 'order_not_found');
    res.json(serializeOrder(order));
  } catch (e) {
    next(e);
  }
});
