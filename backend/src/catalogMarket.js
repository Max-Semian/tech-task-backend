// Синтетический каталог маркетплейса (2-я часть ТЗ): тысячи офферов с продавцами.
// Детерминированный (seed) — API и заглушки поставщиков A/B генерируют одинаковые
// пулы ключей, поэтому остатки на витрине и пулы поставщиков не разъезжаются.
//
// Структура оффера:
//   { sku, name, type, price, currency, image, seller, product_group }
// product_group = «тот же товар» для предложения альтернативного продавца.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SELLERS = [
  'GameMarket', 'KeysPro', 'DigitalWorld', 'GameDeal', 'TopSeller',
  'GamingPoint', 'VaultKeys', 'DealsHub', 'NeoGaming', 'FastDelivery',
];

const TOPUP_PLATFORMS = ['Steam', 'PlayStation Store', 'Xbox', 'Nintendo eShop', 'Roblox', 'Fortnite', 'EA App', 'Battle.net', 'Genshin Impact', 'Mobile Legends', 'PUBG Mobile', 'Free Fire', 'Valorant', 'TikTok', 'Telegram', 'App Store'];
const TOPUP_AMOUNTS = [100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6500, 7500, 9000, 10000];

const GIFT_PLATFORMS = ['PlayStation Store', 'Xbox', 'Steam', 'Nintendo eShop', 'Roblox', 'Valorant', 'Fortnite', 'Riot Games', 'EA App', 'Battle.net', 'Spotify', 'App Store', 'Google Play', 'Netflix'];
const GIFT_AMOUNTS = [250, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000];

const SUB_SERVICES = ['Discord Nitro', 'YouTube Premium', 'Spotify Premium', 'Netflix', 'Xbox Game Pass', 'PlayStation Plus', 'EA Play', 'Apple Music'];
const SUB_DURATIONS = ['1 месяц', '3 месяца', '6 месяцев', '12 месяцев'];

const GAMES = [
  'CS2 Prime Status', 'GTA V', 'Minecraft Java Edition', "Baldur's Gate 3", 'Cyberpunk 2077',
  'Elden Ring', 'Red Dead Redemption 2', 'Hogwarts Legacy', 'EA SPORTS FC 25', 'Call of Duty: Modern Warfare III',
  'Dota 2', 'Rust', 'ARK: Survival Ascended', 'Sea of Thieves', 'Forza Horizon 5',
  'God of War Ragnarök', 'Marvel Spider-Man 2', 'The Last of Us Part I', 'Horizon Forbidden West', 'Starfield',
  'Diablo IV', 'Lies of P', 'Alan Wake 2', 'Warhammer 40,000: Space Marine 2', 'Helldivers 2',
  'Palworld', 'Black Myth: Wukong', "Dragon's Dogma 2", 'Tekken 8', 'Prince of Persia: The Lost Crown',
  'Persona 3 Reload', 'Ghost of Tsushima', 'Uncharted: Legacy of Thieves', 'Death Stranding', 'Days Gone',
  'God of War', 'Horizon Zero Dawn', 'Ratchet and Clank: Rift Apart', 'Returnal', 'Stray',
  'Hades II', 'Dead Cells', 'Cuphead', 'Hollow Knight', 'Stardew Valley',
  'Sekiro: Shadows Die Twice', 'Dark Souls III', 'Resident Evil 4', 'Dead Space', 'Silent Hill 2',
  'Atomic Heart', 'The Witcher 3', 'Kingdom Come Deliverance II', 'Assassin Creed Mirage', 'Far Cry 6',
  'Rainbow Six Siege', 'Tom Clancy The Division 2', 'Avatar: Frontiers of Pandora', 'Star Wars Jedi: Survivor', 'It Takes Two',
  'Overcooked 2', 'Terraria', 'Don Starve Together', 'Project Zomboid', 'Escape from Tarkov',
  'Rain World', 'Baldur Gate 1', 'Disco Elysium', 'Path of Exile 2', 'Grim Dawn',
  'Borderlands 3', 'Tiny Tina Wonderlands', 'Age of Empires IV', 'Company of Heroes 3', 'Total War: Warhammer III',
];
const EDITIONS = ['Standard', 'Deluxe', 'Ultimate'];
const REGIONS = ['RU', 'СНГ'];

const TYPE_LABEL = {
  topup: 'Пополнение',
  key: 'Ключ',
  giftcard: 'Gift Card',
  subscription: 'Подписка',
};

// Базовые товары (первый продавец). Возвращает массив офферов + карту group -> count
function buildBaseProducts(rnd) {
  const offers = [];
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  for (const platform of TOPUP_PLATFORMS) {
    for (const amount of TOPUP_AMOUNTS) {
      offers.push({
        name: `Пополнение ${platform} ${amount} ₽`, type: 'topup',
        price: amount, group: `topup:${platform}`, sellerIndex: 0,
      });
    }
  }
  for (const platform of GIFT_PLATFORMS) {
    for (const amount of GIFT_AMOUNTS) {
      offers.push({
        name: `${TYPE_LABEL.giftcard} ${platform} ${amount} ₽`, type: 'giftcard',
        price: amount, group: `giftcard:${platform}`, sellerIndex: 0,
      });
    }
  }
  for (const service of SUB_SERVICES) {
    for (const d of SUB_DURATIONS) {
      const base = 99 + Math.floor(rnd() * 900);
      offers.push({
        name: `${service} — ${d}`, type: 'subscription',
        price: base, group: `subscription:${service}`, sellerIndex: 0,
      });
    }
  }
  for (const game of GAMES) {
    const base = 390 + Math.floor(rnd() * 5400);
    for (const edition of EDITIONS) {
      for (const region of REGIONS) {
        const delta = EDITIONS.indexOf(edition) * Math.round(base * 0.15);
        offers.push({
          name: `${game} — ключ (${edition}, ${region})`, type: 'key',
          price: Math.max(100, base + delta), group: `key:${game}`, sellerIndex: 0,
        });
      }
    }
  }
  return offers;
}

// Дополнительные продавцы: чтобы добрать до `count` офферов, для случайных товаров
// добавляем 2-4 продавца с ценой ±несколько процентов. Именно эти группы дают
// «предложение другого продавца» при проигрыше гонки за последнюю единицу.
function addExtraSellers(baseOffers, extra, rnd, maxPerGroup = 4) {
  const byGroup = new Map();
  for (const o of baseOffers) {
    if (!byGroup.has(o.group)) byGroup.set(o.group, []);
    byGroup.get(o.group).push(o);
  }
  const groups = [...byGroup.keys()];
  const out = baseOffers.slice();
  const existingSellers = new Map();
  const groupSeen = new Map();

  const sellerVariant = (o, sellerIdx) => {
    const jitter = 1 + (sellerIdx - 1) * 0.012 + (rnd() * 0.02 - 0.01);
    return {
      ...o,
      sellerIndex: sellerIdx,
      price: Math.max(80, Math.round(o.price * jitter)),
    };
  };

  while (extra > 0 && groups.length) {
    const g = groups[Math.floor(rnd() * groups.length)];
    const reps = byGroup.get(g);
    if (!groupSeen.has(g)) groupSeen.set(g, new Set([0]));
    const used = groupSeen.get(g);
    // случайный из неиспользованных продавцов
    const choices = SELLERS.map((_, i) => i).filter((i) => !used.has(i));
    if (!choices.length) { groups.splice(groups.indexOf(g), 1); continue; }
    const sIdx = choices[Math.floor(rnd() * choices.length)];
    used.add(sIdx);
    const rep = reps[Math.floor(rnd() * reps.length)];
    out.push(sellerVariant(rep, sIdx));
    extra -= 1;
  }
  return out;
}

// Генерация каталога маркетплейса. available детерминированно 0..26.
export function generateMarketplace({ count = 3000, seed = 20260701 } = {}) {
  const rnd = mulberry32(seed);
  const base = buildBaseProducts(rnd);
  // «тот же товар» = точное название: у него могут быть несколько продавцов,
  // и при проигрыше гонки клиенту предлагается альтернатива у другого продавца
  for (const o of base) o.group = o.name;
  const offers = addExtraSellers(base, Math.max(0, count - base.length), rnd);

  const skuOf = (i) => `MK-${String(i).padStart(5, '0')}`;
  const list = offers.slice(0, count).map((o, i) => ({
    sku: skuOf(i),
    name: o.name,
    type: o.type,
    price: o.price,
    currency: 'RUB',
    image: null,
    seller: SELLERS[o.sellerIndex % SELLERS.length],
    product_group: o.group,
    available: 0 + Math.floor(rnd() * 26), // 0..25, часть позиций пустая
  }));

  // Пулы ключей A/B: столько кодов, сколько available в сумме
  const pools = { a: new Map(), b: new Map() };
  for (const o of list) {
    const total = o.available;
    const a = pools.a.get(o.sku) || [];
    const b = pools.b.get(o.sku) || [];
    for (let n = 0; n < total; n++) {
      const code = `MK${o.sku.replace('MK-', '-')}-${String(n).padStart(3, '0')}`;
      (n % 2 === 0 ? a : b).push(code);
    }
    if (a.length) pools.a.set(o.sku, a);
    if (b.length) pools.b.set(o.sku, b);
  }
  return { offers: list, pools };
}

// Пулы одного поставщика (для заглушек A/B и сидера)
export function poolsForSupplier(name, opts) {
  const { pools } = generateMarketplace(opts);
  return name === 'A' ? pools.a : pools.b;
}
