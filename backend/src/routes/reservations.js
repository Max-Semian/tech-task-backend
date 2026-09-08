import { Router } from 'express';
import { ApiError } from '../errors.js';
import {
  createReservation,
  getReservation,
  cancelReservation,
  getAlternatives,
} from '../services/reservationService.js';
import { publishOffer } from '../services/live.js';

export const reservationsRouter = Router();

function serialize(r) {
  return {
    id: r.id,
    sku: r.sku,
    status: r.status,
    expires_at: r.expires_at,
    price: Number(r.price),
    order_id: r.order_id || null,
    offer: r.offer || null,
  };
}

// POST /reservations { sku, purchase_key?, ttl_seconds? }
// Атомарная бронь: гонка за последнюю единицу решается здесь.
reservationsRouter.post('/', async (req, res, next) => {
  const { sku, purchase_key, ttl_seconds } = req.body || {};
  try {
    if (!sku || typeof sku !== 'string') throw new ApiError(400, 'sku_required');
    const ttlMs = Number.isFinite(+ttl_seconds) && +ttl_seconds > 0 ? +ttl_seconds * 1000 : undefined;
    const out = await createReservation({
      sku,
      purchaseKey: typeof purchase_key === 'string' && purchase_key ? purchase_key : null,
      ttlMs,
    });
    // после успешной брони витрина «гаснет» у всех подписчиков SSE
    await publishOffer(sku);
    const { reservation, created } = out;
    res.status(created ? 201 : 200).json(serialize(reservation));
  } catch (e) {
    // проигравшему в гонке — понятный отказ + предложение других продавцов
    if (e instanceof ApiError && e.message === 'just_sold_out') {
      try {
        const alternatives = await getAlternatives(sku);
        return res.status(409).json({ error: 'just_sold_out', alternatives });
      } catch (err) {
        return res.status(409).json({ error: 'just_sold_out', alternatives: [] });
      }
    }
    next(e);
  }
});

// GET /reservations/:id — состояние брони; протухшая освобождается лениво.
reservationsRouter.get('/:id', async (req, res, next) => {
  try {
    const r = await getReservation(req.params.id);
    res.json(serialize(r));
  } catch (e) {
    next(e);
  }
});

// POST /reservations/:id/cancel — явная отмена, единица возвращается.
reservationsRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const r = await cancelReservation(req.params.id);
    res.json(serialize(r));
  } catch (e) {
    next(e);
  }
});
