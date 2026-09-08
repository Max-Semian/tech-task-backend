import { createApp } from './app.js';
import { config } from './config.js';
import { pool, initSchema, waitForDb } from './db.js';
import { seedIfEmpty } from './services/seedService.js';
import { logger } from './logger.js';
import { startBackgroundWorkers, stopBackgroundWorkers } from './worker.js';
import { startLiveSimulator } from './services/live.js';

async function main() {
  await waitForDb(pool);
  await initSchema(pool);
  await seedIfEmpty(pool); // авто-сид каталога при чистой БД (Docker: одна команда up)

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`API listening on :${config.port}`);
  });

  let stopSim = null;
  if (process.env.WORKER !== '0') {
    startBackgroundWorkers();
    if (config.liveSim.enabled) {
      logger.info(config.liveSim, 'live simulator started');
      stopSim = startLiveSimulator({ ...config.liveSim, log: (m) => logger.info(m, 'live.sim.price') });
    }
  }

  const shutdown = async () => {
    logger.info('shutting down');
    if (stopSim) stopSim();
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
