import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupDb, dropTestDb, seedProducts, seedStockMirror, startMocks, startApi,
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

// Контракт вебхука: status: paid | failed. failed -> симметричный CAS created -> payment_failed.
test('вебхук status=failed -> created -> payment_failed (финальный), без выдачи и без денег', async () => {
  const created = await postJson(base, '/orders', { sku: 'STEAM-TOPUP-500' });
  assert.equal(created.status, 201);
  const orderId = created.body.order_id;

  const res = await postJson(base, '/webhook/payment', {
    event_id: `evt_failed_${Date.now()}`,
    order_id: orderId,
    status: 'failed',
    amount: 500,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.applied, true);

  const order = await getOrderRow(pool, orderId);
  assert.equal(order.status, 'payment_failed');
  assert.equal(order.code, null);

  // никакой задачи выдачи и никаких денежных движений
  const jobs = await pool.query('SELECT COUNT(*)::int AS n FROM delivery_jobs');
  assert.equal(jobs.rows[0].n, 0);
  const ledger = await pool.query('SELECT COUNT(*)::int AS n FROM money_ledger');
  assert.equal(ledger.rows[0].n, 0);
});

test('повторный failed с тем же event_id — no-op (идемпотентность)', async () => {
  const created = await postJson(base, '/orders', { sku: 'SUB-DISCORD-1M' });
  const orderId = created.body.order_id;
  const event = {
    event_id: `evt_fdup_${Date.now()}`,
    order_id: orderId,
    status: 'failed',
    amount: 399,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  };

  await postJson(base, '/webhook/payment', event);
  const dup = await postJson(base, '/webhook/payment', event);
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);

  const order = await getOrderRow(pool, orderId);
  assert.equal(order.status, 'payment_failed');
});

test('поздний failed после paid — no-op, заказ доставляется (не откат)', async () => {
  const created = await postJson(base, '/orders', { sku: 'KEY-CS2-PRIME' });
  const orderId = created.body.order_id;

  await postJson(base, '/webhook/payment', {
    event_id: `evt_p_${Date.now()}`,
    order_id: orderId,
    status: 'paid',
    amount: 1290,
    currency: 'RUB',
    created_at: '2025-01-01T10:00:00Z',
  });
  // поздний failed (бизнес-время позже)
  await postJson(base, '/webhook/payment', {
    event_id: `evt_f_${Date.now()}`,
    order_id: orderId,
    status: 'failed',
    amount: 1290,
    currency: 'RUB',
    created_at: '2025-01-01T11:00:00Z',
  });

  await processDeliveryJobsOnce();
  const order = await waitFor(() => getOrderRow(pool, orderId).then((o) => (o?.status === 'delivered' ? o : null)));
  assert.equal(order.status, 'delivered');
  assert.ok(order.code);
});
