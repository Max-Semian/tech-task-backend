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
  // пустые пулы у обоих поставщиков -> «пустой остаток» в момент выдачи
  mocks = await startMocks({ withKeys: false });
  server = await startApi();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  closeMocks(mocks);
  closeServer(server);
  await pool.end();
  await dropTestDb();
});

test('Критерий 6: пустой остаток -> восстановимое состояние, без падения', async () => {
  const created = await postJson(base, '/orders', { sku: 'KEY-CS2-PRIME' });
  assert.equal(created.status, 201);
  const orderId = created.body.order_id;

  await postJson(base, '/webhook/payment', {
    event_id: `evt_stock_${Date.now()}`,
    order_id: orderId,
    status: 'paid',
    amount: 1290,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  });

  await processDeliveryJobsOnce();

  // заказ в восстановимом состоянии out_of_stock, не упал
  const order = await waitFor(() => getOrderRow(pool, orderId).then((o) => (o?.status === 'out_of_stock' ? o : null)));
  assert.equal(order.status, 'out_of_stock');
  assert.equal(order.code, null);

  // пополнение: добавляем ключ поставщику B + зеркало остатков
  const code = 'NEWKEY-AAAA-BBBB';
  const restockRes = await fetch(`http://127.0.0.1:${mocks.b.port}/restock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'KEY-CS2-PRIME', codes: [code] }),
  });
  assert.equal(restockRes.status, 200);
  await pool.query(
    `INSERT INTO stock_mirror (sku, available) VALUES ('KEY-CS2-PRIME',1)
     ON CONFLICT (sku) DO UPDATE SET available=stock_mirror.available+1`,
  );

  // безопасная ручная повторная выдача (админка)
  const red = await postJson(base, `/admin/orders/${orderId}/redeliver`, {});
  assert.equal(red.status, 200);

  await processDeliveryJobsOnce();
  const delivered = await waitFor(() => getOrderRow(pool, orderId).then((o) => (o?.status === 'delivered' ? o : null)));
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.code, code);

  // за весь цикл — ровно одна успешная выдача
  const okAttempts = await pool.query(`SELECT COUNT(*)::int AS n FROM delivery_attempts WHERE status='ok'`);
  assert.equal(okAttempts.rows[0].n, 1);

  // повторный redeliver после delivered — идемпотентен, код не меняется
  const red2 = await postJson(base, `/admin/orders/${orderId}/redeliver`, {});
  assert.equal(red2.body.changed, false);
  const finalOrder = await getOrderRow(pool, orderId);
  assert.equal(finalOrder.code, code);
});
