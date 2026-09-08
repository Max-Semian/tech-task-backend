import { pool, withTransaction } from '../db.js';
import { logger } from '../logger.js';
import { ledgerRecordPayment } from './ledger.js';
import { enqueueDeliveryJob } from './deliveryService.js';
import { publishOffer } from './live.js';

// =====================================================================
// ЕДИНСТВЕННАЯ точка применения события оплаты к заказу.
// Вызывается из: вебхука, POST /orders (линковка), reconciler.
// Идемпотентность: CAS-переход по статусу + UNIQUE(event_id) + ON CONFLICT.
//
// `effects` — массив, в который складываются пост-коммитные действия
// (освобождение единицы брони) для публикации SSE строго ПОСЛЕ COMMIT.
// =====================================================================
export async function applyPaymentEvent(tx, orderId, event, effects = []) {
  if (event.status === 'paid') {
    // для заказа-из-брони оплата возможна только до дедлайна pay_until
    const res = await tx.query(
      `UPDATE orders SET status='paid', paid_at=now(), updated_at=now()
       WHERE order_id=$1 AND status='created'
         AND (pay_until IS NULL OR pay_until > now())
       RETURNING id, amount, currency`,
      [orderId],
    );
    if (res.rowCount === 1) {
      const { id, amount, currency } = res.rows[0];
      // outbox в ТОЙ ЖЕ транзакции: задача выдачи не теряется, дубль невозможен
      await enqueueDeliveryJob(tx, id);
      // журнал денег (идемпотентно): ровно одна запись payment на заказ
      await ledgerRecordPayment(tx, orderId, amount, currency, event.event_id);
      logger.info({ orderId, eventId: event.event_id, amount }, 'payment.received');
    }
  } else if (event.status === 'failed') {
    const res = await tx.query(
      `UPDATE orders SET status='payment_failed', updated_at=now()
       WHERE order_id=$1 AND status='created'
       RETURNING id, sku, reservation_id`,
      [orderId],
    );
    if (res.rowCount === 1) {
      const o = res.rows[0];
      // заказ из брони: оплата не прошла -> единица возвращается в продажу
      if (o.reservation_id && o.sku) {
        await tx.query(
          `UPDATE stock_mirror SET held = greatest(held - 1, 0), updated_at = now()
           WHERE sku=$1 AND held > 0`,
          [o.sku],
        );
        effects.push({ type: 'release', sku: o.sku });
      }
      logger.info({ orderId, eventId: event.event_id }, 'payment.failed');
    }
  }

  // пометить событие применённым (идемпотентно)
  await tx.query(
    `UPDATE payment_events
     SET applied_at=now(), order_fk=(SELECT id FROM orders WHERE order_id=$1)
     WHERE event_id=$2 AND applied_at IS NULL`,
    [orderId, event.event_id],
  );
}

// Применение накопленных необработанных событий в детерминированном порядке:
// бизнес-время (created_at), при равенстве — время приёма (processed_at).
// FOR UPDATE исключает конкурентное применение.
export async function linkUnappliedEvents(tx, orderId, effects = []) {
  const unapplied = await tx.query(
    `SELECT * FROM payment_events
     WHERE order_id=$1 AND applied_at IS NULL
     ORDER BY created_at ASC NULLS LAST, processed_at ASC
     FOR UPDATE`,
    [orderId],
  );
  for (const ev of unapplied.rows) {
    await applyPaymentEvent(tx, orderId, ev, effects);
  }
  return unapplied.rowCount;
}

// Обработка вебхука платежа (контракт из ТЗ). Всегда быстрый 200 для принятых.
export async function handleWebhook({ event_id, order_id, status, amount, currency, created_at }) {
  const effects = [];
  const result = await withTransaction(pool, async (tx) => {
    // 1) идемпотентность по event_id: повторный вебхук = no-op
    const ins = await tx.query(
      `INSERT INTO payment_events (event_id, order_id, status, amount, currency, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event_id, order_id, status, amount ?? null, currency || 'RUB', created_at || null],
    );
    if (ins.rowCount === 0) {
      return { duplicate: true, applied: false };
    }

    // 2) заказ может ещё не существовать (вебхук раньше заказа) — событие сохраняется,
    //    линковку доделают POST /orders или reconciler
    const order = await tx.query('SELECT order_id FROM orders WHERE order_id=$1', [order_id]);
    if (order.rows.length === 0) {
      logger.info({ orderId: order_id, eventId: event_id }, 'payment.event_unlinked');
      return { duplicate: false, applied: false };
    }

    // 3) применить событие через единую точку
    await applyPaymentEvent(tx, order_id, { event_id, status, amount, currency }, effects);
    return { duplicate: false, applied: true };
  });

  // 4) пост-коммитные уведомления живой витрины
  for (const e of effects) {
    if (e.type === 'release') await publishOffer(e.sku);
  }
  return result;
}
