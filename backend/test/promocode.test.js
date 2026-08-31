import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupDb, dropTestDb, seedProducts, seedPromocodes, startMocks, startApi,
  postJson, getJson, getOrderRow, closeMocks, closeServer,
} from './helpers.js';
import { pool } from '../src/db.js';

let base;
let mocks;
let server;

before(async () => {
  await setupDb();
  await seedProducts(pool);
  await seedPromocodes(pool);
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

test('promo/validate: WELCOME10 -> 10% скидка, использование НЕ списывается', async () => {
  const r = await postJson(base, '/promo/validate', { code: 'WELCOME10', amount: 500 });
  assert.equal(r.status, 200);
  assert.equal(r.body.valid, true);
  assert.equal(r.body.discount, 50);
  assert.equal(r.body.final_amount, 450);
  const used = await pool.query('SELECT used_count FROM promocodes WHERE code=$1', ['WELCOME10']);
  assert.equal(used.rows[0].used_count, 0);
});

test('promo/validate: несуществующий код -> valid:false', async () => {
  const r = await postJson(base, '/promo/validate', { code: 'NOPE', amount: 500 });
  assert.equal(r.body.valid, false);
});

test('заказ с промокодом: скидку считает сервер, сумма со скидкой', async () => {
  const r = await postJson(base, '/orders', { sku: 'STEAM-TOPUP-1000', promocode: 'welcome10' });
  assert.equal(r.status, 201);
  assert.equal(r.body.amount, 900);          // 1000 - 10%
  assert.equal(r.body.promo_code, 'WELCOME10');
  assert.equal(r.body.promo_discount, 100);
});

test('Критерий 5: LIMIT3 под 50 параллельными запросами — не более 3 использований', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      postJson(base, '/orders', { sku: 'STEAM-TOPUP-500', promocode: 'LIMIT3' })),
  );
  const created = attempts.filter((r) => r.status === 201);
  const rejected = attempts.filter((r) => r.status === 409);
  assert.equal(created.length, 3);
  assert.equal(rejected.length, 47);
  const used = await pool.query('SELECT used_count FROM promocodes WHERE code=$1', ['LIMIT3']);
  assert.equal(used.rows[0].used_count, 3);
});

test('ONCEONLY: ровно одно применение', async () => {
  const r1 = await postJson(base, '/orders', { sku: 'KEY-GTA5', promocode: 'ONCEONLY' });
  const r2 = await postJson(base, '/orders', { sku: 'KEY-GTA5', promocode: 'ONCEONLY' });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 409);
});

test('GG500: фиксированная скидка 500', async () => {
  const r = await postJson(base, '/orders', { sku: 'STEAM-TOPUP-2500', promocode: 'GG500' });
  assert.equal(r.status, 201);
  assert.equal(r.body.amount, 2000);
  assert.equal(r.body.promo_discount, 500);
});

test('идемпотентный повтор с промокодом не списывает лимит повторно', async () => {
  const before = await pool.query('SELECT used_count FROM promocodes WHERE code=$1', ['GG500']);
  const body = { sku: 'STEAM-TOPUP-1000', promocode: 'GG500', idempotency_key: `idem_promo_${Date.now()}` };
  const r1 = await postJson(base, '/orders', body);
  const r2 = await postJson(base, '/orders', body);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  assert.equal(r1.body.order_id, r2.body.order_id);
  const after = await pool.query('SELECT used_count FROM promocodes WHERE code=$1', ['GG500']);
  assert.equal(after.rows[0].used_count, before.rows[0].used_count + 1);
});

test('POST /orders/:id/pay: paid -> delivered, failed -> payment_failed', async () => {
  const { processDeliveryJobsOnce } = await import('../src/services/deliveryService.js');

  const o1 = await postJson(base, '/orders', { sku: 'STEAM-TOPUP-500' });
  const pay = await postJson(base, `/orders/${o1.body.order_id}/pay`, { status: 'paid' });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.accepted, true);
  await processDeliveryJobsOnce();
  const delivered = await getOrderRow(pool, o1.body.order_id);
  assert.equal(delivered.status, 'delivered');
  assert.ok(delivered.code);

  const o2 = await postJson(base, '/orders', { sku: 'STEAM-TOPUP-500' });
  await postJson(base, `/orders/${o2.body.order_id}/pay`, { status: 'failed' });
  const failed = await getOrderRow(pool, o2.body.order_id);
  assert.equal(failed.status, 'payment_failed');
});

test('GET /products возвращает каталог (фуллстек витрина)', async () => {
  const r = await getJson(base, '/products');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.length >= 12);
  const steam = r.body.find((p) => p.sku === 'STEAM-TOPUP-500');
  assert.equal(steam.price, 500);
  assert.equal(typeof steam.available, 'number');
});
