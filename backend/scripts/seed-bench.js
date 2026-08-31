// Синтетический сид на масштаб для Этапа 5 (каталог под нагрузкой).
// Добавляет N синтетических SKU + зеркало остатков (не трогает реальный каталог).
//
// Использование: npm run seed-bench -- --count 10000
// После этого: npm test (catalog.test.js) или EXPLAIN вручную.
import { pool, initSchema, waitForDb } from '../src/db.js';
import { generateSyntheticProducts } from '../src/catalog.js';
import { logger } from '../src/logger.js';

const countIdx = process.argv.indexOf('--count');
const COUNT = countIdx !== -1 ? parseInt(process.argv[countIdx + 1] || '10000', 10) : 10000;

await waitForDb(pool);
await initSchema(pool);

const products = generateSyntheticProducts(COUNT);
const rows = products.map(
  (p) => `('${p.sku}', '${p.name.replace(/'/g, "''")}', '${p.type}', ${p.price}, '${p.currency}', NULL)`,
);
// вставляем порциями по 1000, чтобы не упираться в лимиты параметров/пакета
for (let i = 0; i < rows.length; i += 1000) {
  const chunk = rows.slice(i, i + 1000);
  await pool.query(
    `INSERT INTO products (sku, name, type, price, currency, image)
     VALUES ${chunk.join(',')}
     ON CONFLICT (sku) DO NOTHING`,
  );
}

// зеркало остатков: 5 единиц на каждый SKU
const stockRows = products.map((p) => `('${p.sku}', 5)`);
for (let i = 0; i < stockRows.length; i += 1000) {
  const chunk = stockRows.slice(i, i + 1000);
  await pool.query(
    `INSERT INTO stock_mirror (sku, available)
     VALUES ${chunk.join(',')}
     ON CONFLICT (sku) DO UPDATE SET available=EXCLUDED.available, updated_at=now()`,
  );
}

const count = await pool.query(`SELECT COUNT(*)::int AS n FROM products`);
const keys = await pool.query(`SELECT COUNT(*)::int AS n FROM products WHERE type='key'`);
logger.info({ total_products: count.rows[0].n, type_key: keys.rows[0].n }, 'seed-bench done');
await pool.end();
