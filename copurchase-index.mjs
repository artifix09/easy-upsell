// =============================================================================
// Co-purchase Index — "frequently bought together" signal
// =============================================================================
// The heuristic engine scores on shared collection / tag / vendor / price.
// That answers "what is similar" — not "what is actually bought together".
// This module builds the latter from real order history, which is the single
// highest-value signal for an upsell product.
//
// Storage:
//   hybrid:idx:copurchase:{shop}:{productId}
//     Redis sorted set. Members = other products bought in the same orders.
//     Score   = number of orders the pair co-occurred in.
//
// Update sources:
//   1. orders/create webhook   — incremental ZINCRBY on every ordered pair
//   2. orders/cancelled webhook — reverse the increments
//   3. periodic rebuild         — full recompute from order history (drift fix)
//
// Idempotency: the orders/create webhook handler dedups by order ID *before*
// calling recordOrderCopurchases, so each order contributes exactly once.
// =============================================================================

import { redis } from './redis-client.mjs';

const CONFIG = {
  KEY_PREFIX: 'hybrid:idx:copurchase',
  PAIR_TTL: 90 * 86_400,        // sets expire if a product stops co-selling
  MAX_PRODUCTS_PER_ORDER: 40,   // cap pair explosion on huge orders (40 → 1560 pairs)
  MAX_SET_MEMBERS: 200,         // trim each product's set to its top co-buys
};

function logCopurchase(event, data = {}) {
  console.log(JSON.stringify({
    component: 'copurchase',
    event,
    ts: new Date().toISOString(),
    ...data,
  }));
}

function keyFor(shop, productId) {
  return `${CONFIG.KEY_PREFIX}:${shop}:${productId}`;
}

// Distinct, capped list of product IDs from an order's line items.
function distinctProductIds(lineItems) {
  const ids = new Set();
  for (const line of lineItems || []) {
    if (line.product_id == null) continue;
    ids.add(String(line.product_id));
    if (ids.size >= CONFIG.MAX_PRODUCTS_PER_ORDER) break;
  }
  return [...ids];
}

// --------------------------------------------------------------------------
// WRITE: record co-purchases for one order (delta = +1) or reversal (-1)
// --------------------------------------------------------------------------

async function applyOrderDelta(shop, lineItems, delta) {
  const ids = distinctProductIds(lineItems);
  if (ids.length < 2) return { pairs: 0 };

  const pipeline = redis.multi();
  let pairs = 0;

  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const key = keyFor(shop, ids[i]);
      pipeline.zIncrBy(key, delta, ids[j]);
      pairs++;
    }
    if (delta > 0) {
      pipeline.expire(keyFor(shop, ids[i]), CONFIG.PAIR_TTL);
    }
  }

  await pipeline.exec();

  if (delta < 0) {
    // Clean up members that fell to zero or below after a cancellation.
    const cleanup = redis.multi();
    for (const id of ids) {
      cleanup.zRemRangeByScore(keyFor(shop, id), '-inf', '0');
    }
    await cleanup.exec();
  }

  return { pairs };
}

export async function recordOrderCopurchases(shop, lineItems) {
  const { pairs } = await applyOrderDelta(shop, lineItems, 1);
  if (pairs > 0) logCopurchase('order_recorded', { shop, pairs });
  return { pairs };
}

export async function decrementOrderCopurchases(shop, lineItems) {
  const { pairs } = await applyOrderDelta(shop, lineItems, -1);
  if (pairs > 0) logCopurchase('order_decremented', { shop, pairs });
  return { pairs };
}

// --------------------------------------------------------------------------
// CLEANUP: product deletion
// --------------------------------------------------------------------------
// Drop the deleted product's own set. It may still linger as a *member* of
// other products' sets, but the recommendation engine resolves candidates
// against the product cache and silently skips missing products, so orphan
// members are harmless. The periodic rebuild removes them entirely.

export async function removeProductFromCopurchase(shop, productId) {
  await redis.del(keyFor(shop, productId));
}

// Note: the recommendation engine *reads* these sets directly through its own
// redis client (see safeCopurchaseScores in recommendation-engine-v2.mjs) so
// the engine stays free of Redis-connection side effects. This module owns
// only the write/rebuild/cleanup side. The key format is shared by contract:
//   hybrid:idx:copurchase:{shop}:{productId}

// --------------------------------------------------------------------------
// PERIODIC REBUILD — full recompute from order history
// --------------------------------------------------------------------------
// Called from the best-sellers sync (which already holds the order list) so
// we don't fetch orders twice. Rebuilds atomically per product set.

export async function rebuildCopurchaseFromOrders(shop, orders) {
  const start = Date.now();

  // pairCounts: Map(productId -> Map(otherId -> count))
  const pairCounts = new Map();

  for (const order of orders) {
    if (order.cancelled_at || order.financial_status === 'refunded') continue;
    const ids = distinctProductIds(order.line_items);
    if (ids.length < 2) continue;

    for (const a of ids) {
      let inner = pairCounts.get(a);
      if (!inner) {
        inner = new Map();
        pairCounts.set(a, inner);
      }
      for (const b of ids) {
        if (a === b) continue;
        inner.set(b, (inner.get(b) || 0) + 1);
      }
    }
  }

  if (pairCounts.size === 0) {
    logCopurchase('rebuild_empty', { shop, orders_scanned: orders.length });
    return { products: 0 };
  }

  const pipeline = redis.multi();
  for (const [productId, inner] of pairCounts) {
    const key = keyFor(shop, productId);
    pipeline.del(key);
    const members = [...inner.entries()].map(([value, score]) => ({ score, value }));
    pipeline.zAdd(key, members);
    // Keep only the top MAX_SET_MEMBERS co-buys (rank 0 = lowest score).
    if (members.length > CONFIG.MAX_SET_MEMBERS) {
      pipeline.zRemRangeByRank(key, 0, members.length - CONFIG.MAX_SET_MEMBERS - 1);
    }
    pipeline.expire(key, CONFIG.PAIR_TTL);
  }
  await pipeline.exec();

  logCopurchase('rebuild_complete', {
    shop,
    products: pairCounts.size,
    orders_scanned: orders.length,
    duration_ms: Date.now() - start,
  });
  return { products: pairCounts.size };
}

export { CONFIG as COPURCHASE_CONFIG, distinctProductIds };
