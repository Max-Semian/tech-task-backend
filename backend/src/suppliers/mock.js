// Заглушка поставщика выдачи (Этап 3). Контракт: POST /issue
//   -> 200 {status:'ok', request_id, code}
//   -> 4xx/5xx {status:'error', reason:'out_of_stock'|'internal_error'}
//
// Ключевые свойства:
//   1. Дедуп по request_id: повтор возвращает ТОТ ЖЕ результат (код), а не новый.
//   2. Дедуп по order_id: заказу не выдаётся второй код.
//   3. Таймаут: внутренне выдать код, но ответить позже клиентского таймаута
//      (симуляция «выдал, но ответ потерялся»). Повтор с тем же request_id вернёт код.
//   4. errorRate / timeoutRate настраиваются (0..1).

import http from 'node:http';
import { logger } from '../logger.js';
import { splitPoolBetweenSuppliers } from '../catalog.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createStore() {
  return {
    pool: new Map(),        // sku -> string[] (свободные коды)
    byRequest: new Map(),   // request_id -> { statusCode, body }
    byOrder: new Map(),     // order_id -> code
    force: null,            // детерминированное поведение для тестов: { mode, requestId? }
  };
}

export function createHandler({ store, errorRate = 0, timeoutRate = 0, timeoutMs = 1500, extraHangMs = 5000 }) {
  return async function handleIssue(body) {
    const { request_id, sku, order_id } = body || {};
    if (!request_id || !order_id) {
      return { statusCode: 400, body: { status: 'error', reason: 'bad_request' } };
    }

    // 1) дедуп по request_id — ловушка таймаута
    if (store.byRequest.has(request_id)) {
      const prev = store.byRequest.get(request_id);
      return { statusCode: prev.statusCode, body: prev.body };
    }

    // 2) дедуп по order_id — один код на заказ
    if (store.byOrder.has(order_id)) {
      const code = store.byOrder.get(order_id);
      const result = { statusCode: 200, body: { status: 'ok', request_id, code } };
      store.byRequest.set(request_id, result);
      return result;
    }

    // 3) принудительное поведение для детерминированных тестов
    const force = store.force;
    if (force?.mode === 'timeout' && (!force.requestId || force.requestId === request_id)) {
      store.force = null;
      const out = takeFromPool(store, sku);
      if (!out) {
        const res = { statusCode: 422, body: { status: 'error', reason: 'out_of_stock' } };
        store.byRequest.set(request_id, res);
        return res;
      }
      store.byOrder.set(order_id, out);
      const result = { statusCode: 200, body: { status: 'ok', request_id, code: out } };
      store.byRequest.set(request_id, result);   // повтор вернёт код
      await sleep(timeoutMs + extraHangMs);       // не успеем ответить в срок
      return result;
    }
    if (force?.mode === 'error' && (!force.requestId || force.requestId === request_id)) {
      store.force = null;
      const result = { statusCode: 500, body: { status: 'error', reason: 'internal_error' } };
      store.byRequest.set(request_id, result);
      return result;
    }
    if (force?.mode === 'out_of_stock' && (!force.requestId || force.requestId === request_id)) {
      store.force = null;
      const result = { statusCode: 422, body: { status: 'error', reason: 'out_of_stock' } };
      store.byRequest.set(request_id, result);
      return result;
    }

    // 4) случайный таймаут
    if (timeoutRate > 0 && Math.random() < timeoutRate) {
      const out = takeFromPool(store, sku);
      if (!out) {
        const res = { statusCode: 422, body: { status: 'error', reason: 'out_of_stock' } };
        store.byRequest.set(request_id, res);
        return res;
      }
      store.byOrder.set(order_id, out);
      const result = { statusCode: 200, body: { status: 'ok', request_id, code: out } };
      store.byRequest.set(request_id, result);
      await sleep(timeoutMs + extraHangMs);
      return result;
    }

    // 5) случайная ошибка 5xx
    if (errorRate > 0 && Math.random() < errorRate) {
      const result = { statusCode: 500, body: { status: 'error', reason: 'internal_error' } };
      store.byRequest.set(request_id, result);
      return result;
    }

    // 6) обычная выдача
    const code = takeFromPool(store, sku);
    if (!code) {
      const res = { statusCode: 422, body: { status: 'error', reason: 'out_of_stock' } };
      store.byRequest.set(request_id, res);
      return res;
    }
    store.byOrder.set(order_id, code);
    const result = { statusCode: 200, body: { status: 'ok', request_id, code } };
    store.byRequest.set(request_id, result);
    return result;
  };
}

function takeFromPool(store, sku) {
  const list = store.pool.get(sku);
  if (!list || list.length === 0) return null;
  return list.shift();
}

export function seedStorePool(store, poolMap) {
  for (const [sku, codes] of poolMap) {
    store.pool.set(sku, [...(codes || [])]);
  }
}

// Заполнить пул поставщика по имени (A|B) из общего пула ключей
export function seedByName(store, name) {
  const { a, b } = splitPoolBetweenSuppliers();
  seedStorePool(store, name === 'A' ? a : b);
  return name === 'A' ? a : b;
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function createSupplierServer({ port = 0, name = 'mock', store: providedStore, ...opts }) {
  const store = providedStore || createStore();
  const handler = createHandler({ store, ...opts });
  const server = http.createServer(async (req, res) => {
    res.on('error', () => {});
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/issue') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      try {
        const body = JSON.parse(raw || '{}');
        const result = await handler(body);
        writeJson(res, result.statusCode, result.body);
        logger.info({ provider: name, request_id: body?.request_id, status: result.statusCode }, 'supplier issue');
      } catch (e) {
        writeJson(res, 500, { status: 'error', reason: 'internal_error' });
      }
    } else if (req.method === 'POST' && url.pathname === '/restock') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      try {
        const { sku, codes } = JSON.parse(raw || '{}');
        if (!store.pool.has(sku)) store.pool.set(sku, []);
        store.pool.get(sku).push(...(codes || []));
        writeJson(res, 200, { status: 'ok', available: store.pool.get(sku).length });
      } catch {
        writeJson(res, 500, { status: 'error', reason: 'bad_request' });
      }
    } else if (req.method === 'GET' && url.pathname === '/stock') {
      const sku = url.searchParams.get('sku');
      if (sku) {
        writeJson(res, 200, { status: 'ok', sku, available: store.pool.get(sku)?.length ?? 0 });
      } else {
        writeJson(res, 200, {
          status: 'ok',
          available: Object.fromEntries([...store.pool.entries()].map(([k, v]) => [k, v.length])),
        });
      }
    } else if (req.method === 'POST' && url.pathname === '/reset') {
      store.pool.clear();
      store.byRequest.clear();
      store.byOrder.clear();
      writeJson(res, 200, { status: 'ok' });
    } else {
      writeJson(res, 404, { status: 'error', reason: 'not_found' });
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  return { server, store, port: actualPort, close: () => new Promise((r) => server.close(r)) };
}

