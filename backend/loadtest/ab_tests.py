#!/usr/bin/env python3
"""A/B-тесты поставщиков A и B на Playwright (API request context).

Сценарии (A/B = пути поставщиков):
  1. A-путь   — supplier-b остановлен, заказ выдаёт поставщик A.
  2. B-путь   — supplier-a остановлен, fallback на B (ровно одна выдача).
  3. Нормальный флоу — оба в строю, выдача ровно один раз.
  4. Идемпотентность — повторный вебхук с тем же event_id ничего не меняет.
  5. Out-of-order — вебхук пришёл раньше заказа, линковка при создании.

Запуск: python3 ab_tests.py   (стек должен быть поднят: docker compose up -d)
"""
import json
import sys
import time
import uuid

from playwright.sync_api import sync_playwright

from config import (
    BASE_URL, reset_db, set_supplier_rates, stop_supplier, start_supplier,
    db_scalar, db_query,
)

PASS = []


def report(name, ok, detail=""):
    PASS.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'} | {name}" + (f" | {detail}" if detail else ""))


def wait_status(ctx, order_id, wanted, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = ctx.get(f"/orders/{order_id}")
        if r.ok and r.json().get("status") == wanted:
            return r.json()
        time.sleep(0.3)
    return None


def create_order(ctx, sku, order_id=None):
    body = {"sku": sku}
    if order_id:
        body["order_id"] = order_id
    r = ctx.post("/orders", data=json.dumps(body),
                 headers={"content-type": "application/json"})
    if not r.ok:
        raise RuntimeError(f"order create failed: {r.status} {r.text()}")
    return r.json()


def pay(ctx, order_id, amount, event_id=None, status="paid"):
    ev = event_id or f"evt_{uuid.uuid4().hex}"
    r = ctx.post("/webhook/payment", data=json.dumps({
        "event_id": ev, "order_id": order_id, "status": status,
        "amount": amount, "currency": "RUB", "created_at": "2025-01-01T12:00:00Z",
    }), headers={"content-type": "application/json"})
    if not r.ok:
        raise RuntimeError(f"webhook failed: {r.status} {r.text()}")
    return r.json(), ev


def ok_provider(order_id):
    rows = db_query(
        f"SELECT da.provider FROM delivery_attempts da "
        f"JOIN orders o ON o.id = da.order_id "
        f"WHERE o.order_id = '{order_id}' AND da.status = 'ok'")
    return rows[0] if rows else None


def ok_count(order_id):
    return int(db_scalar(
        f"SELECT COUNT(*)::int FROM delivery_attempts da "
        f"JOIN orders o ON o.id = da.order_id "
        f"WHERE o.order_id = '{order_id}' AND da.status = 'ok'"))


def main():
    print("== A/B-тесты поставщиков (Playwright) ==")
    with sync_playwright() as p:
        req = p.request.new_context(base_url=BASE_URL, timeout=60000)

        print("[setup] сброс БД; поставщики без отказов")
        reset_db()
        set_supplier_rates(0.0, 0.0)

        # --- 1) A-путь: B остановлен ---
        print("[1] A-путь: supplier-b остановлен")
        stop_supplier("supplier-b")
        order = create_order(req, "STEAM-TOPUP-500")
        pay(req, order["order_id"], order["amount"])
        got = wait_status(req, order["order_id"], "delivered", timeout=40)
        report("A-путь: заказ доставлен при остановленном B", got is not None,
               f"status={got.get('status') if got else None}")
        report("A-путь: выдал поставщик A", ok_provider(order["order_id"]) == "A",
               f"provider={ok_provider(order['order_id'])}")
        report("A-путь: ровно одна успешная выдача", ok_count(order["order_id"]) == 1)
        start_supplier("supplier-b")

        # --- 2) B-путь: A остановлен (fallback) ---
        print("[2] B-путь (fallback): supplier-a остановлен")
        stop_supplier("supplier-a")
        order = create_order(req, "KEY-GTA5")
        pay(req, order["order_id"], order["amount"])
        got = wait_status(req, order["order_id"], "delivered", timeout=90)
        report("B-путь (fallback): заказ доставлен при остановленном A", got is not None,
               f"status={got.get('status') if got else None}")
        report("B-путь (fallback): выдал поставщик B", ok_provider(order["order_id"]) == "B",
               f"provider={ok_provider(order['order_id'])}")
        report("B-путь (fallback): ровно одна успешная выдача", ok_count(order["order_id"]) == 1)
        start_supplier("supplier-a")

        # --- 3) Нормальный флоу ---
        print("[3] нормальный флоу: оба поставщика в строю")
        order = create_order(req, "STEAM-TOPUP-1000")
        pay(req, order["order_id"], order["amount"])
        got = wait_status(req, order["order_id"], "delivered", timeout=40)
        report("нормальный флоу: delivered", got is not None)
        report("нормальный флоу: код выдан", bool(got and got.get("code")))
        report("нормальный флоу: одна успешная выдача", ok_count(order["order_id"]) == 1)

        # --- 4) Идемпотентность event_id ---
        print("[4] идемпотентность: повторный вебхук с тем же event_id")
        order = create_order(req, "SUB-DISCORD-1M")
        _, ev = pay(req, order["order_id"], order["amount"])
        resp2, _ = pay(req, order["order_id"], order["amount"], event_id=ev)
        got = wait_status(req, order["order_id"], "delivered", timeout=40)
        report("идемпотентность: повтор = duplicate:true", resp2.get("duplicate") is True,
               f"resp={resp2}")
        report("идемпотентность: одна успешная выдача", ok_count(order["order_id"]) == 1)

        # --- 5) Out-of-order: вебхук раньше заказа ---
        print("[5] out-of-order: вебхук до создания заказа")
        oid = f"ord_early_{uuid.uuid4().hex[:8]}"
        resp, _ = pay(req, oid, 500)
        report("out-of-order: вебхук принят (accepted)", resp.get("accepted") is True, f"resp={resp}")
        r = req.post("/orders", data=json.dumps({"sku": "STEAM-TOPUP-500", "order_id": oid}),
                     headers={"content-type": "application/json"})
        body = r.json() if r.ok else {}
        report("out-of-order: заказ создан и сразу оплачен", r.ok and body.get("status") == "paid",
               f"status={body.get('status') if r.ok else None}")
        got = wait_status(req, oid, "delivered", timeout=40)
        report("out-of-order: в итоге delivered", got is not None)

        req.dispose()

    total = len(PASS)
    ok = sum(PASS)
    print(f"\n=== ИТОГ: {'ВСЕ ПРОШЛИ' if ok == total else f'ПАДЕНИЯ {total - ok}'} ({ok}/{total}) ===")
    sys.exit(0 if ok == total else 1)


if __name__ == "__main__":
    main()

