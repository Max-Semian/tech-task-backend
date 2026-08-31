// Seed: сброс схемы + каталог (12 SKU) + зеркало остатков.
// Пул ключей при старте уходит заглушкам поставщиков (seedByName в src/suppliers/server.js).
import { pool, initSchema, waitForDb } from '../src/db.js';
import { seedIfEmpty } from '../src/services/seedService.js';
import { logger } from '../src/logger.js';

async function main() {
  await waitForDb(pool);
  await initSchema(pool);

  await pool.query(
    `TRUNCATE products, order_items, orders, payment_events,
       delivery_attempts, delivery_jobs, money_ledger, stock_mirror
     RESTART IDENTITY CASCADE`,
  );

  const result = await seedIfEmpty(pool);
  logger.info({ products: result.products }, 'seed done');
  await pool.end();
}

main().catch((e) => {
  logger.error({ err: e.message }, 'seed failed');
  process.exit(1);
});
