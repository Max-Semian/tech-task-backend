import { config } from './config.js';
import { logger } from './logger.js';
import { processDeliveryJobsOnce } from './services/deliveryService.js';
import { runRecoveryOnce } from './services/reconciler.js';

let timers = [];

// Фоновые задачи: поллер очереди выдачи + recovery-воркер (Этап 4)
export function startBackgroundWorkers() {
  const { pollIntervalMs, recoveryIntervalMs } = config.worker;

  const pollTimer = setInterval(async () => {
    try {
      const n = await processDeliveryJobsOnce();
      if (n > 0) logger.info({ processed: n }, 'delivery batch done');
    } catch (e) {
      logger.error({ err: e.message }, 'delivery poll error');
    }
  }, pollIntervalMs);

  const recoveryTimer = setInterval(async () => {
    try {
      const r = await runRecoveryOnce();
      if (r.linked > 0 || r.reclaimed > 0 || r.expiredHolds > 0) {
        logger.info({ linked: r.linked, reclaimed: r.reclaimed, expiredHolds: r.expiredHolds }, 'recovery pass');
      }
    } catch (e) {
      logger.error({ err: e.message }, 'recovery error');
    }
  }, recoveryIntervalMs);

  pollTimer.unref();
  recoveryTimer.unref();
  timers = [pollTimer, recoveryTimer];
  logger.info({ pollIntervalMs, recoveryIntervalMs }, 'background workers started');
}

export function stopBackgroundWorkers() {
  for (const t of timers) clearInterval(t);
  timers = [];
}
