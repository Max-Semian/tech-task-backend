// CLI-сверка: «оплачен, но не выдан» / «выдан, но не оплачен» + баланс журнала.
// Использование: npm run reconcile
import { pool, waitForDb } from '../src/db.js';
import { findInconsistencies, linkPendingEvents } from '../src/services/reconciler.js';
import { logger } from '../src/logger.js';

await waitForDb(pool);
const linked = await linkPendingEvents();
const report = await findInconsistencies();
console.log(JSON.stringify({ linked, ...report }, null, 2));
await pool.end();
logger.info('reconcile done');
