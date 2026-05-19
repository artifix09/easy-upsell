// =============================================================================
// Shopify Webhook Handlers — products/* + inventory_levels/update
// =============================================================================
// Runtime:    Node.js 20+ / Express 4.x
// Data:       Redis 7+ (pipelining)
// Auth:       Shopify HMAC-SHA256 webhook verification
// Logging:    Structured JSON, no PII, no product titles
// =============================================================================

import express from 'express';
import { redis } from './redis-client.mjs';
import { verifyWebhookHmac } from './hmac-validators.mjs';
import { removeProductFromBestsellers } from './bestsellers-index.mjs';
import { removeProductFromCopurchase } from './copurchase-index.mjs';
import { adminGraphQL } from './shopify-admin-graphql.mjs';

// =============================================================================
// CONFIG
// =============================================================================

const CONFIG = {
  APP_SECRET: process.env.SHOPIFY_API_SECRET,
  PRODUCT_TTL: 600,           // tier 1: product cache (10 min)
  INDEX_TTL: 3600,            // tier 3: collection/tag/vendor indexes (1 hr)
  RESULT_INVALIDATE: true,    // also bust tier 2 result cache on product change
  WEBHOOK_DEDUP_TTL: 300,
};

// =============================================================================
// EXPRESS SETUP
// =============================================================================
// Webhooks arrive as raw JSON. We need the raw body for HMAC verification,
// so we use express.raw() on the webhook path and parse JSON manually.
// This is NOT the same middleware as the proxy route — keep them separate.

const app = express();

app.use(
  '/webhooks',
  express.raw({ type: 'application/json', limit: '1mb' }),
);

const SHOP_DOMAIN_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

// =============================================================================
// HMAC VERIFICATION
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

// Shared pre-handler: verify + parse + extract shop
async function webhookGate(req, res) {
  if (!verifyWebhook(req)) {
    logWebhook(req, 'rejected', 'invalid_hmac');
    res.status(401).end();
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf-8'));
  } catch {
    logWebhook(req, 'rejected', 'malformed_json');
    res.status(400).end();
    return null;
  }

  const shop = req.headers['x-shopify-shop-domain'];
  if (!shop) {
    logWebhook(req, 'rejected', 'missing_shop_domain');
    res.status(400).end();
    return null;
  }

  if (!SHOP_DOMAIN_REGEX.test(shop)) {
    logWebhook(req, 'rejected', 'invalid_shop_domain');
    res.status(400).end();
    return null;
  }

  try {
    const installed = await redis.exists(`hybrid:shop:installed:${shop}`);
    if (installed !== 1) {
      logWebhook(req, 'rejected', 'shop_not_installed', { shop });
      res.status(403).end();
      return null;
    }
  } catch (error) {
    logWebhook(req, 'error', 'shop_lookup_failed', { shop, message: error.message });
  }

  const webhookId = req.headers['x-shopify-webhook-id'];
  if (webhookId) {
    try {
      const dedupKey = `hybrid:webhook:seen:${webhookId}`;
      const set = await redis.set(dedupKey, '1', { NX: true, EX: CONFIG.WEBHOOK_DEDUP_TTL });
      if (!set) {
        logWebhook(req, 'skipped', 'duplicate_webhook', { shop, webhook_id: webhookId });
        res.status(200).end();
        return null;
      }
    } catch (error) {
      logWebhook(req, 'error', 'webhook_dedup_failed', { shop, message: error.message });
    }
  }

  return { payload, shop };
}


// =============================================================================
// PRODUCT NORMALIZATION
// =============================================================================
// Shopify product webhook payloads include title, body_html, and other fields
// we don't store. This function extracts only what the recommendation engine
// and cache need.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ COLLECTION MEMBERSHIP — NOT IN WEBHOOK PAYLOAD                        │
// │                                                                       │
// │ Shopify product webhooks do NOT include collection IDs. The payload   │
// │ has tags, vendor, variants, images — but no collections.             │
// │                                                                       │
// │ Two strategies to resolve this:                                       │
// │                                                                       │
// │ STRATEGY A (recommended): Fetch on demand                            │
// │   After normalizing the product, call the Admin API to get           │
// │   collection membership:                                              │
// │                                                                       │
// │   query {                                                             │
// │     product(id: "gid://shopify/Product/123") {                       │
// │       collections(first: 50) {                                        │
// │         edges { node { id legacyResourceId } }                       │
// │       }                                                               │
// │     }                                                                 │
// │   }                                                                   │
// │                                                                       │
// │   Cost: 1 API call per product webhook. Acceptable at webhook        │
// │   volume. The call is async and doesn't block the 200 response.      │
// │                                                                       │
// │ STRATEGY B: Listen to collection webhooks                            │
// │   Subscribe to collections/update. When a collection changes,        │
// │   diff its product list and update indexes. Downside: Shopify        │
// │   doesn't fire collection webhooks when a product is added via       │
// │   automated collections (smart collections), so you still miss       │
// │   some changes.                                                       │
// │                                                                       │
// │ STRATEGY C: Periodic full sync                                       │
// │   Cron job every 30–60 min that re-fetches all collection            │
// │   memberships. Simplest but adds latency to catalog changes.         │
// │                                                                       │
// │ This skeleton uses Strategy A — see fetchCollectionIds() below.      │
// └─────────────────────────────────────────────────────────────────────────┘

function normalizeProduct(payload) {
  const firstVariant = payload.variants?.[0] || {};
  const image = payload.image?.src || payload.images?.[0]?.src || null;

  return {
    id: payload.id,
    handle: payload.handle || '',
    vendor: payload.vendor || '',
    tags: parseTags(payload.tags),
    price_cents: toCents(firstVariant.price),
    compare_at_price_cents: toCents(firstVariant.compare_at_price),
    default_variant_id: firstVariant.id || null,
    featured_image: image,
    available: isAvailable(payload.status, firstVariant),
    inventory_quantity: firstVariant.inventory_quantity ?? 0,
    collection_ids: [], // populated async via fetchCollectionIds()
  };
}

function isAvailable(status, variant) {
  if (status !== 'active') {
    return false;
  }
  if (variant.inventory_policy === 'continue') {
    return true;
  }
  return (variant.inventory_quantity ?? 0) > 0;
}

function parseTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => t.trim().toLowerCase());
  if (typeof tags === 'string') return tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  return [];
}

function toCents(priceStr) {
  if (priceStr == null) return null;
  const num = parseFloat(priceStr);
  if (Number.isNaN(num)) return null;
  return Math.round(num * 100);
}


// =============================================================================
// COLLECTION MEMBERSHIP FETCH (Strategy A)
// =============================================================================

const COLLECTIONS_QUERY = `
  query ProductCollections($id: ID!) {
    product(id: $id) {
      collections(first: 50) {
        edges { node { legacyResourceId } }
      }
    }
  }
`;

async function fetchCollectionIds(shop, productId) {
  // Shopify product webhooks omit collection membership, so we resolve it
  // from the Admin API. Failure here is non-fatal: we return [] and the
  // product is still cached/indexed by tag + vendor. A later products/update
  // or the periodic catalog re-sync will backfill the collection edges.
  try {
    const data = await adminGraphQL(shop, COLLECTIONS_QUERY, {
      id: `gid://shopify/Product/${productId}`,
    });
    const edges = data?.product?.collections?.edges || [];
    return edges
      .map((e) => Number(e.node?.legacyResourceId))
      .filter((n) => Number.isFinite(n));
  } catch (err) {
    console.warn(JSON.stringify({
      component: 'webhooks',
      event: 'collection_fetch_failed',
      shop,
      product_id: productId,
      message: err.message,
    }));
    return [];
  }
}



// =============================================================================
// INDEX MANAGEMENT — UPDATE
// =============================================================================
// Redis indexes are sets: each key holds the product IDs belonging to that
// collection, tag, or vendor. We use SADD/SREM for atomic membership changes
// and pipeline all writes into a single round-trip.

async function updateIndexes(shop, product) {
  const pid = String(product.id);
  const pipeline = redis.multi();

  // Collection indexes
  for (const collId of product.collection_ids) {
    const collKey = String(collId);
    pipeline.sAdd(`hybrid:idx:coll:${shop}:${collKey}`, pid);
    pipeline.expire(`hybrid:idx:coll:${shop}:${collKey}`, CONFIG.INDEX_TTL);
  }

  // Tag indexes
  for (const tag of product.tags) {
    const tagKey = String(tag);
    pipeline.sAdd(`hybrid:idx:tag:${shop}:${tagKey}`, pid);
    pipeline.expire(`hybrid:idx:tag:${shop}:${tagKey}`, CONFIG.INDEX_TTL);
  }

  // Vendor index
  if (product.vendor) {
    const vendorKey = String(product.vendor);
    pipeline.sAdd(`hybrid:idx:vendor:${shop}:${vendorKey}`, pid);
    pipeline.expire(`hybrid:idx:vendor:${shop}:${vendorKey}`, CONFIG.INDEX_TTL);
  }

  await pipeline.exec();
}


// =============================================================================
// INDEX MANAGEMENT — REMOVE
// =============================================================================
// On product delete or when tags/collections/vendor change, remove the product
// from all old index sets.

async function removeIndexes(shop, product) {
  const pid = String(product.id);
  const pipeline = redis.multi();

  for (const collId of product.collection_ids) {
    pipeline.sRem(`hybrid:idx:coll:${shop}:${String(collId)}`, pid);
  }
  for (const tag of product.tags) {
    pipeline.sRem(`hybrid:idx:tag:${shop}:${String(tag)}`, pid);
  }
  if (product.vendor) {
    pipeline.sRem(`hybrid:idx:vendor:${shop}:${String(product.vendor)}`, pid);
  }

  await pipeline.exec();
}


// =============================================================================
// INDEX MANAGEMENT — DIFF ON UPDATE
// =============================================================================
// When a product is updated, tags/vendor/collections may have changed.
// We diff old vs new and issue targeted SREM + SADD instead of
// blowing away all indexes and rebuilding.

function diffSets(oldArr, newArr) {
  const oldSet = new Set(oldArr);
  const newSet = new Set(newArr);
  return {
    added: newArr.filter((v) => !oldSet.has(v)),
    removed: oldArr.filter((v) => !newSet.has(v)),
  };
}

async function applyIndexDiff(shop, productId, oldProduct, newProduct) {
  const pid = String(productId);
  const pipeline = redis.multi();

  // Diff collections
  const collDiff = diffSets(
    oldProduct.collection_ids || [],
    newProduct.collection_ids || [],
  );
  for (const collId of collDiff.removed) {
    pipeline.sRem(`hybrid:idx:coll:${shop}:${String(collId)}`, pid);
  }
  for (const collId of collDiff.added) {
    const collKey = String(collId);
    pipeline.sAdd(`hybrid:idx:coll:${shop}:${collKey}`, pid);
    pipeline.expire(`hybrid:idx:coll:${shop}:${collKey}`, CONFIG.INDEX_TTL);
  }

  // Diff tags
  const tagDiff = diffSets(oldProduct.tags || [], newProduct.tags || []);
  for (const tag of tagDiff.removed) {
    pipeline.sRem(`hybrid:idx:tag:${shop}:${String(tag)}`, pid);
  }
  for (const tag of tagDiff.added) {
    const tagKey = String(tag);
    pipeline.sAdd(`hybrid:idx:tag:${shop}:${tagKey}`, pid);
    pipeline.expire(`hybrid:idx:tag:${shop}:${tagKey}`, CONFIG.INDEX_TTL);
  }

  // Diff vendor
  if (oldProduct.vendor && oldProduct.vendor !== newProduct.vendor) {
    pipeline.sRem(`hybrid:idx:vendor:${shop}:${String(oldProduct.vendor)}`, pid);
  }
  if (newProduct.vendor && newProduct.vendor !== oldProduct.vendor) {
    const vendorKey = String(newProduct.vendor);
    pipeline.sAdd(`hybrid:idx:vendor:${shop}:${vendorKey}`, pid);
    pipeline.expire(`hybrid:idx:vendor:${shop}:${vendorKey}`, CONFIG.INDEX_TTL);
  }

  await pipeline.exec();
}


// =============================================================================
// TIER 2 RESULT CACHE INVALIDATION
// =============================================================================
// When a product changes, any cached recommendation result that includes
// or could include this product is potentially stale. Rather than tracking
// which result keys reference which products (complex), we invalidate all
// result keys for the shop. This is safe because:
//   - Result TTL is only 5 min anyway
//   - Product webhooks fire at catalog-change frequency, not request frequency
//   - The scan uses a cursor and deletes in batches

async function invalidateResultCache(shop) {
  if (!CONFIG.RESULT_INVALIDATE) return;

  let cursor = '0';
  let totalDeleted = 0;
  do {
    const result = await redis.scan(cursor, {
      MATCH: `hybrid:reco:${shop}:*`,
      COUNT: 100,
    });
    cursor = result.cursor;
    if (result.keys.length > 0) {
      await redis.del(result.keys);
      totalDeleted += result.keys.length;
    }
  } while (cursor !== '0');

  if (totalDeleted > 0) {
    console.log(JSON.stringify({
      event: 'result_cache_invalidated',
      shop,
      keys_deleted: totalDeleted,
    }));
  }
}


// =============================================================================
// ROUTE: products/create
// =============================================================================

app.post('/webhooks/products/create', async (req, res) => {
  const gate = await webhookGate(req, res);
  if (!gate) return;
  const { payload, shop } = gate;

  // Respond 200 immediately — Shopify retries on non-2xx
  res.status(200).end();

  try {
    const product = normalizeProduct(payload);

    // Fetch collection membership (async, not in webhook payload)
    product.collection_ids = await fetchCollectionIds(shop, product.id);

    // Write tier 1 product cache
    await redis.setEx(
      `hybrid:prod:${shop}:${product.id}`,
      CONFIG.PRODUCT_TTL,
      JSON.stringify(product),
    );

    // Add to tier 3 indexes
    await updateIndexes(shop, product);

    // Build inventory item mappings for fast inventory webhooks
    await buildInventoryMappings(shop, payload);

    // Bust stale result cache
    await invalidateResultCache(shop);

    logWebhook(req, 'processed', 'product_created', {
      shop,
      product_id: product.id,
      tags_count: product.tags.length,
      collections_count: product.collection_ids.length,
    });
  } catch (err) {
    logWebhook(req, 'error', 'product_create_failed', {
      shop,
      product_id: payload.id,
      error: err.message,
    });
  }
});


// =============================================================================
// ROUTE: products/update
// =============================================================================

app.post('/webhooks/products/update', async (req, res) => {
  const gate = await webhookGate(req, res);
  if (!gate) return;
  const { payload, shop } = gate;

  res.status(200).end();

  try {
    // Load old product from cache (needed for index diff)
    let oldProduct = null;
    const oldRaw = await redis.get(`hybrid:prod:${shop}:${payload.id}`);
    if (oldRaw) {
      oldProduct = JSON.parse(oldRaw);
    }

    const newProduct = normalizeProduct(payload);
    newProduct.collection_ids = await fetchCollectionIds(shop, newProduct.id);

    // Write updated tier 1 cache
    await redis.setEx(
      `hybrid:prod:${shop}:${newProduct.id}`,
      CONFIG.PRODUCT_TTL,
      JSON.stringify(newProduct),
    );

    // Diff and update tier 3 indexes
    if (oldProduct) {
      await applyIndexDiff(shop, newProduct.id, oldProduct, newProduct);
    } else {
      // No old data — full add (first time seeing this product post-install)
      await updateIndexes(shop, newProduct);
    }

    // Refresh inventory item mappings
    await buildInventoryMappings(shop, payload);

    // Bust stale result cache
    await invalidateResultCache(shop);

    logWebhook(req, 'processed', 'product_updated', {
      shop,
      product_id: newProduct.id,
      had_old_cache: !!oldProduct,
      tags_changed: oldProduct
        ? diffSets(oldProduct.tags, newProduct.tags).added.length
          + diffSets(oldProduct.tags, newProduct.tags).removed.length
        : null,
      vendor_changed: oldProduct
        ? oldProduct.vendor !== newProduct.vendor
        : null,
    });
  } catch (err) {
    logWebhook(req, 'error', 'product_update_failed', {
      shop,
      product_id: payload.id,
      error: err.message,
    });
  }
});


// =============================================================================
// ROUTE: products/delete
// =============================================================================

app.post('/webhooks/products/delete', async (req, res) => {
  const gate = await webhookGate(req, res);
  if (!gate) return;
  const { payload, shop } = gate;

  res.status(200).end();

  try {
    // Shopify delete payloads are minimal: { id: 123 }
    // We need the cached product to know which indexes to clean up.
    const productId = payload.id;
    const cachedRaw = await redis.get(`hybrid:prod:${shop}:${productId}`);

    if (cachedRaw) {
      const cachedProduct = JSON.parse(cachedRaw);

      // Remove from all tier 3 indexes
      await removeIndexes(shop, cachedProduct);

      // Remove tier 1 product cache
      await redis.del(`hybrid:prod:${shop}:${productId}`);

      // Remove any discount rules for this product
      await redis.del(`hybrid:discount:rule:${shop}:${productId}`);
    } else {
      // Product wasn't in our cache — best-effort: just delete the key
      // Indexes may contain orphan references; the recommendation engine
      // handles this gracefully (resolveProducts skips missing products).
      await redis.del(`hybrid:prod:${shop}:${productId}`);
    }

    await removeProductFromBestsellers(shop, productId);
    await removeProductFromCopurchase(shop, productId);

    // Bust stale result cache
    await invalidateResultCache(shop);

    logWebhook(req, 'processed', 'product_deleted', {
      shop,
      product_id: productId,
      had_cache: !!cachedRaw,
    });
  } catch (err) {
    logWebhook(req, 'error', 'product_delete_failed', {
      shop,
      product_id: payload.id,
      error: err.message,
    });
  }
});


// =============================================================================
// ROUTE: inventory_levels/update
// =============================================================================
// Payload shape:
//   {
//     "inventory_item_id": 808950810,
//     "location_id": 905684977,
//     "available": 42,
//     "updated_at": "2026-05-02T..."
//   }
//
// Problem: inventory webhooks reference inventory_item_id, not product_id
// or variant_id. We need a lookup to map inventory_item → variant → product.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ PLUG-IN POINT: inventory_item → product mapping                       │
// │                                                                       │
// │ Option A (recommended): Maintain a Redis hash on product create/     │
// │ update that maps inventory_item_id → { product_id, variant_id }.     │
// │                                                                       │
// │   Key:   inv:map:{shop}:{inventory_item_id}                          │
// │   Value: { product_id, variant_id }                                   │
// │                                                                       │
// │ Populated in normalizeProduct or in the products/create handler      │
// │ by iterating payload.variants[].inventory_item_id.                   │
// │                                                                       │
// │ Option B: Call Admin API to resolve. Costs 1 API call per webhook.   │
// │ Acceptable for low-volume stores; use Option A at scale.             │
// └─────────────────────────────────────────────────────────────────────────┘

app.post('/webhooks/inventory/update', async (req, res) => {
  const gate = await webhookGate(req, res);
  if (!gate) return;
  const { payload, shop } = gate;

  res.status(200).end();

  try {
    const inventoryItemId = payload.inventory_item_id;
    const newAvailable = payload.available;

    // Resolve inventory_item_id → product_id
    const mapping = await resolveInventoryMapping(shop, inventoryItemId);
    if (!mapping) {
      logWebhook(req, 'skipped', 'inventory_mapping_miss', {
        shop,
        inventory_item_id: inventoryItemId,
      });
      return;
    }

    const { productId } = mapping;

    // Patch tier 1 product cache in place
    const cachedRaw = await redis.get(`hybrid:prod:${shop}:${productId}`);
    if (!cachedRaw) {
      logWebhook(req, 'skipped', 'inventory_product_cache_miss', {
        shop,
        product_id: productId,
      });
      return;
    }

    const product = JSON.parse(cachedRaw);
    const wasAvailable = product.available;

    product.inventory_quantity = newAvailable;
    product.available = newAvailable > 0;

    await redis.setEx(
      `hybrid:prod:${shop}:${productId}`,
      CONFIG.PRODUCT_TTL,
      JSON.stringify(product),
    );

    // Only bust result cache if availability state flipped
    // (quantity 50→48 doesn't matter; quantity 1→0 does)
    if (wasAvailable !== product.available) {
      await invalidateResultCache(shop);
    }

    logWebhook(req, 'processed', 'inventory_updated', {
      shop,
      product_id: productId,
      available_before: wasAvailable,
      available_after: product.available,
      quantity: newAvailable,
    });
  } catch (err) {
    logWebhook(req, 'error', 'inventory_update_failed', {
      shop,
      inventory_item_id: payload.inventory_item_id,
      error: err.message,
    });
  }
});

async function resolveInventoryMapping(shop, inventoryItemId) {
  const raw = await redis.get(`hybrid:inv:map:${shop}:${inventoryItemId}`);
  if (raw) return JSON.parse(raw);

  // ┌─────────────────────────────────────────────────────────────────────┐
  // │ PLUG-IN POINT: fallback to Admin API                               │
  // │                                                                     │
  // │ const { data } = await shopifyClient(shop).query({                 │
  // │   query: `{                                                         │
  // │     inventoryItem(id: "gid://shopify/InventoryItem/${id}") {       │
  // │       variant { id legacyResourceId product {                      │
  // │         id legacyResourceId                                         │
  // │       }}                                                            │
  // │     }                                                               │
  // │   }`                                                                │
  // │ });                                                                 │
  // │ // Cache the result for next time                                   │
  // │ await redis.setEx(`inv:map:${shop}:${id}`, 86400, ...);           │
  // └─────────────────────────────────────────────────────────────────────┘

  return null;
}


// =============================================================================
// IDEMPOTENCY NOTE
// =============================================================================
// Shopify may deliver the same webhook multiple times. All handlers above
// are naturally idempotent:
//   - products/create: SETEX overwrites same key → safe
//   - products/update: SETEX overwrites, SADD is idempotent → safe
//   - products/delete: DEL on missing key is a no-op → safe
//   - inventory/update: SETEX overwrites with latest value → safe
//
// If you add side effects (email, Slack, analytics events), gate them
// behind a deduplication check:
//   const dedupKey = `webhook:seen:${req.headers['x-shopify-webhook-id']}`;
//   const seen = await redis.set(dedupKey, '1', { NX: true, EX: 300 });
//   if (!seen) return; // already processed


// =============================================================================
// LOGGING (NO PII)
// =============================================================================
// Never logs: product titles, descriptions, image URLs, customer data,
//             variant names, prices, tag values, vendor names
// Does log:   product IDs, counts, boolean flags, durations, error messages

function logWebhook(req, status, event, extra = {}) {
  console.log(JSON.stringify({
    event,
    status,
    topic: req.headers['x-shopify-topic'] || 'unknown',
    webhook_id: req.headers['x-shopify-webhook-id'] || null,
    ts: new Date().toISOString(),
    ...extra,
  }));
}


// =============================================================================
// INVENTORY MAPPING BUILDER (call from products/create and products/update)
// =============================================================================
// Populates the inv:map:{shop}:{inventory_item_id} keys so that
// inventory_levels/update can resolve product ownership without an API call.

async function buildInventoryMappings(shop, payload) {
  const variants = payload.variants || [];
  if (variants.length === 0) return;

  const pipeline = redis.multi();

  for (const variant of variants) {
    if (!variant.inventory_item_id) continue;
    const mapping = JSON.stringify({
      productId: payload.id,
      variantId: variant.id,
    });
    pipeline.setEx(
      `hybrid:inv:map:${shop}:${variant.inventory_item_id}`,
      86400, // 24hr TTL — refreshed on every product webhook
      mapping,
    );
  }

  await pipeline.exec();
}

// ── Wire this into the create/update handlers ──────────────────────────────
// Add after normalizeProduct() in both products/create and products/update:
//
//   await buildInventoryMappings(shop, payload);
//
// This keeps the mapping warm so inventory webhooks resolve instantly.


// =============================================================================
// EXPORTS
// =============================================================================

export { app };
