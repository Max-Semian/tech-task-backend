import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupDb, dropTestDb, seedProducts, seedStockMirror, startMocks, startApi,
  postJson, getJson, closeMocks, closeServer,
} from './helpers.js';
import { pool } from '../src/db.js';

let base;
let mocks;
let server;

before(async () => {
  await setupDb();
  await seedProducts(pool);
  await seedStockMirror(pool);
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

test('POST /orders создаёт заказ по SKU (Этап 1)', async () => {
  const r = await postJson(base, '/orders', { sku: 'STEAM-TOPUP-500' });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'created');
  assert.equal(r.body.amount, 500);
  assert.equal(r.body.currency, 'RUB');
  assert.equal(r.body.items[0].sku, 'STEAM-TOPUP-500');
});

test('GET /orders/:id возвращает заказ; неизвестный id -> 404', async () => {
  const created = await postJson(base, '/orders', { sku: 'KEY-CS2-PRIME' });
  const got = await getJson(base, `/orders/${created.body.order_id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.order_id, created.body.order_id);

  const missing = await getJson(base, '/orders/ord_nope');
  assert.equal(missing.status, 404);
});

test('POST /orders с тем же idempotency_key возвращает тот же заказ', async () => {
  const body = { sku: 'GIFT-PSN-1000', idempotency_key: `idem_${Date.now()}` };
  const r1 = await postJson(base, '/orders', body);
  const r2 = await postJson(base, '/orders', body);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  assert.equal(r1.body.order_id, r2.body.order_id);
});

test('order_id первичен: существующий order_id возвращается независимо от SKU/ключей', async () => {
  const r1 = await postJson(base, '/orders', {
    sku: 'STEAM-TOPUP-500', order_id: `ord_prio_${Date.now()}`, idempotency_key: 'k_prio_1',
  });
  assert.equal(r1.status, 201);
  // повтор с тем же order_id, но другим SKU и другим idempotency_key -> 200, тот же заказ
  const r2 = await postJson(base, '/orders', {
    sku: 'KEY-GTA5', order_id: r1.body.order_id, idempotency_key: 'k_prio_2',
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.order_id, r1.body.order_id);
  assert.equal(r2.body.items[0].sku, 'STEAM-TOPUP-500'); // исходный SKU, не переданный
});

test('новый order_id + idempotency_key, занятый другим заказом -> 409', async () => {
  const takenKey = `key_taken_${Date.now()}`;
  await postJson(base, '/orders', { sku: 'STEAM-TOPUP-1000', idempotency_key: takenKey });
  const r = await postJson(base, '/orders', {
    sku: 'STEAM-TOPUP-500', order_id: `ord_fresh_${Date.now()}`, idempotency_key: takenKey,
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'idempotency_key_conflict');
});

test('гонка двух одинаковых POST /orders (тот же order_id) -> один заказ, без дубля', async () => {
  const orderId = `ord_race_${Date.now()}`;
  const body = { sku: 'STEAM-TOPUP-500', order_id: orderId };
  const [r1, r2] = await Promise.all([postJson(base, '/orders', body), postJson(base, '/orders', body)]);
  const statuses = [r1.status, r2.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 201]); // один создал, второй получил существующий
  assert.equal(r1.body.order_id, r2.body.order_id);
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE order_id=$1', [orderId]);
  assert.equal(count.rows[0].n, 1);
});

test('idempotency_key без order_id: повтор -> тот же заказ (200)', async () => {
  const body = { sku: 'GIFT-ROBLOX-800', idempotency_key: `idem_only_${Date.now()}` };
  const r1 = await postJson(base, '/orders', body);
  const r2 = await postJson(base, '/orders', body);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  assert.equal(r1.body.order_id, r2.body.order_id);
});

test('неизвестный SKU -> 404', async () => {
  const r = await postJson(base, '/orders', { sku: 'NOPE' });
  assert.equal(r.status, 404);
});

test('валидация: без sku -> 400', async () => {
  const r = await postJson(base, '/orders', {});
  assert.equal(r.status, 400);
});
