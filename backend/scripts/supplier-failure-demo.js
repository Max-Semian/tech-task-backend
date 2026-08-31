// Демо отказа и фолбэка поставщика (критерий 5 приёмки):
// Поставщик A всегда 5xx (errorRate=1), fallback на B -> товар выдан ровно один раз.
//
// ВАЖНО: скрипт сбрасывает схему и данные dev-базы.
// Использование: npm run supplier-failure-demo
import { pool, waitForDb, resetSchema } from '../src/db.js';
import { createApp } from '../src/app.js';
import { setSupplierUrls } from '../src/config.js';
import { PRODUCTS, splitPoolBetweenSuppliers } from '../src/catalog.js';
import { createSupplierServer, seedStorePool } from '../src/suppliers/mock.js';
import { processDeliveryJobsOnce } from '../src/services/deliveryService.js';
import { logger } from '../src/logger.js';

async function main() {
  await waitForDb(pool);
  await resetSchema(pool);

  for (const p of PRODUCTS) {
    await pool.query(
      `INSERT INTO products (sku,name,type,price,currency,image) VALUES ($1,$2,$3,$4,$5,$6)`,
      [p.sku, p.name, p.type, p.price, p.currency, p.image],
    );
  }

  const a = await createSupplierServer({ port: 0, name: 'A', errorRate: 1, timeoutRate: 0 });
  const b = await createSupplierServer({ port: 0, name: 'B', errorRate: 0, timeoutRate: 0 });
  const pools = splitPoolBetweenSuppliers();
  seedStorePool(a.store, pools.a);
  seedStorePool(b.store, pools.b);
  setSupplierUrls(`http://127.0.0.1:${a.port}`, `http://127.0.0.1:${b.port}`);

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const orderRes = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'KEY-GTA5' }),
  });
  const order = await orderRes.json();
  logger.info({ orderId: order.order_id }, 'order created');

  await fetch(`${base}/webhook/payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: `evt_fallback_${Date.now()}`,
      order_id: order.order_id,
      status: 'paid',
      amount: 1990,
      currency: 'RUB',
      created_at: new Date().toISOString(),
    }),
  });

  await processDeliveryJobsOnce();

  const final = await pool.query('SELECT * FROM orders WHERE order_id=$1', [order.order_id]);
  const attempts = await pool.query(
    `SELECT provider, status, COUNT(*)::int AS n FROM delivery_attempts
     WHERE order_id=(SELECT id FROM orders WHERE order_id=$1)
     GROUP BY provider, status ORDER BY provider`,
    [order.order_id],
  );

  const report = {
    order_id: order.order_id,
    order_status: final.rows[0]?.status,
    delivered_code: final.rows[0]?.code || null,
    attempts: attempts.rows,
  };
  const providerB = attempts.rows.find((r) => r.provider === 'B' && r.status === 'ok');
  const pass = report.order_status === 'delivered' && !!report.delivered_code && !!providerB;

  console.log('\n=== SUPPLIER FALLBACK REPORT ===');
  console.log(JSON.stringify(report, null, 2));
  console.log(pass ? '✅ PASS: A недоступен, fallback на B, выдан ровно один раз' : '❌ FAIL');
  console.log('================================\n');

  await a.close();
  await b.close();
  server.close();
  await pool.end();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  logger.error({ err: e.message, stack: e.stack }, 'demo failed');
  process.exit(1);
});
