import express from 'express';
import { ordersRouter } from './routes/orders.js';
import { webhookRouter } from './routes/webhook.js';
import { adminRouter } from './routes/admin.js';
import { productsRouter } from './routes/products.js';
import { promoRouter } from './routes/promo.js';
import { logger } from './logger.js';
import { ApiError } from './errors.js';
import { config } from './config.js';
import crypto from 'node:crypto';

// Сравнение за постоянное время: обычное === даёт утечку по таймингу.
function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function createApp() {
  const app = express();
  app.use(express.json());

  // CORS: фронт может жить на отдельном origin (статик/хостинг/Netlify)
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use((req, res, next) => {
    res.on('finish', () => {
      logger.info({ method: req.method, url: req.url, status: res.statusCode }, 'http');
    });
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/orders', ordersRouter);
  app.use('/webhook/payment', webhookRouter);
  // Админка меняет остатки и повторную выдачу — наружу её пускать нельзя.
  // Если ADMIN_TOKEN не задан (локально, тесты), проверка отключена: ТЗ
  // разрешает «без авторизации или с простым токеном».
  app.use('/admin', (req, res, next) => {
    const expected = config.adminToken;
    if (!expected) return next();
    const got = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (got && timingSafeEqualStr(got, expected)) return next();
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'unauthorized' });
  }, adminRouter);
  app.use('/products', productsRouter);
  app.use('/promo', promoRouter);

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
    return res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
