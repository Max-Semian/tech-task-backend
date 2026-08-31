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

test('Критерий 2: повторный вебхук с тем же event_id ничего не меняет', async () => {
  const created = await postJson(base, '/orders', { sku: 'KEY-EFT' });
  const orderId = created.body.order_id;
  const event = {
    event_id: `evt_idem_${Date.now()}`,
    order_id: orderId,
    status: 'paid',
    amount: 3490,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  };

  const r1 = await postJson(base, '/webhook/payment', event);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.duplicate, false);

  const r2 = await postJson(base, '/webhook/payment', event); // тот же event_id
  assert.equal(r2.status, 200);
  assert.equal(r2.body.duplicate, true);

  await processDeliveryJobsOnce();
  const order = await waitFor(() => getOrderRow(pool, orderId).then((o) => (o?.status === 'delivered' ? o : null)));
  assert.equal(order.status, 'delivered');

  // один факт выдачи, один платёж в журнале
  const okAttempts = await pool.query(`SELECT COUNT(*)::int AS n FROM delivery_attempts WHERE status='ok'`);
  assert.equal(okAttempts.rows[0].n, 1);
  const payments = await pool.query(`SELECT COUNT(*)::int AS n FROM money_ledger WHERE entry_type='payment'`);
  assert.equal(payments.rows[0].n, 1);

  // повтор уже после доставки — тоже no-op, код не меняется
  const r3 = await postJson(base, '/webhook/payment', event);
  assert.equal(r3.body.duplicate, true);
  const again = await getOrderRow(pool, orderId);
  assert.equal(again.code, order.code);
  assert.equal(again.status, 'delivered');
});

test('Критерий 2b: повторное создание заказа с тем же idempotency_key — тот же заказ', async () => {
  const body = { sku: 'SUB-DISCORD-1M', idempotency_key: `idem_${Date.now()}` };
  const r1 = await postJson(base, '/orders', body);
  const r2 = await postJson(base, '/orders', body);
  assert.equal(r1.body.order_id, r2.body.order_id);
  assert.equal(r2.status, 200);
});
