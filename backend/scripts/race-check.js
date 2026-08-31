// Воспроизведение проверки гонок (критерий 1 приёмки):
// 50 параллельных вебхуков «paid» по одному заказу -> ровно один факт выдачи.
//
// Скрипт полностью самодостаточен: своя одноразовая БД (shop_race_<pid>), свой
// экземпляр приложения и свои заглушки поставщиков. Изоляция по БД обязательна —
// иначе воркер запущенного `app` (docker compose up) перехватывает job через
// FOR UPDATE SKIP LOCKED и идёт в свои заглушки поставщиков, чей пул ключей
// скрипту не принадлежит. Дев-база `shop` при этом не трогается.
//
// Использование: npm run race-check   (нужен только поднятый Postgres: docker compose up -d db)
import pg from 'pg';

const ADMIN_URL = (process.env.DATABASE_URL || 'postgres://app:app@localhost:5432/shop')
  .replace(/\/[^/]+$/, '/postgres');
const RACE_DB = `shop_race_${process.pid}`;
process.env.DATABASE_URL = ADMIN_URL.replace(/\/postgres$/, `/${RACE_DB}`);

async function withAdmin(fn) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try { return await fn(admin); } finally { await admin.end(); }
}

await withAdmin(async (admin) => {
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [RACE_DB]);
  if (rowCount === 0) await admin.query(`CREATE DATABASE ${RACE_DB}`);
});

const { pool, waitForDb, resetSchema } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { setSupplierUrls } = await import('../src/config.js');
const { PRODUCTS, splitPoolBetweenSuppliers } = await import('../src/catalog.js');
const { createSupplierServer, seedStorePool } = await import('../src/suppliers/mock.js');
const { processDeliveryJobsOnce } = await import('../src/services/deliveryService.js');
const { logger } = await import('../src/logger.js');

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

  // Доводим выдачу до финального состояния.
  // Свой прогон processDeliveryJobsOnce() — не единственный: если поднят app
  // (docker compose up), его воркер заберёт job первым через FOR UPDATE SKIP LOCKED
  // и нам вернётся processed=0. Поэтому вердикт выносим не по своему прогону,
  // а по фактическому статусу заказа.
  const TERMINAL = ['delivered', 'out_of_stock', 'delivery_failed', 'payment_failed'];
  const deadline = Date.now() + 30000;
  let processed = 0;
  let orderStatus = null;
  while (Date.now() < deadline) {
    processed += await processDeliveryJobsOnce();
    const { rows } = await pool.query('SELECT status FROM orders WHERE order_id=$1', [order.order_id]);
    orderStatus = rows[0]?.status;
    if (TERMINAL.includes(orderStatus)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  logger.info({ processed, orderStatus }, 'jobs processed');

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
  await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${RACE_DB} WITH (FORCE)`));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  logger.error({ err: e.message, stack: e.stack }, 'race-check failed');
  process.exit(1);
});
