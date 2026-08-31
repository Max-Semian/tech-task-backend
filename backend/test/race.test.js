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

test('Критерий 1: 50 параллельных вебхуков paid -> ровно один факт выдачи', async () => {
  const created = await postJson(base, '/orders', { sku: 'KEY-CS2-PRIME' });
  assert.equal(created.status, 201);
  const orderId = created.body.order_id;

  // 50 ВЕБХУКОВ С РАЗНЫМИ event_id (максимально состязательный сценарий)
  const events = Array.from({ length: 50 }, (_, i) => ({
    event_id: `evt_race_${i}_${Date.now()}`,
    order_id: orderId,
    status: 'paid',
    amount: 1290,
    currency: 'RUB',
    created_at: new Date(Date.now() - (50 - i) * 1000).toISOString(),
  }));

  const responses = await Promise.all(events.map((e) => postJson(base, '/webhook/payment', e)));
  for (const r of responses) assert.equal(r.status, 200);

  const processed = await processDeliveryJobsOnce();
  assert.ok(processed >= 1);

  const order = await waitFor(() => getOrderRow(pool, orderId).then((o) => (o?.status === 'delivered' ? o : null)));
  assert.equal(order.status, 'delivered');
  assert.ok(order.code);

  // ровно один факт выдачи
  const okAttempts = await pool.query(`SELECT COUNT(*)::int AS n FROM delivery_attempts WHERE status='ok'`);
  assert.equal(okAttempts.rows[0].n, 1);

  // в журнале ровно один платёж (журнал сходится)
  const payments = await pool.query(`SELECT COUNT(*)::int AS n FROM money_ledger WHERE entry_type='payment'`);
  assert.equal(payments.rows[0].n, 1);

  // израсходован ровно один ключ: остаток 4 -> 3
  const stock = await pool.query(`SELECT available::int AS available FROM stock_mirror WHERE sku='KEY-CS2-PRIME'`);
  assert.equal(stock.rows[0].available, 3);

  // заказ в финальном статусе, повторные вебхуки не меняют код
  const again = await getOrderRow(pool, orderId);
  assert.equal(again.code, order.code);
  assert.equal(again.status, 'delivered');
});
