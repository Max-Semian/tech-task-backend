// Standalone-сервер поставщика-заглушки.
// Запуск: SUPPLIER_NAME=A PORT=4100 node src/suppliers/server.js
import { createSupplierServer, createStore, seedByName } from './mock.js';
import { logger } from '../logger.js';

const name = process.env.SUPPLIER_NAME || 'A';
const port = parseInt(process.env.PORT || (name === 'A' ? '4100' : '4200'), 10);
const errorRate = parseFloat(process.env.ERROR_RATE ?? (name === 'A' ? '0.2' : '0.3'));
const timeoutRate = parseFloat(process.env.TIMEOUT_RATE ?? '0.1');
const timeoutMs = parseInt(process.env.TIMEOUT_MS || '3000', 10);
const seed = process.env.SEED_POOL !== '0';

const store = createStore();
if (seed) {
  seedByName(store, name);
}

const { server } = await createSupplierServer({ port, name, store, errorRate, timeoutRate, timeoutMs });
logger.info(
  {
    name,
    port,
    errorRate,
    timeoutRate,
    pool: Object.fromEntries([...store.pool.entries()].map(([k, v]) => [k, v.length])),
  },
  'supplier started',
);
