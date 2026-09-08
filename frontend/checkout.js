/* Покупка с бронью (2-я часть ТЗ, Задачи 2-4).
   Состояние покупки живёт в sessionStorage ('gm.checkout'): переживает refresh,
   Back, обрыв сети. Один purchase_key на попытку -> двойной клик не создаёт
   второй брони; повторная оплата оплаченного заказа ничего не меняет (сервер). */
(function () {
  'use strict';

  const API = window.API_BASE || 'http://localhost:3000';
  const $ = (id) => document.getElementById(id);
  const SKEY = 'gm.checkout';
  const TERMINAL_OK = ['paid', 'delivering', 'delivered'];

  const fmt = (n) => new Intl.NumberFormat('ru-RU').format(n);
  const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  function uid() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  }

  function getSess() {
    try { return JSON.parse(sessionStorage.getItem(SKEY)) || null; } catch (e) { return null; }
  }
  function setSess(patch) {
    const cur = getSess() || {};
    const next = Object.assign({}, cur, patch);
    try { sessionStorage.setItem(SKEY, JSON.stringify(next)); } catch (e) { /* noop */ }
    return next;
  }
  function clearSess() { try { sessionStorage.removeItem(SKEY); } catch (e) { /* noop */ } }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, { headers: { 'content-type': 'application/json' }, ...opts });
    let body = null;
    try { body = await res.json(); } catch (e) { /* noop */ }
    return { status: res.status, body };
  }

  /* ============ Начало покупки с карточки/топапа ============ */
  let attemptBusy = false;

  function toast(msg) {
    let t = $('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 4000);
  }

  function showSoldOut(sku, alternatives) {
    let overlay = $('soldoutOverlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'soldoutOverlay';
    overlay.className = 'modal-backdrop';
    const altRows = (alternatives || []).map((a) =>
      '<div class="soldout-alt"><div>' +
        '<b>' + esc(a.name) + '</b>' +
        '<span class="product-seller">продавец: ' + esc(a.seller) + '</span></div>' +
        '<span class="price">' + fmt(a.price) + ' ₽</span>' +
        '<button class="buy-btn" data-alt-sku="' + esc(a.sku) + '">Купить</button></div>').join('');
    overlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
        '<button class="modal-close" id="soldoutClose" aria-label="Закрыть">✕</button>' +
        '<h3>Только что раскупили 😔</h3>' +
        '<p class="promo-msg">Последнюю единицу только что забрал другой покупатель.</p>' +
        (altRows ? '<div class="soldout-list">' + altRows + '</div>' : '') +
        '<div class="modal-actions"><button class="btn-success" id="soldoutBack">← Вернуться к товару</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.hidden = false;
    $('soldoutClose').addEventListener('click', close);
    $('soldoutBack').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-alt-sku]').forEach((b) => b.addEventListener('click', () => { close(); attempt(b.dataset.altSku); }));
    function close() { overlay.remove(); }
  }

  async function attempt(sku, opts) {
    if (attemptBusy) return;
    attemptBusy = true;
    try {
      const promo = (opts && opts.promo) || null;
      const sess = getSess() || {};

      // уже есть активный заказ на этот ску -> резюмируем вместо новой брони
      if (sess.sku === sku && sess.orderId && sess.status !== 'done' && TERMINAL_OK.indexOf(sess.orderStatus || '') === -1) {
        location.href = 'checkout.html';
        return;
      }

      const purchaseKey = (sess.sku === sku && sess.purchaseKey) ? sess.purchaseKey : uid();
      setSess({ sku, purchaseKey, promo, status: 'reserving' });

      const r = await api('/reservations', { method: 'POST', body: JSON.stringify({ sku, purchase_key: purchaseKey }) });
      if (r.status === 201 || r.status === 200) {
        setSess({ reservationId: r.body.id, status: 'reserved' });
        location.href = 'checkout.html';
        return;
      }
      if (r.status === 409) {
        setSess({ status: 'sold_out' });
        showSoldOut(sku, r.body.alternatives || []);
        return;
      }
      toast('Ошибка: ' + ((r.body && r.body.error) || r.status));
      setSess({ status: 'error' });
    } finally {
      attemptBusy = false;
    }
  }

  const Checkout = { attempt, getSess, setSess, clearSess, API };
  window.Checkout = Checkout;

  /* ============ Страница оформления checkout.html ============ */
  const IS_CHECKOUT = document.body && document.body.dataset.page === 'checkout';

  const els = {
    wrap: $('checkoutWrap'),
    product: $('chProduct'),
    priceLive: $('chPriceLive'),
    orderAmount: $('chOrderAmount'),
    promoInput: $('chPromo'),
    promoMsg: $('chPromoMsg'),
    orderBtn: $('chOrderBtn'),
    countdown: $('chCountdown'),
    phase: $('chPhase'),
    status: $('chStatus'),
    paySuccess: $('chPaySuccess'),
    payFail: $('chPayFail'),
    cancelBtn: $('chCancel'),
    againLink: $('chAgain'),
  };

  let res = null;      // резервация
  let order = null;    // заказ
  let offer = null;    // последняя известная цена
  let timer = null;
  let liveOff = null;
  let busy = false;
  let promoEntered = '';

  function state() {
    if (order && TERMINAL_OK.indexOf(order.status) !== -1) return 'paid';
    if (order && ['expired', 'payment_failed'].indexOf(order.status) !== -1) return order.status;
    if (order) return 'order';
    if (res && res.status === 'active') return 'reserved';
    if (res && res.status === 'expired') return 'reservation_expired';
    return 'reserved';
  }

  function fmtClock(ms) {
    if (ms <= 0) return '00:00';
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function renderOffer() {
    if (!offer) return;
    els.product.innerHTML =
      '<div class="ch-offer"><img src="images/product-key.png" alt="">' +
      '<div><h2>' + esc(offer.name) + '</h2>' +
      '<div class="product-seller">продавец: ' + esc(offer.seller || 'GameMarket') + '</div></div></div>';
    els.priceLive.textContent = 'Текущая цена: ' + fmt(offer.price) + ' ₽';
  }

  function renderOrderAmount() {
    if (!order) return;
    let html = 'К оплате: <b>' + fmt(order.amount) + ' ' + esc(order.currency) + '</b>';
    if (order.promo_code) html += ' · промокод ' + esc(order.promo_code) + ' (−' + fmt(order.promo_discount) + ' ₽)';
    // цена выросла с момента брони -> предупреждение до оплаты
    if (offer && order.amount > offer.price && res && Number(res.price) !== Number(order.amount)) {
      html += '<div class="price-warn">⚠️ Цена обновилась: было ' + fmt(res.price) + ' ₽, теперь ' + fmt(order.amount) + ' ₽ — сумма указана до оплаты.</div>';
    }
    els.orderAmount.innerHTML = html;
  }

  function updateLive(payload) {
    if (!offer || payload.sku !== offer.sku) return;
    if (!payload.price || payload.price === offer.price) return;
    offer = Object.assign({}, offer, payload);
    renderOffer();
    if (order && order.status === 'created') renderOrderAmount();
  }

  function deadline() {
    if (order && order.pay_until) return new Date(order.pay_until).getTime();
    if (res && res.expires_at) return new Date(res.expires_at).getTime();
    return 0;
  }

  function renderUi() {
    const st = state();
    els.status.className = 'ch-status';
    switch (st) {
      case 'reserved':
        els.phase.textContent = 'Товар забронирован за вами. Успейте оплатить до конца отсчёта.';
        els.orderBtn.hidden = false;
        els.paySuccess.hidden = true;
        els.payFail.hidden = true;
        els.cancelBtn.hidden = false;
        break;
      case 'order':
        els.phase.textContent = 'Заказ создан. Оплатите до конца отсчёта — иначе бронь снимется автоматически.';
        els.orderBtn.hidden = true;
        els.paySuccess.hidden = false;
        els.payFail.hidden = false;
        els.cancelBtn.hidden = false;
        els.paySuccess.textContent = '💳 Оплатить ' + fmt(order.amount) + ' ' + (order.currency || '₽');
        els.payFail.textContent = 'Оплатить (неуспех)';
        renderOrderAmount();
        break;
      case 'paid':
      case 'delivering':
        els.phase.textContent = 'Оплата получена. Выдаём товар…';
        els.orderBtn.hidden = true;
        els.paySuccess.hidden = true;
        els.payFail.hidden = true;
        els.cancelBtn.hidden = true;
        break;
      case 'reservation_expired':
      case 'expired':
        els.phase.textContent = 'Срок брони истёк — товар снова в продаже. Можно попробовать ещё раз.';
        els.countdown.textContent = '00:00';
        els.orderBtn.hidden = true;
        els.paySuccess.hidden = true;
        els.payFail.hidden = true;
        els.cancelBtn.hidden = true;
        els.againLink.hidden = false;
        break;
      case 'payment_failed':
        els.phase.textContent = 'Оплата не прошла. Бронь снята, товар вернулся в продажу.';
        els.orderBtn.hidden = true;
        els.paySuccess.hidden = false;
        els.payFail.hidden = true;
        els.cancelBtn.hidden = true;
        els.againLink.hidden = false;
        break;
      default:
        break;
    }
  }

  function tick() {
    const d = deadline();
    if (!d) return;
    const left = d - Date.now();
    els.countdown.textContent = fmtClock(left);
    els.countdown.classList.toggle('urgent', left < 30000);
    if (left <= 0) {
      clearInterval(timer);
      onDeadline();
    }
  }

  async function onDeadline() {
    // ленивое освобождение на сервере + честное состояние на экране
    try {
      if (res && res.id) await api('/reservations/' + res.id);
      if (order && order.order_id) await api('/orders/' + order.order_id);
    } catch (e) { /* noop */ }
    await loadState();
  }

  async function loadState() {
    const sess = getSess();
    const orderId = (sess && sess.orderId) || null;
    const resId = (sess && sess.reservationId) || null;
    els.wrap.hidden = false;
    try {
      // резервация всегда даёт offer (название, продавец, текущую цену, статус)
      if (resId) {
        const r = await api('/reservations/' + resId);
        if (r.status === 200) res = r.body;
      }
      // заказ — если подтверждали (refresh после «Оформить заказ»)
      if (orderId) {
        const r = await api('/orders/' + orderId);
        if (r.status === 200) order = r.body;
      }
      if (!order && !res) {
        els.phase.textContent = 'Нет активной покупки. Вернитесь в каталог и выберите товар.';
        els.againLink.hidden = false;
        return;
      }
      const sku = (order && (order.sku || (order.items && order.items[0] && order.items[0].sku))) || (res && res.sku);
      const ofr = (res && res.offer) || null;
      const oItem = order && order.items && order.items[0];
      offer = {
        sku,
        name: (ofr && ofr.name) || sku || '',
        price: (ofr && ofr.price) || (order && order.amount) || 0,
        seller: (ofr && ofr.seller) || '',
      };
      setSess({ sku });
      renderOffer();
      liveOff = window.Live && window.Live.onOffer(updateLive);
      renderUi();
      timer = setInterval(tick, 250);
      tick();
    } catch (e) {
      els.phase.textContent = 'Сеть недоступна: ' + e.message + ' — повторяем…';
      setTimeout(loadState, 1500);
    }
  }

  async function confirmOrder() {
    if (busy) return;
    busy = true;
    els.orderBtn.disabled = true;
    els.status.textContent = 'Оформляем заказ…';
    try {
      promoEntered = els.promoInput.value.trim().toUpperCase();
      const body = { reservation_id: res.id };
      if (promoEntered) body.promocode = promoEntered;
      const r = await api('/orders', { method: 'POST', body: JSON.stringify(body) });
      if (r.status === 201 || r.status === 200) {
        order = r.body;
        setSess({ orderId: order.order_id, status: 'ordered', reservationId: res.id });
        renderOffer();
        renderUi();
        if (r.status === 200 && !order.promo_code) { /* повтор */ }
      } else if (r.status === 409 && r.body && r.body.error === 'reservation_expired') {
        await loadState();
      } else {
        els.status.className = 'ch-status err';
        els.status.textContent = 'Ошибка: ' + ((r.body && r.body.error) || r.status);
      }
    } catch (e) {
      els.status.className = 'ch-status err';
      els.status.textContent = 'Сеть недоступна: ' + e.message + '. Проверяем статус…';
      setTimeout(loadState, 1200);
    } finally {
      busy = false;
      els.orderBtn.disabled = false;
    }
  }

  async function pay(status) {
    if (busy) return;
    busy = true;
    els.paySuccess.disabled = true;
    els.payFail.disabled = true;
    els.status.textContent = status === 'paid' ? 'Оплачиваем…' : 'Эмулируем отказ оплаты…';
    try {
      if (!order || !order.order_id) {
        await confirmOrder();
      }
      if (!order || !order.order_id) return;
      const r = await api('/orders/' + order.order_id + '/pay', { method: 'POST', body: JSON.stringify({ status }) });
      if (r.status === 409) {
        els.status.className = 'ch-status err';
        els.status.textContent = 'Бронь истекла — товар вернулся в продажу.';
        clearInterval(timer);
        await loadState();
        return;
      }
      await pollOrder();
    } catch (e) {
      // обрыв связи в момент оплаты: не создаём второй платёж, а узнаём фактический статус
      els.status.className = 'ch-status';
      els.status.textContent = 'Связь прервалась. Проверяем статус заказа…';
      await pollOrder();
    } finally {
      busy = false;
      els.paySuccess.disabled = false;
      els.payFail.disabled = false;
    }
  }

  async function pollOrder() {
    if (!order) return;
    const oid = order.order_id;
    for (let i = 0; i < 60; i++) {
      const r = await api('/orders/' + oid);
      if (r.status === 200) {
        order = r.body;
        if (order.status === 'delivered') {
          clearInterval(timer);
          setSess({ status: 'done', orderStatus: 'delivered' });
          els.phase.innerHTML = '✅ Товар выдан!<div class="key-box">' + esc(order.code) + '</div>';
          els.status.textContent = '';
          els.orderBtn.hidden = true;
          els.paySuccess.hidden = true;
          els.payFail.hidden = true;
          els.cancelBtn.hidden = true;
          const link = document.createElement('a');
          link.className = 'link-btn';
          link.href = 'order.html?id=' + oid;
          link.target = '_blank';
          link.textContent = 'Страница заказа';
          els.status.appendChild(link);
          return;
        }
        if (['out_of_stock', 'delivery_failed'].indexOf(order.status) !== -1) {
          els.phase.textContent = 'Товар оплачен, выдаём. Если остаток закончился — восстановим автоматически.';
          els.status.innerHTML = '<a class="link-btn" href="order.html?id=' + oid + '" target="_blank">Страница заказа</a>';
          return;
        }
        if (['expired', 'payment_failed'].indexOf(order.status) !== -1) {
          clearInterval(timer);
          renderUi();
          return;
        }
        // paid/delivering/created — ждём
        if (i === 0) els.phase.textContent = 'Оплата получена, выдаём товар…';
      }
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  async function cancelFlow() {
    if (busy) return;
    busy = true;
    try {
      if (order && order.order_id) {
        await api('/orders/' + order.order_id + '/cancel', { method: 'POST', body: '{}' });
      } else if (res && res.id) {
        await api('/reservations/' + res.id + '/cancel', { method: 'POST', body: '{}' });
      }
      clearSess();
      els.phase.textContent = 'Бронь отменена. Товар снова доступен всем.';
      els.cancelBtn.hidden = true;
      els.againLink.hidden = false;
      clearInterval(timer);
    } finally {
      busy = false;
    }
  }

  function bindCheckoutPage() {
    els.orderBtn.addEventListener('click', confirmOrder);
    els.paySuccess.addEventListener('click', () => pay('paid'));
    els.payFail.addEventListener('click', () => pay('failed'));
    els.cancelBtn.addEventListener('click', cancelFlow);
    els.againLink.addEventListener('click', () => { location.href = 'index.html'; });
    window.addEventListener('beforeunload', () => { if (timer) clearInterval(timer); });
    loadState();
  }

  if (IS_CHECKOUT && els.wrap) bindCheckoutPage();

  /* ============ Баннер «есть незавершённый заказ» на витрине ============ */
  function indexResume() {
    const sess = getSess();
    if (!sess || (!sess.orderId && !sess.reservationId)) return;
    const bar = $('resumeBar');
    if (!bar) return;
    bar.hidden = false;
    bar.innerHTML = 'У вас есть активная покупка: <button type="button" class="link-btn" id="resumeBtn">продолжить оформление</button>';
    $('resumeBtn').addEventListener('click', () => { location.href = 'checkout.html'; });
  }

  if (!IS_CHECKOUT && document.readyState !== 'loading') indexResume();
  if (!IS_CHECKOUT && document.readyState === 'loading') document.addEventListener('DOMContentLoaded', indexResume);
})();
