import { Router } from 'express';
import { pool } from '../db.js';
import { config } from '../config.js';
import { findInconsistencies, redeliverOrder } from '../services/reconciler.js';
import { restockSupplier } from '../services/supplierClient.js';
import { publishOffer } from '../services/live.js';

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

// Пополнение остатка (Этап 4/5): добавляем ключи поставщикам и в зеркало остатков.
// После коммита живая витрина получает SSE-событие об изменении available.
adminRouter.post('/stock/:sku/restock', async (req, res, next) => {
  try {
    const { sku } = req.params;
    const count = Math.max(1, Math.min(1000, parseInt(req.body?.count || '1', 10)));
    const codes = Array.from(
      { length: count },
      () => `RSTK-${sku}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase(),
    );
    // делим коды между поставщиками, чтобы один код не оказался в двух пулах
    const mid = Math.ceil(codes.length / 2);
    const aOk = await restockSupplier(config.supplierA.url, sku, codes.slice(0, mid));
    const bOk = await restockSupplier(config.supplierB.url, sku, codes.slice(mid));
    const upd = await pool.query(
      `INSERT INTO stock_mirror (sku, available)
       VALUES ($1,$2)
       ON CONFLICT (sku) DO UPDATE
         SET available = stock_mirror.available + EXCLUDED.available, updated_at=now()`,
      [sku, count],
    );
    if (upd.rowCount === 1) await publishOffer(sku);
    res.json({ sku, added: count, suppliers: { a: aOk, b: bOk } });
  } catch (e) {
    next(e);
  }
});

// Смена цены оффера (2-я часть ТЗ) — живая витрина мгновенно показывает новую цену
adminRouter.post('/products/:sku/price', async (req, res, next) => {
  try {
    const { sku } = req.params;
    const price = parseInt(req.body?.price, 10);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'invalid_price' });
    }
    const upd = await pool.query(
      `UPDATE products SET price=$2 WHERE sku=$1 RETURNING sku, price::int AS price`,
      [sku, price],
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'sku_not_found' });
    await publishOffer(sku);
    res.json({ sku, price: upd.rows[0].price });
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
