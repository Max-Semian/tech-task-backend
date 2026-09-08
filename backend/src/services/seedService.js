import { withTransaction } from '../db.js';
import { PRODUCTS, PROMOCODES, splitPoolBetweenSuppliers } from '../catalog.js';
import { generateMarketplace } from '../catalogMarket.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Маркетплейс-каталог «тысячи офферов» (2-я часть ТЗ). Идемпотентно:
// существующие SKU не перезаписываются (не «воскрешаем» уже проданные остатки).
export async function seedMarketplaceTx(tx, count = config.marketplace.seedOffers) {
  if (!count || count <= 0) return 0;
  const { offers } = generateMarketplace({ count });

  // пакетная вставка продуктами по 300 строк (один round-trip на батч)
  const BATCH = 300;
  for (let i = 0; i < offers.length; i += BATCH) {
    const chunk = offers.slice(i, i + BATCH);
    const params = [];
    const rows = [];
    for (const o of chunk) {
      rows.push(`($${params.length + 1},$${params.length + 2},$${params.length + 3},$${params.length + 4},$${params.length + 5},$${params.length + 6},$${params.length + 7},$${params.length + 8})`);
      params.push(o.sku, o.name, o.type, o.price, o.currency, o.image, o.seller, o.product_group);
    }
    await tx.query(
      `INSERT INTO products (sku, name, type, price, currency, image, seller, product_group)
       VALUES ${rows.join(',')}
       ON CONFLICT (sku) DO NOTHING`,
      params,
    );
    const sParams = [];
    const sRows = [];
    for (const o of chunk) {
      sRows.push(`($${sParams.length + 1}, $${sParams.length + 2})`);
      sParams.push(o.sku, o.available);
    }
    await tx.query(
      `INSERT INTO stock_mirror (sku, available) VALUES ${sRows.join(',')}
       ON CONFLICT (sku) DO NOTHING`,
      sParams,
    );
  }
  logger.info({ offers: offers.length }, 'marketplace seeded');
  return offers.length;
}

async function seedPromocodesTx(tx) {
  for (const p of PROMOCODES) {
    await tx.query(
      `INSERT INTO promocodes (code, type, value, currency, max_uses)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (code) DO NOTHING`,
      [p.code, p.type, p.value, p.currency, p.max_uses],
    );
  }
}

async function marketplaceExists(tx) {
  const res = await tx.query(`SELECT COUNT(*)::int AS n FROM products WHERE sku LIKE 'MK-%'`);
  return res.rows[0].n;
}

// Каталог + зеркало остатков, если таблицы пусты.
// Используется при старте приложения (Docker: авто-сид) и scripts/seed.js (после TRUNCATE).
export async function seedIfEmpty(poolInstance) {
  const res = await poolInstance.query('SELECT COUNT(*)::int AS n FROM products');
  if (res.rows[0].n > 0) {
    // продукты уже есть (старая БД) — досеем промокоды и, при необходимости, маркетплейс-каталог
    let marketplace = 0;
    await withTransaction(poolInstance, async (tx) => {
      await seedPromocodesTx(tx);
      if (config.marketplace.seedOffers > 0) {
        const existing = await marketplaceExists(tx);
        if (existing < config.marketplace.seedOffers) {
          marketplace = await seedMarketplaceTx(tx, config.marketplace.seedOffers);
        }
      }
    });
    return { seeded: false, reason: 'products_exist', marketplace };
  }

  return withTransaction(poolInstance, async (tx) => {
    for (const p of PRODUCTS) {
      await tx.query(
        `INSERT INTO products (sku, name, type, price, currency, image)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (sku) DO NOTHING`,
        [p.sku, p.name, p.type, p.price, p.currency, p.image],
      );
    }
    // зеркало остатков = сумма пулов поставщиков A+B по каждому SKU
    const { a, b } = splitPoolBetweenSuppliers();
    const counts = new Map();
    for (const m of [a, b]) {
      for (const [sku, codes] of m) counts.set(sku, (counts.get(sku) || 0) + codes.length);
    }
    for (const [sku, n] of counts) {
      await tx.query(
        `INSERT INTO stock_mirror (sku, available) VALUES ($1,$2)
         ON CONFLICT (sku) DO NOTHING`,
        [sku, n],
      );
    }
    await seedPromocodesTx(tx);
    const marketplace = config.marketplace.seedOffers > 0
      ? await seedMarketplaceTx(tx, config.marketplace.seedOffers)
      : 0;
    logger.info({ products: PRODUCTS.length, marketplace }, 'catalog seeded');
    return { seeded: true, products: PRODUCTS.length, marketplace };
  });
}
