import { ApiError } from '../errors.js';

// Расчёт скидки и итоговой суммы. ВСЕГДА на сервере (данным клиента не доверяем).
export function computeDiscount(promo, price) {
  if (promo.type === 'percent') {
    const discount = Math.round((price * promo.value) / 100);
    return { discount, final: Math.max(0, price - discount) };
  }
  // type === 'amount'
  const discount = Math.min(price, promo.value);
  return { discount, final: Math.max(0, price - discount) };
}

// Проверка промокода БЕЗ списания использования (для UI: POST /promo/validate)
export async function validatePromocode(client, rawCode, price) {
  const code = String(rawCode || '').trim().toUpperCase();
  const res = await client.query('SELECT * FROM promocodes WHERE code=$1', [code]);
  if (!res.rows.length) throw new ApiError(404, 'promocode_not_found');
  const promo = res.rows[0];
  if (promo.used_count >= promo.max_uses) throw new ApiError(409, 'promocode_limit_reached');
  return { promo, ...computeDiscount(promo, price) };
}

// Атомарное списание одного использования + расчёт скидки.
// UPDATE ... WHERE used_count < max_uses гарантирует лимит даже под параллельными запросами.
// Должен вызываться внутри транзакции (вместе с созданием заказа) — при откате
// использование не списывается.
export async function applyPromocode(tx, rawCode, price) {
  const code = String(rawCode || '').trim().toUpperCase();
  const res = await tx.query(
    `UPDATE promocodes SET used_count = used_count + 1
     WHERE code = $1 AND used_count < max_uses
     RETURNING *`,
    [code],
  );
  if (res.rowCount === 0) {
    // ошибка UPDATE не портит транзакцию, можно читать
    const exists = await tx.query('SELECT 1 FROM promocodes WHERE code=$1', [code]);
    if (!exists.rows.length) throw new ApiError(404, 'promocode_not_found');
    throw new ApiError(409, 'promocode_limit_reached');
  }
  const promo = res.rows[0];
  return { code: promo.code, ...computeDiscount(promo, price) };
}
