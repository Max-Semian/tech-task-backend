import { pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { callSupplier } from './supplierClient.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Outbox-вставка задачи выдачи (вызывается в транзакции applyPaymentEvent/redeliver).
// Частичный UNIQUE-индекс не даёт появиться второму активному job для заказа.
export async function enqueueDeliveryJob(tx, orderDbId) {
  await tx.query(
    `INSERT INTO delivery_jobs (order_id)
     SELECT id FROM orders WHERE id=$1
     ON CONFLICT (order_id) WHERE status IN ('pending','processing') DO NOTHING`,
    [orderDbId],
  );
}

// Атомарный захват job'а: FOR UPDATE SKIP LOCKED — два воркера не возьмут один job
export async function claimNextJob() {
  return withTransaction(pool, async (tx) => {
    const res = await tx.query(
      `UPDATE delivery_jobs SET status='processing', locked_by=$1, locked_at=now()
       WHERE id = (SELECT id FROM delivery_jobs
                   WHERE status='pending' AND next_run_at <= now()
                   ORDER BY id LIMIT 1
                   FOR UPDATE SKIP LOCKED)
       RETURNING id, order_id, attempts`,
      [config.workerId],
    );
    if (res.rowCount === 0) return null;
    const job = res.rows[0];
    const orderRes = await tx.query(
      `SELECT o.id, o.order_id, o.status, o.amount, o.currency, oi.sku
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id=$1
       LIMIT 1`,
      [job.order_id],
    );
    return { job, order: orderRes.rows[0] };
  });
}

// Выдача товара у поставщиков A -> B с повторами и ловушкой таймаута.
export async function deliverOrder({ orderId, orderDbId, sku }) {
  const providers = [
    { name: 'A', url: config.supplierA.url },
    { name: 'B', url: config.supplierB.url },
  ];
  const { maxAttemptsPerProvider, timeoutMs, maxTimeoutRetries, backoffBaseMs } = config.delivery;

  // Нумерация попыток продолжается от предыдущих прогонов (redeliver/recovery):
  // request_id не должны повторяться, иначе поставщик по дедупу вернёт устаревший ответ.
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(attempt), 0)::int AS m FROM delivery_attempts WHERE order_id=$1`,
    [orderDbId],
  );
  let attemptCounter = rows[0].m;
  let sawOutOfStock = false;

  for (const provider of providers) {
    for (let i = 0; i < maxAttemptsPerProvider; i++) {
      attemptCounter += 1;
      const requestId = `req_${orderId}-${attemptCounter}`;
      // поставщику уходит ПУБЛИЧНЫЙ order_id (контракт: "ord_00123")
      const out = await issueCodeWithTimeoutRetries({
        provider,
        requestId,
        sku,
        orderId,
        timeoutMs,
        maxTimeoutRetries,
        backoffBaseMs,
      });
      await recordAttempt({ requestId, orderDbId, provider: provider.name, attempt: attemptCounter, out });

      if (out.kind === 'ok') {
        return { ok: true, code: out.code, provider: provider.name, requestId };
      }
      if (out.kind === 'out_of_stock') {
        sawOutOfStock = true;
        break; // fallback к следующему поставщику
      }
      // error / timeout_exhausted -> ещё попытка на этом же поставщике
    }
  }
  return { ok: false, reason: sawOutOfStock ? 'out_of_stock' : 'delivery_failed' };
}

// Ловушка таймаута: таймаут != отказ. Поставщик мог успеть выдать код, но ответ не дошёл.
// Повтор после таймаута идёт с ТЕМ ЖЕ request_id -> поставщик возвращает тот же код.
async function issueCodeWithTimeoutRetries({ provider, requestId, sku, orderId, timeoutMs, maxTimeoutRetries, backoffBaseMs }) {
  let res = await callSupplier({ url: provider.url, requestId, sku, orderId, timeoutMs });
  if (res.kind === 'ok' || res.kind === 'out_of_stock') return res;

  for (let r = 0; r < maxTimeoutRetries; r++) {
    if (res.kind !== 'timeout' && res.kind !== 'error') break;
    await sleep(backoffBaseMs * 2 ** r);
    res = await callSupplier({ url: provider.url, requestId, sku, orderId, timeoutMs });
    if (res.kind === 'ok' || res.kind === 'out_of_stock') return res;
  }
  return res.kind === 'timeout' ? { kind: 'timeout_exhausted' } : res;
}

async function recordAttempt({ requestId, orderDbId, provider, attempt, out }) {
  const status = out.kind === 'ok'
    ? 'ok'
    : out.kind === 'out_of_stock'
      ? 'out_of_stock'
      : out.kind === 'timeout_exhausted'
        ? 'timeout_exhausted'
        : 'error';
  await pool.query(
    `INSERT INTO delivery_attempts (request_id, order_id, provider, attempt, status, code)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (request_id) DO NOTHING`,
    [requestId, orderDbId, provider, attempt, status, out.code || null],
  );
}

// Фиксация результата выдачи. Guard по статусу -> ровно один факт выдачи,
// даже если процесс джоба случился дважды (гонки/ретраи/восстановление).
async function finalizeDelivery(job, order, result) {
  return withTransaction(pool, async (tx) => {
    if (result.ok) {
      const res = await tx.query(
        `UPDATE orders SET status='delivered', code=$2, delivered_at=now(), updated_at=now()
         WHERE id=$1 AND status IN ('paid','delivering','out_of_stock','delivery_failed')
         RETURNING id`,
        [order.id, result.code],
      );
      if (res.rowCount === 1) {
        // зеркало остатков витрины (Этап 5) — в той же транзакции
        await tx.query(
          `UPDATE stock_mirror SET available = greatest(available-1, 0), updated_at=now()
           WHERE sku=$1`,
          [order.sku],
        );
        logger.info(
          { orderId: order.order_id, provider: result.provider, requestId: result.requestId },
          'delivery.completed',
        );
      }
    } else {
      const newStatus = result.reason === 'out_of_stock' ? 'out_of_stock' : 'delivery_failed';
      const res = await tx.query(
        `UPDATE orders SET status=$2, updated_at=now()
         WHERE id=$1 AND status IN ('paid','delivering')
         RETURNING id`,
        [order.id, newStatus],
      );
      if (res.rowCount === 1) {
        logger.info({ orderId: order.order_id, status: newStatus, reason: result.reason }, 'delivery.failed');
      }
    }
    await tx.query(`UPDATE delivery_jobs SET status='done' WHERE id=$1`, [job.id]);
  });
}

export async function processJob(job, order) {
  const result = await deliverOrder({ orderId: order.order_id, orderDbId: order.id, sku: order.sku });
  await finalizeDelivery(job, order, result);
  return result;
}

// Один проход воркера: выбирает и обрабатывает все готовые job'ы по очереди.
export async function processDeliveryJobsOnce() {
  let processed = 0;
  for (;;) {
    const claimed = await claimNextJob();
    if (!claimed) break;
    processed += 1;
    const { job, order } = claimed;
    try {
      await processJob(job, order);
    } catch (e) {
      logger.error({ err: e.message, orderId: order.order_id }, 'delivery job error');
      await requeueJobWithBackoff(job);
    }
  }
  return processed;
}

async function requeueJobWithBackoff(job) {
  const backoffMs = Math.min(config.delivery.backoffBaseMs * 2 ** Math.min(job.attempts, 6), 60000);
  await pool.query(
    `UPDATE delivery_jobs
     SET status='pending', attempts=attempts+1, locked_by=NULL, locked_at=NULL,
         next_run_at = now() + make_interval(secs => $2)
     WHERE id=$1`,
    [job.id, backoffMs / 1000],
  );
}

