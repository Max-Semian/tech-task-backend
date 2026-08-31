import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupDb, dropTestDb, seedProducts, startMocks, startApi,
  postJson, getJson, closeMocks, closeServer,
} from './helpers.js';
import { pool } from '../src/db.js';
import { processDeliveryJobsOnce } from '../src/services/deliveryService.js';
import { findInconsistencies, linkPendingEvents } from '../src/services/reconciler.js';

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

test('Этап 4: «оплачен, но не выдан» -> находится сверкой, исчезает после выдачи', async () => {
  const created = await postJson(base, '/orders', { sku: 'KEY-CS2-PRIME' });
  const orderId = created.body.order_id;
  await postJson(base, '/webhook/payment', {
    event_id: `evt_rec_${Date.now()}`,
    order_id: orderId,
    status: 'paid',
    amount: 1290,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  });

  // воркер НЕ запущен -> заказ в 'paid', не выдан
  const report = await findInconsistencies();
  assert.ok(report.paid_not_delivered.some((o) => o.order_id === orderId));

  // обрабатываем выдачи -> исчезает из списка
  await processDeliveryJobsOnce();
  const report2 = await findInconsistencies();
  assert.ok(!report2.paid_not_delivered.some((o) => o.order_id === orderId));
});

test('Этап 4: «выдан, но не оплачен» -> находится сверкой', async () => {
  await pool.query(
    `INSERT INTO orders (order_id, status, amount, currency, code, delivered_at)
     VALUES ('ord_nopay_1','delivered',100,'RUB','FAKE-CODE-1', now())`,
  );
  const report = await findInconsistencies();
  assert.ok(report.delivered_not_paid.some((o) => o.order_id === 'ord_nopay_1'));
});

test('Этап 4: журнал денег всегда сходится (balance.ok)', async () => {
  const created = await postJson(base, '/orders', { sku: 'STEAM-TOPUP-500' });
  await postJson(base, '/webhook/payment', {
    event_id: `evt_bal_${Date.now()}`,
    order_id: created.body.order_id,
    status: 'paid',
    amount: 500,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  });
  await processDeliveryJobsOnce();

  const report = await findInconsistencies();
  assert.equal(report.balance.ok, true);
  assert.ok(report.balance.ledger_total > 0);
});

test('Этап 4: endpoint /admin/reconciliation отвечает', async () => {
  const r = await getJson(base, '/admin/reconciliation');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.paid_not_delivered));
  assert.ok(Array.isArray(r.body.delivered_not_paid));
  assert.equal(typeof r.body.balance.ok, 'boolean');
});

test('Этап 4: линковка необработанных событий через reconciler', async () => {
  // вебхук без заказа, затем заказ без линковки (прямое создание) -> reconciler доводит
  const orderId = `ord_link_${Date.now()}`;
  await postJson(base, '/webhook/payment', {
    event_id: `evt_link_${Date.now()}`,
    order_id: orderId,
    status: 'paid',
    amount: 399,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  });
  // создаём заказ с отключённой линковкой через прямой SQL, чтобы осталось unapplied
  await pool.query(
    `INSERT INTO orders (order_id, amount, currency) VALUES ($1, 399, 'RUB')`,
    [orderId],
  );
  const before = await pool.query(`SELECT applied_at FROM payment_events WHERE order_id=$1`, [orderId]);
  assert.equal(before.rows[0].applied_at, null);

  const linked = await linkPendingEvents();
  assert.ok(linked >= 1);
  const after = await pool.query(`SELECT status FROM orders WHERE order_id=$1`, [orderId]);
  assert.equal(after.rows[0].status, 'paid');
});
