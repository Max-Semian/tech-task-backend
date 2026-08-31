// Отправка тестового вебхука на API.
// Использование: node scripts/webhook-stub.js <order_id> <paid|failed> <amount> [event_id]
import { config } from '../src/config.js';

const [, , orderId = 'ord_test', status = 'paid', amount = '500', eventId = `evt_${Date.now()}`] = process.argv;

const res = await fetch(`http://127.0.0.1:${config.port}/webhook/payment`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    event_id: eventId,
    order_id: orderId,
    status,
    amount: Number(amount),
    currency: 'RUB',
    created_at: new Date().toISOString(),
  }),
});
console.log(res.status, await res.text());
