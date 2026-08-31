// Конфигурация: env с разумными дефолтами для локального запуска

// Переопределение URL поставщиков (для тестов и демо-скриптов с эфемерными портами)
export function setSupplierUrls(aUrl, bUrl) {
  config.supplierA.url = aUrl;
  config.supplierB.url = bUrl;
}

const num = (v, d) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};
const float = (v, d) => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : d;
};

export const config = {
  port: num(process.env.PORT, 3000),
  workerId: process.env.WORKER_ID || `worker-${process.pid}`,
  databaseUrl: process.env.DATABASE_URL || 'postgres://app:app@localhost:5432/shop',

  supplierA: {
    url: process.env.SUPPLIER_A_URL || 'http://127.0.0.1:4100',
    errorRate: float(process.env.SUPPLIER_A_ERROR_RATE, 0.2),
    timeoutRate: float(process.env.SUPPLIER_A_TIMEOUT_RATE, 0.1),
    timeoutMs: num(process.env.SUPPLIER_A_TIMEOUT_MS, 2000),
  },
  supplierB: {
    url: process.env.SUPPLIER_B_URL || 'http://127.0.0.1:4200',
    errorRate: float(process.env.SUPPLIER_B_ERROR_RATE, 0.3),
    timeoutRate: float(process.env.SUPPLIER_B_TIMEOUT_RATE, 0.1),
    timeoutMs: num(process.env.SUPPLIER_B_TIMEOUT_MS, 2000),
  },

  delivery: {
    // попыток на одного поставщика, прежде чем перейти к fallback
    maxAttemptsPerProvider: num(process.env.DELIVERY_MAX_ATTEMPTS, 2),
    // повторов с тем же request_id после таймаута (ловушка таймаута)
    maxTimeoutRetries: num(process.env.DELIVERY_MAX_TIMEOUT_RETRIES, 3),
    timeoutMs: num(process.env.DELIVERY_TIMEOUT_MS, 2000),
    backoffBaseMs: num(process.env.DELIVERY_BACKOFF_BASE_MS, 200),
    // lease: через сколько job в 'processing' считается брошенным воркером
    jobLeaseMs: num(process.env.JOB_LEASE_MS, 60000),
  },

  worker: {
    pollIntervalMs: num(process.env.WORKER_POLL_INTERVAL_MS, 500),
    recoveryIntervalMs: num(process.env.RECOVERY_INTERVAL_MS, 30000),
    // заказ в paid/delivering дольше этого времени считается «зависшим»
    stuckAfterMs: num(process.env.STUCK_AFTER_MS, 120000),
    // автоматическая повторная выдача из out_of_stock/delivery_failed
    autoRetryRecoverable: process.env.AUTO_RETRY_RECOVERABLE !== '0',
  },
};
