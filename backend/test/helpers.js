import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTS, PROMOCODES, splitPoolBetweenSuppliers } from '../src/catalog.js';
import { createSupplierServer, seedStorePool } from '../src/suppliers/mock.js';
import { setSupplierUrls, config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');
export const TEST_DB_URL = process.env.DATABASE_URL;

export async function ensureTestDb() {
  const adminUrl = TEST_DB_URL.replace(/\/[^/]+$/, '/postgres');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const dbName = TEST_DB_URL.split('/').pop();
  const res = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName]);
  if (res.rowCount === 0) await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
}

export async function dropTestDb() {
  const adminUrl = TEST_DB_URL.replace(/\/[^/]+$/, '/postgres');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const dbName = TEST_DB_URL.split('/').pop();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
}

// Пересоздать схему с чистого листа
export async function setupDb() {
  await ensureTestDb();
  const { pool } = await import('../src/db.js');
  await pool.query(
    `DROP TABLE IF EXISTS money_ledger, delivery_jobs, delivery_attempts,
       payment_events, order_items, orders, reservations, stock_mirror, products, promocodes CASCADE`,
  );
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  await pool.query(sql);
  return pool;
}

export async function seedProducts(pool) {
  for (const p of PRODUCTS) {
    await pool.query(
      `INSERT INTO products (sku,name,type,price,currency,image)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (sku) DO NOTHING`,
      [p.sku, p.name, p.type, p.price, p.currency, p.image],
    );
  }
}

export async function seedPromocodes(pool) {
  for (const p of PROMOCODES) {
    await pool.query(
      `INSERT INTO promocodes (code, type, value, currency, max_uses)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO NOTHING`,
      [p.code, p.type, p.value, p.currency, p.max_uses],
    );
  }
}

// Зеркало остатков как в seed-скрипте (сумма пулов A+B по каждому SKU)
export async function seedStockMirror(pool) {
  const { a, b } = splitPoolBetweenSuppliers();
  const counts = new Map();
  for (const m of [a, b]) {
    for (const [sku, codes] of m) counts.set(sku, (counts.get(sku) || 0) + codes.length);
  }
  for (const [sku, n] of counts) {
    await pool.query(
      `INSERT INTO stock_mirror (sku, available) VALUES ($1,$2)
       ON CONFLICT (sku) DO UPDATE SET available=EXCLUDED.available, updated_at=now()`,
      [sku, n],
    );
  }
  return counts;
}

// Запуск заглушек A/B на эфемерных портах + переадресация клиента
export async function startMocks({
  withKeys = true,
  errorRateA = 0,
  timeoutRateA = 0,
  errorRateB = 0,
  timeoutRateB = 0,
  timeoutMs = 400,
} = {}) {
  const a = await createSupplierServer({
    port: 0, name: 'A', errorRate: errorRateA, timeoutRate: timeoutRateA,
    timeoutMs, extraHangMs: 600,
  });
  const b = await createSupplierServer({
    port: 0, name: 'B', errorRate: errorRateB, timeoutRate: timeoutRateB,
    timeoutMs, extraHangMs: 600,
  });
  if (withKeys) {
    const pools = splitPoolBetweenSuppliers();
    seedStorePool(a.store, pools.a);
    seedStorePool(b.store, pools.b);
  }
  setSupplierUrls(`http://127.0.0.1:${a.port}`, `http://127.0.0.1:${b.port}`);
  config.delivery.timeoutMs = timeoutMs;
  return { a, b };
}

export async function startApi() {
  const { createApp } = await import('../src/app.js');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  server.unref(); // не держит процесс теста живым, если забыли закрыть
  return server;
}

export function closeServer(server) {
  if (server) {
    server.closeAllConnections?.();
    server.close();
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(fn, { timeout = 10000, interval = 40 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`waitFor timeout; last=${JSON.stringify(last)}`);
}

export async function postJson(baseUrl, pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export async function getJson(baseUrl, pathname) {
  const res = await fetch(`${baseUrl}${pathname}`);
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
}

export async function getOrderRow(pool, publicId) {
  const res = await pool.query('SELECT * FROM orders WHERE order_id=$1', [publicId]);
  return res.rows[0] || null;
}

export function closeMocks(mocks) {
  for (const m of [mocks?.a, mocks?.b]) {
    if (m) {
      m.server.closeAllConnections?.();
      m.close().catch(() => {});
    }
  }
}
