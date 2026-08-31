import { createApp } from './app.js';
import { config } from './config.js';
import { pool, initSchema, waitForDb } from './db.js';
import { logger } from './logger.js';
import { startBackgroundWorkers, stopBackgroundWorkers } from './worker.js';

async function main() {
  await waitForDb(pool);
  await initSchema(pool);

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`API listening on :${config.port}`);
  });

  if (process.env.WORKER !== '0') {
    startBackgroundWorkers();
  }

  const shutdown = async () => {
    logger.info('shutting down');
    stopBackgroundWorkers();
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error({ err: e.message }, 'startup failed');
  process.exit(1);
});
