import { withTransaction } from '../db.js';
import { PRODUCTS, PROMOCODES, splitPoolBetweenSuppliers } from '../catalog.js';
import { logger } from '../logger.js';

// Каталог + зеркало остатков, если таблицы пусты.
// Используется при старте приложения (Docker: авто-сид) и scripts/seed.js (после TRUNCATE).
export async function seedIfEmpty(poolInstance) {
  const res = await poolInstance.query('SELECT COUNT(*)::int AS n FROM products');
  if (res.rows[0].n > 0) {
    // продукты уже есть (старая БД), но промокоды могли не появиться — досеем идемпотентно
    await withTransaction(poolInstance, async (tx) => {
      await seedPromocodesTx(tx);
    });
    return { seeded: false, reason: 'products_exist' };
  }

  return withTransaction(poolInstance, async (tx) => {
    for (const p of PRODUCTS) {
      await tx.query(
        `INSERT INTO products (sku, name, type, price, currency, image)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (sku) DO NOTHING`,
        [p.sku, p.name, p.type, p.price, p.currency, p.image],
      );
    }
    // зеркало остатков = сумма пулов поставщиков A+B по каждому SKU
    const { a, b } = splitPoolBetweenSuppliers();
    const counts = new Map();
    for (const m of [a, b]) {
      for (const [sku, codes] of m) counts.set(sku, (counts.get(sku) || 0) + codes.length);
    }
    for (const [sku, n] of counts) {
      await tx.query(
        `INSERT INTO stock_mirror (sku, available) VALUES ($1,$2)
         ON CONFLICT (sku) DO UPDATE SET available=EXCLUDED.available, updated_at=now()`,
        [sku, n],
      );
    }
    await seedPromocodesTx(tx);
    logger.info({ products: PRODUCTS.length }, 'catalog seeded');
    return { seeded: true, products: PRODUCTS.length };
  });
}

async function seedPromocodesTx(tx) {
  for (const p of PROMOCODES) {
    await tx.query(
      `INSERT INTO promocodes (code, type, value, currency, max_uses)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO NOTHING`,
      [p.code, p.type, p.value, p.currency, p.max_uses],
    );
  }
}
