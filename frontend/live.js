/* Живая витрина (2-я часть ТЗ): SSE-клиент.
   - слушает /events, обновляет локальный стор ску -> {price, available, ...}
   - зовёт подписчиков при каждом событии
   - EventSource сам переподключается после обрыва; при каждом open
     вызываются open-подписчики, чтобы перечитать свежий снапшот с сервера. */
(function () {
  'use strict';

  const API = window.API_BASE || 'http://localhost:3000';
  const listeners = new Set();
  const openListeners = new Set();
  const offers = new Map(); // sku -> {price, available, held, seller...}

  function notify(payload) {
    if (!payload || payload.type !== 'offer') return;
    const prev = offers.get(payload.sku) || {};
    const next = Object.assign({}, prev, {
      sku: payload.sku,
      price: payload.price,
      available: payload.available,
      held: payload.held,
      ts: payload.ts,
    });
    offers.set(payload.sku, next);
    listeners.forEach((cb) => { try { cb(next, payload); } catch (e) { /* noop */ } });
  }

  function connect() {
    const es = new EventSource(API + '/events');
    es.onopen = () => openListeners.forEach((cb) => { try { cb(); } catch (e) { /* noop */ } });
    es.onmessage = (ev) => { try { notify(JSON.parse(ev.data)); } catch (e) { /* noop */ } };
    es.onerror = () => { /* EventSource переподключится сам; при open будет снапшот */ };
    Live._es = es;
  }

  const Live = {
    API,
    offers,
    isLive: false,
    /** подписка на изменения офферов; возвращает отписку */
    onOffer(cb) { listeners.add(cb); if (!Live._es) connect(); return () => listeners.delete(cb); },
    /** подписка на переподключение SSE (после обрыва/refresh) */
    onOpen(cb) { openListeners.add(cb); if (!Live._es) connect(); return () => openListeners.delete(cb); },
    get(sku) { return offers.get(sku); },
  };

  window.Live = Live;
})();
