import { Router } from 'express';
import { pool } from '../db.js';
import { config } from '../config.js';
import { findInconsistencies, redeliverOrder } from '../services/reconciler.js';
import { restockSupplier } from '../services/supplierClient.js';

export const adminRouter = Router();

// Сверка: «оплачен, но не выдан» / «выдан, но не оплачен» + баланс журнала (Этап 4)
adminRouter.get('/reconciliation', async (req, res, next) => {
  try {
    res.json(await findInconsistencies());
  } catch (e) {
    next(e);
  }
});

// Безопасная ручная повторная выдача (идемпотентна) (Этап 4)
adminRouter.post('/orders/:id/redeliver', async (req, res, next) => {
  try {
    const result = await redeliverOrder(req.params.id);
    res.json({ order_id: result.order.order_id, status: result.order.status, changed: result.changed });
  } catch (e) {
    next(e);
  }
});

// Пополнение остатка (Этап 4/5): добавляем ключи поставщикам и в зеркало остатков
adminRouter.post('/stock/:sku/restock', async (req, res, next) => {
  try {
    const { sku } = req.params;
    const count = Math.max(1, Math.min(1000, parseInt(req.body?.count || '1', 10)));
    const codes = Array.from(
      { length: count },
      () => `RSTK-${sku}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase(),
    );
    const aOk = await restockSupplier(config.supplierA.url, sku, codes);
    const bOk = await restockSupplier(config.supplierB.url, sku, codes);
    await pool.query(
      `INSERT INTO stock_mirror (sku, available)
       VALUES ($1,$2)
       ON CONFLICT (sku) DO UPDATE
         SET available = stock_mirror.available + EXCLUDED.available, updated_at=now()`,
      [sku, count],
    );
    res.json({ sku, added: count, suppliers: { a: aOk, b: bOk } });
  } catch (e) {
    next(e);
  }
});

// Журнал денежных движений (Этап 4)
adminRouter.get('/ledger', async (req, res, next) => {
  try {
    const rows = await pool.query('SELECT * FROM money_ledger ORDER BY id');
    res.json({ entries: rows.rows, total: rows.rows.reduce((s, r) => s + Number(r.amount), 0) });
  } catch (e) {
    next(e);
  }
});
