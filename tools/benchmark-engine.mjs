import { runRecommendationEngine } from '../recommendation-engine-v2.mjs';

class MockPipeline {
  constructor(store) {
    this.store = store;
    this.keys = [];
  }

  get(key) {
    this.keys.push(key);
    return this;
  }

  async exec() {
    return this.keys.map((key) => this.store.get(key) ?? null);
  }
}

class MockRedis {
  constructor() {
    this.kv = new Map();
    this.sets = new Map();
    this.zsets = new Map();
  }

  multi() {
    return new MockPipeline(this.kv);
  }

  async get(key) {
    return this.kv.get(key) ?? null;
  }

  async sRandMember(key, count) {
    const set = this.sets.get(key);
    if (!set) return [];
    const values = Array.from(set);
    return values.slice(0, count);
  }

  async zRange(key, start, stop, options) {
    const set = this.zsets.get(key);
    if (!set) return [];
    const sorted = [...set].sort((a, b) => b.score - a.score);
    const slice = sorted.slice(start, stop + 1);
    return options?.REV ? slice.map((item) => item.member) : slice.map((item) => item.member);
  }
}

function seedProduct(redis, shop, product) {
  const key = `hybrid:prod:${shop}:${product.id}`;
  redis.kv.set(key, JSON.stringify(product));
}

function seedSet(redis, key, members) {
  redis.sets.set(key, new Set(members.map(String)));
}

async function main() {
  const redis = new MockRedis();
  const shop = 'bench.myshopify.com';

  const cart = [];
  for (let i = 0; i < 5; i += 1) {
    cart.push({
      id: i + 1,
      collection_ids: ['10'],
      tags: ['x'],
      vendor: 'A',
      price_cents: 1000 + i * 100,
    });
  }

  const candidateIds = [];
  for (let i = 0; i < 200; i += 1) {
    candidateIds.push(String(1000 + i));
    seedProduct(redis, shop, {
      id: 1000 + i,
      collection_ids: ['10'],
      tags: ['x'],
      vendor: 'A',
      price_cents: 1200 + i,
      default_variant_id: 10000 + i,
      available: true,
      inventory_quantity: 50,
    });
  }

  seedSet(redis, `hybrid:idx:coll:${shop}:10`, candidateIds);

  const start = performance.now();
  const results = await runRecommendationEngine(redis, shop, cart, 5, [], 'en');
  const duration = performance.now() - start;

  console.log(`[bench] results=${results.length} duration_ms=${duration.toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
