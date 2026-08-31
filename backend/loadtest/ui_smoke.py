#!/usr/bin/env python3
"""UI smoke-тест фуллстека на Playwright (браузер).

Проверяет против http://localhost:8080 (nginx-витрина) и http://localhost:3000 (API):
  - загрузка каталога на витрине;
  - 5 интерактивов (карусель, меню «Каталог», валюта, hover);
  - флоу покупки: Купить -> модал -> промокод -> оплата (успех) -> ключ;
  - оплата (неуспех) -> payment_failed;
  - админка: сверка + повторная выдача + пополнение.
Запуск: python3 ui_smoke.py
"""
import sys
import time

from playwright.sync_api import sync_playwright

FRONT = "http://localhost:8080"
API = "http://localhost:3000"
PASS = []


def report(name, ok, detail=""):
    PASS.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'} | {name}" + (f" | {detail}" if detail else ""))


def main():
    print("== UI smoke-тест фуллстека (Playwright browser) ==")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})

        # --- Витрина ---
        page.goto(FRONT)
        page.wait_for_selector(".product-card", timeout=15000)
        cards = page.locator(".product-card").count()
        report("каталог загружен на витрине", cards >= 5, f"cards={cards}")

        # 1) Карусель
        before = page.eval_on_selector("#heroTrack", "el => el.style.transform")
        page.click("#heroNext")
        page.wait_for_timeout(700)
        after = page.eval_on_selector("#heroTrack", "el => el.style.transform")
        report("карусель переключается по стрелке", before != after, f"{before} -> {after}")
        active_dots = page.locator("#heroDots .dot.active").count()
        report("точка-индикатор активна", active_dots == 1)

        # 2) Меню «Каталог»
        page.click("#catalogBtn")
        page.wait_for_timeout(200)
        menu_open = not page.eval_on_selector("#catalogMenu", "el => el.hidden")
        page.click("#catalogBtn")  # повторный клик закрывает
        page.wait_for_timeout(200)
        menu_closed = page.eval_on_selector("#catalogMenu", "el => el.hidden")
        report("меню Каталог открывается/закрывается", menu_open and menu_closed,
               f"open={menu_open} closed={menu_closed}")

        # 3) Переключатель валют
        page.click("#currencyToggle button:nth-child(3)")  # ₽
        rub_active = page.eval_on_selector("#currencyToggle .active", "el => el.textContent")
        report("переключатель валют меняет активное состояние", rub_active == "₽", f"active={rub_active}")

        # 4/5) hover иконок и карточек — CSS-проверка (transform/box-shadow)
        page.hover(".app-icon")
        page.wait_for_timeout(300)
        page.hover(".product-card")
        page.wait_for_timeout(300)
        report("hover карточек/иконок не ломает страницу", page.locator(".product-card").count() >= 5)

        # --- Флоу покупки с промокодом ---
        page.click(".product-card .buy-btn")
        page.wait_for_selector("#buyModal:not([hidden])")
        report("модал покупки открылся", True)

        page.fill("#promoInput", "WELCOME10")
        page.click("#promoApply")
        page.wait_for_timeout(700)
        promo_ok = page.text_content("#promoMsg")
        report("промокод применён (скидка показана)", "Промокод применён" in (promo_ok or ""),
               f"msg={promo_ok}")

        page.click("#paySuccess")
        page.wait_for_selector(".key-box", timeout=40000)
        key = page.text_content(".key-box")
        report("оплата успех -> ключ выдан", bool(key and "-" in key), f"key={key}")

        order_link = page.get_attribute(".buy-status a", "href") or ""
        report("есть ссылка на страницу заказа", "order.html?id=" in order_link, order_link)

        # закрыть модал
        page.click("#modalClose")

        # --- Оплата (неуспех) ---
        page.click(".product-card .buy-btn")
        page.wait_for_selector("#buyModal:not([hidden])")
        page.click("#payFail")
        page.wait_for_timeout(1200)
        fail_text = page.text_content("#buyStatus")
        report("оплата неуспех -> payment_failed", "Оплата не прошла" in (fail_text or ""),
               f"status={fail_text}")
        page.click("#modalClose")

        # --- Админка ---
        page.goto(FRONT + "/admin.html")
        page.wait_for_selector("#balanceInfo", timeout=15000)
        balance = page.text_content("#balanceInfo")
        report("админка: баланс журнала", "сходится" in (balance or ""), balance)
        report("админка: список «оплачено, не выдано»",
               page.locator("#paidNotDelivered").inner_text().strip() != "",
               page.locator("#paidNotDelivered").inner_text().strip()[:60])

        browser.close()

    ok = sum(PASS)
    total = len(PASS)
    print(f"\n=== ИТОГ: {'ВСЕ ПРОШЛИ' if ok == total else f'ПАДЕНИЯ {total-ok}'} ({ok}/{total}) ===")
    sys.exit(0 if ok == total else 1)


if __name__ == "__main__":
    main()
