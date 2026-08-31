import { Router } from 'express';
import { handleWebhook } from '../services/paymentService.js';
import { ApiError } from '../errors.js';

export const webhookRouter = Router();

// POST /webhook/payment — вебхук платёжки (контракт из ТЗ).
// Гарантии: идемпотентен по event_id; отвечает быстро 200 для принятых.
webhookRouter.post('/', async (req, res, next) => {
  try {
    const { event_id, order_id, status, amount, currency, created_at } = req.body || {};
    if (!event_id || !order_id || (status !== 'paid' && status !== 'failed')) {
      throw new ApiError(400, 'invalid_webhook');
    }
    const result = await handleWebhook({ event_id, order_id, status, amount, currency, created_at });
    res.json({ accepted: true, duplicate: !!result.duplicate, applied: !!result.applied });
  } catch (e) {
    next(e);
  }
});
