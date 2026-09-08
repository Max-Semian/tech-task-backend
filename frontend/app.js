/* GameMarket frontend (макет-часть): карусель, меню «Каталог», валюта,
   иконки приложений, отзывы, блок пополнения. Карточки каталога, поиск,
   live-обновления и покупка с бронью — в catalog.js/checkout.js/live.js. */
'use strict';

const API = window.API_BASE || 'http://localhost:3000';
const PRODUCT_COVER = 'images/product-key.png';
const $ = (id) => document.getElementById(id);

function fmt(n) { return new Intl.NumberFormat('ru-RU').format(n); }

function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3500);
}

/* ===== Приложения витрины =====
   sku — реальная позиция каталога; null — пополнение недоступно. */
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

const PROMO_BADGE = {
  WELCOME10: '10%',
  LIMIT3: '25%',
  ONCEONLY: '50%',
  GG500: '\u2212500\u20BD',
};

let currentApp = 'steam';

function renderSelectedApp() {
  const a = APPS[currentApp];
  if (!$('selectedAppImg')) return;
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

/* Пополнение выбранного приложения -> покупка с бронью на checkout.html */
function startTopup() {
  const a = APPS[currentApp];
  if (!a.sku) {
    toast('Пополнение «' + a.name + '» пока недоступно в каталоге');
    return;
  }
  if (window.Checkout && window.Checkout.attempt) {
    window.Checkout.attempt(a.sku, { promo: a.promo });
  } else {
    toast('Модуль покупки не загружен');
  }
}

/* ===== Отзывы (статичные по макету) ===== */
const REVIEWS = [
  { author: 'Bizidin', avatar: 'images/profile.png', rating: 5, time: 'Сегодня в 11:48',
    text: 'Отзывчивый и приятный продавец, помог не только с товаром но и с другим вопросом. Рекомендую!',
    item: '\uD83C\uDF38 FunTime | Полностью готовый сервер под ключ \u26A1', price: 139 },
];

function renderReviews() {
  const grid = $('reviewsGrid');
  if (!grid) return;
  grid.innerHTML = '';
  REVIEWS.forEach((r) => {
    const stars = '\u2605'.repeat(r.rating) + '\u2606'.repeat(5 - r.rating);
    const card = document.createElement('article');
    card.className = 'review-card';
    card.innerHTML =
      '<div class="review-top"><div class="review-author"><img src="' + r.avatar + '" alt=""><div>' +
      '<h4>' + r.author + '</h4><div class="review-rating"><span class="stars">' + stars + '</span>' +
      '<span class="score">' + r.rating.toFixed(1) + '</span></div></div></div>' +
      '<span class="review-time">' + r.time + '</span></div>' +
      '<p class="review-text">' + r.text + '</p>' +
      '<div class="review-item"><img src="' + PRODUCT_COVER + '" alt=""><span>' + r.item + '</span>' +
      '<span class="review-price">' + fmt(r.price) + '\u20BD</span></div>';
    grid.appendChild(card);
  });
}

/* ===== Carousel (интерактив №1) ===== */
function initCarousel() {
  const track = $('heroTrack');
  const dotsWrap = $('heroDots');
  if (!track || !dotsWrap) return;
  const slides = track.children.length;
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

/* ===== Меню «Каталог» (интерактив №2): фильтры теперь на сервере (catalog.js) ===== */
function initCatalogMenu() {
  const btn = $('catalogBtn');
  const menu = $('catalogMenu');
  if (!btn || !menu) return;
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
      if (window.Catalog) window.Catalog.setType(cat);
      const grid = $('productGrid');
      if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      close();
    });
  });
}

/* ===== Валюта в блоке пополнения (интерактив №3) ===== */
const CURRENCIES = {
  RUB: { symbol: '\u20BD', rate: 1, dp: 0 },
  USD: { symbol: '$', rate: 1 / 90, dp: 2 },
  KZT: { symbol: '\u20B8', rate: 5.2, dp: 0 },
};
let topupRub = 500;
let topupCur = 'RUB';

function fmtAmount(value, dp) {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0, maximumFractionDigits: dp, useGrouping: false,
  }).format(value);
}
function sizeAmountInput() {
  const input = $('steamAmount');
  if (!input) return;
  input.style.width = Math.max(2, input.value.length) + 'ch';
}
function renderAmount() {
  const c = CURRENCIES[topupCur];
  const shown = fmtAmount(topupRub * c.rate, c.dp);
  if ($('steamAmount')) { $('steamAmount').value = shown; sizeAmountInput(); $('steamCurrency').textContent = c.symbol; }
  if ($('steamPayBtn')) $('steamPayBtn').textContent = 'Оплатить ' + shown + c.symbol;
}

function initCurrency() {
  const toggle = $('currencyToggle');
  const input = $('steamAmount');
  if (!toggle || !input) return;
  toggle.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      toggle.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      topupCur = b.dataset.cur;
      renderAmount();
    });
  });
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
  input.addEventListener('blur', renderAmount);
  renderAmount();
}

/* ===== Init ===== */
function init() {
  initCarousel();
  initCatalogMenu();
  initCurrency();
  initApps();
  renderReviews();

  const payBtn = $('steamPayBtn');
  if (payBtn) payBtn.addEventListener('click', startTopup);
  const promoBtn = $('steamPromoBtn');
  if (promoBtn) promoBtn.addEventListener('click', startTopup);
}

document.addEventListener('DOMContentLoaded', init);
