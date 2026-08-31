import { Router } from 'express';
import { pool } from '../db.js';
import { validatePromocode } from '../services/promoService.js';
import { ApiError } from '../errors.js';

export const promoRouter = Router();

// POST /promo/validate — проверка промокода без списания (этап 4, UI).
// body: { code, amount } — скидку считает ТОЛЬКО сервер.
promoRouter.post('/validate', async (req, res, next) => {
  try {
    const { code, amount } = req.body || {};
    if (!code || amount == null) throw new ApiError(400, 'code_and_amount_required');
    const price = Number(amount);
    if (!Number.isFinite(price) || price < 0) throw new ApiError(400, 'invalid_amount');

    const result = await validatePromocode(pool, code, price);
    res.json({
      valid: true,
      code: result.promo.code,
      type: result.promo.type,
      value: Number(result.promo.value),
      discount: result.discount,
      final_amount: result.final,
      used: result.promo.used_count,
      max_uses: result.promo.max_uses,
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return res.status(e.status).json({ valid: false, reason: e.message });
    }
    next(e);
  }
});
