/* GameMarket frontend: 5 интерактивов + флоу покупки + промокод (фуллстек) */
'use strict';

const API = window.API_BASE || 'http://localhost:3000';

/* По макету все карточки товаров идут с единой обложкой PUBG */
const PRODUCT_COVER = 'images/product-key.png';

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

/* ===== Приложения витрины =====
   sku — реальная позиция каталога; null означает, что бэкенд пока не отдаёт
   пополнение для этого приложения (произвольная сумма не поддерживается). */
const APPS = {
  steam:       { name: 'Steam',          img: 'images/steam.png',       promo: 'WELCOME10', sku: 'STEAM-TOPUP-500' },
  telegram:    { name: 'Telegram',       img: 'images/telegram.png',    promo: 'GG500',     sku: null },
  roblox:      { name: 'Roblox',         img: 'images/roblox.png',      promo: 'LIMIT3',    sku: 'GIFT-ROBLOX-800' },
  brawl:       { name: 'Brawl Stars',    img: 'images/brawl.png',       promo: 'WELCOME10', sku: null },
  pubg:        { name: 'PUBG Mobile',    img: 'images/pubg.png',        promo: 'WELCOME10', sku: null },
  appstore:    { name: 'App Store',      img: 'images/appstore.png',    promo: 'GG500',     sku: null },
  playstation: { name: 'PlayStation',    img: 'images/playstation.png', promo: 'ONCEONLY',  sku: 'GIFT-PSN-1000' },
  tiktok:      { name: 'TikTok',         img: 'images/tiktok.png',      promo: 'WELCOME10', sku: null },
  mlegends:    { name: 'Mobile Legends', img: 'images/mlegends.png',    promo: 'LIMIT3',    sku: null },
};

/* Скидка бейджа берётся из самого промокода, чтобы цифра не расходилась с флоу */
const PROMO_BADGE = {
  WELCOME10: '10%',
  LIMIT3: '25%',
  ONCEONLY: '50%',
  GG500: '\u2212500\u20BD',
};

let currentApp = 'steam';

function renderSelectedApp() {
  const a = APPS[currentApp];
  $('selectedAppImg').src = a.img;
  $('selectedAppImg').alt = a.name;
  $('selectedAppName').textContent = 'Пополнение ' + a.name;
  $('selectedAppBadge').textContent = PROMO_BADGE[a.promo] || '';
  $('appLoginInput').placeholder = 'Логин ' + a.name;
  $('steamPromoBtn').textContent = 'Промокод ' + a.promo;
}

function initApps() {
  document.querySelectorAll('.app-icon[data-app]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.app-icon[data-app]').forEach((x) => {
        x.classList.remove('active');
        x.setAttribute('aria-pressed', 'false');
      });
      el.classList.add('active');
      el.setAttribute('aria-pressed', 'true');
      currentApp = el.dataset.app;
      renderSelectedApp();
    });
  });
  renderSelectedApp();
}

/* Пополнение выбранного приложения: открываем каталожную позицию, если она есть */
function openTopup(focusPromo) {
  const a = APPS[currentApp];
  if (!a.sku) { toast('Пополнение «' + a.name + '» пока недоступно в каталоге'); return; }
  openBuy(a.sku);
  $('promoInput').value = a.promo;
  if (focusPromo) $('promoInput').focus();
}

/* ===== Товары =====
   Фильтр витрины держим в одном месте: тип + поиск. Раньше меню и поиск
   независимо звали renderProducts со своим списком, и после выбора категории
   вернуть все карточки было нечем. */
const TYPE_LABEL = {
  topup: 'Донат',
  subscription: 'Подписки',
  key: 'Ключи',
  giftcard: 'Подарочные карты',
};

let activeType = 'all';
let searchQuery = '';

async function loadProducts() {
  try {
    const { status, body } = await api('/products');
    if (status !== 200) throw new Error('products api error ' + status);
    PRODUCTS = body;
    renderChips();
    applyShowcaseFilters();
  } catch (e) {
    $('productGrid').innerHTML = '<div class="grid-loader">API недоступен: ' + e.message + '</div>';
  }
}

function visibleProducts() {
  let list = activeType === 'all' ? PRODUCTS : PRODUCTS.filter((p) => p.type === activeType);
  if (searchQuery) list = list.filter((p) => p.name.toLowerCase().includes(searchQuery));
  return list;
}

function setShowcaseType(type) {
  activeType = type;
  applyShowcaseFilters();
}

function applyShowcaseFilters() {
  renderProducts(visibleProducts());
  document.querySelectorAll('#filterChips button').forEach((b) => {
    b.classList.toggle('active', b.dataset.type === activeType);
  });
}

/* Чипы строим по типам, которые реально есть в каталоге */
function renderChips() {
  const wrap = $('filterChips');
  const types = [...new Set(PRODUCTS.map((p) => p.type))];
  wrap.innerHTML = '';
  [['all', 'Все'], ...types.map((t) => [t, TYPE_LABEL[t] || t])].forEach(([type, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.type = type;
    b.textContent = label;
    b.addEventListener('click', () => setShowcaseType(type));
    wrap.appendChild(b);
  });
}

function renderProducts(list) {
  const grid = $('productGrid');
  grid.innerHTML = '';
  if (!list.length) {
    grid.innerHTML = '<div class="grid-loader">Товары не найдены — <button type="button" class="link-btn" id="resetFilters">показать все</button></div>';
    $('resetFilters').addEventListener('click', () => {
      searchQuery = '';
      $('searchInput').value = '';
      setShowcaseType('all');
    });
    return;
  }
  list.forEach((p) => {
    const card = document.createElement('article');
    card.className = 'product-card';
    card.innerHTML =
      '<img src="' + PRODUCT_COVER + '" alt="' + p.name + '" class="product-img">' +
      '<div class="product-body">' +
      '<h3>' + p.name + '</h3>' +
      '<p class="price"><span class="new">' + fmt(p.price) + ' ₽</span></p>' +
      '<button class="buy-btn" data-sku="' + p.sku + '">Купить</button>' +
      '</div>';
    grid.appendChild(card);
  });
}

/* ===== Отзывы =====
   Бэкенд отзывы не отдаёт, поэтому витрина рендерится из статики по макету. */
const REVIEWS = [
  { author: 'Bizidin', avatar: 'images/profile.png', rating: 5, time: 'Сегодня в 11:48',
    text: 'Отзывчивый и приятный продавец, помог не только с товаром но и с другим вопросом. Рекомендую!',
    item: '\uD83C\uDF38 FunTime | Полностью готовый сервер под ключ \u26A1', price: 139 },
  { author: 'Bizidin', avatar: 'images/profile.png', rating: 5, time: 'Сегодня в 11:48',
    text: 'Отзывчивый и приятный продавец, помог не только с товаром но и с другим вопросом. Рекомендую!',
    item: '\uD83C\uDF38 FunTime | Полностью готовый сервер под ключ \u26A1', price: 139 },
  { author: 'Bizidin', avatar: 'images/profile.png', rating: 5, time: 'Сегодня в 11:48',
    text: 'Отзывчивый и приятный продавец, помог не только с товаром но и с другим вопросом. Рекомендую!',
    item: '\uD83C\uDF38 FunTime | Полностью готовый сервер под ключ \u26A1', price: 139 },
];

function renderReviews() {
  const grid = $('reviewsGrid');
  grid.innerHTML = '';
  REVIEWS.forEach((r) => {
    const stars = '\u2605'.repeat(r.rating) + '\u2606'.repeat(5 - r.rating);
    const card = document.createElement('article');
    card.className = 'review-card';
    card.innerHTML =
      '<div class="review-top">' +
        '<div class="review-author">' +
          '<img src="' + r.avatar + '" alt="">' +
          '<div>' +
            '<h4>' + r.author + '</h4>' +
            '<div class="review-rating"><span class="stars">' + stars + '</span>' +
              '<span class="score">' + r.rating.toFixed(1) + '</span></div>' +
          '</div>' +
        '</div>' +
        '<span class="review-time">' + r.time + '</span>' +
      '</div>' +
      '<p class="review-text">' + r.text + '</p>' +
      '<div class="review-item">' +
        '<img src="' + PRODUCT_COVER + '" alt="">' +
        '<span>' + r.item + '</span>' +
        '<span class="review-price">' + fmt(r.price) + '\u20BD</span>' +
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
      setShowcaseType(cat);
      $('productGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
      close();
    });
  });
}

/* ===== Currency toggle (интерактив №3) ===== */
/* rate — сколько единиц валюты в одном рубле, dp — знаков после запятой */
const CURRENCIES = {
  RUB: { symbol: '\u20BD', rate: 1, dp: 0 },
  USD: { symbol: '$', rate: 1 / 90, dp: 2 },
  KZT: { symbol: '\u20B8', rate: 5.2, dp: 0 },
};

let topupRub = 500;
let topupCur = 'RUB';

function fmtAmount(value, dp) {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: dp,
    useGrouping: false,
  }).format(value);
}

/* Поле тянется по содержимому, чтобы символ валюты не отрывался от числа */
function sizeAmountInput() {
  const input = $('steamAmount');
  input.style.width = Math.max(2, input.value.length) + 'ch';
}

function renderAmount() {
  const c = CURRENCIES[topupCur];
  const shown = fmtAmount(topupRub * c.rate, c.dp);
  $('steamAmount').value = shown;
  sizeAmountInput();
  $('steamCurrency').textContent = c.symbol;
  $('steamPayBtn').textContent = 'Оплатить ' + shown + c.symbol;
}

function initCurrency() {
  const toggle = $('currencyToggle');
  const input = $('steamAmount');

  toggle.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      toggle.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      topupCur = b.dataset.cur;
      renderAmount();
    });
  });

  // Пока пользователь печатает — не переформатируем поле, только пересчитываем базу
  input.addEventListener('input', () => {
    sizeAmountInput();
    const raw = input.value.replace(/\s/g, '').replace(',', '.');
    const n = parseFloat(raw);
    if (!isNaN(n) && n >= 0) {
      topupRub = n / CURRENCIES[topupCur].rate;
      const c = CURRENCIES[topupCur];
      $('steamPayBtn').textContent = 'Оплатить ' + fmtAmount(n, c.dp) + c.symbol;
    }
  });

  // На blur приводим поле к нормальному виду (или откатываем мусор)
  input.addEventListener('blur', renderAmount);

  renderAmount();
}

/* ===== Buy flow ===== */
function openBuy(sku) {
  const p = PRODUCTS.find((x) => x.sku === sku);
  if (!p) { toast('Товар не найден'); return; }
  currentSku = sku;
  currentPrice = p.price;
  currentDiscount = 0;
  currentPromo = null;
  $('modalImg').src = PRODUCT_COVER;
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
  initApps();
  renderReviews();
  loadProducts();

  $('productGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.buy-btn');
    if (btn) openBuy(btn.dataset.sku);
  });
  $('steamPayBtn').addEventListener('click', () => openTopup(false));
  $('steamPromoBtn').addEventListener('click', () => openTopup(true));
  $('modalClose').addEventListener('click', closeBuy);
  $('buyModal').addEventListener('click', (e) => { if (e.target === $('buyModal')) closeBuy(); });
  $('promoApply').addEventListener('click', applyPromo);
  $('promoInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPromo(); });
  $('paySuccess').addEventListener('click', () => pay('paid'));
  $('payFail').addEventListener('click', () => pay('failed'));

  $('searchInput').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    applyShowcaseFilters();
  });
}

document.addEventListener('DOMContentLoaded', init);
