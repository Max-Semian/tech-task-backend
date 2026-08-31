#!/usr/bin/env python3
"""Нагрузочный тест: N одновременных созданий заказов + N вебхуков оплаты (Playwright async).

Проверяет под нагрузкой:
  - все N заказов созданы и доставлены ровно один раз;
  - нет дублей кодов (каждый ключ выдан одному заказу);
  - журнал денежных движений сходится;
  - бонус: 50 параллельных вебхуков по одному заказу -> ровно одна выдача.

Запуск: python3 loadtest.py [N]   (стек должен быть поднят: docker compose up -d)
"""
import asyncio
import collections
import json
import sys
import time

from playwright.async_api import async_playwright

from config import BASE_URL, reset_db, set_supplier_rates, db_scalar

N = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
SKU = "STEAM-TOPUP-500"
CONTEXTS = 64
RESTOCK = int(N * 1.1)  # с запасом: ключи нужны всем N заказам


def int_scalar(sql):
    return int(db_scalar(sql))


async def create_phase(ctxs, n):
    async def create(i):
        ctx = ctxs[i % CONTEXTS]
        t0 = time.perf_counter()
        resp = await ctx.post("/orders", data=json.dumps({"sku": SKU}),
                              headers={"content-type": "application/json"})
        dt = time.perf_counter() - t0
        body = await resp.json() if resp.ok else {}
        return i, resp.status, body, dt

    t0 = time.perf_counter()
    results = await asyncio.gather(*[create(i) for i in range(n)])
    elapsed = time.perf_counter() - t0
    statuses = collections.Counter(st for _, st, _, _ in results)
    order_ids = [b["order_id"] for _, st, b, _ in results if st == 201]
    lat = sorted(dt for _, _, _, dt in results)
    print(f"  создано: {len(order_ids)}/{n} (статусы {dict(statuses)}) "
          f"за {elapsed:.1f}s => {n / elapsed:.0f} req/s")
    if lat:
        print(f"  latency create: p50={lat[len(lat) // 2] * 1000:.0f}ms "
              f"p95={lat[int(len(lat) * 0.95)] * 1000:.0f}ms max={lat[-1] * 1000:.0f}ms")
    return order_ids


async def pay_phase(ctxs, order_ids):
    async def pay(i):
        ctx = ctxs[i % CONTEXTS]
        ev = {"event_id": f"evt_load_{i}", "order_id": order_ids[i],
              "status": "paid", "amount": 500, "currency": "RUB",
              "created_at": "2025-01-01T12:00:00Z"}
        t0 = time.perf_counter()
        resp = await ctx.post("/webhook/payment", data=json.dumps(ev),
                              headers={"content-type": "application/json"})
        return resp.status, time.perf_counter() - t0

    t0 = time.perf_counter()
    results = await asyncio.gather(*[pay(i) for i in range(len(order_ids))])
    elapsed = time.perf_counter() - t0
    p_ok = sum(1 for s, _ in results if s == 200)
    lat = sorted(dt for _, dt in results)
    print(f"  вебхуков 200: {p_ok}/{len(order_ids)} за {elapsed:.1f}s "
          f"=> {len(order_ids) / elapsed:.0f} req/s")
    if lat:
        print(f"  latency webhook: p50={lat[len(lat) // 2] * 1000:.0f}ms "
              f"p95={lat[int(len(lat) * 0.95)] * 1000:.0f}ms max={lat[-1] * 1000:.0f}ms")
    return p_ok


async def main():
    print(f"== Нагрузочный тест: {N} заказов + {N} оплат (Playwright async) ==")
    print("[setup] сброс БД; поставщики без отказов; пополнение пула ключей")
    reset_db()
    set_supplier_rates(0.0, 0.0)

    async with async_playwright() as p:
        ctxs = [await p.request.new_context(base_url=BASE_URL, timeout=120000)
                for _ in range(CONTEXTS)]

        r = await ctxs[0].post(f"/admin/stock/{SKU}/restock",
                               data=json.dumps({"count": RESTOCK}),
                               headers={"content-type": "application/json"})
        if not r.ok:
            raise RuntimeError(f"restock failed: {r.status} {r.text()}")
        print(f"  пул пополнен: {RESTOCK} ключей")

        print(f"[фаза 1] создание {N} заказов параллельно")
        order_ids = await create_phase(ctxs, N)

        print(f"[фаза 2] оплата {N} заказов параллельно")
        await pay_phase(ctxs, order_ids)

        print("[фаза 3] ожидание доставки всех заказов (воркер)")
        t0 = time.perf_counter()
        delivered = 0
        while delivered < N:
            await asyncio.sleep(1)
            delivered = int_scalar("SELECT COUNT(*)::int FROM orders WHERE status='delivered'")
            if time.perf_counter() - t0 > 600:
                break
        wait_elapsed = time.perf_counter() - t0
        print(f"  доставлено {delivered}/{N} за {wait_elapsed:.1f}s "
              f"({delivered / wait_elapsed:.0f} order/s через воркер)")

        for ctx in ctxs:
            await ctx.dispose()

    # --- Проверки корректности (только N заказов нагрузки) ---
    print("[проверки корректности]")
    checks = {
        "все заказы созданы": int_scalar("SELECT COUNT(*)::int FROM orders") == N,
        "все заказы доставлены":
            int_scalar("SELECT COUNT(*)::int FROM orders WHERE status='delivered'") == N,
        "ровно N успешных выдач (по одной на заказ)":
            int_scalar("SELECT COUNT(*)::int FROM delivery_attempts WHERE status='ok'") == N,
        "ровно N платежей в журнале":
            int_scalar("SELECT COUNT(*)::int FROM money_ledger WHERE entry_type='payment'") == N,
        "нет дублей кодов (N уникальных)":
            int_scalar("SELECT COUNT(DISTINCT code)::int FROM orders "
                       "WHERE status='delivered'") == N,
        "нет зависших/ошибочных заказов":
            int_scalar("SELECT COUNT(*)::int FROM orders "
                       "WHERE status NOT IN ('delivered','payment_failed')") == 0,
        "журнал сходится (balance)":
            int_scalar("SELECT COALESCE(SUM(amount),0)::int FROM money_ledger")
            == int_scalar("SELECT COALESCE(SUM(amount),0)::int FROM orders "
                          "WHERE EXISTS (SELECT 1 FROM payment_events pe "
                          "WHERE pe.order_id = orders.order_id AND pe.status='paid')"),
    }
    all_ok = True
    for name, ok in checks.items():
        print(f"  {'OK' if ok else 'FAIL'} | {name}")
        all_ok = all_ok and ok

    # --- Бонус: гонка 50 вебхуков по одному заказу ---
    print("[бонус] 50 параллельных вебхуков по одному заказу")
    async with async_playwright() as p:
        ctxs = [await p.request.new_context(base_url=BASE_URL, timeout=60000)
                for _ in range(8)]

        r = await ctxs[0].post("/orders", data=json.dumps({"sku": "KEY-CS2-PRIME"}),
                               headers={"content-type": "application/json"})
        race_order = await r.json()

        async def race_pay(i):
            ctx = ctxs[i % 8]
            return await ctx.post("/webhook/payment", data=json.dumps({
                "event_id": f"evt_race_{i}", "order_id": race_order["order_id"],
                "status": "paid", "amount": race_order["amount"], "currency": "RUB",
                "created_at": "2025-01-01T12:00:00Z"}),
                headers={"content-type": "application/json"})

        race_resp = await asyncio.gather(*[race_pay(i) for i in range(50)])
        race_ok_statuses = sum(1 for r2 in race_resp if r2.status == 200)
        race_deadline = time.time() + 60
        while int_scalar(
            f"SELECT COUNT(*)::int FROM orders WHERE order_id='{race_order['order_id']}' "
            f"AND status='delivered'") == 0:
            if time.time() > race_deadline:
                break
            await asyncio.sleep(0.5)
        race_ok = int_scalar(
            f"SELECT COUNT(*)::int FROM delivery_attempts da "
            f"JOIN orders o ON o.id = da.order_id "
            f"WHERE o.order_id = '{race_order['order_id']}' AND da.status = 'ok'")

        for ctx in ctxs:
            await ctx.dispose()

    race_checks = {
        f"гонка 50 вебхуков: все 200 ({race_ok_statuses}/50)": race_ok_statuses == 50,
        "гонка 50 вебхуков: ровно одна выдача": race_ok == 1,
    }
    for name, ok in race_checks.items():
        print(f"  {'OK' if ok else 'FAIL'} | {name}")
        all_ok = all_ok and ok

    print(f"\n=== ИТОГ: {'УСПЕХ' if all_ok else 'ПРОВАЛ'} ===")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    asyncio.run(main())

