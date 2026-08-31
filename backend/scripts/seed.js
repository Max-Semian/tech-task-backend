// Seed: каталог (12 SKU) + зеркало остатков stock_mirror.
// Пул ключей при старте уходит заглушкам поставщиков (seedByName).
import { pool, initSchema, waitForDb } from '../src/db.js';
import { PRODUCTS, splitPoolBetweenSuppliers } from '../src/catalog.js';
import { logger } from '../src/logger.js';

async function main() {
  await waitForDb(pool);
  await initSchema(pool);

  await pool.query(
    `TRUNCATE products, order_items, orders, payment_events,
       delivery_attempts, delivery_jobs, money_ledger, stock_mirror
     RESTART IDENTITY CASCADE`,
  );

  for (const p of PRODUCTS) {
    await pool.query(
      `INSERT INTO products (sku, name, type, price, currency, image)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (sku) DO UPDATE SET name=EXCLUDED.name, price=EXCLUDED.price`,
      [p.sku, p.name, p.type, p.price, p.currency, p.image],
    );
  }

  const { a, b } = splitPoolBetweenSuppliers();
  const counts = new Map();
  for (const m of [a, b]) {
    for (const [sku, codes] of m) counts.set(sku, (counts.get(sku) || 0) + codes.length);
  }
  for (const [sku, n] of counts) {
    await pool.query(
      `INSERT INTO stock_mirror (sku, available) VALUES ($1,$2)
       ON CONFLICT (sku) DO UPDATE SET available=EXCLUDED.available, updated_at=now()`,
      [sku, n],
    );
  }

  logger.info(
    {
      products: PRODUCTS.length,
      keys: { a: [...a.values()].flat().length, b: [...b.values()].flat().length },
      stock: Object.fromEntries(counts),
    },
    'seed done',
  );
  await pool.end();
}

main().catch((e) => {
  logger.error({ err: e.message }, 'seed failed');
  process.exit(1);
});
