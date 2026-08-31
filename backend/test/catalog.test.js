import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDb, dropTestDb, seedProducts } from './helpers.js';
import { pool } from '../src/db.js';
import { generateSyntheticProducts } from '../src/catalog.js';

before(async () => {
  await setupDb();
  await seedProducts(pool);
});

after(async () => {
  await pool.end();
  await dropTestDb();
});

test('Этап 5: витрина остатков при тысячах SKU использует индексы и остаётся быстрой', async () => {
  // синтетический каталог на масштаб (как scripts/seed-bench.js)
  const synthetic = generateSyntheticProducts(5000);
  const rows = synthetic.map((p) => `('${p.sku}', '${p.name}', '${p.type}', ${p.price}, '${p.currency}', NULL)`);
  await pool.query(
    `INSERT INTO products (sku, name, type, price, currency, image) VALUES ${rows.join(',')}`,
  );
  await pool.query(
    `INSERT INTO stock_mirror (sku, available)
     SELECT sku, 5 FROM products WHERE type='key'`,
  );

  // «горячий» запрос витрины остатков
  const plan = await pool.query(
    `EXPLAIN (ANALYZE, FORMAT TEXT)
     SELECT p.sku, sm.available
     FROM stock_mirror sm
     JOIN products p ON p.sku = sm.sku
     WHERE p.type = 'key'
     ORDER BY sm.available DESC
     LIMIT 100`,
  );
  const planText = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
  console.log('EXPLAIN витрины остатков:\n' + planText);

  // products читается через индекс по типу, а не последовательным сканом
  assert.match(planText, /Index Scan|Index Only Scan|Bitmap Heap Scan/);
  assert.doesNotMatch(planText, /Seq Scan on products/);

  // точка-запрос по SKU — index lookup
  const point = await pool.query(`EXPLAIN (FORMAT TEXT) SELECT * FROM products WHERE sku='sku_bulk_42'`);
  const pointText = point.rows.map((r) => r['QUERY PLAN']).join('\n');
  assert.match(pointText, /Index Scan using products_pkey|Index Only Scan/);

  // выполняется быстро
  const m = planText.match(/Execution Time:\s*([\d.]+)/);
  assert.ok(m, 'нет Execution Time в плане');
  assert.ok(parseFloat(m[1]) < 200, `план слишком медленный: ${m[1]} ms`);
});
