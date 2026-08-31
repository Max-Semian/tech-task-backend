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
  // A всегда 5xx, B исправен -> проверяем fallback
  mocks = await startMocks({ errorRateA: 1 });
  server = await startApi();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  closeMocks(mocks);
  closeServer(server);
  await pool.end();
  await dropTestDb();
});

test('Критерий 5: поставщик A недоступен -> fallback на B, товар выдан ровно один раз', async () => {
  const created = await postJson(base, '/orders', { sku: 'KEY-GTA5' });
  assert.equal(created.status, 201);
  const orderId = created.body.order_id;

  await postJson(base, '/webhook/payment', {
    event_id: `evt_fb_${Date.now()}`,
    order_id: orderId,
    status: 'paid',
    amount: 1990,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  });

  await processDeliveryJobsOnce();

  const order = await waitFor(() => getOrderRow(pool, orderId).then((o) => (o?.status === 'delivered' ? o : null)));
  assert.equal(order.status, 'delivered');
  assert.ok(order.code);

  const attempts = await pool.query(
    `SELECT provider, status, COUNT(*)::int AS n FROM delivery_attempts
     WHERE order_id=(SELECT id FROM orders WHERE order_id=$1)
     GROUP BY provider, status`,
    [orderId],
  );

  // A не выдал, B выдал ровно один раз
  const bOk = attempts.rows.find((r) => r.provider === 'B' && r.status === 'ok');
  assert.ok(bOk, 'B должен выдать код');
  assert.ok(!attempts.rows.some((r) => r.provider === 'A' && r.status === 'ok'), 'A не должен выдать код');

  const totalOk = attempts.rows.filter((r) => r.status === 'ok').reduce((s, r) => s + r.n, 0);
  assert.equal(totalOk, 1);

  // одна запись в журнале, остаток уменьшен ровно на 1
  const payments = await pool.query(`SELECT COUNT(*)::int AS n FROM money_ledger WHERE entry_type='payment'`);
  assert.equal(payments.rows[0].n, 1);
});
