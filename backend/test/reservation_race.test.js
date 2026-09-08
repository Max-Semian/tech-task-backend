// 2-я часть ТЗ, Задача 2: покупка последней единицы наперегонки.
// Ровно один покупатель получает бронь; остальные — понятный 409 с альтернативами.
// Никто не получает оплаченный заказ без товара.
import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupDb, dropTestDb, seedProducts, startMocks, startApi,
  postJson, getOrderRow, waitFor, closeMocks, closeServer,
} from './helpers.js';
import { pool } from '../src/db.js';
import { processDeliveryJobsOnce } from '../src/services/deliveryService.js';

let base;
let mocks;
let server;

async function setStock(sku, available) {
  await pool.query(
    `INSERT INTO stock_mirror (sku, available) VALUES ($1,$2)
     ON CONFLICT (sku) DO UPDATE SET available=EXCLUDED.available, held=0`,
    [sku, available],
  );
}

async function setHeld(sku, held) {
  await pool.query(`UPDATE stock_mirror SET held=$2 WHERE sku=$1`, [sku, held]);
}

async function held(sku) {
  const r = await pool.query(`SELECT held::int AS held FROM stock_mirror WHERE sku=$1`, [sku]);
  return r.rows[0]?.held ?? 0;
}

before(async () => {
  await setupDb();
  await seedProducts(pool);
  // группа «тот же товар» из двух продавцов + целевой оффер с одной единицей
  await pool.query(
    `INSERT INTO products (sku, name, type, price, currency, seller, product_group)
     VALUES ('TEST-GAME-A', 'Test Game ключ (A)', 'key', 1000, 'RUB', 'SellerA', 'test:game'),
            ('TEST-GAME-B', 'Test Game ключ (B)', 'key', 1100, 'RUB', 'SellerB', 'test:game')`,
  );
  await setStock('TEST-GAME-A', 1);
  await setStock('TEST-GAME-B', 5);
  mocks = await startMocks();
  // кладём ключи кастомным SKU в пулы обоих мок-поставщиков (как restock в админке)
  for (const skuName of ['TEST-GAME-A', 'TEST-GAME-B']) {
    for (const m of [mocks.a, mocks.b]) {
      await fetch(`http://127.0.0.1:${m.port}/restock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sku: skuName, codes: [`KEY-${skuName}-${Date.now()}`] }),
      });
    }
  }
  server = await startApi();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  closeMocks(mocks);
  closeServer(server);
  await pool.end();
  await dropTestDb();
});

test('Задача 2: параллельные брони последней единицы — ровно один победитель', async () => {
  // 12 покупателей одновременно жмут «Купить» на товаре с остатком 1
  const attempts = Array.from({ length: 12 }, (_, i) =>
    postJson(base, '/reservations', { sku: 'TEST-GAME-A', purchase_key: `buyer_${i}` }),
  );
  const responses = await Promise.all(attempts);

  const winners = responses.filter((r) => r.status === 201);
  const losers = responses.filter((r) => r.status === 409);
  assert.equal(winners.length, 1, `ожидали одного победителя, получили ${winners.length}`);
  assert.equal(losers.length, 11);

  // проигравшему — понятное сообщение + предложение другого продавца
  for (const l of losers) {
    assert.equal(l.body.error, 'just_sold_out');
    const alternatives = l.body.alternatives;
    assert.ok(Array.isArray(alternatives) && alternatives.some((a) => a.sku === 'TEST-GAME-B'), 'нужна альтернатива у другого продавца');
  }

  // у победителя единица удержана, у проигравших броней нет
  assert.equal(await held('TEST-GAME-A'), 1);
  const resCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM reservations WHERE sku='TEST-GAME-A' AND status='active'`,
  );
  assert.equal(resCount.rows[0].n, 1);

  // победитель подтверждает и оплачивает — товар выдан ровно один раз
  const reservationId = winners[0].body.id;
  const created = await postJson(base, '/orders', { reservation_id: reservationId });
  assert.equal(created.status, 201);
  const orderId = created.body.order_id;

  const paid = await postJson(base, `/orders/${orderId}/pay`, { status: 'paid' });
  assert.equal(paid.status, 200);

  await processDeliveryJobsOnce();
  const order = await waitFor(() => getOrderRow(pool, orderId).then((o) => (o?.status === 'delivered' ? o : null)));
  assert.equal(order.status, 'delivered');
  assert.ok(order.code);

  // одна выдача, один ключ; остаток и held сошлись к нулю
  const okAttempts = await pool.query(`SELECT COUNT(*)::int AS n FROM delivery_attempts WHERE status='ok'`);
  assert.equal(okAttempts.rows[0].n, 1);
  const sm = await pool.query(`SELECT available::int AS a, held::int AS h FROM stock_mirror WHERE sku='TEST-GAME-A'`);
  assert.equal(sm.rows[0].a, 0);
  assert.equal(sm.rows[0].h, 0);

  // оплаченных заказов без товара из-за гонки нет
  const orphan = await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders o
     WHERE EXISTS (SELECT 1 FROM payment_events pe
                   WHERE pe.order_id=o.order_id AND pe.status='paid')
       AND o.status NOT IN ('delivered')`,
  );
  assert.equal(orphan.rows[0].n, 0);
});

test('Двойной клик: одинаковый purchase_key создаёт одну бронь', async () => {
  const key = `double_click_${Date.now()}`;
  const [r1, r2] = await Promise.all([
    postJson(base, '/reservations', { sku: 'TEST-GAME-B', purchase_key: key }),
    postJson(base, '/reservations', { sku: 'TEST-GAME-B', purchase_key: key }),
  ]);
  assert.ok([200, 201].includes(r1.status) && [200, 201].includes(r2.status));
  assert.equal(r1.body.id, r2.body.id);
  const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM reservations WHERE purchase_key=$1`, [key]);
  assert.equal(cnt.rows[0].n, 1);
});
