/* Админка: сверка, повторная выдача, пополнение остатка (фуллстек, этап 3) */
'use strict';

const API = window.API_BASE || 'http://localhost:3000';
const $ = (id) => document.getElementById(id);

const STATUS_LABEL = {
  created: 'created', paid: 'paid', delivering: 'delivering', delivered: 'delivered',
  payment_failed: 'payment_failed', out_of_stock: 'out_of_stock', delivery_failed: 'delivery_failed',
};
const BADGE = (s) => '<span class="status-badge ' + (s || 'created') + '">' + (STATUS_LABEL[s] || s) + '</span>';

// Токен админки. Локально ADMIN_TOKEN не задан и /admin/* открыт — поэтому
// ничего не спрашиваем заранее, а реагируем на 401 от сервера.
const TOKEN_KEY = 'adminToken';

function authHeaders() {
  const t = localStorage.getItem(TOKEN_KEY);
  return t ? { authorization: 'Bearer ' + t } : {};
}

async function api(path, opts = {}) {
  const send = () => fetch(API + path, {
    headers: { 'content-type': 'application/json', ...authHeaders() },
    ...opts,
  });

  let res = await send();

  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    const t = prompt('Админка защищена. Введите ADMIN_TOKEN:');
    if (t) {
      localStorage.setItem(TOKEN_KEY, t.trim());
      res = await send();
      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        alert('Токен не подошёл.');
      }
    }
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

/* Смена цены оффера: сервер публикует SSE, витрина обновляется у всех без F5 */
async function setPrice() {
  const sku = $('priceSku').value.trim();
  const price = parseInt($('priceValue').value, 10);
  if (!sku || !Number.isFinite(price) || price <= 0) {
    msg($('priceMsg'), 'Укажите SKU и цену', false);
    return;
  }
  const r = await api('/admin/products/' + encodeURIComponent(sku) + '/price', {
    method: 'POST',
    body: JSON.stringify({ price }),
  });
  msg($('priceMsg'), r.status === 200
    ? 'Цена ' + r.body.sku + ' = ' + r.body.price + ' ₽ (разослано по SSE)'
    : 'Ошибка: ' + (r.body.error || r.status), r.status === 200);
}

document.addEventListener('DOMContentLoaded', () => {
  const priceBtn = $('priceBtn');
  if (priceBtn) priceBtn.addEventListener('click', setPrice);
});
