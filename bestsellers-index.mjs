// =============================================================================
// Best-Sellers Index — Webhook Handler + Periodic Sync
// =============================================================================
// Maintains a Redis sorted set per shop ranking products by units sold.
// Used as the fallback source when the recommendation engine's primary
// indexes (collection, tag, vendor) return an empty candidate pool.
//
// Key:     idx:bestsellers:{shop}
// Score:   cumulative units sold (ZINCRBY on each order)
// Member:  product ID (string)
//
// Update sources:
//   1. orders/create webhook  — real-time, incremental
//   2. Periodic sync job      — daily, full rebuild (consistency backstop)
//
// Idempotency:
//   Shopify may deliver the same webhook multiple times. We track processed
//   order IDs in a Redis set with a 7-day TTL. Duplicate deliveries are
//   detected and skipped before any ZINCRBY runs.
// =============================================================================

import express from 'express';
import { redis } from './redis-client.mjs';
import { verifyWebhookHmac } from './hmac-validators.mjs';
import { adminGraphQL } from './shopify-admin-graphql.mjs';
import { listInstalledShops } from './postgres-store.mjs';
import { attributeOrderConversion } from './analytics.mjs';
import {
  recordOrderCopurchases,
  decrementOrderCopurchases,
  rebuildCopurchaseFromOrders,
} from './copurchase-index.mjs';

// =============================================================================
// CONFIG
// =============================================================================

const CONFIG = {
  APP_SECRET: process.env.SHOPIFY_API_SECRET,
  BESTSELLERS_KEY_PREFIX: 'hybrid:idx:bestsellers',
  DEDUP_KEY_PREFIX: 'hybrid:webhook:order:seen',
  DEDUP_TTL: 604_800,          // 7 days — covers Shopify's retry window
  BESTSELLERS_MAX_MEMBERS: 500, // cap set size per shop (trim tail on sync)
  SYNC_LOOKBACK_DAYS: 90,       // periodic job: orders from last 90 days
};

// =============================================================================
// EXPRESS SETUP
// =============================================================================

const app = express();
app.use('/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));


// =============================================================================
// HMAC VERIFICATION (shared with other webhook handlers)
// =============================================================================

function verifyWebhook(req) {
  const result = verifyWebhookHmac({
    secret: CONFIG.APP_SECRET,
    rawBody: req.body,
    signature: req.headers['x-shopify-hmac-sha256'],
  });
  if (!result.ok && !CONFIG.APP_SECRET) {
    console.error('[security] APP_SECRET not configured');
  }
  return result.ok;
}

async function webhookGate(req, res) {
  if (!verifyWebhook(req)) {
    logEvent('rejected', { reason: 'invalid_hmac' });
    res.status(401).end();
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf-8'));
  } catch {
    logEvent('rejected', { reason: 'malformed_json' });
    res.status(400).end();
    return null;
  }

  const shop = req.headers['x-shopify-shop-domain'];
  if (!shop) {
    logEvent('rejected', { reason: 'missing_shop' });
    res.status(400).end();
    return null;
  }

  if (!SHOP_DOMAIN_REGEX.test(shop)) {
    logEvent('rejected', { reason: 'invalid_shop', shop });
    res.status(400).end();
    return null;
  }

  try {
    const installed = await redis.exists(`hybrid:shop:installed:${shop}`);
    if (installed !== 1) {
      logEvent('rejected', { reason: 'shop_not_installed', shop });
      res.status(403).end();
      return null;
    }
  } catch (error) {
    logEvent('error', { reason: 'shop_lookup_failed', shop, message: error.message });
  }

  return { payload, shop };
}

const SHOP_DOMAIN_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;


// =============================================================================
// ROUTE: orders/create
// =============================================================================
//
// Shopify order webhook payload includes line_items[], each with:
//   { product_id, variant_id, quantity, ... }
//
// We increment the sorted set score by quantity for each product.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ WHY orders/create, NOT orders/paid                                    │
// │                                                                       │
// │ orders/create fires once when the order is placed. orders/paid can   │
// │ fire multiple times (partial payments, manual captures). Since we    │
// │ track units sold (not revenue), create is the right event. Cancelled │
// │ orders are handled by the periodic sync which rebuilds from scratch. │
// └─────────────────────────────────────────────────────────────────────────┘

app.post('/webhooks/orders/create', async (req, res) => {
  const gate = await webhookGate(req, res);
  if (!gate) return;
  const { payload, shop } = gate;

  // Respond 200 immediately
  res.status(200).end();

  try {
    const orderId = payload.id;
    if (!orderId) {
      logEvent('skipped', { shop, reason: 'missing_order_id' });
      return;
    }

    // ── Idempotency check ──────────────────────────────────────────────────
    // Redis SET with NX: returns true only if the key didn't exist.
    // If it already existed, this is a duplicate delivery — skip.
    const dedupKey = `${CONFIG.DEDUP_KEY_PREFIX}:${shop}:${orderId}`;
    const isNew = await redis.set(dedupKey, '1', { NX: true, EX: CONFIG.DEDUP_TTL });

    if (!isNew) {
      logEvent('duplicate_skipped', { shop, order_id: orderId });
      return;
    }

    // ── Extract line items ─────────────────────────────────────────────────
    const lineItems = payload.line_items;
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      logEvent('skipped', { shop, order_id: orderId, reason: 'no_line_items' });
      return;
    }

    // ── Increment scores via pipeline ──────────────────────────────────────
    const bestsellersKey = `${CONFIG.BESTSELLERS_KEY_PREFIX}:${shop}`;
    const pipeline = redis.multi();
    let validLines = 0;
    let skippedLines = 0;

    for (const line of lineItems) {
      // ── Safety: skip lines without product_id ────────────────────────────
      // Custom line items (tips, gift wrapping) have product_id: null.
      // Gift cards may also lack a product_id depending on setup.
      if (!line.product_id) {
        skippedLines++;
        continue;
      }

      // Quantity is always positive on orders/create (no negative adjustments)
      const quantity = Math.max(0, parseInt(line.quantity, 10) || 0);
      if (quantity === 0) {
        skippedLines++;
        continue;
      }

      // ── ZINCRBY: O(log N) per call, atomic ────────────────────────────
      // If the member doesn't exist, it's created with score = quantity.
      // If it exists, score += quantity. Idempotent when guarded by dedup.
      pipeline.zIncrBy(bestsellersKey, quantity, String(line.product_id));
      validLines++;
    }

    if (validLines > 0) {
      await pipeline.exec();
    }

    // Co-purchase matrix + conversion attribution. Both are derived from the
    // same line items; failures here must not affect the best-sellers update.
    await recordOrderCopurchases(shop, lineItems).catch((err) => {
      logEvent('copurchase_error', { shop, order_id: orderId, error: err.message });
    });
    await attributeOrderConversion(shop, lineItems).catch((err) => {
      logEvent('conversion_error', { shop, order_id: orderId, error: err.message });
    });

    logEvent('order_processed', {
      shop,
      order_id: orderId,
      lines_scored: validLines,
      lines_skipped: skippedLines,
    });

  } catch (err) {
    logEvent('order_error', {
      shop,
      order_id: payload.id,
      error: err.message,
    });
  }
});


// =============================================================================
// ROUTE: orders/cancelled (optional — decrement on cancellation)
// =============================================================================
// If you want real-time accuracy on cancellations, subscribe to
// orders/cancelled and reverse the scores. The periodic sync handles
// this regardless, so this handler is optional.

app.post('/webhooks/orders/cancelled', async (req, res) => {
  const gate = await webhookGate(req, res);
  if (!gate) return;
  const { payload, shop } = gate;

  res.status(200).end();

  try {
    const orderId = payload.id;
    if (!orderId) return;

    // Only decrement if we previously processed this order
    const dedupKey = `${CONFIG.DEDUP_KEY_PREFIX}:${shop}:${orderId}`;
    const wasProcessed = await redis.exists(dedupKey);
    if (!wasProcessed) {
      logEvent('cancel_skipped', { shop, order_id: orderId, reason: 'not_tracked' });
      return;
    }

    const lineItems = payload.line_items;
    if (!Array.isArray(lineItems)) return;

    const bestsellersKey = `${CONFIG.BESTSELLERS_KEY_PREFIX}:${shop}`;
    const pipeline = redis.multi();
    let decremented = 0;

    for (const line of lineItems) {
      if (!line.product_id) continue;
      const quantity = Math.max(0, parseInt(line.quantity, 10) || 0);
      if (quantity === 0) continue;

      // Decrement: ZINCRBY with negative value
      pipeline.zIncrBy(bestsellersKey, -quantity, String(line.product_id));
      decremented++;
    }

    if (decremented > 0) {
      await pipeline.exec();

      // Clean up any members that dropped to 0 or below
      await redis.zRemRangeByScore(bestsellersKey, '-inf', '0');
    }

    // Reverse the co-purchase increments this order contributed.
    await decrementOrderCopurchases(shop, lineItems).catch((err) => {
      logEvent('copurchase_decrement_error', { shop, order_id: orderId, error: err.message });
    });

    // Remove dedup key so re-orders of the same ID aren't blocked
    await redis.del(dedupKey);

    logEvent('order_cancelled', {
      shop,
      order_id: orderId,
      lines_decremented: decremented,
    });

  } catch (err) {
    logEvent('cancel_error', {
      shop,
      order_id: payload.id,
      error: err.message,
    });
  }
});


// =============================================================================
// PRODUCT DELETION CLEANUP
// =============================================================================
// Called from the existing products/delete webhook handler.
// Removes the product from the best-sellers set so deleted products
// never appear in fallback recommendations.

async function removeProductFromBestsellers(shop, productId) {
  const key = `${CONFIG.BESTSELLERS_KEY_PREFIX}:${shop}`;
  await redis.zRem(key, String(productId));
}


// =============================================================================
// PERIODIC SYNC JOB
// =============================================================================
// Full rebuild of the best-sellers index from order history.
// Run daily via cron (e.g., 3 AM UTC) to correct drift from:
//   - Missed webhooks
//   - Cancelled/refunded orders not caught in real time
//   - App reinstalls or Redis flushes
//
// Strategy:
//   1. Fetch all orders from last 90 days via Admin API (paginated)
//   2. Aggregate units sold per product in memory
//   3. Write the full sorted set atomically (MULTI/EXEC)
//   4. Trim to top 500 products
//
// This is a background job — no latency requirement. Runs once per shop.

async function rebuildBestsellersIndex(shop) {
  const start = Date.now();

  try {
    // ── Step 1: Fetch orders ─────────────────────────────────────────────
    const orders = await fetchRecentOrders(shop, CONFIG.SYNC_LOOKBACK_DAYS);

    // ── Step 2: Aggregate units per product ──────────────────────────────
    const unitsByProduct = new Map();

    for (const order of orders) {
      // Skip cancelled/refunded orders
      if (order.cancelled_at || order.financial_status === 'refunded') continue;

      for (const line of (order.line_items || [])) {
        if (!line.product_id) continue;
        const pid = String(line.product_id);
        const qty = Math.max(0, parseInt(line.quantity, 10) || 0);
        unitsByProduct.set(pid, (unitsByProduct.get(pid) || 0) + qty);
      }
    }

    if (unitsByProduct.size === 0) {
      logEvent('sync_empty', { shop, orders_scanned: orders.length });
      return;
    }

    // ── Step 3: Atomic write ─────────────────────────────────────────────
    // Delete old set and write new one in a single MULTI/EXEC.
    // This avoids a window where the set is partially written.
    const key = `${CONFIG.BESTSELLERS_KEY_PREFIX}:${shop}`;
    const pipeline = redis.multi();
    pipeline.del(key);

    for (const [pid, units] of unitsByProduct) {
      pipeline.zAdd(key, { score: units, value: pid });
    }

    // ── Step 4: Trim to top N ────────────────────────────────────────────
    // ZREMRANGEBYRANK removes everything except the top MAX_MEMBERS.
    // Rank 0 = lowest score. We remove from 0 to -(MAX+1) to keep the top.
    if (unitsByProduct.size > CONFIG.BESTSELLERS_MAX_MEMBERS) {
      const cutoff = unitsByProduct.size - CONFIG.BESTSELLERS_MAX_MEMBERS;
      pipeline.zRemRangeByRank(key, 0, cutoff - 1);
    }

    await pipeline.exec();

    // Rebuild the co-purchase matrix from the same order set — avoids a
    // second Admin API pass over order history.
    await rebuildCopurchaseFromOrders(shop, orders).catch((err) => {
      logEvent('copurchase_rebuild_error', { shop, error: err.message });
    });

    const elapsed = Date.now() - start;
    logEvent('sync_complete', {
      shop,
      orders_scanned: orders.length,
      products_indexed: Math.min(unitsByProduct.size, CONFIG.BESTSELLERS_MAX_MEMBERS),
      duration_ms: elapsed,
    });

  } catch (err) {
    logEvent('sync_error', {
      shop,
      error: err.message,
      duration_ms: Date.now() - start,
    });
  }
}


// =============================================================================
// ADMIN API: FETCH RECENT ORDERS
// =============================================================================
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ PLUG-IN POINT: Shopify Admin API                                      │
// │                                                                       │
// │ Replace with your authenticated client. Paginate with cursor-based   │
// │ pagination (pageInfo.hasNextPage + endCursor).                        │
// │                                                                       │
// │ query {                                                               │
// │   orders(                                                             │
// │     first: 250                                                        │
// │     query: "created_at:>2026-02-01"                                  │
// │     sortKey: CREATED_AT                                               │
// │   ) {                                                                 │
// │     edges {                                                           │
// │       node {                                                          │
// │         id                                                            │
// │         cancelledAt                                                   │
// │         displayFinancialStatus                                        │
// │         lineItems(first: 50) {                                       │
// │           edges {                                                     │
// │             node { product { id } quantity }                          │
// │           }                                                           │
// │         }                                                             │
// │       }                                                               │
// │     }                                                                 │
// │     pageInfo { hasNextPage endCursor }                                │
// │   }                                                                   │
// │ }                                                                     │
// │                                                                       │
// │ Rate limit: each page costs ~12 points. At 250 orders/page and      │
// │ 2000-point bucket restoring 100/sec, you can sustain ~8 pages/sec.  │
// │ Add a 150ms delay between pages for safety.                          │
// └─────────────────────────────────────────────────────────────────────────┘

const ORDERS_QUERY = `
  query RecentOrders($query: String!, $cursor: String) {
    orders(first: 250, query: $query, sortKey: CREATED_AT, after: $cursor) {
      edges {
        node {
          id
          cancelledAt
          displayFinancialStatus
          lineItems(first: 50) {
            edges {
              node {
                quantity
                product { legacyResourceId }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ORDERS_PAGE_DELAY_MS = 150;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Paginates the Admin API for orders created within `lookbackDays` and
// returns them in the shape rebuildBestsellersIndex() expects:
//   { cancelled_at, financial_status, line_items: [{ product_id, quantity }] }
async function fetchRecentOrders(shop, lookbackDays) {
  const since = new Date(Date.now() - lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const queryFilter = `created_at:>=${since}`;

  const orders = [];
  let cursor = null;
  let hasNext = true;
  let pages = 0;

  while (hasNext) {
    const data = await adminGraphQL(shop, ORDERS_QUERY, { query: queryFilter, cursor });
    const connection = data?.orders;
    if (!connection) break;

    for (const edge of connection.edges || []) {
      const node = edge.node;
      orders.push({
        cancelled_at: node.cancelledAt || null,
        financial_status: (node.displayFinancialStatus || '').toLowerCase(),
        line_items: (node.lineItems?.edges || []).map((le) => ({
          product_id: le.node.product?.legacyResourceId
            ? Number(le.node.product.legacyResourceId)
            : null,
          quantity: le.node.quantity,
        })),
      });
    }

    hasNext = Boolean(connection.pageInfo?.hasNextPage);
    cursor = connection.pageInfo?.endCursor || null;
    pages++;
    if (hasNext) await sleep(ORDERS_PAGE_DELAY_MS);
  }

  logEvent('orders_fetched', { shop, pages, orders: orders.length });
  return orders;
}


// =============================================================================
// CRON ENTRYPOINT
// =============================================================================
// Call this from your job scheduler (node-cron, BullMQ, Cloud Scheduler).
// Iterates all installed shops and rebuilds each index sequentially.

async function runBestsellersSyncJob() {
  let shops = [];
  try {
    shops = await listInstalledShops();
  } catch (err) {
    logEvent('sync_job_error', { reason: 'shop_list_failed', message: err.message });
    return;
  }

  logEvent('sync_job_started', { shop_count: shops.length });

  for (const shop of shops) {
    await rebuildBestsellersIndex(shop);
    // Brief pause between shops to avoid sustained API pressure
    await sleep(2000);
  }

  logEvent('sync_job_finished', { shop_count: shops.length });
}


// =============================================================================
// LOGGING (NO PII)
// =============================================================================
// Logs:   shop domain, order ID (numeric), line counts, durations, errors
// Never:  customer names, emails, product titles, prices, addresses

function logEvent(event, data = {}) {
  console.log(JSON.stringify({
    component: 'bestsellers',
    event,
    ts: new Date().toISOString(),
    ...data,
  }));
}


// =============================================================================
// EXPORTS
// =============================================================================

export {
  app,
  removeProductFromBestsellers,
  rebuildBestsellersIndex,
  runBestsellersSyncJob,
  CONFIG,
};
