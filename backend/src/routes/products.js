import { Router } from 'express';
import { pool } from '../db.js';

export const productsRouter = Router();

// GET /products — каталог для витрины (фуллстек, Этап 1)
productsRouter.get('/', async (req, res, next) => {
  try {
    const rows = await pool.query(
      `SELECT p.sku, p.name, p.type, p.price::int, p.currency, p.image,
              COALESCE(sm.available, 0)::int AS available
       FROM products p
       LEFT JOIN stock_mirror sm ON sm.sku = p.sku
       ORDER BY p.sku`,
    );
    res.json(rows.rows);
  } catch (e) {
    next(e);
  }
});
