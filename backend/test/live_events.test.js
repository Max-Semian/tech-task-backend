// 2-я часть ТЗ, Задача 1: живая витрина. SSE-события об изменении цены/остатка
// доходят до клиента (без перезагрузки), heartbeat поддерживает соединение.
import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  setupDb, dropTestDb, seedProducts, startApi,
  postJson, closeServer,
} from './helpers.js';
import { pool } from '../src/db.js';

let base;
let server;

// Примитивный SSE-клиент: открывает поток и ждёт событие по предикату
function sseWait(url, predicate, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error('sse timeout'));
      }, timeout);
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue; // heartbeat-комментарии пропускаем
          const payload = JSON.parse(dataLine.slice(6));
          if (predicate(payload)) {
            clearTimeout(timer);
            req.destroy();
            resolve(payload);
          }
        }
      });
      res.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    req.on('error', reject);
  });
}

before(async () => {
  await setupDb();
  await seedProducts(pool);
  await pool.query(
    `INSERT INTO stock_mirror (sku, available) VALUES ('STEAM-TOPUP-500', 3)
     ON CONFLICT (sku) DO UPDATE SET available=3, held=0`,
  );
  server = await startApi();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  closeServer(server);
  await pool.end();
  await dropTestDb();
});

test('Бронь единицы видна всем подписчикам без перезагрузки', async () => {
  const ev = sseWait(`${base}/events`, (p) => p.type === 'offer' && p.sku === 'STEAM-TOPUP-500' && p.available === 2);
  const r = await postJson(base, '/reservations', {
    sku: 'STEAM-TOPUP-500',
    purchase_key: `live_res_${Date.now()}`,
  });
  assert.equal(r.status, 201);
  const payload = await ev;
  assert.equal(payload.sku, 'STEAM-TOPUP-500');
  assert.equal(payload.available, 2);
  assert.equal(payload.held, 1);
});

test('Смена цены через админку уходит в SSE', async () => {
  const ev = sseWait(`${base}/events`, (p) => p.type === 'offer' && p.sku === 'STEAM-TOPUP-500' && p.price === 1234);
  const r = await postJson(base, '/admin/products/STEAM-TOPUP-500/price', { price: 1234 });
  assert.equal(r.status, 200);
  const payload = await ev;
  assert.equal(payload.price, 1234);
});

test('Restock тоже публикует событие с новым остатком', async () => {
  const ev = sseWait(`${base}/events`, (p) => p.type === 'offer' && p.sku === 'STEAM-TOPUP-500' && p.available === 3);
  // выставим базовое состояние вручную, чтобы restock был единственным изменением
  await pool.query(`UPDATE stock_mirror SET available=2, held=0 WHERE sku='STEAM-TOPUP-500'`);
  await postJson(base, '/admin/stock/STEAM-TOPUP-500/restock', { count: 1 });
  const payload = await ev;
  assert.equal(payload.available, 3);
});
