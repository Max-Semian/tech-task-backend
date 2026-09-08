import { Router } from 'express';
import { bus, LIVE_CHANNEL } from '../services/live.js';
import { logger } from '../logger.js';

export const eventsRouter = Router();

// GET /events — Server-Sent Events: живые изменения офферов (цена/остаток).
// Клиент при open/reconnect дополнительно сверяется полным GET /products.
// Heartbeat-комментарии каждые 25 c не дают прокси/nginx разорвать соединение.
eventsRouter.get('/', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  bus.on(LIVE_CHANNEL, send);
  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off(LIVE_CHANNEL, send);
  });
  logger.info({ client: req.ip }, 'sse.connected');
});
