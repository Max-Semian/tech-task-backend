import { Router } from 'express';
import {
  createOrderWithLink,
  getOrder,
  createOrderFromReservation,
  cancelMarketplaceOrder,
} from '../services/orderService.js';
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
    sku: o.sku || (o.items && o.items[0] ? o.items[0].sku : null) || null,
    pay_until: o.pay_until || null,
    reservation_id: o.reservation_id || null,
    items: o.items,
    created_at: o.created_at,
    paid_at: o.paid_at,
    delivered_at: o.delivered_at,
  };
}

async function respondOrder(res, orderId, createdStatus = 201) {
  const full = await getOrder(orderId);
  if (!full) throw new ApiError(404, 'order_not_found');
  res.status(createdStatus).json(serializeOrder(full));
}

// POST /orders
//  * legacy (этап 1): { sku, idempotency_key?, order_id?, promocode? } — прямой заказ
//    без предоплатной брони (пустой остаток у поставщика -> восстановимый out_of_stock).
//  * маркетплейс (2-я часть): { reservation_id, promocode? } — подтверждение брони
//    заказом по ТЕКУЩЕЙ цене. Идемпотентен: повтор с той же reservation_id возвращает
//    уже созданный заказ (refresh/двойной клик/повтор после обрыва).
ordersRouter.post('/', async (req, res, next) => {
  try {
    const { sku, idempotency_key, order_id, promocode, reservation_id } = req.body || {};

    if (reservation_id) {
      if (typeof reservation_id !== 'string') throw new ApiError(400, 'invalid_reservation_id');
      const { order, created } = await createOrderFromReservation({ reservationId: reservation_id, promocode: promocode || null });
      await respondOrder(res, order.order_id, created ? 201 : 200);
      return;
    }

    if (!sku || typeof sku !== 'string') throw new ApiError(400, 'sku_required');
    const { order, created } = await createOrderWithLink({
      sku,
      idempotencyKey: idempotency_key || null,
      orderId: order_id || null,
      promocode: promocode || null,
    });
    await respondOrder(res, order.order_id, created ? 201 : 200);
  } catch (e) {
    next(e);
  }
});

// GET /orders/:id — статус заказа (Этап 1; переживает refresh/Назад/обрыв)
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
// Идемпотентна: повторный вызов по уже оплаченному/выданному заказу ничего не меняет,
// в ответе всегда фактический статус заказа (для resume после обрыва/Back).
ordersRouter.post('/:id/pay', async (req, res, next) => {
  try {
    const { status = 'paid' } = req.body || {};
    if (!['paid', 'failed'].includes(status)) throw new ApiError(400, 'invalid_pay_status');

    const orderId = req.params.id;
    const order = await getOrder(orderId);
    if (!order) throw new ApiError(404, 'order_not_found');
    // дедлайн брони истёк: оплата больше невозможна, единица возвращается в продажу
    if (order.status === 'created' && order.pay_until && new Date(order.pay_until) <= new Date()) {
      try { await cancelMarketplaceOrder(orderId); } catch (err) { /* уже истёк */ }
      return res.status(409).json({ error: 'reservation_expired', order_id: orderId });
    }
    // заказ уже истёк (sweeper/lazy-release) — повторная оплата не меняет статус
    if (order.status === 'expired') {
      return res.status(409).json({ error: 'reservation_expired', order_id: orderId });
    }
    // уже финальный/оплаченный заказ — повторная оплата ничего не меняет
    if (['paid', 'delivering', 'delivered'].includes(order.status) && status === 'paid') {
      return res.json({
        accepted: true,
        order_id: orderId,
        status: order.status,
        duplicate: true,
        applied: false,
      });
    }

    const event_id = `evt_pay_${orderId}_${Date.now()}`;
    const result = await handleWebhook({
      event_id,
      order_id: orderId,
      status,
      amount: Number(order.amount),
      currency: order.currency || 'RUB',
      created_at: new Date().toISOString(),
    });
    const fresh = await getOrder(orderId);
    res.json({
      accepted: true,
      order_id: orderId,
      status: status,
      order_status: fresh ? fresh.status : null,
      duplicate: !!result.duplicate,
      applied: !!result.applied,
    });
  } catch (e) {
    next(e);
  }
});

// POST /orders/:id/cancel — отмена заказа-из-брони до оплаты; единица возвращается.
ordersRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const order = await cancelMarketplaceOrder(req.params.id);
    res.json({
      order_id: order.order_id,
      status: order.status,
      released: true,
    });
  } catch (e) {
    next(e);
  }
});
