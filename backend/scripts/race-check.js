// Воспроизведение проверки гонок (критерий 1 приёмки):
// 50 параллельных вебхуков «paid» по одному заказу -> ровно один факт выдачи.
//
// ВАЖНО: скрипт сбрасывает схему и данные dev-базы (чистая среда).
// Использование: npm run race-check   (предварительно: docker compose up -d, npm run seed)
import { pool, waitForDb, resetSchema } from '../src/db.js';
import { createApp } from '../src/app.js';
import { config, setSupplierUrls } from '../src/config.js';
import { PRODUCTS, splitPoolBetweenSuppliers } from '../src/catalog.js';
import { createSupplierServer, seedStorePool } from '../src/suppliers/mock.js';
import { processDeliveryJobsOnce } from '../src/services/deliveryService.js';
import { logger } from '../src/logger.js';

const PARALLEL = 50;

async function main() {
  await waitForDb(pool);
  await resetSchema(pool);

  for (const p of PRODUCTS) {
    await pool.query(
      `INSERT INTO products (sku,name,type,price,currency,image) VALUES ($1,$2,$3,$4,$5,$6)`,
      [p.sku, p.name, p.type, p.price, p.currency, p.image],
    );
  }

  const a = await createSupplierServer({ port: 0, name: 'A', errorRate: 0, timeoutRate: 0 });
  const b = await createSupplierServer({ port: 0, name: 'B', errorRate: 0, timeoutRate: 0 });
  const pools = splitPoolBetweenSuppliers();
  seedStorePool(a.store, pools.a);
  seedStorePool(b.store, pools.b);
  setSupplierUrls(`http://127.0.0.1:${a.port}`, `http://127.0.0.1:${b.port}`);

  // зеркало остатков
  const counts = new Map();
  for (const m of [pools.a, pools.b]) for (const [sku, codes] of m) counts.set(sku, (counts.get(sku) || 0) + codes.length);
  for (const [sku, n] of counts) {
    await pool.query('INSERT INTO stock_mirror (sku, available) VALUES ($1,$2)', [sku, n]);
  }

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // создаём заказ
  const orderRes = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'KEY-CS2-PRIME' }),
  });
  const order = await orderRes.json();
  logger.info({ status: orderRes.status, orderId: order.order_id }, 'order created');

  // 50 параллельных вебхуков
  const t0 = Date.now();
  const events = Array.from({ length: PARALLEL }, (_, i) => ({
    event_id: `evt_race_${i}_${Date.now()}`,
    order_id: order.order_id,
    status: 'paid',
    amount: 1290,
    currency: 'RUB',
    created_at: new Date().toISOString(),
  }));
  const responses = await Promise.all(
    events.map((e) =>
      fetch(`${base}/webhook/payment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(e),
      }),
    ),
  );
  const statuses = responses.map((r) => r.status);
  logger.info({ all_200: statuses.every((s) => s === 200), statuses: [...new Set(statuses)] }, 'webhooks fired');

  const processed = await processDeliveryJobsOnce();
  logger.info({ processed }, 'jobs processed');

  const final = await pool.query('SELECT * FROM orders WHERE order_id=$1', [order.order_id]);
  const okAttempts = await pool.query(`SELECT COUNT(*)::int AS n FROM delivery_attempts WHERE status='ok'`);
  const payments = await pool.query(`SELECT COUNT(*)::int AS n FROM money_ledger WHERE entry_type='payment'`);
  const stock = await pool.query(`SELECT available FROM stock_mirror WHERE sku='KEY-CS2-PRIME'`);

  const report = {
    order_id: order.order_id,
    order_status: final.rows[0]?.status,
    delivered_code: final.rows[0]?.code || null,
    successful_delivery_attempts: okAttempts.rows[0].n,
    ledger_payment_entries: payments.rows[0].n,
    stock_available_after: stock.rows[0]?.available ?? null,
    webhook_responses: { all_200: statuses.every((s) => s === 200) },
    elapsed_ms: Date.now() - t0,
  };

  const pass =
    report.order_status === 'delivered' &&
    !!report.delivered_code &&
    report.successful_delivery_attempts === 1 &&
    report.ledger_payment_entries === 1;

  console.log('\n=== RACE CHECK REPORT ===');
  console.log(JSON.stringify(report, null, 2));
  console.log(pass ? '✅ PASS: ровно один факт выдачи, без дублей и потерь' : '❌ FAIL');
  console.log('=========================\n');

  await a.close();
  await b.close();
  server.close();
  await pool.end();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  logger.error({ err: e.message, stack: e.stack }, 'race-check failed');
  process.exit(1);
});
