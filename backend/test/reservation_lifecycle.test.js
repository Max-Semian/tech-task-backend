// 2-я часть ТЗ, Задача 3+4: таймер брони, CAS на подтверждении,
// однократное освобождение held, оплата только до дедлайна, идемпотентность.
import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupDb, dropTestDb, seedProducts, startMocks, startApi,
  postJson, getOrderRow, waitFor, closeMocks, closeServer,
} from './helpers.js';
import { pool } from '../src/db.js';
import { processDeliveryJobsOnce } from '../src/services/deliveryService.js';
import { expireMarketplaceHoldsOnce } from '../src/services/reconciler.js';

let base;
let mocks;
let server;
let n = 0;

const sku = () => {
  n += 1;
  return n % 2 ? 'KEY-CS2-PRIME' : 'KEY-GTA5';
};

async function setStock(activeSku, available) {
  await pool.query(
    `INSERT INTO stock_mirror (sku, available) VALUES ($1,$2)
     ON CONFLICT (sku) DO UPDATE SET available=EXCLUDED.available, held=0`,
    [activeSku, available],
  );
}

async function sm(activeSku) {
  const r = await pool.query(
    `SELECT available::int AS a, held::int AS h FROM stock_mirror WHERE sku=$1`,
    [activeSku],
  );
  return { available: r.rows[0]?.a ?? 0, held: r.rows[0]?.h ?? 0 };
}

async function reserve(activeSku) {
  const r = await postJson(base, '/reservations', {
    sku: activeSku,
    purchase_key: `life_${activeSku}_${Date.now()}_${Math.random()}`,
  });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  return r.body;
}

async function confirm(rid) {
  const r = await postJson(base, '/orders', { reservation_id: rid });
  return r;
}

before(async () => {
  await setupDb();
  await seedProducts(pool);
  mocks = await startMocks();
  server = await startApi();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  closeMocks(mocks);
  closeServer(server);
  await pool.end();
  await dropTestDb();
});

test('Ленивое освобождение: GET протухшей брони возвращает единицу', async () => {
  const s = 'KEY-CS2-PRIME';
  await setStock(s, 3);
  const r = await reserve(s);
  assert.equal((await sm(s)).held, 1);

  await pool.query(`UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE id=$1`, [r.id]);
  const got = await fetch(`${base}/reservations/${r.id}`).then((res) => res.json());
  assert.equal(got.status, 'expired');
  const st = await sm(s);
  assert.equal(st.held, 0);
  assert.equal(st.available, 3);
});

test('Sweeper: заказ-из-брони с протухшим pay_until истекает ровно один раз', async () => {
  const s = 'KEY-GTA5';
  await setStock(s, 2);
  const r = await reserve(s);
  const created = await confirm(r.id);
  assert.equal(created.status, 201);
  const orderId = created.body.order_id;
  assert.equal((await sm(s)).held, 1, 'после confirm held не меняется (единица перешла к заказу)');

  // броня уже confirmed -> sweeper её не трогает даже при протухшем expires_at
  await pool.query(`UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE id=$1`, [r.id]);
  await expireMarketplaceHoldsOnce();
  const reservation = await pool.query(`SELECT status FROM reservations WHERE id=$1`, [r.id]);
  assert.equal(reservation.rows[0].status, 'confirmed', 'confirmed-бронь не участвует повторно в sweep');
  assert.equal((await sm(s)).held, 1);

  // теперь истекает дедлайн оплаты заказа
  await pool.query(`UPDATE orders SET pay_until = now() - interval '1 second' WHERE order_id=$1`, [orderId]);
  const released = await expireMarketplaceHoldsOnce();
  assert.ok(released >= 1);
  const order = await getOrderRow(pool, orderId);
  assert.equal(order.status, 'expired');
  assert.equal((await sm(s)).held, 0);

  // повторный sweep не уводит счётчик в минус
  await expireMarketplaceHoldsOnce();
  assert.equal((await sm(s)).held, 0);

  // оплатить истёкший заказ нельзя
  const pay = await postJson(base, `/orders/${orderId}/pay`, { status: 'paid' });
  assert.equal(pay.status, 409);
  assert.equal(pay.body.error, 'reservation_expired');
});

test('Повторное подтверждение одной брони возвращает тот же заказ', async () => {
  const s = 'STEAM-TOPUP-500';
  await setStock(s, 5);
  const r = await reserve(s);
  const a = await confirm(r.id);
  const b = await confirm(r.id);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(a.body.order_id, b.body.order_id);
});

test('Заказ создаётся по ТЕКУЩЕЙ цене (не по цене на момент брони)', async () => {
  const s = 'GIFT-ROBLOX-800';
  await setStock(s, 4);
  const r = await reserve(s);
  assert.equal(r.price, 890); // цена брони
  await pool.query(`UPDATE products SET price=999 WHERE sku=$1`, [s]);
  const created = await confirm(r.id);
  assert.equal(created.body.amount, 999, 'подорожало — новая цена видна уже в заказе (до оплаты)');
  await pool.query(`UPDATE products SET price=890 WHERE sku=$1`, [s]);
});

test('payment_failed освобождает единицу, повторная оплата не задваивает', async () => {
  const s = 'KEY-CS2-PRIME';
  await setStock(s, 2);
  const r = await reserve(s);
  const created = await confirm(r.id);
  const fail = await postJson(base, `/orders/${created.body.order_id}/pay`, { status: 'failed' });
  assert.equal(fail.status, 200);
  const order = await getOrderRow(pool, created.body.order_id);
  assert.equal(order.status, 'payment_failed');
  assert.equal((await sm(s)).held, 0, 'единица вернулась в продажу');

  // повторная попытка «успешной» оплаты оплаченного заказа ничего не меняет
  const okRes = await postJson(base, `/orders/${created.body.order_id}/pay`, { status: 'paid' });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.order_status, 'payment_failed');
  const after = await getOrderRow(pool, created.body.order_id);
  assert.equal(after.status, 'payment_failed');
});

test('Подтверждение брони ровно один раз: CAS не даёт двух заказов (параллельно)', async () => {
  const s = 'GIFT-PSN-1000';
  await setStock(s, 2);
  const r = await reserve(s);
  const [a, b] = await Promise.all([confirm(r.id), confirm(r.id)]);
  assert.equal(a.body.order_id, b.body.order_id);
  const cnt = await pool.query(
    `SELECT COUNT(*)::int AS n FROM orders WHERE reservation_id=$1`,
    [r.id],
  );
  assert.equal(cnt.rows[0].n, 1, 'на бронь создан ровно один заказ');
});

test('Полный happy path: бронь -> заказ -> оплата -> выдача', async () => {
  const s = 'KEY-GTA5';
  await setStock(s, 1);
  const r = await reserve(s);
  assert.equal(r.status, 'active');
  const created = await confirm(r.id);
  const orderId = created.body.order_id;
  await postJson(base, `/orders/${orderId}/pay`, { status: 'paid' });
  await processDeliveryJobsOnce();
  const order = await waitFor(() => getOrderRow(pool, orderId).then((o) => (o?.status === 'delivered' ? o : null)));
  assert.equal(order.status, 'delivered');
  assert.ok(order.code);
  const st = await sm(s);
  assert.equal(st.available, 0);
  assert.equal(st.held, 0);
});
