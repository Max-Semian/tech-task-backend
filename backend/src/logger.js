import pino from 'pino';

// Структурированные JSON-логи (Этап 4 — наблюдаемость)
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'shop-backend' },
});
