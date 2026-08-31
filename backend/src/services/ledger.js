// Журнал денежных движений (Этап 4). Гарантия «всегда сходится»:
// UNIQUE(order_id, entry_type) -> ровно один платёж на заказ,
// сумма журнала всегда равна сумме оплаченных заказов.

export async function ledgerRecordPayment(tx, orderId, amount, currency, eventKey) {
  await tx.query(
    `INSERT INTO money_ledger (order_id, entry_type, amount, currency, event_key)
     VALUES ($1, 'payment', $2, $3, $4)
     ON CONFLICT (order_id, entry_type) DO NOTHING`,
    [orderId, amount, currency, eventKey],
  );
}
