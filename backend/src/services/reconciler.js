import { pool, withTransaction } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { linkUnappliedEvents } from './paymentService.js';
import { enqueueDeliveryJob } from './deliveryService.js';
import { ApiError } from '../errors.js';

// Сверка (Этап 4): «оплачен, но не выдан» / «выдан, но не оплачен» + баланс журнала
export async function findInconsistencies() {
  const paidNotDelivered = await pool.query(
    `SELECT o.order_id, o.status, o.amount, o.currency, o.created_at, o.updated_at
     FROM orders o
     WHERE o.status IN ('paid','delivering','out_of_stock','delivery_failed')
       AND EXISTS (SELECT 1 FROM payment_events pe
                   WHERE pe.order_id = o.order_id AND pe.status='paid' AND pe.applied_at IS NOT NULL)
     ORDER BY o.created_at`,
  );

  const deliveredNotPaid = await pool.query(
    `SELECT o.order_id, o.status, o.delivered_at
     FROM orders o
     WHERE o.status='delivered'
       AND NOT EXISTS (SELECT 1 FROM payment_events pe
                       WHERE pe.order_id = o.order_id AND pe.status='paid')
     ORDER BY o.delivered_at`,
  );

  const ledger = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::bigint AS total FROM money_ledger WHERE entry_type='payment'`,
  );
  const paidOrders = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::bigint AS total FROM orders o
     WHERE EXISTS (SELECT 1 FROM payment_events pe
                   WHERE pe.order_id=o.order_id AND pe.status='paid' AND pe.applied_at IS NOT NULL)`,
  );

  const ledgerTotal = Number(ledger.rows[0].total);
  const paidTotal = Number(paidOrders.rows[0].total);
  return {
    paid_not_delivered: paidNotDelivered.rows,
    delivered_not_paid: deliveredNotPaid.rows,
    balance: {
      ledger_total: ledgerTotal,
      paid_orders_total: paidTotal,
      ok: ledgerTotal === paidTotal,
    },
  };
}

// Линковка событий оплаты, пришедших раньше заказа (критерий 3)
export async function linkPendingEvents() {
  const pending = await pool.query(
    `SELECT DISTINCT pe.order_id
     FROM payment_events pe
     WHERE pe.applied_at IS NULL
       AND EXISTS (SELECT 1 FROM orders o WHERE o.order_id = pe.order_id)`,
  );
  for (const { order_id } of pending.rows) {
    await withTransaction(pool, async (tx) => {
      await linkUnappliedEvents(tx, order_id);
    });
  }
  return pending.rowCount;
}

// Возврат «протухших» job'ов: воркер упал, lease истёк
export async function reclaimStuckJobs() {
  const res = await pool.query(
    `UPDATE delivery_jobs SET status='pending', locked_by=NULL, locked_at=NULL
     WHERE status='processing'
       AND locked_at < now() - make_interval(secs => $1)
     RETURNING id, order_id`,
    [config.delivery.jobLeaseMs / 1000],
  );
  return res.rowCount;
}

// Доводка «зависших» заказов: нет активного job, но статус требует выдачи
export async function retryStuckOrders() {
  await withTransaction(pool, async (tx) => {
    const stuck = await tx.query(
      `SELECT o.id, o.order_id
       FROM orders o
       WHERE o.status IN ('paid','delivering')
         AND NOT EXISTS (SELECT 1 FROM delivery_jobs dj
                         WHERE dj.order_id = o.id AND dj.status IN ('pending','processing'))
         AND o.updated_at < now() - make_interval(secs => $1)`,
      [config.worker.stuckAfterMs / 1000],
    );
    for (const order of stuck.rows) await enqueueDeliveryJob(tx, order.id);
  });

  if (config.worker.autoRetryRecoverable) {
    // восстановимые состояния: пополнение остатка могло произойти -> безопасная повторная выдача
    await withTransaction(pool, async (tx) => {
      const rec = await tx.query(
        `SELECT o.id, o.order_id
         FROM orders o
         WHERE o.status IN ('out_of_stock','delivery_failed')
           AND NOT EXISTS (SELECT 1 FROM delivery_jobs dj
                           WHERE dj.order_id = o.id AND dj.status IN ('pending','processing'))
           AND o.updated_at < now() - make_interval(secs => $1)`,
        [config.worker.stuckAfterMs / 1000],
      );
      for (const order of rec.rows) await enqueueDeliveryJob(tx, order.id);
    });
  }
}

// Один проход recovery-воркера
export async function runRecoveryOnce() {
  const linked = await linkPendingEvents();
  const reclaimed = await reclaimStuckJobs();
  await retryStuckOrders();
  return { linked, reclaimed };
}

// Ручная повторная выдача (админка). Идемпотентна через enqueue + guard фиксации.
export async function redeliverOrder(publicOrderId) {
  return withTransaction(pool, async (tx) => {
    const order = await tx.query('SELECT * FROM orders WHERE order_id=$1', [publicOrderId]);
    if (!order.rows.length) throw new ApiError(404, 'order_not_found');
    const o = order.rows[0];
    if (o.status === 'delivered') return { order: o, changed: false };
    if (!['out_of_stock', 'delivery_failed', 'paid', 'delivering'].includes(o.status)) {
      throw new ApiError(409, `cannot_redeliver_status_${o.status}`);
    }
    await enqueueDeliveryJob(tx, o.id);
    logger.info({ orderId: publicOrderId, status: o.status }, 'admin.redeliver_enqueued');
    return { order: o, changed: true };
  });
}
