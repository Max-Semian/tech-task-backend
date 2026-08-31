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

test('неизвестный SKU -> 404', async () => {
  const r = await postJson(base, '/orders', { sku: 'NOPE' });
  assert.equal(r.status, 404);
});

test('валидация: без sku -> 400', async () => {
  const r = await postJson(base, '/orders', {});
  assert.equal(r.status, 400);
});
