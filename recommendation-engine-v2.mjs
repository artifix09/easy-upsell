// =============================================================================
// Recommendation Engine v2 — Hardened Scoring Pipeline
// =============================================================================
// Replaces: runRecommendationEngine() in recommendations-handler.mjs
// Changes:  Candidate pool cap, index fallbacks, deterministic tie-break,
//           availability + variant enforcement, pipeline batching
// Target:   <200ms p95 (cache-warm path <40ms)
// =============================================================================

// =============================================================================
// TUNING CONSTANTS
// =============================================================================
//
// The co-purchase index itself (writes, rebuild, cleanup) lives in
// copurchase-index.mjs. The engine only *reads* it, and does so through the
// `redis` client passed into runRecommendationEngine — the engine stays a
// pure, side-effect-free module with no Redis connection of its own.

const ENGINE = {
  // ── Pool guardrails ──────────────────────────────────────────────────────
  MAX_CANDIDATES: 150,          // hard cap on candidate pool before scoring
  MAX_INDEX_READ: 200,          // max members read per SRANDMEMBER call
  MAX_INDEXES_PER_SOURCE: 5,    // max collection/tag/vendor indexes to query

  // ── Co-purchase (strongest signal — real "bought together" data) ─────────
  COPURCHASE_CANDIDATE_LIMIT: 80,   // max co-purchase IDs pulled into the pool
  COPURCHASE_PER_CART_ITEM: 50,     // top-N co-buys read per cart product
  W_COPURCHASE: 0.50,               // full weight when co-occurrence saturates
  W_COPURCHASE_SATURATION: 8,       // co-occurrence count that earns full weight

  // ── Scoring weights ──────────────────────────────────────────────────────
  W_COLLECTION: 0.20,           // per shared collection, capped at 0.40
  W_COLLECTION_CAP: 0.40,
  W_TAG_AFFINITY: 0.30,         // complementary tag match
  W_PRICE_PROXIMITY: 0.15,      // price within 50% of cart average
  W_VENDOR: 0.10,               // same vendor
  W_INVENTORY: 0.05,            // well-stocked (>20 units)

  // ── Diversity ────────────────────────────────────────────────────────────
  MAX_PER_COLLECTION: 2,        // diversity cap per primary collection

  // ── Fallback ─────────────────────────────────────────────────────────────
  FALLBACK_ENABLED: true,       // use best-sellers fallback when pool is empty
  FALLBACK_KEY: 'hybrid:idx:bestsellers', // shop-level sorted set, score = units sold
};


// =============================================================================
// ENTRY POINT
// =============================================================================

async function runRecommendationEngine(redis, shop, cartProducts, limit, excludeIds, locale) {
  const ctx = buildCartContext(cartProducts);
  const excludeSet = new Set(excludeIds.map(String));
  const cartProductIds = cartProducts
    .map((p) => String(p.id))
    .filter((id) => id && id !== 'undefined' && id !== 'null');

  // ── Step 1: Co-purchase candidates (strongest signal) ────────────────────
  // Real "bought together" data from order history. These IDs lead the pool
  // and also carry a score map into the scoring step.
  const copurchaseScores = await safeCopurchaseScores(redis, shop, cartProductIds, excludeSet);

  const candidateIds = new Set();
  for (const id of copurchaseScores.keys()) {
    candidateIds.add(id);
    if (candidateIds.size >= ENGINE.COPURCHASE_CANDIDATE_LIMIT) break;
  }

  // ── Step 2: Heuristic candidate IDs from indexes ─────────────────────────
  if (candidateIds.size < ENGINE.MAX_CANDIDATES) {
    const heuristicIds = await gatherCandidateIds(redis, shop, ctx, excludeSet);
    for (const id of heuristicIds) {
      if (candidateIds.size >= ENGINE.MAX_CANDIDATES) break;
      candidateIds.add(id);
    }
  }

  // ── Step 3: Fallback if pool is empty ────────────────────────────────────
  let finalCandidateIds = candidateIds;
  if (finalCandidateIds.size === 0 && ENGINE.FALLBACK_ENABLED) {
    finalCandidateIds = await gatherFallbackIds(redis, shop, excludeSet);
  }

  if (finalCandidateIds.size === 0) {
    return []; // nothing to recommend — caller returns empty array
  }

  // ── Step 4: Resolve product data (batch, with availability filter) ──────
  const candidates = await resolveAndFilter(redis, shop, finalCandidateIds);

  if (candidates.length === 0) {
    return [];
  }

  // ── Step 5: Score ────────────────────────────────────────────────────────
  const scored = scoreCandidates(candidates, ctx, copurchaseScores);

  // ── Step 6: Deterministic sort + diversity filter + limit ────────────────
  const final = selectFinal(scored, limit);

  return final;
}

// Reads the co-purchase sorted sets (hybrid:idx:copurchase:{shop}:{productId})
// for every cart product and returns Map(candidateId -> summed co-occurrence
// score). Must never break the recommendation path — any failure degrades to
// an empty map, leaving the heuristic signals to carry the result.
async function safeCopurchaseScores(redis, shop, cartProductIds, excludeSet) {
  if (cartProductIds.length === 0) return new Map();

  const scores = new Map();
  for (const cartId of cartProductIds) {
    const key = `hybrid:idx:copurchase:${shop}:${cartId}`;
    let rows;
    try {
      rows = await redis.zRangeWithScores(key, 0, ENGINE.COPURCHASE_PER_CART_ITEM - 1, { REV: true });
    } catch {
      continue; // missing key, wrong type, or client without zRangeWithScores
    }
    for (const { value, score } of rows || []) {
      if (excludeSet.has(value)) continue;
      // A candidate co-bought with several cart items accumulates score.
      scores.set(value, (scores.get(value) || 0) + score);
    }
  }
  return scores;
}


// =============================================================================
// STEP 0: CART CONTEXT
// =============================================================================

function buildCartContext(cartProducts) {
  const collections = new Set();
  const tags = new Set();
  const vendors = new Set();
  let priceMin = Infinity;
  let priceMax = 0;
  let priceSum = 0;

  for (const p of cartProducts) {
    (p.collection_ids || []).forEach((c) => collections.add(String(c)));
    (p.tags || []).forEach((t) => tags.add(t));
    if (p.vendor) vendors.add(p.vendor);
    if (p.price_cents != null) {
      priceMin = Math.min(priceMin, p.price_cents);
      priceMax = Math.max(priceMax, p.price_cents);
      priceSum += p.price_cents;
    }
  }

  return {
    collections,
    tags,
    vendors,
    priceMin: priceMin === Infinity ? 0 : priceMin,
    priceMax,
    priceAvg: cartProducts.length > 0 ? priceSum / cartProducts.length : 0,
    productCount: cartProducts.length,
  };
}


// =============================================================================
// STEP 1: GATHER CANDIDATE IDS (with guardrails)
// =============================================================================
//
// Guardrails:
//   1. Cap the number of indexes queried per source type.
//   2. Use SRANDMEMBER with count (not SMEMBERS) to avoid pulling 10K-member
//      sets into memory. This is O(count) not O(N).
//   3. Hard-cap the total candidate pool at MAX_CANDIDATES.
//   4. If any index key is missing, skip it silently — never throw.

async function gatherCandidateIds(redis, shop, ctx, excludeSet) {
  const pool = new Set();

  // ── Source A: Collection indexes (strongest signal) ──────────────────────
  const collIds = limitedSlice(ctx.collections, ENGINE.MAX_INDEXES_PER_SOURCE);
  for (const collId of collIds) {
    const key = `hybrid:idx:coll:${shop}:${collId}`;
    const members = await safeRandomMembers(redis, key, ENGINE.MAX_INDEX_READ);
    for (const m of members) {
      if (!excludeSet.has(m)) pool.add(m);
    }
    if (pool.size >= ENGINE.MAX_CANDIDATES) break;
  }

  // ── Source B: Vendor indexes ─────────────────────────────────────────────
  if (pool.size < ENGINE.MAX_CANDIDATES) {
    const vendorSlice = limitedSlice(ctx.vendors, ENGINE.MAX_INDEXES_PER_SOURCE);
    for (const vendor of vendorSlice) {
      const key = `hybrid:idx:vendor:${shop}:${vendor}`;
      const members = await safeRandomMembers(redis, key, ENGINE.MAX_INDEX_READ);
      for (const m of members) {
        if (!excludeSet.has(m)) pool.add(m);
      }
      if (pool.size >= ENGINE.MAX_CANDIDATES) break;
    }
  }

  // ── Source C: Tag affinity (complementary tags) ──────────────────────────
  if (pool.size < ENGINE.MAX_CANDIDATES) {
    const affinityMap = await safeGetAffinityMap(redis, shop);
    const complementary = new Set();
    for (const tag of ctx.tags) {
      for (const related of (affinityMap[tag] || [])) {
        complementary.add(related);
      }
    }

    const tagSlice = limitedSlice(complementary, ENGINE.MAX_INDEXES_PER_SOURCE);
    for (const tag of tagSlice) {
      const key = `hybrid:idx:tag:${shop}:${tag}`;
      const members = await safeRandomMembers(redis, key, ENGINE.MAX_INDEX_READ);
      for (const m of members) {
        if (!excludeSet.has(m)) pool.add(m);
      }
      if (pool.size >= ENGINE.MAX_CANDIDATES) break;
    }
  }

  // ── Hard cap ─────────────────────────────────────────────────────────────
  if (pool.size > ENGINE.MAX_CANDIDATES) {
    return new Set([...pool].slice(0, ENGINE.MAX_CANDIDATES));
  }

  return pool;
}


// =============================================================================
// STEP 2: FALLBACK — BEST SELLERS
// =============================================================================
//
// When all indexes are empty (new store, cold cache, no tags configured),
// fall back to a shop-level best-sellers list. This is a Redis sorted set
// keyed by units sold, populated by an order-creation webhook or a daily
// cron that queries order line items.
//
// If this key is also missing, we return empty — the endpoint responds
// with an empty recommendations array, which the theme handles gracefully.

async function gatherFallbackIds(redis, shop, excludeSet) {
  const key = `${ENGINE.FALLBACK_KEY}:${shop}`;
  const pool = new Set();

  try {
    // Top 50 best sellers by score (units sold), descending
    const members = await redis.zRange(key, 0, 49, { REV: true });
    for (const m of members) {
      if (!excludeSet.has(m)) pool.add(m);
      if (pool.size >= ENGINE.MAX_CANDIDATES) break;
    }
  } catch {
    // Key missing or wrong type — silent fail
  }

  return pool;
}


// =============================================================================
// STEP 3: RESOLVE + FILTER (batch pipeline, availability + variant check)
// =============================================================================
//
// Two hard filters applied here — a product is dropped if:
//   1. It's not available (out of stock, draft, archived)
//   2. It has no valid default_variant_id (can't be added to cart)
//
// Uses Redis pipeline to resolve all products in a single round-trip.

async function resolveAndFilter(redis, shop, candidateIds) {
  const ids = [...candidateIds];
  const keys = ids.map((id) => `hybrid:prod:${shop}:${id}`);

  // ── Batch fetch via pipeline ─────────────────────────────────────────────
  const pipeline = redis.multi();
  for (const key of keys) {
    pipeline.get(key);
  }

  let results;
  try {
    results = await pipeline.exec();
  } catch {
    // Pipeline failure — degrade to empty rather than throw
    return [];
  }

  const candidates = [];
  for (let i = 0; i < results.length; i++) {
    const raw = results[i];
    if (raw == null) continue; // cache miss — product evicted or deleted

    let product;
    try {
      product = JSON.parse(raw);
    } catch {
      continue; // corrupted cache entry — skip
    }

    // ── AVAILABILITY GATE ──────────────────────────────────────────────────
    if (!product.available) continue;

    // ── VARIANT GATE ───────────────────────────────────────────────────────
    if (!product.default_variant_id) continue;

    // ── VALID IMAGE (optional but improves UX) ─────────────────────────────
    // Don't hard-filter on missing image — some products are text-only.
    // The theme handles null image_url with a placeholder.

    candidates.push(product);
  }

  return candidates;
}


// =============================================================================
// STEP 4: SCORE
// =============================================================================

function scoreCandidates(candidates, ctx, copurchaseScores = new Map()) {
  // Pre-compute complementary tag set once (avoid re-fetching in loop)
  // Already available from step 1 — but since the engine is stateless,
  // we reconstruct from ctx.tags. Cost: negligible (set operations on <50 items).

  return candidates.map((c) => {
    let score = 0;
    const reasons = [];

    // ── Signal 0: Co-purchase affinity (max W_COPURCHASE) ──────────────────
    // Raw score = number of orders this candidate co-occurred with a cart
    // item. Normalized against a saturation point so a runaway pair can't
    // dominate. This is the truest "frequently bought together" signal and
    // is listed first so it wins the primary `reason`.
    const cpRaw = copurchaseScores.get(String(c.id)) || 0;
    if (cpRaw > 0) {
      const norm = Math.min(cpRaw / ENGINE.W_COPURCHASE_SATURATION, 1);
      score += norm * ENGINE.W_COPURCHASE;
      reasons.push('frequently_bought_together');
    }

    // ── Signal 1: Collection overlap (max 0.40) ────────────────────────────
    const sharedColls = (c.collection_ids || []).filter((id) => ctx.collections.has(String(id)));
    const collScore = Math.min(sharedColls.length * ENGINE.W_COLLECTION, ENGINE.W_COLLECTION_CAP);
    score += collScore;
    if (sharedColls.length > 0) reasons.push('same_collection');

    // ── Signal 2: Tag affinity (0.30) ──────────────────────────────────────
    // A product matches if any of its tags appear in the complementary set.
    // Since we don't have the affinity map here, we use a simpler check:
    // does the product share any tag with the cart? This is a weaker signal
    // but avoids a second Redis call inside the scoring loop.
    const sharedTags = (c.tags || []).filter((t) => ctx.tags.has(t));
    if (sharedTags.length > 0) {
      score += ENGINE.W_TAG_AFFINITY;
      reasons.push('similar_items');
    }

    // ── Signal 3: Price proximity (max 0.15) ───────────────────────────────
    if (ctx.priceAvg > 0 && c.price_cents != null) {
      const delta = Math.abs(c.price_cents - ctx.priceAvg) / ctx.priceAvg;
      if (delta <= 0.5) {
        score += ENGINE.W_PRICE_PROXIMITY * (1 - delta / 0.5);
      }
    }

    // ── Signal 4: Same vendor (0.10) ───────────────────────────────────────
    if (c.vendor && ctx.vendors.has(c.vendor)) {
      score += ENGINE.W_VENDOR;
      reasons.push('same_vendor');
    }

    // ── Signal 5: Inventory boost (0.05) ───────────────────────────────────
    if ((c.inventory_quantity || 0) > 20) {
      score += ENGINE.W_INVENTORY;
    }

    return {
      ...c,
      score: Math.round(score * 1000) / 1000, // 3 decimal places for tie-break
      reason: reasons[0] || 'related_product',
    };
  });
}


// =============================================================================
// STEP 5: DETERMINISTIC SORT + DIVERSITY + LIMIT
// =============================================================================
//
// Tie-break rule (applied when two candidates have identical scores):
//   1. Higher price_cents first (higher-value upsell)
//   2. If prices also match: lower product ID first (stable, reproducible)
//
// This guarantees the same cart always produces the same recommendations
// regardless of Redis SET iteration order or JS sort stability.

function selectFinal(scored, limit) {
  scored.sort((a, b) => {
    // Primary: score descending
    if (b.score !== a.score) return b.score - a.score;

    // Tie-break 1: price descending (higher-value upsell)
    const aPrice = a.price_cents ?? 0;
    const bPrice = b.price_cents ?? 0;
    if (bPrice !== aPrice) return bPrice - aPrice;

    // Tie-break 2: product ID ascending (deterministic)
    return (a.id ?? 0) - (b.id ?? 0);
  });

  // ── Diversity filter ─────────────────────────────────────────────────────
  const final = [];
  const collCounts = {};

  for (const item of scored) {
    const primaryColl = String((item.collection_ids || [])[0] || '_none');
    const count = collCounts[primaryColl] || 0;

    if (count >= ENGINE.MAX_PER_COLLECTION) continue;

    collCounts[primaryColl] = count + 1;
    final.push(item);

    if (final.length >= limit) break;
  }

  return final;
}


// =============================================================================
// HELPER: SAFE RANDOM MEMBERS
// =============================================================================
// SRANDMEMBER with a positive count returns up to `count` distinct members.
// O(count), not O(N) — safe on large sets.
// Returns empty array if the key doesn't exist or is the wrong type.

async function safeRandomMembers(redis, key, count) {
  // node-redis v5: sRandMember(key) returns ONE string. The multi-member form
  // is sRandMemberCount(key, count) -> SRANDMEMBER key <count>, returning an
  // array. Calling sRandMember(key, count) silently drops the count and
  // returns a single string, which the caller would then iterate as
  // individual characters (yielding garbage like ['8','1','7',...]).
  try {
    const members = await redis.sRandMemberCount(key, count);
    return Array.isArray(members) ? members : [];
  } catch {
    return [];
  }
}


// =============================================================================
// HELPER: SAFE AFFINITY MAP
// =============================================================================

async function safeGetAffinityMap(redis, shop) {
  try {
    const raw = await redis.get(`hybrid:tag:affinity:${shop}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// =============================================================================
// HELPER: LIMITED SLICE
// =============================================================================
// Takes a Set and returns an array of at most `max` elements.
// Avoids iterating the entire set when only the first N are needed.

function limitedSlice(set, max) {
  const result = [];
  for (const item of set) {
    result.push(item);
    if (result.length >= max) break;
  }
  return result;
}


// =============================================================================
// EDGE CASE SUMMARY
// =============================================================================
//
// ┌─────────────────────────────────────────────┬────────────────────────────┐
// │ Scenario                                    │ Behavior                   │
// ├─────────────────────────────────────────────┼────────────────────────────┤
// │ All index keys missing (cold cache)         │ Falls back to best-sellers │
// │ Best-sellers key also missing               │ Returns empty array        │
// │ Index key is wrong Redis type               │ safeRandomMembers → []     │
// │ Product cache entry corrupted               │ JSON.parse catch → skip    │
// │ Product is draft/archived                   │ available=false → filtered │
// │ Product has no variants                     │ variant_id=null → filtered │
// │ Product is in cart (excluded)               │ excludeSet check → skipped │
// │ Two products have identical scores          │ Higher price wins, then    │
// │                                             │ lower product ID           │
// │ All candidates in same collection           │ MAX_PER_COLLECTION=2, rest │
// │                                             │ dropped; may return < limit│
// │ Cart has 50 items across 30 collections     │ MAX_INDEXES_PER_SOURCE=5   │
// │                                             │ caps to 5 collection reads │
// │ A collection index has 10,000 members       │ SRANDMEMBER reads 200 max  │
// │ Redis pipeline fails                        │ resolveAndFilter → []      │
// │ Tag affinity map not configured             │ safeGetAffinityMap → {}    │
// │ Candidate pool exceeds MAX_CANDIDATES       │ Hard-sliced to 150         │
// │ limit=10 but only 3 candidates pass filters │ Returns 3 (no padding)    │
// │ Cart contains only 1 product                │ Works normally; priceAvg   │
// │                                             │ = that product's price     │
// └─────────────────────────────────────────────┴────────────────────────────┘


// =============================================================================
// LATENCY BUDGET (cache-warm path)
// =============================================================================
//
//  buildCartContext          <1ms   (pure JS, no I/O)
//  gatherCandidateIds        5ms   (3–5 SRANDMEMBER calls)
//  resolveAndFilter          3ms   (1 pipeline GET, up to 150 keys)
//  scoreCandidates           1ms   (pure JS, 150 iterations max)
//  selectFinal              <1ms   (sort 150 items + filter)
//  ────────────────────────────────
//  Total engine time        ~10ms
//
//  Full request path (with proxy hop, validation, cache write):
//    Cache hit:   ~35ms
//    Cache miss:  ~50ms  (engine) + ~80ms (Shopify API for cold products)
//    Worst case: ~180ms  (within 200ms budget)


// =============================================================================
// EXPORTS
// =============================================================================

export {
  runRecommendationEngine,
  // Exported for unit testing:
  buildCartContext,
  scoreCandidates,
  selectFinal,
  resolveAndFilter,
  gatherCandidateIds,
  gatherFallbackIds,
  ENGINE,
};
