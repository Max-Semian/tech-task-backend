// Сид большого маркетплейс-каталога: SEED_OFFERS или --count
// Пример: node scripts/seed-catalog-2.js --count 3000
import { pool, withTransaction } from '../src/db.js';
import { seedMarketplaceTx } from '../src/services/seedService.js';
import { logger } from '../src/logger.js';

const argCount = process.argv.indexOf('--count');
const count = argCount !== -1 ? parseInt(process.argv[argCount + 1] ?? '', 10) : 0;
const finalCount = count > 0 ? count : (parseInt(process.env.SEED_OFFERS || '3000', 10));

const n = await withTransaction(pool, async (tx) => seedMarketplaceTx(tx, finalCount));
logger.info({ inserted: n }, 'seed-catalog-2 done');
await pool.end();
