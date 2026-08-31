import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');

export function createPool(connectionString = config.databaseUrl) {
  const p = new pg.Pool({ connectionString, max: 10 });
  p.on('error', (err) => logger.error({ err: err.message }, 'pg pool error'));
  return p;
}

export const pool = createPool();

export async function waitForDb(poolInstance = pool, { retries = 30, delayMs = 1000 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      await poolInstance.query('SELECT 1');
      return;
    } catch (e) {
      if (i === retries - 1) throw e;
      logger.info({ attempt: i + 1 }, 'waiting for database...');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function initSchema(poolInstance = pool, schemaPath = SCHEMA_PATH) {
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await poolInstance.query(sql);
}

export async function resetSchema(poolInstance = pool) {
  await poolInstance.query(`
    DROP TABLE IF EXISTS money_ledger, delivery_jobs, delivery_attempts,
      payment_events, order_items, orders, stock_mirror, products CASCADE`);
  await initSchema(poolInstance);
}

// Выполнить fn(client) внутри транзакции: BEGIN/COMMIT/ROLLBACK
export async function withTransaction(poolInstance, fn) {
  const client = await poolInstance.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
