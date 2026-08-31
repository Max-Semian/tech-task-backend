/* GameMarket frontend: 5 интерактивов + флоу покупки + промокод (фуллстек) */
'use strict';

const API = window.API_BASE || 'http://localhost:3000';

const TYPE_IMG = {
  topup: 'images/steam.png',
  key: 'images/product-key.png',
  subscription: 'images/telegram.png',
  giftcard: 'images/playstation.png',
};

let PRODUCTS = [];
let currentSku = null;
let currentPrice = 0;
let currentDiscount = 0;
let currentPromo = null;

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(API + path, { headers: { 'content-type': 'application/json' }, ...opts });
  let body = null;
  try { body = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body };
}

function fmt(n) { return new Intl.NumberFormat('ru-RU').format(n); }

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3500);
}

/* ===== Товары ===== */
async function loadProducts() {
  try {
    const { status, body } = await api('/products');
    if (status !== 200) throw new Error('products api error ' + status);
    PRODUCTS = body;
    renderProducts(PRODUCTS);
  } catch (e) {
    $('productGrid').innerHTML = '<div class="grid-loader">API недоступен: ' + e.message + '</div>';
  }
}

function renderProducts(list) {
  const grid = $('productGrid');
  grid.innerHTML = '';
  if (!list.length) { grid.innerHTML = '<div class="grid-loader">Товары не найдены</div>'; return; }
  list.forEach((p) => {
    const card = document.createElement('article');
    card.className = 'product-card';
    card.innerHTML =
      '<img src="' + (TYPE_IMG[p.type] || 'images/product-topup.png') + '" alt="' + p.name + '" class="product-img">' +
      '<div class="product-body">' +
      '<h3>' + p.name + '</h3>' +
      '<p class="price"><span class="new">' + fmt(p.price) + ' ₽</span></p>' +
      '<button class="buy-btn" data-sku="' + p.sku + '">Купить</button>' +
      '</div>';
    grid.appendChild(card);
  });
}

/* ===== Carousel (интерактив №1) ===== */
function initCarousel() {
  const track = $('heroTrack');
  const slides = track.children.length;
  const dotsWrap = $('heroDots');
  for (let i = 0; i < slides; i++) {
    const d = document.createElement('span');
    d.className = 'dot' + (i === 0 ? ' active' : '');
    d.addEventListener('click', () => go(i));
    dotsWrap.appendChild(d);
  }
  let idx = 0;
  let timer = null;
  function go(i) {
    idx = (i + slides) % slides;
    track.style.transform = 'translateX(-' + (idx * 100) + '%)';
    [...dotsWrap.children].forEach((d, j) => d.classList.toggle('active', j === idx));
  }
  function next() { go(idx + 1); }
  function prev() { go(idx - 1); }
  $('heroNext').addEventListener('click', next);
  $('heroPrev').addEventListener('click', prev);
  function autoplay() { clearInterval(timer); timer = setInterval(next, 4000); }
  autoplay();
  const hero = $('hero');
  hero.addEventListener('mouseenter', () => clearInterval(timer));
  hero.addEventListener('mouseleave', autoplay);
}

/* ===== Catalog menu (интерактив №2) ===== */
function initCatalogMenu() {
  const btn = $('catalogBtn');
  const menu = $('catalogMenu');
  function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target) && !menu.contains(e.target)) close();
  });
  menu.querySelectorAll('a[data-cat]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const cat = a.dataset.cat;
      renderProducts(cat === 'all' ? PRODUCTS : PRODUCTS.filter((p) => p.type === cat));
      close();
    });
  });
}

/* ===== Currency toggle (интерактив №3) ===== */
function initCurrency() {
  const toggle = $('currencyToggle');
  toggle.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      toggle.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    });
  });
}

/* ===== Buy flow ===== */
function openBuy(sku) {
  const p = PRODUCTS.find((x) => x.sku === sku);
  if (!p) { toast('Товар не найден'); return; }
  currentSku = sku;
  currentPrice = p.price;
  currentDiscount = 0;
  currentPromo = null;
  $('modalImg').src = TYPE_IMG[p.type] || 'images/product-topup.png';
  $('modalName').textContent = p.name;
  $('modalPrice').textContent = 'Цена: ' + fmt(p.price) + ' ₽';
  $('modalDiscount').hidden = true;
  $('promoInput').value = '';
  $('promoMsg').textContent = '';
  $('buyStatus').textContent = '';
  $('buyModal').hidden = false;
}

function closeBuy() { $('buyModal').hidden = true; }

async function applyPromo() {
  const code = $('promoInput').value.trim();
  if (!code) { $('promoMsg').textContent = 'Введите код'; return; }
  const { body } = await api('/promo/validate', { method: 'POST', body: JSON.stringify({ code, amount: currentPrice }) });
  const msg = $('promoMsg');
  msg.className = 'promo-msg';
  if (body.valid) {
    currentDiscount = body.discount;
    currentPromo = code.toUpperCase();
    msg.classList.add('ok');
    msg.textContent = 'Промокод применён: −' + fmt(body.discount) + ' ₽ → ' + fmt(body.final_amount) + ' ₽';
    $('modalDiscount').textContent = 'Скидка: ' + fmt(body.discount) + ' ₽ (итого ' + fmt(body.final_amount) + ' ₽)';
    $('modalDiscount').hidden = false;
  } else {
    currentDiscount = 0;
    currentPromo = null;
    msg.classList.add('err');
    msg.textContent = ({ promocode_not_found: 'Промокод не найден', promocode_limit_reached: 'Лимит использования исчерпан' })[body.reason] || 'Не удалось применить';
    $('modalDiscount').hidden = true;
  }
}

async function pay(status) {
  const st = $('buyStatus');
  st.className = 'buy-status';
  st.textContent = 'Создание заказа…';
  try {
    const bodyOrder = { sku: currentSku };
    if (currentPromo) bodyOrder.promocode = currentPromo;
    const orderRes = await api('/orders', { method: 'POST', body: JSON.stringify(bodyOrder) });
    if (orderRes.status !== 201 && orderRes.status !== 200) {
      st.classList.add('err');
      st.textContent = orderRes.body.error === 'promocode_limit_reached'
        ? 'Лимит промокода исчерпан'
        : 'Ошибка: ' + (orderRes.body.error || 'unknown');
      return;
    }
    const orderId = orderRes.body.order_id;

    st.textContent = 'Оплата…';
    await api('/orders/' + orderId + '/pay', { method: 'POST', body: JSON.stringify({ status }) });
    if (status === 'failed') {
      st.classList.add('err');
      st.textContent = 'Оплата не прошла. Заказ #' + orderId;
      toast('Заказ #' + orderId + ' — оплата не прошла');
      return;
    }

    st.textContent = 'Ожидание доставки ключа…';
    const order = await pollOrder(orderId);
    if (order.status === 'delivered') {
      st.classList.add('ok');
      st.innerHTML = 'Ключ выдан! <div class="key-box">' + order.code + '</div>' +
        '<a href="order.html?id=' + orderId + '" target="_blank">Страница заказа</a>';
      toast('Товар доставлен');
    } else if (order.status === 'out_of_stock' || order.status === 'delivery_failed') {
      st.classList.add('err');
      st.textContent = 'Восстановимое состояние «' + order.status + '» — остаток закончился, ключ появится после пополнения.';
    } else {
      st.textContent = 'Статус заказа: ' + order.status;
    }
  } catch (e) {
    st.classList.add('err');
    st.textContent = 'Ошибка сети: ' + e.message;
  }
}

async function pollOrder(orderId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, body } = await api('/orders/' + orderId);
    if (status === 200 && ['delivered', 'out_of_stock', 'delivery_failed', 'payment_failed'].includes(body.status)) return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  const { body } = await api('/orders/' + orderId);
  return body || { status: 'timeout' };
}

/* ===== Init ===== */
function init() {
  initCarousel();
  initCatalogMenu();
  initCurrency();
  loadProducts();

  $('productGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.buy-btn');
    if (btn) openBuy(btn.dataset.sku);
  });
  $('steamPayBtn').addEventListener('click', () => openBuy('STEAM-TOPUP-500'));
  $('steamPromoBtn').addEventListener('click', () => { openBuy('STEAM-TOPUP-500'); $('promoInput').focus(); });
  $('modalClose').addEventListener('click', closeBuy);
  $('buyModal').addEventListener('click', (e) => { if (e.target === $('buyModal')) closeBuy(); });
  $('promoApply').addEventListener('click', applyPromo);
  $('promoInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPromo(); });
  $('paySuccess').addEventListener('click', () => pay('paid'));
  $('payFail').addEventListener('click', () => pay('failed'));

  $('searchInput').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    renderProducts(q ? PRODUCTS.filter((p) => p.name.toLowerCase().includes(q)) : PRODUCTS);
  });
}

document.addEventListener('DOMContentLoaded', init);
