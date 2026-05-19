import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runRecommendationEngine,
  selectFinal,
  scoreCandidates,
  ENGINE,
} from '../recommendation-engine-v2.mjs';

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

  async sRandMember(key) {
    const set = this.sets.get(key);
    if (!set) return null;
    return Array.from(set)[0] ?? null;
  }

  // node-redis v5: SRANDMEMBER key <count> — the engine uses this form.
  async sRandMemberCount(key, count) {
    const set = this.sets.get(key);
    if (!set) return [];
    return Array.from(set).slice(0, count);
  }

  async zRange(key, start, stop, options) {
    const set = this.zsets.get(key);
    if (!set) return [];
    const sorted = [...set].sort((a, b) => b.score - a.score);
    const slice = sorted.slice(start, stop + 1);
    return options?.REV ? slice.map((item) => item.member) : slice.map((item) => item.member);
  }

  // node-redis v5 zRangeWithScores returns [{ value, score }, ...].
  async zRangeWithScores(key, start, stop, options) {
    const set = this.zsets.get(key);
    if (!set) return [];
    const sorted = [...set].sort((a, b) =>
      options?.REV ? b.score - a.score : a.score - b.score);
    return sorted.slice(start, stop + 1).map((item) => ({
      value: item.member,
      score: item.score,
    }));
  }
}

function seedProduct(redis, shop, product) {
  const key = `hybrid:prod:${shop}:${product.id}`;
  redis.kv.set(key, JSON.stringify(product));
}

function seedSet(redis, key, members) {
  redis.sets.set(key, new Set(members.map(String)));
}

function seedZSet(redis, key, members) {
  redis.zsets.set(key, members);
}

function seedCopurchase(redis, shop, productId, coBuys) {
  // coBuys: [{ member, score }] — products co-bought with productId
  redis.zsets.set(`hybrid:idx:copurchase:${shop}:${productId}`, coBuys);
}

test('runRecommendationEngine: deterministic tie-break on price then id', async () => {
  const redis = new MockRedis();
  const shop = 'alpha.myshopify.com';

  const cart = [{ id: 1, collection_ids: ['10'], tags: ['x'], vendor: 'A', price_cents: 1000 }];

  seedSet(redis, `hybrid:idx:coll:${shop}:10`, ['2', '3']);

  seedProduct(redis, shop, {
    id: 2,
    collection_ids: ['10'],
    tags: ['x'],
    vendor: 'A',
    price_cents: 2000,
    compare_at_price_cents: null,
    default_variant_id: 22,
    available: true,
  });

  seedProduct(redis, shop, {
    id: 3,
    collection_ids: ['10'],
    tags: ['x'],
    vendor: 'A',
    price_cents: 1500,
    compare_at_price_cents: null,
    default_variant_id: 33,
    available: true,
  });

  const results = await runRecommendationEngine(redis, shop, cart, 2, [], 'en');
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 2);
  assert.equal(results[1].id, 3);
});

test('runRecommendationEngine: filters unavailable and missing variant', async () => {
  const redis = new MockRedis();
  const shop = 'beta.myshopify.com';

  const cart = [{ id: 1, collection_ids: ['9'], tags: ['x'], vendor: 'A', price_cents: 1000 }];
  seedSet(redis, `hybrid:idx:coll:${shop}:9`, ['2', '3', '4']);

  seedProduct(redis, shop, {
    id: 2,
    collection_ids: ['9'],
    tags: ['x'],
    vendor: 'A',
    price_cents: 1200,
    default_variant_id: null,
    available: true,
  });

  seedProduct(redis, shop, {
    id: 3,
    collection_ids: ['9'],
    tags: ['x'],
    vendor: 'A',
    price_cents: 1300,
    default_variant_id: 33,
    available: false,
  });

  seedProduct(redis, shop, {
    id: 4,
    collection_ids: ['9'],
    tags: ['x'],
    vendor: 'A',
    price_cents: 1400,
    default_variant_id: 44,
    available: true,
  });

  const results = await runRecommendationEngine(redis, shop, cart, 3, [], 'en');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 4);
});

test('runRecommendationEngine: fallback to bestsellers when indexes empty', async () => {
  const redis = new MockRedis();
  const shop = 'gamma.myshopify.com';

  seedZSet(redis, `${ENGINE.FALLBACK_KEY}:${shop}`, [
    { member: '9', score: 100 },
    { member: '8', score: 90 },
  ]);

  seedProduct(redis, shop, {
    id: 9,
    collection_ids: ['1'],
    tags: ['z'],
    vendor: 'Z',
    price_cents: 5000,
    default_variant_id: 99,
    available: true,
  });

  const results = await runRecommendationEngine(redis, shop, [], 1, [], 'en');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 9);
});


test('runRecommendationEngine: co-purchase candidate outranks collection-only match', async () => {
  const redis = new MockRedis();
  const shop = 'alpha.myshopify.com';

  const cart = [{ id: 1, collection_ids: ['10'], tags: ['x'], vendor: 'A', price_cents: 1000 }];

  // Product 2 is reachable only via the collection index (weaker signal).
  seedSet(redis, `hybrid:idx:coll:${shop}:10`, ['2']);
  // Product 3 is reachable only via co-purchase history (strongest signal).
  seedCopurchase(redis, shop, 1, [{ member: '3', score: 8 }]);

  seedProduct(redis, shop, {
    id: 2, collection_ids: ['10'], tags: [], vendor: 'B',
    price_cents: 9999, default_variant_id: 22, available: true,
  });
  seedProduct(redis, shop, {
    id: 3, collection_ids: ['99'], tags: [], vendor: 'C',
    price_cents: 9999, default_variant_id: 33, available: true,
  });

  const results = await runRecommendationEngine(redis, shop, cart, 2, [1], 'en');
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 3);
  assert.equal(results[0].reason, 'frequently_bought_together');
  assert.ok(results[0].score > results[1].score);
});

test('runRecommendationEngine: co-purchase respects excludeSet', async () => {
  const redis = new MockRedis();
  const shop = 'alpha.myshopify.com';

  const cart = [{ id: 1, collection_ids: ['10'], tags: [], vendor: 'A', price_cents: 1000 }];
  seedSet(redis, `hybrid:idx:coll:${shop}:10`, ['2']);
  seedCopurchase(redis, shop, 1, [{ member: '3', score: 8 }]);

  seedProduct(redis, shop, {
    id: 2, collection_ids: ['10'], tags: [], vendor: 'B',
    price_cents: 5000, default_variant_id: 22, available: true,
  });
  seedProduct(redis, shop, {
    id: 3, collection_ids: ['99'], tags: [], vendor: 'C',
    price_cents: 5000, default_variant_id: 33, available: true,
  });

  // Exclude both the cart product and the co-purchased product 3.
  const results = await runRecommendationEngine(redis, shop, cart, 5, [1, 3], 'en');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 2);
});

test('runRecommendationEngine: co-purchase weight saturates at W_COPURCHASE', async () => {
  const redis = new MockRedis();
  const shop = 'alpha.myshopify.com';

  const cart = [{ id: 1, collection_ids: [], tags: [], vendor: 'A', price_cents: 1000 }];
  // Score far above the saturation point — contribution must still be capped.
  seedCopurchase(redis, shop, 1, [{ member: '7', score: 1000 }]);
  seedProduct(redis, shop, {
    id: 7, collection_ids: [], tags: [], vendor: 'Z',
    price_cents: 9999, default_variant_id: 77, available: true,
  });

  const results = await runRecommendationEngine(redis, shop, cart, 1, [1], 'en');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 7);
  assert.ok(results[0].score <= ENGINE.W_COPURCHASE + 0.06); // copurchase + inventory at most
});


test('selectFinal: respects per-collection diversity cap', () => {
  const scored = [
    { id: 1, score: 1, price_cents: 1000, collection_ids: ['1'] },
    { id: 2, score: 0.9, price_cents: 900, collection_ids: ['1'] },
    { id: 3, score: 0.8, price_cents: 800, collection_ids: ['1'] },
    { id: 4, score: 0.7, price_cents: 700, collection_ids: ['2'] },
  ];

  const final = selectFinal(scored, 4);
  assert.equal(final.length, 3);
  assert.equal(final.filter((p) => p.collection_ids[0] === '1').length, 2);
});


test('scoreCandidates: scores are rounded to 3 decimals', () => {
  const candidates = [{
    id: 1,
    collection_ids: ['1'],
    tags: ['x'],
    vendor: 'A',
    price_cents: 1000,
    inventory_quantity: 25,
  }];

  const ctx = {
    collections: new Set(['1']),
    tags: new Set(['x']),
    vendors: new Set(['A']),
    priceAvg: 1000,
  };

  const scored = scoreCandidates(candidates, ctx);
  assert.equal(String(scored[0].score).split('.')[1].length <= 3, true);
});
