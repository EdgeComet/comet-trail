// Generates the CometTrail demo dataset: a fictional outdoor-gear store,
// https://gearshop.example, crawled by search engines and AI bots for 120 days.
//
//   node scripts/seed-demo.mjs [outFile]
//   SEED=<n>   RNG seed (default 1337)
//   SCALE=<x>  traffic multiplier (default 1, about 75k rows)
//
// `npm run dev:local` (make dev) and `make seed` run this to (re)generate
// dashboard/seed.local.sql and load it into the LOCAL D1 (Miniflare), never the
// remote DB. The .sql is a build artifact (gitignored); this script is the source
// of truth.
//
// The model:
//   - A site catalog (~1,100 URLs): home, 10 categories with pagination, facet and
//     sort URLs, ~500 products, buying guides, brand and static pages, internal
//     search, private pages, legacy redirects and long-dead products.
//   - Each page's HTML at time t comes from stateAt(page, t), which applies the
//     storylines below. Every bot that fetches the page at t gets the same HTML,
//     exactly as the worker would see it.
//   - Each bot has a daily volume (with noise, trends and bursts) and a crawl
//     profile: which kinds of URL it spends its requests on. Googlebot spends ~30%
//     on facets, sorts and search (crawl waste); AI user bots read guides and the
//     popular products; training bots crawl broadly.
//   - Rows use only bot names from shared/bots.js, and index_status comes from
//     shared/seo.js computeIndexStatus with the inputs the worker would use.
//
// Deterministic: a fixed RNG seed means every run produces the same dataset,
// anchored to the current time so the newest rows are minutes old.
//
// Storylines (D-n = n days before generation time):
//   S1  D-40       Product title template rewrite: "<Name> | GearShop" becomes
//                  "<Name> - Free Shipping & Returns | GearShop" on every product.
//   S2  D-18..D-12 A release canonicalizes every boots and backpacks product to its
//                  category page (non_canonical). Fixed at D-12, except six products
//                  that stay broken until now.
//   S3  D-3        Noindex leak, still active: /c/sleeping-bags, its pagination,
//                  facets and products serve "noindex, nofollow".
//   S4  D-15       Origin outage 02:00-05:00 UTC: 503 for every bot (some requests
//                  never get a response), 3-9 s responses. Googlebot crawls ~35% less
//                  for the next two days.
//   S5  D-25, D-9  Ten products are discontinued: 404 from D-25, then a 301 to their
//                  category from D-9. ChatGPT-User and Perplexity-User keep fetching
//                  them, plus six long-dead products that still return 404.
//   S6  D-6        A CMS change removes the H1 from eight guides and rewrites their
//                  meta descriptions.
//   S7  hero       /p/ridgeline-gtx-hiking-boot: title rewrite (D-40), AggregateRating
//                  added (D-30), H2 "Reviews" -> "Customer reviews (124)" (D-20),
//                  canonical broken (D-18) and fixed (D-12). Googlebot's last visit
//                  is D-14, so it has not seen the fix; ChatGPT-User, GPTBot and
//                  Bingbot fetched it after the fix.
//
// Hero URLs for the demo:
//   https://gearshop.example/p/ridgeline-gtx-hiking-boot   (S1, S2, S7: time machine)
//   https://gearshop.example/c/sleeping-bags               (S3: noindex leak)
//   https://gearshop.example/guides/how-to-choose-a-tent   (S6: AI favourite, H1 removed)
//   https://gearshop.example/p/cascade-2p-ultralight-tent  (S5: 200 -> 404 -> 301)

import fs from 'node:fs';
import { botInfo } from '../shared/bots.js';
import { computeIndexStatus } from '../shared/seo.js';

const OUT = process.argv[2] || new URL('../dashboard/seed.local.sql', import.meta.url).pathname;
const SEED = Number(process.env.SEED) || 1337;
const SCALE = Number(process.env.SCALE) || 1;

const HOST = 'https://gearshop.example';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DAYS = 120;
const NOW = Date.now();
const ago = (days) => NOW - days * DAY;

// ---- Seeded PRNG (mulberry32) so the dataset is reproducible across runs ----
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(SEED);
const rand = (n) => Math.floor(random() * n);
const pick = (arr) => arr[rand(arr.length)];
const chance = (p) => random() < p;
const between = (lo, hi) => lo + rand(hi - lo + 1); // integer, inclusive
const uniform = (lo, hi) => lo + random() * (hi - lo);
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const titleize = (slug) => slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// ---- Storyline clock ----
const T = {
  titleRewrite: ago(40),    // S1
  canonicalBug: ago(18),    // S2 release
  canonicalFix: ago(12),    // S2 fix
  noindexLeak: ago(3),      // S3
  dead404: ago(25),         // S5 discontinued -> 404
  dead301: ago(9),          // S5 404 -> 301
  guideCms: ago(6),         // S6
  heroRating: ago(30),      // S7 AggregateRating added
  heroReviewsH2: ago(20),   // S7 H2 renamed
};
// S4: 02:00-05:00 UTC on the calendar day 15 days ago.
const outageDay = new Date(ago(15));
outageDay.setUTCHours(0, 0, 0, 0);
const OUTAGE = { from: outageDay.getTime() + 2 * HOUR, to: outageDay.getTime() + 5 * HOUR };
const inOutage = (t) => t >= OUTAGE.from && t < OUTAGE.to;

// =============================================================================
// Site catalog
// =============================================================================

const BRANDS = ['Ridgeline', 'Northpeak', 'Alpenrose', 'Summitcraft', 'Trailborn', 'Cascadia',
  'Fjellwood', 'Timberlark', 'Bluecrest', 'Stonefly', 'Kestrel Peak', 'Wildgrove'];
const MODELS = ['Aero', 'Vista', 'Ember', 'Atlas', 'Nomad', 'Zephyr', 'Talus', 'Scree', 'Cirrus',
  'Basalt', 'Orion', 'Juniper', 'Sierra', 'Glacier', 'Tundra', 'Solstice', 'Meridian', 'Kestrel',
  'Alpine', 'Drift', 'Pioneer', 'Trace', 'Summit', 'Horizon', 'Lumen', 'Granite', 'Fjord', 'Cedar'];
const VARIANTS = ['', '', '', 'Pro', 'Lite', '2', 'XT', 'Plus'];
const PRICE_BANDS = [['under-100', 'Under $100'], ['100-250', '$100-250'], ['250-plus', '$250+']];

// Each category: product count, product types, a feature line for descriptions,
// and two facet dimensions whose values become filter URLs.
const CATEGORIES = [
  { slug: 'tents', name: 'Tents', count: 60, types: ['Ultralight Tent', 'Backpacking Tent', 'Dome Tent', 'Family Tent', 'Bivy Shelter', 'Trekking Pole Tent'],
    feature: 'Fast pitch, two doors and a full-coverage rainfly',
    dims: [['color', [['green', 'Green'], ['orange', 'Orange'], ['grey', 'Grey'], ['blue', 'Blue']]], ['size', [['1p', '1-Person'], ['2p', '2-Person'], ['3p', '3-Person'], ['4p', '4-Person']]]] },
  { slug: 'backpacks', name: 'Backpacks', count: 65, types: ['Daypack', 'Backpacking Pack', 'Hydration Pack', 'Travel Pack', 'Ultralight Pack'],
    feature: 'Adjustable torso, hip-belt pockets and a hydration sleeve',
    dims: [['color', [['black', 'Black'], ['blue', 'Blue'], ['red', 'Red'], ['green', 'Green']]], ['capacity', [['20-30l', '20-30L'], ['30-40l', '30-40L'], ['40-60l', '40-60L'], ['60l-plus', '60L+']]]] },
  { slug: 'sleeping-bags', name: 'Sleeping Bags', count: 45, types: ['Down Sleeping Bag', 'Synthetic Sleeping Bag', 'Quilt', 'Mummy Bag', 'Sleeping Bag Liner'],
    feature: 'Draft collar, full-length zip and a compression sack',
    dims: [['season', [['summer', 'Summer'], ['3-season', '3-Season'], ['winter', 'Winter']]], ['fill', [['down', 'Down'], ['synthetic', 'Synthetic']]]] },
  { slug: 'jackets', name: 'Jackets', count: 70, types: ['Rain Jacket', 'Down Jacket', 'Softshell Jacket', 'Fleece Jacket', 'Insulated Parka'],
    feature: 'Waterproof, breathable and packs into its own pocket',
    dims: [['gender', [['mens', "Men's"], ['womens', "Women's"]]], ['color', [['black', 'Black'], ['red', 'Red'], ['blue', 'Blue'], ['yellow', 'Yellow'], ['green', 'Green']]]] },
  { slug: 'boots', name: 'Boots', count: 60, types: ['Hiking Boot', 'Mountaineering Boot', 'Approach Shoe', 'Trail Runner', 'Winter Boot'],
    feature: 'Waterproof membrane, grippy outsole and a supportive midsole',
    dims: [['gender', [['mens', "Men's"], ['womens', "Women's"]]], ['type', [['waterproof', 'Waterproof'], ['wide', 'Wide Fit'], ['vegan', 'Vegan'], ['lightweight', 'Lightweight']]]] },
  { slug: 'stoves', name: 'Stoves', count: 35, types: ['Canister Stove', 'Liquid Fuel Stove', 'Wood Stove', 'Cook System', 'Alcohol Stove'],
    feature: 'Boils a liter in under four minutes, even in wind',
    dims: [['fuel', [['canister', 'Canister'], ['liquid', 'Liquid Fuel'], ['wood', 'Wood'], ['alcohol', 'Alcohol']]], ['weight', [['ultralight', 'Ultralight'], ['standard', 'Standard']]]] },
  { slug: 'headlamps', name: 'Headlamps', count: 40, types: ['Headlamp', 'Rechargeable Headlamp', 'Running Headlamp', 'Camp Lantern'],
    feature: 'Red light mode, lockout switch and an IPX7 rating',
    dims: [['lumens', [['under-300', 'Under 300 Lumens'], ['300-600', '300-600 Lumens'], ['600-plus', '600+ Lumens']]], ['battery', [['rechargeable', 'Rechargeable'], ['aaa', 'AAA']]]] },
  { slug: 'trekking-poles', name: 'Trekking Poles', count: 30, types: ['Trekking Poles', 'Carbon Trekking Poles', 'Folding Poles'],
    feature: 'Flick locks, cork grips and carbide tips',
    dims: [['material', [['carbon', 'Carbon'], ['aluminum', 'Aluminum']]], ['lock', [['flick-lock', 'Flick Lock'], ['twist', 'Twist Lock'], ['folding', 'Folding']]]] },
  { slug: 'water-filters', name: 'Water Filters', count: 30, types: ['Water Filter', 'Gravity Filter', 'Purifier Bottle', 'Squeeze Filter', 'UV Purifier'],
    feature: 'Removes 99.99% of bacteria and filters 1,000 liters',
    dims: [['type', [['squeeze', 'Squeeze'], ['gravity', 'Gravity'], ['pump', 'Pump'], ['uv', 'UV']]], ['capacity', [['1l', '1L'], ['3l', '3L'], ['6l', '6L']]]] },
  { slug: 'kids', name: 'Kids Gear', count: 61, types: ['Kids Hiking Boot', 'Kids Sleeping Bag', 'Kids Backpack', 'Kids Fleece', 'Kids Headlamp'],
    feature: 'Sized for growing explorers and built to be passed down',
    dims: [['age', [['3-6', 'Ages 3-6'], ['7-10', 'Ages 7-10'], ['11-14', 'Ages 11-14']]], ['color', [['red', 'Red'], ['blue', 'Blue'], ['yellow', 'Yellow'], ['green', 'Green']]]] },
];
const CAT_BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

const GUIDES = ['how-to-choose-a-tent', 'how-to-choose-a-sleeping-bag', 'backpack-fitting-guide',
  'layering-for-hiking', 'waterproof-jacket-guide', 'hiking-boot-sizing', 'best-backpacking-stoves',
  'water-filter-vs-purifier', 'headlamp-lumens-explained', 'do-you-need-trekking-poles',
  'kids-hiking-gear-checklist', 'ultralight-backpacking-checklist', 'winter-camping-tips',
  'how-to-pitch-a-tent-in-wind', 'sleeping-pad-r-values', 'down-vs-synthetic-insulation',
  'how-to-wash-a-down-jacket', 'breaking-in-hiking-boots', 'bear-safe-food-storage',
  'leave-no-trace-basics', 'first-aid-kit-checklist', 'how-to-waterproof-boots',
  'choosing-camp-stove-fuel', 'hydration-on-the-trail', 'family-camping-checklist',
  'thru-hiking-resupply-guide', 'backpacking-meal-ideas', 'how-to-read-a-topo-map',
  'avoiding-blisters', 'day-hike-gear-list'];

const STATIC_PAGES = [
  ['about', 'About GearShop', ['Organization']],
  ['shipping', 'Shipping Information | GearShop', ['WebPage']],
  ['returns', 'Returns & Exchanges | GearShop', ['WebPage']],
  ['contact', 'Contact Us | GearShop', ['Organization', 'ContactPoint']],
  ['stores', 'Store Locator | GearShop', ['WebPage', 'Store', 'PostalAddress']],
  ['size-guide', 'Size Guide | GearShop', ['WebPage']],
  ['warranty', 'Warranty | GearShop', ['WebPage']],
];

const SEARCHES = ['down jacket', '2 person tent', 'waterproof boots', 'water filter', 'headlamp',
  'ultralight backpack', 'winter sleeping bag', 'carbon trekking poles', 'camp stove',
  'kids hiking boots', 'rain jacket women', 'gravity filter', 'bivy', 'quilt', 'gaiters',
  'trail runners', 'sleeping pad', 'stove fuel', 'family tent', 'fleece', 'parka', 'daypack',
  'hydration pack', 'mummy bag', 'lantern', 'approach shoes', 'uv purifier', 'tent footprint',
  'sale', 'gift card', 'ridgeline boots', 'northpeak tent', 'alpenrose jacket', 'cheap tent',
  'best headlamp', 'waterproof backpack', 'kids sleeping bag', 'insulated jacket',
  'wide hiking boots', 'vegan boots'];

const HERO = {
  product: `${HOST}/p/ridgeline-gtx-hiking-boot`,
  category: `${HOST}/c/sleeping-bags`,
  guide: `${HOST}/guides/how-to-choose-a-tent`,
  discontinued: `${HOST}/p/cascade-2p-ultralight-tent`,
};

const hreflangsFor = (path) => [
  { lang: 'en', href: HOST + path },
  { lang: 'de', href: `${HOST}/de${path}` },
  { lang: 'fr', href: `${HOST}/fr${path}` },
  { lang: 'x-default', href: HOST + path },
];

// Product structured data as the worker collects it: every @type, nested ones
// included (Brand inside Product, ListItem inside BreadcrumbList), deduped.
const productSd = (rating) => ['Product', 'Brand', 'Offer', ...(rating ? ['AggregateRating'] : []), 'BreadcrumbList', 'ListItem'];

function buildSite() {
  const pages = [];
  const add = (path, kind, data) => {
    const page = { url: HOST + path, path, kind, w: 1, ...data };
    pages.push(page);
    return page;
  };

  add('/', 'home', {
    title: 'GearShop - Outdoor Gear for Hiking, Camping & Climbing',
    desc: 'Tents, backpacks, sleeping bags and boots from the brands hikers trust. Free shipping over $50, 60-day returns and expert buying guides.',
    h1: ['Outdoor gear for every trail'],
    h2: ['Shop by category', 'New arrivals', 'Expert guides', 'Why GearShop'],
    sd: ['WebSite', 'SearchAction', 'Organization'], hreflang: true,
  });

  for (const cat of CATEGORIES) {
    const base = `/c/${cat.slug}`;
    cat.page = add(base, 'category', {
      cat: cat.slug, w: uniform(0.7, 1.3),
      title: `${cat.name} | GearShop`,
      desc: `Shop ${cat.name.toLowerCase()} from top outdoor brands. Compare specs, read reviews and get free shipping on orders over $50.`,
      h1: [cat.name], h2: ['Shop by type', `Top rated ${cat.name.toLowerCase()}`, 'Buying guides'],
      sd: ['CollectionPage', 'ItemList', 'ListItem', 'BreadcrumbList'], hreflang: true,
    });
    for (const n of [2, 3, 4]) {
      add(`${base}?page=${n}`, 'paginated', {
        cat: cat.slug, title: `${cat.name} - Page ${n} | GearShop`,
        desc: `Shop ${cat.name.toLowerCase()} from top outdoor brands, page ${n}.`,
        h1: [cat.name], h2: ['Shop by type'], sd: ['CollectionPage', 'ItemList', 'ListItem', 'BreadcrumbList'],
      });
    }
    // Facets: every single value (the category's own dimensions, price bands and
    // brands), then two-dimension combinations, capped at 36 per category. All
    // canonicalize to the category page.
    const [[k1, v1], [k2, v2]] = cat.dims;
    const facets = [];
    for (const [v, l] of v1) facets.push([`${k1}=${v}`, l]);
    for (const [v, l] of v2) facets.push([`${k2}=${v}`, l]);
    for (const [v, l] of PRICE_BANDS) facets.push([`price=${v}`, l]);
    for (const brand of BRANDS) facets.push([`brand=${slugify(brand)}`, brand]);
    for (const [a, la] of v1) for (const [b, lb] of v2) facets.push([`${k1}=${a}&${k2}=${b}`, `${la} ${lb}`]);
    for (const [a, la] of v1) for (const [b, lb] of PRICE_BANDS) facets.push([`${k1}=${a}&price=${b}`, `${la} ${lb}`]);
    for (const [q, label] of facets.slice(0, 36)) {
      add(`${base}?${q}`, 'facet', {
        cat: cat.slug, w: uniform(0.5, 1.5), canonical: HOST + base,
        title: `${label} ${cat.name} | GearShop`,
        desc: `Shop ${label.toLowerCase()} ${cat.name.toLowerCase()} at GearShop.`,
        h1: [cat.name], h2: ['Shop by type'], sd: ['CollectionPage', 'ItemList', 'ListItem'],
      });
    }
    // Sort variants keep the category title: a duplicate-title cluster.
    for (const s of ['price_asc', 'price_desc', 'newest', 'rating']) {
      add(`${base}?sort=${s}`, 'sort', {
        cat: cat.slug, canonical: HOST + base, title: `${cat.name} | GearShop`,
        desc: `Shop ${cat.name.toLowerCase()} from top outdoor brands. Compare specs, read reviews and get free shipping on orders over $50.`,
        h1: [cat.name], h2: ['Shop by type'], sd: ['CollectionPage', 'ItemList', 'ListItem'],
      });
    }
  }

  // Products. The two heroes are fixed; the rest are generated per category.
  const used = new Set();
  const addProduct = (cat, name, extra = {}) => {
    const slug = extra.slug ?? slugify(name);
    if (used.has(slug)) return null;
    used.add(slug);
    return add(`/p/${slug}`, 'product', {
      cat: cat.slug, name, rating: chance(0.4),
      title: `${name} | GearShop`,
      desc: `Shop the ${name} at GearShop. ${cat.feature}. Free shipping over $50 and 60-day returns.`,
      h1: [name], h2: ['Description', 'Specifications', 'Reviews', 'You may also like'],
      ...extra,
    });
  };
  addProduct(CAT_BY_SLUG.get('boots'), 'Ridgeline GTX Hiking Boot', { rating: false, hero: true });
  addProduct(CAT_BY_SLUG.get('tents'), 'Cascade 2P Ultralight Tent', { rating: true, discontinued: true });
  // Variant listings that share one title: a duplicate-title cluster.
  for (const color of ['red', 'blue', 'yellow', 'green']) {
    addProduct(CAT_BY_SLUG.get('kids'), 'Kids Rain Jacket', { slug: `kids-rain-jacket-${color}` });
  }
  for (const cat of CATEGORIES) {
    let made = pages.filter((p) => p.kind === 'product' && p.cat === cat.slug).length;
    while (made < cat.count) {
      const variant = pick(VARIANTS);
      const name = [pick(BRANDS), pick(MODELS), variant, pick(cat.types)].filter(Boolean).join(' ');
      if (addProduct(cat, name)) made++;
    }
  }

  for (const slug of GUIDES) {
    const topic = titleize(slug);
    add(`/guides/${slug}`, 'guide', {
      slug, title: `${topic} | GearShop Guides`,
      desc: `${topic}: our gear experts explain what matters, what to skip and which products we recommend for your next trip.`,
      h1: [topic], h2: ['What to consider', 'Our top picks', 'Frequently asked questions'],
      sd: ['Article', 'Person', 'Organization', 'BreadcrumbList', 'ListItem'], hreflang: true,
    });
  }

  for (const brand of BRANDS) {
    add(`/brands/${slugify(brand)}`, 'brand', {
      title: `${brand} Outdoor Gear | GearShop`,
      desc: `Shop ${brand} tents, packs and apparel at GearShop, with free shipping over $50.`,
      h1: [brand], h2: ['Best sellers', 'New from ' + brand], sd: ['CollectionPage', 'Brand'],
    });
  }

  for (const [slug, title, sd] of STATIC_PAGES) {
    add(`/${slug}`, 'static', {
      slug, title, desc: `${title.replace(' | GearShop', '')} for GearShop orders, stores and support.`,
      h1: [title.replace(' | GearShop', '')], h2: [], sd,
    });
  }

  for (const q of SEARCHES) {
    add(`/search?q=${q.replace(/ /g, '+')}`, 'search', {
      title: `Search results for "${q}" | GearShop`, desc: null, canonical: null,
      robots: ['noindex', 'follow'], h1: [`Results for "${q}"`], h2: ['Filters'], sd: [],
    });
  }

  for (const [slug, title] of [['cart', 'Your Cart | GearShop'], ['account', 'My Account | GearShop'], ['wishlist', 'Wishlist | GearShop']]) {
    add(`/${slug}`, 'private', {
      title, desc: null, canonical: null, robots: ['noindex', 'nofollow'],
      h1: [title.replace(' | GearShop', '')], h2: [], sd: [],
    });
  }

  // Legacy URL structure: /products/<slug> permanently redirects to /p/<slug>.
  const products = pages.filter((p) => p.kind === 'product');
  for (const p of shuffle(products).slice(0, 30)) {
    add(`/products/${p.path.slice(3)}`, 'legacy', { status: 301 });
  }
  add('/sale', 'sale', { status: 302 }); // seasonal sale, temporary redirect

  // Long-dead products, gone before the dataset starts. Six of them are still
  // "recommended" by AI assistants, which keep fetching them for users.
  const dead = [];
  for (let i = 0; i < 25; i++) {
    const cat = pick(CATEGORIES);
    const slug = slugify(`${pick(BRANDS)} ${pick(MODELS)} ${pick(cat.types)} ${2017 + rand(5)}`);
    if (used.has(slug)) continue;
    used.add(slug);
    dead.push(add(`/p/${slug}`, 'dead', { status: 404 }));
  }
  for (const p of dead.slice(0, 6)) p.aiRecommended = true;

  // ---- Storyline and content-quality flags on generated products ----
  const pool = shuffle(products.filter((p) => !p.hero && !p.discontinued && !p.name.startsWith('Kids Rain')));
  let i = 0;
  const take = (n, filter = () => true) => {
    const out = [];
    for (; i < pool.length && out.length < n; i++) if (filter(pool[i])) out.push(pool[i]);
    return out;
  };
  // S5: ten discontinued products (the hero tent plus nine more).
  for (const p of take(9)) p.discontinued = true;
  // S2: six boots/backpacks products whose canonical stays broken after the fix.
  for (const p of take(6, (q) => q.cat === 'boots' || q.cat === 'backpacks')) p.canonicalStaysBroken = true;
  // Content-quality noise.
  for (const p of take(10)) p.desc = null;                                      // missing meta description
  for (const p of take(6)) p.h1 = [p.name, 'Specifications'];                   // two H1s
  for (const p of take(5)) p.desc += ' Built for long days on the trail, tested by our staff on real trips across three seasons.'; // too long

  // S6: eight guides (the hero first) lose their H1 at D-6.
  const guides = pages.filter((p) => p.kind === 'guide');
  for (const g of [guides[0], ...shuffle(guides.slice(1)).slice(0, 7)]) g.cmsBroken = true;
  for (const g of shuffle(guides).slice(0, 6)) g.desc += ' Updated every season with new picks, field-tested advice and answers to the questions our customers ask most.';
  for (const g of guides.slice(0, 10)) g.sd = [...g.sd, 'FAQPage', 'Question', 'Answer'];

  // Brand pages: two with an empty <title>, one with no description.
  const brands = pages.filter((p) => p.kind === 'brand');
  brands[3].title = null;
  brands[7].title = null;
  brands[9].desc = null;

  // Popularity: Zipf-like weights over products and guides, so a few pages draw
  // most of the attention. The hero guide is the AI favourite.
  shuffle(products).forEach((p, rank) => { p.w = 1 / Math.pow(rank + 1, 0.9); });
  shuffle(guides).forEach((g, rank) => { g.w = 1 / Math.pow(rank + 1, 0.7); });
  guides[0].w *= 5;

  return pages;
}

// =============================================================================
// Page state at time t (the HTML a bot would receive)
// =============================================================================

function stateAt(page, t) {
  if (page.kind === 'legacy' || page.kind === 'sale') return { status: page.status };
  if (page.kind === 'dead') return { status: 404 };
  if (page.discontinued && t >= T.dead301) return { status: 301 };
  if (page.discontinued && t >= T.dead404) return { status: 404 };

  const s = {
    status: 200,
    title: page.title ?? null,
    desc: page.desc ?? null,
    canonical: page.canonical === undefined ? page.url : page.canonical,
    robots: page.robots ?? [],
    h1: page.h1 ?? [],
    h2: page.h2 ?? [],
    hreflangs: page.hreflang ? hreflangsFor(page.path) : [],
    sd: page.sd ?? [],
  };

  if (page.kind === 'product') {
    // S1: title template rewrite.
    if (t >= T.titleRewrite) s.title = `${page.name} - Free Shipping & Returns | GearShop`;
    s.sd = productSd(page.rating || (page.hero && t >= T.heroRating));
    // S7: the hero's reviews block got a count in its heading.
    if (page.hero && t >= T.heroReviewsH2) s.h2 = s.h2.map((h) => (h === 'Reviews' ? 'Customer reviews (124)' : h));
    // S2: canonical bug on boots and backpacks.
    const s2 = page.cat === 'boots' || page.cat === 'backpacks';
    if (s2 && t >= T.canonicalBug && (t < T.canonicalFix || page.canonicalStaysBroken)) {
      s.canonical = `${HOST}/c/${page.cat}`;
    }
  }

  // S3: noindex leak across the sleeping-bags templates.
  if (page.cat === 'sleeping-bags' && t >= T.noindexLeak) s.robots = ['noindex', 'nofollow'];

  // S6: CMS change on eight guides.
  if (page.cmsBroken && t >= T.guideCms) {
    s.h1 = [];
    s.desc = `Everything you need to know about ${titleize(page.slug).toLowerCase()}, updated for 2026 by the GearShop team.`;
  }
  return s;
}

const ERROR_PAGES = {
  404: { title: 'Page not found | GearShop', h1: ['Page not found'], h2: ['Popular categories'] },
  429: { title: '429 Too Many Requests', h1: ['Too Many Requests'], h2: [] },
  500: { title: 'Something went wrong | GearShop', h1: ['Something went wrong'], h2: [] },
  503: { title: '503 Service Temporarily Unavailable', h1: ['Service Temporarily Unavailable'], h2: [] },
};

// Origin response time for a 200, by page type.
const RT_RANGE = {
  home: [150, 450], category: [300, 900], paginated: [300, 900], facet: [350, 950], sort: [300, 900],
  product: [180, 600], guide: [200, 550], brand: [250, 700], static: [120, 350], search: [800, 1500],
  private: [150, 400],
};

// Share of each bot's requests the origin rate-limits with a 429.
const RATE_LIMITED = { 'Meta-ExternalAgent': 0.08, Bytespider: 0.05, CCBot: 0.02 };

let outageRequests = 0;

// One crawls row, shaped exactly as the worker inserts it.
function makeRow(page, bot, t) {
  let s;
  let rt;
  if (inOutage(t)) {
    // S4: the origin is down. Every 12th request gets no response at all (a
    // counter, not a coin flip, so the story always has a few of them).
    if (++outageRequests % 12 === 6) {
      s = { status: null };
      rt = between(8000, 15000);
    } else {
      s = { status: 503, ...ERROR_PAGES[503] };
      rt = between(3000, 9000);
    }
  } else if (chance(RATE_LIMITED[bot] ?? 0)) {
    s = { status: 429, ...ERROR_PAGES[429] };
    rt = between(20, 80);
  } else {
    s = stateAt(page, t);
    if (s.status === 200 && (page.kind === 'search' ? chance(0.015) : chance(0.0015))) {
      s = { status: 500, ...ERROR_PAGES[500] };
    }
    if (s.status === 200) {
      const [lo, hi] = RT_RANGE[page.kind];
      rt = chance(0.04) ? between(1500, 5200) : between(lo, hi); // ~4% slow outliers
    } else if (s.status === 404) {
      s = { ...s, ...ERROR_PAGES[404] };
      rt = between(60, 200);
    } else if (s.status === 500) {
      rt = between(400, 2500);
    } else {
      rt = between(30, 120); // redirects
    }
  }

  const robots = s.robots ?? [];
  const canonical = s.status === 200 ? s.canonical : null;
  return {
    url: page.url,
    status: s.status,
    response_time_ms: rt,
    title: s.title ?? null,
    meta_description: s.desc ?? null,
    canonical,
    hreflangs: s.hreflangs ?? [],
    h1: s.h1 ?? [],
    h2: s.h2 ?? [],
    meta_robots: robots,
    meta_googlebot: [],
    structured_data_types: s.sd ?? [],
    index_status: computeIndexStatus({ status: s.status, metaRobots: robots, metaGooglebot: [], canonical, finalUrl: page.url }),
    bot_name: bot,
    ts: Math.round(t),
  };
}

// =============================================================================
// Traffic
// =============================================================================

// Crawl profiles: the share of a bot's requests that goes to each kind of URL.
// Within a kind, pages are picked by their popularity weight.
const PROFILES = {
  // ~32% on facets, sorts, search, private pages, redirects and dead URLs.
  googlebot: { home: 3, category: 9, paginated: 3, product: 45, guide: 4, brand: 2, static: 1.5, facet: 18, sort: 5, search: 5, private: 0.5, legacy: 1.5, dead: 1.5, sale: 0.5 },
  bing: { home: 4, category: 12, paginated: 2, product: 44, guide: 6, brand: 3, static: 3, facet: 10, sort: 3, search: 3, legacy: 4, dead: 3, private: 1, sale: 1 },
  image: { home: 5, category: 20, product: 70, guide: 5 },
  ads: { home: 5, category: 15, product: 80 },
  training: { home: 1, category: 6, paginated: 4, product: 38, guide: 10, brand: 3, static: 3, facet: 25, sort: 4, search: 3, legacy: 1, dead: 2 },
  scraper: { category: 5, product: 15, facet: 65, sort: 10, search: 5 },
  aiSearch: { home: 3, category: 12, product: 45, guide: 25, brand: 4, static: 6, dead: 2, facet: 2, legacy: 1 },
  // AI user bots read guides and the hot products; "aiDead" are the discontinued
  // and long-dead products assistants still recommend.
  aiUser: { home: 2, category: 6, productHot: 42, guide: 38, staticHelp: 6, aiDead: 2 },
  aiUserDead: { home: 2, category: 6, productHot: 38, guide: 34, staticHelp: 6, aiDead: 10 },
};

function buildPickers(pages) {
  const buckets = {};
  const put = (name, page, w) => (buckets[name] ??= []).push([page, w]);
  for (const p of pages) {
    if (p.hero) continue; // the hero product only gets its scripted visits (S7)
    put(p.kind, p, p.w);
    if (p.kind === 'product') put('productHot', p, Math.pow(p.w, 1.8));
    if (p.kind === 'static' && ['shipping', 'returns', 'size-guide', 'warranty'].includes(p.slug)) put('staticHelp', p, 1);
    if (p.discontinued || p.aiRecommended) put('aiDead', p, p.url === HERO.discontinued ? 3 : 1);
  }
  const pickers = {};
  for (const [name, shares] of Object.entries(PROFILES)) {
    const entries = [];
    for (const [bucket, share] of Object.entries(shares)) {
      const items = buckets[bucket] ?? [];
      const total = items.reduce((a, [, w]) => a + w, 0);
      for (const [page, w] of items) entries.push([page, (share * w) / total]);
    }
    const cum = [];
    let acc = 0;
    for (const [, w] of entries) cum.push((acc += w));
    pickers[name] = () => {
      const x = random() * acc;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < x) lo = mid + 1; else hi = mid;
      }
      return entries[lo][0];
    };
  }
  return pickers;
}

// Steady daily traffic per bot. `rate(d)` is the expected requests on the day
// that is d days ago. `human` bots fetch while people are awake (UTC daytime)
// and a little less on weekends.
const lerp = (from, to, d) => to + (from - to) * (d / DAYS); // value `from` at D-120, `to` today
const STREAMS = [
  { bot: () => (chance(0.8) ? 'Googlebot-Smartphone' : 'Googlebot'), profile: 'googlebot', rate: (d) => lerp(240, 270, d), googlebot: true },
  { bot: 'Bingbot', profile: 'bing', rate: () => 45 },
  { bot: 'Googlebot-Image', profile: 'image', rate: () => 20 },
  { bot: 'AdsBot-Google', profile: 'ads', rate: () => 10 },
  { bot: 'GoogleOther', profile: 'training', rate: () => 5 },
  { bot: 'YandexBot', profile: 'bing', rate: () => 8 },
  { bot: 'Applebot', profile: 'bing', rate: () => 10 },
  { bot: 'DuckDuckBot', profile: 'bing', rate: () => 3 },
  { bot: 'GPTBot', profile: 'training', rate: () => 10 },
  { bot: 'OAI-SearchBot', profile: 'aiSearch', rate: (d) => lerp(18, 30, d) },
  { bot: 'ChatGPT-User', profile: 'aiUserDead', rate: (d) => 25 + 30 * Math.pow(1 - d / DAYS, 1.6), human: true },
  { bot: 'ClaudeBot', profile: 'training', rate: () => 30 },
  { bot: 'Claude-SearchBot', profile: 'aiSearch', rate: () => 5 },
  { bot: 'Claude-User', profile: 'aiUser', rate: (d) => (d > 60 ? 0 : 8 + 10 * (1 - d / 60)), human: true },
  { bot: 'PerplexityBot', profile: 'aiSearch', rate: () => 20 },
  { bot: 'Perplexity-User', profile: 'aiUserDead', rate: (d) => lerp(9, 15, d), human: true },
  { bot: 'Meta-WebIndexer', profile: 'aiSearch', rate: () => 3 },
  { bot: 'Meta-ExternalFetcher', profile: 'aiUser', rate: () => 2, human: true },
  { bot: 'MistralAI-User', profile: 'aiUser', rate: (d) => (d > 45 ? 0 : 2), human: true },
  { bot: 'MistralAI-Index', profile: 'aiSearch', rate: () => 2 },
];

// Bulk crawls: every `every` days a bot fetches `count` pages over a few hours.
const BURSTS = [
  { bot: 'GPTBot', profile: 'training', every: [5, 8], count: [250, 450], hours: [3, 8] },
  { bot: 'ClaudeBot', profile: 'training', every: [10, 14], count: [150, 300], hours: [4, 10] },
  { bot: 'Meta-ExternalAgent', profile: 'scraper', every: [8, 12], count: [180, 360], hours: [2, 6] },
  { bot: 'CCBot', profile: 'training', every: [18, 24], count: [150, 250], hours: [6, 12] },
  { bot: 'Bytespider', profile: 'scraper', every: [14, 20], count: [100, 200], hours: [2, 5] },
];

// A time in [start, start + DAY) when a person might be awake (peaks ~15:00 UTC).
function daytime(start) {
  for (;;) {
    const t = start + random() * DAY;
    const h = new Date(t).getUTCHours();
    if (random() < 0.6 + 0.4 * Math.cos(((h - 15) / 24) * 2 * Math.PI)) return t;
  }
}

function generateVisits(pages, pickers) {
  const visits = [];
  const push = (bot, page, t) => { if (t < NOW) visits.push({ bot, page, t }); };

  for (const stream of STREAMS) {
    for (let k = 0; k < DAYS; k++) {
      const start = NOW - (k + 1) * DAY;
      const weekend = [0, 6].includes(new Date(start + DAY / 2).getUTCDay());
      const noise = uniform(0.8, 1.2) * (stream.human && weekend ? 0.85 : 1);
      const n = Math.round(stream.rate(k + 0.5) * noise * SCALE);
      for (let i = 0; i < n; i++) {
        const t = stream.human ? daytime(start) : start + random() * DAY;
        // S4 aftermath: Googlebot backs off for two days after the outage.
        if (stream.googlebot && t >= OUTAGE.to && t < OUTAGE.to + 2 * DAY && chance(0.35)) continue;
        const bot = typeof stream.bot === 'function' ? stream.bot() : stream.bot;
        push(bot, pickers[stream.profile](), t);
      }
    }
  }

  for (const b of BURSTS) {
    for (let d = DAYS - rand(b.every[1]); d > 0; d -= between(...b.every)) {
      const start = ago(d) + random() * DAY / 2;
      const span = between(...b.hours) * HOUR;
      const n = Math.round(between(...b.count) * SCALE);
      for (let i = 0; i < n; i++) push(b.bot, pickers[b.profile](), start + random() * span);
    }
  }

  scriptedVisits(pages, push);
  return visits.sort((a, b) => a.t - b.t);
}

// Visits the storylines depend on, placed by hand so the story holds whatever
// the random traffic does. `at(days)` jitters a few hours around D-days.
function scriptedVisits(pages, push) {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const at = (days) => ago(days) + uniform(-3, 3) * HOUR;
  const gbot = () => (chance(0.8) ? 'Googlebot-Smartphone' : 'Googlebot');
  const visit = (url, bot, days) => push(typeof bot === 'function' ? bot() : bot, byUrl.get(url), at(days));

  // S7 hero product: Googlebot every 1-3 days until D-14 (mid canonical bug), then
  // never again. Other bots keep coming, several of them after the fix.
  const hero = HERO.product;
  for (let d = DAYS - 2; d > 15; d -= uniform(1.2, 2.8)) visit(hero, gbot, d);
  push(gbot(), byUrl.get(hero), ago(14) + 3 * HOUR); // the last Googlebot visit
  for (let d = DAYS - 5; d > 0.5; d -= uniform(5, 8)) visit(hero, 'Bingbot', d);
  for (const d of [10.3, 4.2]) visit(hero, 'Bingbot', d);
  for (const d of [95, 61, 33, 8.4]) visit(hero, 'GPTBot', d);
  for (let d = 58; d > 1; d -= uniform(3, 6)) visit(hero, 'ChatGPT-User', d);
  for (const d of [11.2, 5.1, 2.3]) visit(hero, 'ChatGPT-User', d);
  for (const d of [80, 44, 16.5]) visit(hero, 'ClaudeBot', d);
  for (const d of [9.6, 3.3]) visit(hero, 'Claude-User', d);
  for (let d = DAYS - 10; d > 1; d -= uniform(9, 12)) visit(hero, 'PerplexityBot', d);
  for (const d of [21, 7.2]) visit(hero, 'Perplexity-User', d);
  for (const d of [50, 26, 13.4, 3.1]) visit(hero, 'OAI-SearchBot', d);
  for (const d of [70, 35]) visit(hero, 'Googlebot-Image', d);

  // S3: Googlebot and Bingbot reach the leaked noindex.
  for (const d of [2.6, 1.3, 0.4]) visit(HERO.category, gbot, d);
  visit(HERO.category, 'Bingbot', 2.1);

  // S6: Googlebot sees the guide without its H1.
  for (const d of [5.2, 2.4, 0.8]) visit(HERO.guide, gbot, d);

  // S5: the discontinued tent, through 404 and into the redirect.
  for (const d of [7.3, 4.1, 1.2, 0.3]) visit(HERO.discontinued, 'ChatGPT-User', d);
  visit(HERO.discontinued, 'Perplexity-User', 5.5);
  for (const d of [20, 8, 3]) visit(HERO.discontinued, gbot, d);
}

// =============================================================================
// SQL emit
// =============================================================================

const sqlStr = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const sqlJson = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
const sqlNum = (v) => (v === null || v === undefined ? 'NULL' : String(v));

const COLS = '(url, status, response_time_ms, title, meta_description, canonical, '
  + 'hreflangs, h1, h2, meta_robots, meta_googlebot, structured_data_types, index_status, bot_name, ts)';
const MAX_STATEMENT_BYTES = 60_000; // D1 caps one statement at 100 KB

function toSql(rows) {
  const lines = [
    `-- Demo seed for local dashboard development (${rows.length} rows, SEED=${SEED}, SCALE=${SCALE}).`,
    '-- GENERATED FILE - do not edit or commit. Source: scripts/seed-demo.mjs.',
    '-- Loaded into the LOCAL D1 (Miniflare) by `npm run dev:local` and `make seed`.',
    '-- Idempotent: wipes the local table first, so every run gives the same dataset.',
    'BEGIN TRANSACTION;',
    'DELETE FROM crawls;',
  ];
  let chunk = [];
  let size = 0;
  const flush = () => {
    lines.push(`INSERT INTO crawls ${COLS} VALUES\n  ${chunk.join(',\n  ')};`);
    chunk = [];
    size = 0;
  };
  for (const r of rows) {
    const tuple = '(' + [
      sqlStr(r.url), sqlNum(r.status), sqlNum(r.response_time_ms), sqlStr(r.title),
      sqlStr(r.meta_description), sqlStr(r.canonical), sqlJson(r.hreflangs), sqlJson(r.h1),
      sqlJson(r.h2), sqlJson(r.meta_robots), sqlJson(r.meta_googlebot),
      sqlJson(r.structured_data_types), sqlStr(r.index_status), sqlStr(r.bot_name), sqlNum(r.ts),
    ].join(', ') + ')';
    if (chunk.length && size + tuple.length > MAX_STATEMENT_BYTES) flush();
    chunk.push(tuple);
    size += tuple.length + 4;
  }
  if (chunk.length) flush();
  lines.push('COMMIT;');
  return lines.join('\n');
}

// =============================================================================
// Main
// =============================================================================

const pages = buildSite();
const visits = generateVisits(pages, buildPickers(pages));
const rows = visits.map((v) => makeRow(v.page, v.bot, v.t));

for (const name of new Set(rows.map((r) => r.bot_name))) {
  if (!botInfo(name)) throw new Error(`seed uses a bot missing from shared/bots.js: ${name}`);
}

fs.writeFileSync(OUT, toSql(rows) + '\n');

const tally = (key) => rows.reduce((m, r) => ((m[key(r)] = (m[key(r)] || 0) + 1), m), {});
console.log(`Wrote ${rows.length} rows for ${pages.length} URLs over ${DAYS} days to ${OUT}`);
console.log('family:', tally((r) => botInfo(r.bot_name).family));
console.log('purpose:', tally((r) => botInfo(r.bot_name).purpose ?? '-'));
console.log('index_status:', tally((r) => r.index_status));
console.log('status:', tally((r) => (r.status === null ? 'none' : `${String(r.status)[0]}xx`)));
console.log('hero URLs:', Object.values(HERO).join('  '));
