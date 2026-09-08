import { Router } from 'express';
import { pool } from '../db.js';
import { config } from '../config.js';

export const productsRouter = Router();

// Экранирование LIKE-спецсимволов пользовательского ввода
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const SORTS = {
  price_asc: 'p.price ASC, p.sku ASC',
  price_desc: 'p.price DESC, p.sku ASC',
  name: 'p.name ASC, p.sku ASC',
  default: 'p.sku ASC',
};

// GET /products — витрина с серверным поиском/фильтрами (2-я часть ТЗ).
// Параметры: q (подстрока по названию, pg_trgm), type, seller, in_stock=1,
// sort=price_asc|price_desc|name, limit (<=200), offset.
// available в ответе = available - held («можно купить прямо сейчас»).
productsRouter.get('/', async (req, res, next) => {
  try {
    const { q, type, seller, in_stock, sort } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '', 10) || config.catalog.defaultLimit, 1), config.catalog.maxLimit);
    const offset = Math.max(parseInt(req.query.offset ?? '', 10) || 0, 0);

    const where = [];
    const params = [];
    const push = (sql, val) => {
      params.push(val);
      where.push(sql.replace('?', `$${params.length}`));
    };

    if (q) push(`p.name ILIKE '%' || ? || '%'`, `%${escapeLike(String(q).trim())}%`);
    if (type) push('p.type = ?', String(type));
    if (seller) push('p.seller = ?', String(seller));
    if (in_stock === '1') {
      push('GREATEST(COALESCE(sm.available,0) - COALESCE(sm.held,0), 0) > 0', null);
      where.pop();
      params.pop();
      where.push('GREATEST(COALESCE(sm.available,0) - COALESCE(sm.held,0), 0) > 0');
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = SORTS[sort] || SORTS.default;

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM products p
       LEFT JOIN stock_mirror sm ON sm.sku = p.sku
       ${whereSql}`,
      params,
    );
    const total = countRes.rows[0].total;

    const rows = await pool.query(
      `SELECT p.sku, p.name, p.type, p.price::int AS price, p.currency, p.image,
              p.seller, p.product_group,
              GREATEST(COALESCE(sm.available,0) - COALESCE(sm.held,0), 0)::int AS available
       FROM products p
       LEFT JOIN stock_mirror sm ON sm.sku = p.sku
       ${whereSql}
       ORDER BY ${orderSql}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    res.setHeader('X-Total-Count', String(total));
    res.json(rows.rows);
  } catch (e) {
    next(e);
  }
});
