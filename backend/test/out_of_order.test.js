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

test('Критерий 3: вебхук пришёл раньше заказа — обработано корректно, без потери', async () => {
  const orderId = `ord_early_${Date.now()}`;

  // вебхук по ещё не существующему заказу: 200, событие сохранено, не применено
  const wh = await postJson(base, '/webhook/payment', {
    event_id: `evt_early_${Date.now()}`,
    order_id: orderId,
    status: 'paid',
    amount: 890,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  });
  assert.equal(wh.status, 200);
  assert.equal(wh.body.applied, false);

  // создаём заказ с тем же order_id — линковка применит оплату сразу
  const created = await postJson(base, '/orders', { sku: 'GIFT-ROBLOX-800', order_id: orderId });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'paid');

  await processDeliveryJobsOnce();
  const order = await waitFor(() => getOrderRow(pool, orderId).then((o) => (o?.status === 'delivered' ? o : null)));
  assert.equal(order.status, 'delivered');
  assert.ok(order.code);

  // ровно одна выдача, без дублей
  const okAttempts = await pool.query(`SELECT COUNT(*)::int AS n FROM delivery_attempts WHERE status='ok'`);
  assert.equal(okAttempts.rows[0].n, 1);
});

test('Критерий 3b: несколько событий до заказа применяются в порядке created_at', async () => {
  // paid раньше, failed позже -> итог paid
  const o1 = `ord_seq_paidfirst_${Date.now()}`;
  await postJson(base, '/webhook/payment', {
    event_id: `evt_a_${Date.now()}`, order_id: o1, status: 'paid', amount: 500, currency: 'RUB',
    created_at: '2025-01-01T10:00:00Z',
  });
  await postJson(base, '/webhook/payment', {
    event_id: `evt_b_${Date.now()}`, order_id: o1, status: 'failed', amount: 500, currency: 'RUB',
    created_at: '2025-01-01T11:00:00Z',
  });
  const c1 = await postJson(base, '/orders', { sku: 'STEAM-TOPUP-500', order_id: o1 });
  assert.equal(c1.body.status, 'paid');

  // failed раньше, paid позже -> итог payment_failed (детерминированно)
  const o2 = `ord_seq_failedfirst_${Date.now()}`;
  await postJson(base, '/webhook/payment', {
    event_id: `evt_c_${Date.now()}`, order_id: o2, status: 'failed', amount: 500, currency: 'RUB',
    created_at: '2025-01-01T10:00:00Z',
  });
  await postJson(base, '/webhook/payment', {
    event_id: `evt_d_${Date.now()}`, order_id: o2, status: 'paid', amount: 500, currency: 'RUB',
    created_at: '2025-01-01T11:00:00Z',
  });
  const c2 = await postJson(base, '/orders', { sku: 'STEAM-TOPUP-500', order_id: o2 });
  assert.equal(c2.body.status, 'payment_failed');
});
