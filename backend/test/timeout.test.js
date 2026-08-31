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
  // короткие таймауты, чтобы тест не ждал долго
  mocks = await startMocks({ timeoutMs: 250 });
  server = await startApi();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  closeMocks(mocks);
  closeServer(server);
  await pool.end();
  await dropTestDb();
});

test('Критерий 4: таймаут поставщика, который выдал код -> повтор не создаёт вторую выдачу', async () => {
  const created = await postJson(base, '/orders', { sku: 'KEY-GTA5' });
  assert.equal(created.status, 201);
  const orderId = created.body.order_id;

  // детерминированно: первый /issue к A «выдал код, но завис» (выдал + не ответил в срок)
  mocks.a.store.force = { mode: 'timeout' };

  await postJson(base, '/webhook/payment', {
    event_id: `evt_tmo_${Date.now()}`,
    order_id: orderId,
    status: 'paid',
    amount: 1990,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  });

  const processed = await processDeliveryJobsOnce();
  assert.ok(processed >= 1);

  const order = await waitFor(() => getOrderRow(pool, orderId).then((o) => (o?.status === 'delivered' ? o : null)));
  assert.equal(order.status, 'delivered');
  assert.ok(order.code);

  // ровно одна успешная попытка, и код получен у A тем же request_id
  const okAttempts = await pool.query(
    `SELECT provider, request_id, status, code FROM delivery_attempts WHERE status='ok'`,
  );
  assert.equal(okAttempts.rows.length, 1);
  assert.equal(okAttempts.rows[0].provider, 'A');

  // поставщик A помнит код за заказом: повторный запрос вернёт тот же код, а не новый
  assert.equal(mocks.a.store.byOrder.get(orderId), order.code);

  // одна выдача = один израсходованный ключ (остаток 4 -> 3)
  const stock = await pool.query(`SELECT available::int AS available FROM stock_mirror WHERE sku='KEY-GTA5'`);
  assert.equal(stock.rows[0].available, 3);
});
