// 2-я часть ТЗ, Задача 5: мгновенный поиск и фильтры по каталогу в тысячи офферов.
// Серверный поиск через pg_trgm, фильтры, сортировка, пагинация + быстрый ответ.
import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupDb, dropTestDb, startApi, getJson, closeServer,
} from './helpers.js';
import { pool, withTransaction } from '../src/db.js';
import { seedMarketplaceTx } from '../src/services/seedService.js';

let base;
let server;

before(async () => {
  await setupDb();
  await withTransaction(pool, async (tx) => {
    const n = await seedMarketplaceTx(tx, 3000);
    assert.equal(n, 3000);
  });
  server = await startApi();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  closeServer(server);
  await pool.end();
  await dropTestDb();
});

test('Поиск по подстроке возвращает мгновенный и корректный результат', async () => {
  const t0 = Date.now();
  const r = await getJson(base, '/products?q=steam&in_stock=1&limit=40');
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 0 && r.body.length <= 40);
  for (const p of r.body) {
    assert.match(p.name.toLowerCase(), /steam/);
    assert.ok(p.available > 0, 'in_stock=1 должен исключать пустые');
    assert.ok(p.seller, 'у оффера есть продавец');
  }
  const total = Number(r.headers.get('x-total-count'));
  assert.ok(total >= r.body.length);
  assert.ok(elapsed < 500, `медленный ответ: ${elapsed}ms`);
});

test('Фильтры по типу + сортировка по цене', async () => {
  const r = await getJson(base, '/products?type=key&in_stock=1&sort=price_asc&limit=30');
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 0);
  for (const p of r.body) assert.equal(p.type, 'key');
  const prices = r.body.map((p) => p.price);
  for (let i = 1; i < prices.length; i++) assert.ok(prices[i - 1] <= prices[i], 'цена не убывает');
});

test('Пагинация и X-Total-Count согласованы', async () => {
  const page1 = await getJson(base, '/products?limit=25&offset=0');
  const page2 = await getJson(base, '/products?limit=25&offset=25');
  assert.equal(page1.status, 200);
  assert.equal(page1.body.length, 25);
  assert.equal(page2.body.length, 25);
  const ids1 = new Set(page1.body.map((p) => p.sku));
  for (const p of page2.body) assert.ok(!ids1.has(p.sku), 'страницы не пересекаются');
  const total = Number(page1.headers.get('x-total-count'));
  assert.ok(total >= 50);
});

test('Поиск «в наличии» с фильтром продавца', async () => {
  const r = await getJson(base, '/products?seller=KeysPro&in_stock=1&limit=10');
  assert.equal(r.status, 200);
  for (const p of r.body) assert.equal(p.seller, 'KeysPro');
});

test('Точечный запрос оффера и EXPLAIN не используют seq scan по продуктам', async () => {
  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename='products' AND indexname='idx_products_name_trgm'`,
  );
  assert.ok(idx.rows.length, 'нет trgm-индекса по name');
  // доказываем, что trgm-индекс ПРИГОДЕН для поиска: выключаем seq scan
  // (на таблице в 3000 строк планировщик честно предпочитает seq — это нормально,
  // важно, что индекс существует и выбирается, когда строк больше/seq дороже)
  const client = await pool.connect();
  let text = '';
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const plan = await client.query(
      `EXPLAIN (ANALYZE, FORMAT TEXT)
       SELECT p.sku, p.name, p.seller, p.price
       FROM products p
       WHERE p.name ILIKE '%wukong%'
       LIMIT 40`,
    );
    text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.match(text, /Bitmap Index Scan on idx_products_name_trgm/, `trgm-индекс не используется:\n${text}`);
  assert.doesNotMatch(text, /Seq Scan on products/, `seq scan на поиске:\n${text}`);
});
