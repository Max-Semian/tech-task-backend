import { Router } from 'express';
import { createOrderWithLink, getOrder } from '../services/orderService.js';
import { handleWebhook } from '../services/paymentService.js';
import { ApiError } from '../errors.js';

export const ordersRouter = Router();

function serializeOrder(o) {
  return {
    order_id: o.order_id,
    status: o.status,
    amount: Number(o.amount),
    currency: o.currency,
    code: o.code || null,
    promo_code: o.promo_code || null,
    promo_discount: Number(o.promo_discount || 0),
    items: o.items,
    created_at: o.created_at,
    paid_at: o.paid_at,
    delivered_at: o.delivered_at,
  };
}

// POST /orders — создание заказа по SKU (Этап 1)
// body: { sku, idempotency_key?, order_id?, promocode? } — order_id позволяет восстановить
// сценарий «вебхук пришёл раньше заказа» и служит идемпотентностью клиента.
// promocode (этап 4): сервер атомарно списывает использование и считает скидку.
ordersRouter.post('/', async (req, res, next) => {
  try {
    const { sku, idempotency_key, order_id, promocode } = req.body || {};
    if (!sku || typeof sku !== 'string') throw new ApiError(400, 'sku_required');
    const { order, created } = await createOrderWithLink({
      sku,
      idempotencyKey: idempotency_key || null,
      orderId: order_id || null,
      promocode: promocode || null,
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

// POST /orders/:id/pay — эмуляция оплаты (фуллстек).
// body: { status: 'paid'|'failed' } — генерирует event_id и применяет вебхук по контракту.
ordersRouter.post('/:id/pay', async (req, res, next) => {
  try {
    const { status = 'paid' } = req.body || {};
    if (!['paid', 'failed'].includes(status)) throw new ApiError(400, 'invalid_pay_status');

    const orderId = req.params.id;
    const order = await getOrder(orderId);
    if (!order) throw new ApiError(404, 'order_not_found');

    const event_id = `evt_pay_${orderId}_${Date.now()}`;
    const result = await handleWebhook({
      event_id,
      order_id: orderId,
      status,
      amount: Number(order.amount),
      currency: order.currency || 'RUB',
      created_at: new Date().toISOString(),
    });
    res.json({
      accepted: true,
      order_id: orderId,
      status,
      duplicate: !!result.duplicate,
      applied: !!result.applied,
    });
  } catch (e) {
    next(e);
  }
});
