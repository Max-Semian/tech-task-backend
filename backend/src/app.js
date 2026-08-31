import express from 'express';
import { ordersRouter } from './routes/orders.js';
import { webhookRouter } from './routes/webhook.js';
import { adminRouter } from './routes/admin.js';
import { logger } from './logger.js';
import { ApiError } from './errors.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    res.on('finish', () => {
      logger.info({ method: req.method, url: req.url, status: res.statusCode }, 'http');
    });
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/orders', ordersRouter);
  app.use('/webhook/payment', webhookRouter);
  app.use('/admin', adminRouter);

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
