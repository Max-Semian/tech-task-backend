/* Каталог (2-я часть ТЗ, Задача 5): серверный поиск, фильтры, сортировка,
   пагинация «показать ещё», состояние фильтров в URL, live-обновление карточек.
   Мгновенность: debounce ввода + AbortController + монотонный seq — устаревшие
   ответы не перетирают свежие, список не очищается до прихода новых данных. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const API = window.API_BASE || 'http://localhost:3000';
  const COVER = 'images/product-key.png';
  const LIMIT = 48;

  const TYPE_LABEL = { topup: 'Донат', subscription: 'Подписки', key: 'Ключи', giftcard: 'Подарочные карты' };
  const TYPE_ORDER = ['topup', 'key', 'subscription', 'giftcard'];

  const state = { q: '', type: 'all', sort: 'default', inStock: false, offset: 0, total: 0, hasMore: false };
  const cards = new Map(); // sku -> [DOM-карточки]
  let seq = 0;
  let controller = null;
  let firstLoad = true;

  const grid = $('productGrid');
  const statusEl = $('catalogStatus');
  const countEl = $('catalogCount');
  const loadBtn = $('loadMoreBtn');

  const fmt = (n) => new Intl.NumberFormat('ru-RU').format(n);
  const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  /* ---------- URL <-> состояние ---------- */
  function readUrl() {
    const p = new URLSearchParams(location.search);
    return {
      q: p.get('q') || '',
      type: p.get('type') || 'all',
      sort: p.get('sort') || 'default',
      inStock: p.get('in_stock') === '1',
    };
  }

  function writeUrl() {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.type !== 'all') p.set('type', state.type);
    if (state.sort !== 'default') p.set('sort', state.sort);
    if (state.inStock) p.set('in_stock', '1');
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }

  function syncControls() {
    if ($('searchInput')) $('searchInput').value = state.q;
    chips.forEach((b) => b.classList.toggle('active', b.dataset.type === state.type));
    if ($('sortSelect')) $('sortSelect').value = state.sort;
    if ($('inStockOnly')) $('inStockOnly').checked = state.inStock;
  }

  /* ---------- карточка ---------- */
  function stockBadge(o) {
    if (o.available <= 0) return '<span class="stock-badge out">Нет в наличии</span>';
    if (o.available <= 3) return '<span class="stock-badge low">Осталось ' + o.available + '</span>';
    return '<span class="stock-badge in">В наличии</span>';
  }

  function cardHtml(o) {
    const out = o.available <= 0;
    return '' +
      '<article class="product-card' + (out ? ' is-out' : '') + '" data-sku="' + esc(o.sku) + '">' +
        '<img src="' + COVER + '" alt="" class="product-img">' +
        '<div class="product-body">' +
          '<h3>' + esc(o.name) + '</h3>' +
          '<div class="product-seller">' + esc(o.seller || 'GameMarket') + '</div>' +
          '<p class="price"><span class="new">' + fmt(o.price) + ' ₽</span></p>' +
          stockBadge(o) +
          '<button class="buy-btn" data-sku="' + esc(o.sku) + '" ' + (out ? 'disabled' : '') + '>Купить</button>' +
        '</div>' +
      '</article>';
  }

  function applyToCard(card, o) {
    const price = card.querySelector('.new');
    const badge = card.querySelector('.stock-badge');
    const btn = card.querySelector('.buy-btn');
    if (!price || !btn) return;
    price.textContent = fmt(o.price) + ' ₽';
    card.classList.toggle('is-out', o.available <= 0);
    btn.disabled = o.available <= 0;
    btn.textContent = o.available <= 0 ? 'Нет в наличии' : 'Купить';
    if (badge) badge.outerHTML = stockBadge(o);
  }

  /* live-обновление уже отрисованных карточек */
  function onLive(payload) {
    const els = cards.get(payload.sku);
    if (!els) return;
    els.forEach((card) => applyToCard(card, payload));
  }

  /* ---------- рендер ---------- */
  function renderRows(rows, replace) {
    if (replace) {
      grid.innerHTML = '';
      cards.clear();
      if (!rows.length) {
        grid.innerHTML = '<div class="grid-loader">Ничего не найдено — <button type="button" class="link-btn" id="resetFilters2">сбросить фильтры</button></div>';
        const rb = $('resetFilters2');
        if (rb) rb.addEventListener('click', resetAll);
        return;
      }
    }
    rows.forEach((o) => {
      const div = document.createElement('div');
      div.innerHTML = cardHtml(o);
      const card = div.firstElementChild;
      grid.appendChild(card);
      if (!cards.has(o.sku)) cards.set(o.sku, []);
      cards.get(o.sku).push(card);
      // если в сторе уже есть более свежее состояние (SSE могло прийти раньше рендера)
      const fresh = window.Live && window.Live.get(o.sku);
      if (fresh) applyToCard(card, fresh);
    });
  }

  function setStatus(text, isErr) {
    if (!statusEl) return;
    if (isErr) {
      statusEl.className = 'grid-loader err';
      statusEl.textContent = text;
    } else if (text) {
      statusEl.className = 'grid-loader';
      statusEl.textContent = text;
    } else {
      statusEl.textContent = '';
    }
  }

  function showCount() {
    if (!countEl) return;
    const shown = grid.querySelectorAll('.product-card').length;
    countEl.textContent = 'Показано ' + shown + ' из ' + state.total;
    if (loadBtn) loadBtn.hidden = !state.hasMore;
  }

  /* ---------- запросы ---------- */
  function buildUrl(offset) {
    const u = new URLSearchParams();
    if (state.q) u.set('q', state.q);
    if (state.type !== 'all') u.set('type', state.type);
    if (state.sort !== 'default') u.set('sort', state.sort);
    if (state.inStock) u.set('in_stock', '1');
    u.set('limit', String(LIMIT));
    u.set('offset', String(offset));
    return API + '/products?' + u.toString();
  }

  async function fetchPage(offset, replace) {
    if (controller) controller.abort();
    controller = new AbortController();
    const token = ++seq;
    if (replace && firstLoad) setStatus('Загрузка товаров…');
    try {
      const res = await fetch(buildUrl(offset), { signal: controller.signal });
      if (token !== seq) return; // устаревший ответ
      const rows = await res.json();
      if (token !== seq) return;
      state.total = Number(res.headers.get('X-Total-Count')) || rows.length;
      renderRows(rows, replace);
      state.offset = offset + rows.length;
      state.hasMore = state.offset < state.total;
      firstLoad = false;
      setStatus('');
      showCount();
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (token !== seq) return;
      setStatus('Ошибка сети: ' + e.message, true);
    }
  }

  function loadFirst() {
    state.offset = 0;
    writeUrl();
    fetchPage(0, true);
  }

  function loadMore() {
    if (!state.hasMore) return;
    fetchPage(state.offset, false);
  }

  function resetAll() {
    state.q = '';
    state.type = 'all';
    state.sort = 'default';
    state.inStock = false;
    syncControls();
    loadFirst();
  }

  /* ---------- контролы ---------- */
  let chips = [];
  function renderChips() {
    const wrap = $('filterChips');
    if (!wrap) return;
    wrap.innerHTML = '';
    chips = [];
    const mk = (type, label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.type = type;
      b.textContent = label;
      b.addEventListener('click', () => Catalog.setType(type));
      wrap.appendChild(b);
      chips.push(b);
    };
    mk('all', 'Все');
    TYPE_ORDER.forEach((t) => mk(t, TYPE_LABEL[t]));
  }

  function initControls() {
    renderChips();
    const search = $('searchInput');
    if (search) {
      let deb = null;
      search.addEventListener('input', () => {
        clearTimeout(deb);
        deb = setTimeout(() => {
          state.q = search.value.trim().toLowerCase();
          loadFirst();
        }, 180);
      });
    }
    const sort = $('sortSelect');
    if (sort) sort.addEventListener('change', () => { state.sort = sort.value; loadFirst(); });
    const inStock = $('inStockOnly');
    if (inStock) inStock.addEventListener('change', () => { state.inStock = inStock.checked; loadFirst(); });
    if (loadBtn) loadBtn.addEventListener('click', loadMore);

    // клик по карточке «Купить»
    if (grid) {
      grid.addEventListener('click', (e) => {
        const btn = e.target.closest('.buy-btn');
        if (!btn || btn.disabled) return;
        const sku = btn.dataset.sku;
        if (window.Checkout && window.Checkout.attempt) window.Checkout.attempt(sku);
      });
    }

    // стрелки/кнопка «Назад» браузера
    window.addEventListener('popstate', () => {
      Object.assign(state, readUrl());
      syncControls();
      loadFirst();
    });

    window.Live && window.Live.onOffer(onLive);
    // после обрыва SSE и переподключения — тихая сверка текущей страницы
    window.Live && window.Live.onOpen(() => { if (!firstLoad) fetchPage(state.offset - grid.querySelectorAll('.product-card').length, true); });
  }

  const Catalog = {
    setType(type) { if (type && type !== state.type) { state.type = type; syncControls(); loadFirst(); } },
    setQuery(q) { state.q = String(q || '').trim().toLowerCase(); if ($('searchInput')) $('searchInput').value = state.q; loadFirst(); },
    reset: resetAll,
    refresh: () => loadFirst(),
  };
  window.Catalog = Catalog;

  function init() {
    if (!grid) return;
    Object.assign(state, readUrl());
    initControls();
    syncControls();
    loadFirst();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
