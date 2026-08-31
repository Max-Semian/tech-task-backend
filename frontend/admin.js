/* Админка: сверка, повторная выдача, пополнение остатка (фуллстек, этап 3) */
'use strict';

const API = window.API_BASE || 'http://localhost:3000';
const $ = (id) => document.getElementById(id);

const STATUS_LABEL = {
  created: 'created', paid: 'paid', delivering: 'delivering', delivered: 'delivered',
  payment_failed: 'payment_failed', out_of_stock: 'out_of_stock', delivery_failed: 'delivery_failed',
};
const BADGE = (s) => '<span class="status-badge ' + (s || 'created') + '">' + (STATUS_LABEL[s] || s) + '</span>';

// Токен админки. На публичном деплое /admin/* закрыт Bearer-токеном;
// локально ADMIN_TOKEN не задан и заголовок просто игнорируется.
function adminToken() {
  let t = localStorage.getItem('adminToken');
  if (!t) {
    t = prompt('Токен админки (переменная ADMIN_TOKEN на сервере).\nЛокально можно оставить пустым.') || '';
    localStorage.setItem('adminToken', t);
  }
  return t;
}

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  const t = adminToken();
  if (t) headers.authorization = 'Bearer ' + t;
  const res = await fetch(API + path, { headers, ...opts });
  if (res.status === 401) {
    localStorage.removeItem('adminToken');
    alert('Неверный токен админки. Обновите страницу и введите заново.');
  }
  let body = null;
  try { body = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body };
}

function msg(el, text, ok) {
  el.textContent = text;
  el.className = 'promo-msg ' + (ok ? 'ok' : 'err');
}

async function load() {
  const r = await api('/admin/reconciliation');
  if (r.status !== 200) {
    $('balanceInfo').textContent = 'API недоступен (' + r.status + ')';
    return;
  }
  const rep = r.body;

  const b = rep.balance;
  $('balanceInfo').innerHTML = 'Сумма журнала: <b>' + b.ledger_total + ' ₽</b> · ' +
    'сумма оплаченных заказов: <b>' + b.paid_orders_total + ' ₽</b> · ' +
    '<span class="' + (b.ok ? 'balance-ok' : 'balance-bad') + '">' + (b.ok ? '✓ сходится' : '✗ НЕ сходится') + '</span>';

  // оплачено, но не выдано
  const pnd = $('paidNotDelivered');
  if (!rep.paid_not_delivered.length) {
    pnd.innerHTML = '<div class="grid-loader">Пусто — всё выдано ✅</div>';
  } else {
    const rows = rep.paid_not_delivered.map((o) =>
      '<tr><td>' + o.order_id + '</td><td>' + BADGE(o.status) + '</td><td>' + o.amount + ' ₽</td>' +
      '<td><button class="btn-sm" data-order="' + o.order_id + '">Повторная выдача</button></td></tr>').join('');
    pnd.innerHTML = '<table class="admin-table"><thead><tr><th>Заказ</th><th>Статус</th><th>Сумма</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // выдано, но не оплачено
  const dnp = $('deliveredNotPaid');
  if (!rep.delivered_not_paid.length) {
    dnp.innerHTML = '<div class="grid-loader">Пусто ✅</div>';
  } else {
    const rows = rep.delivered_not_paid.map((o) =>
      '<tr><td>' + o.order_id + '</td><td>' + BADGE(o.status) + '</td><td>' + (o.delivered_at || '') + '</td></tr>').join('');
    dnp.innerHTML = '<table class="admin-table"><thead><tr><th>Заказ</th><th>Статус</th><th>Выдан</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
}

async function redeliver(orderId) {
  const r = await api('/admin/orders/' + orderId + '/redeliver', { method: 'POST', body: '{}' });
  if (r.status === 200) {
    alert('Заказ ' + orderId + ': повторная выдача поставлена в очередь' + (r.body.changed ? '' : ' (уже в процессе/выдан)'));
  } else {
    alert('Ошибка: ' + (r.body.error || r.status));
  }
  load();
}

async function restock() {
  const sku = $('restockSku').value.trim();
  const count = parseInt($('restockCount').value, 10) || 1;
  const r = await api('/admin/stock/' + encodeURIComponent(sku) + '/restock', { method: 'POST', body: JSON.stringify({ count }) });
  msg($('restockMsg'), r.status === 200
    ? 'Добавлено ' + r.body.added + ' ключей (' + JSON.stringify(r.body.suppliers) + ')'
    : 'Ошибка: ' + (r.body.error || r.status), r.status === 200);
  load();
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-order]');
    if (btn) redeliver(btn.dataset.order);
  });
  $('restockBtn').addEventListener('click', restock);
});
