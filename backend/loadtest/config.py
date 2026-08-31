import os
import subprocess
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))     # backend/loadtest
BACKEND_DIR = os.path.dirname(BASE_DIR)                    # backend/
BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000")
DB_URL = os.environ.get("DB_URL", "postgres://app:app@localhost:5432/shop")


def db_scalar(sql, db_url=DB_URL):
    """Один скаляр из БД через psql (хост-клиент)."""
    out = subprocess.run(["psql", db_url, "-t", "-A", "-c", sql],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"psql error: {out.stderr}")
    return out.stdout.strip()


def db_query(sql, db_url=DB_URL):
    val = db_scalar(sql, db_url)
    return val.splitlines() if val else []


def docker_compose(args, env=None):
    full_env = dict(os.environ)
    full_env.update(env or {})
    return subprocess.run(["docker", "compose", *args], cwd=BACKEND_DIR,
                          env=full_env, capture_output=True, text=True)


def reset_db():
    r = docker_compose(["exec", "-T", "app", "node", "scripts/seed.js"])
    if r.returncode != 0:
        raise RuntimeError(f"seed failed: {r.stderr}")


def set_supplier_rates(error=0.0, timeout=0.0):
    """Пересоздать поставщиков с заданными долями отказов (env переопределяет compose)."""
    env = {
        "SUPPLIER_A_ERROR_RATE": str(error),
        "SUPPLIER_A_TIMEOUT_RATE": str(timeout),
        "SUPPLIER_B_ERROR_RATE": str(error),
        "SUPPLIER_B_TIMEOUT_RATE": str(timeout),
    }
    r = docker_compose(["up", "-d", "supplier-a", "supplier-b"], env=env)
    if r.returncode != 0:
        raise RuntimeError(f"compose up failed: {r.stderr}")
    time.sleep(3)


def stop_supplier(name):
    r = docker_compose(["stop", name])
    if r.returncode != 0:
        raise RuntimeError(f"compose stop {name} failed: {r.stderr}")
    time.sleep(1)


def start_supplier(name):
    r = docker_compose(["start", name])
    if r.returncode != 0:
        raise RuntimeError(f"compose start {name} failed: {r.stderr}")
    time.sleep(3)
