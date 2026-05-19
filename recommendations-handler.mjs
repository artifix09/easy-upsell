// =============================================================================
// POST /shopify/proxy/recommendations — App Proxy endpoint
// =============================================================================
// Runtime:    Node.js 20+ / Express 5.x
// Auth:       Shopify App Proxy signature (query-string HMAC, hex digest)
// Data:       Redis (rate limit + cache tiers)
// Body limit: 16KB enforced at Express level
//
// Trust model:
//   - The signed query params are the source of truth for `shop`. The
//     X-Shopify-Shop-Domain header is informational only and never used
//     for authorization.
//   - `timestamp` is validated within Â±5 minutes of server clock to bound
//     replay risk on intercepted URLs.
// =============================================================================

import express from 'express';
import crypto from 'node:crypto';
import { redis } from './redis-client.mjs';
import { verifyAppProxySignature } from './hmac-validators.mjs';
import { runRecommendationEngine } from './recommendation-engine-v2.mjs';
import { fetchProductsFromShopify } from './shopify-product-fetcher.mjs';
import { reportError } from './error-monitor.mjs';
import { getShopAccessToken } from './postgres-store.mjs';
import { recordImpressions, recordClick } from './analytics.mjs';

// =============================================================================
// CONFIG
// =============================================================================

const CONFIG = {
  APP_SECRET: process.env.SHOPIFY_API_SECRET,          // Partner dashboard → API secret key
  RATE_LIMIT_MAX: 60,                                   // requests per window
  RATE_LIMIT_WINDOW_SEC: 60,                            // window size
  RATE_LIMIT_COLD_MAX: 30,                              // tighter limit for cache-miss (protects Shopify API quota)
  CACHE_RESULT_TTL: 300,                                // tier 2: recommendation results
  CACHE_PRODUCT_TTL: 600,                               // tier 1: product data
  CACHE_INDEX_TTL: 3600,                                // tier 3: collection/tag indexes
  BODY_SIZE_LIMIT: '16kb',                              // enforced by express.json()
  MAX_CART_ITEMS: 50,
  MAX_EXCLUDE_IDS: 100,
  DEFAULT_LIMIT: 3,
  MAX_LIMIT: 10,
  PROXY_TIMESTAMP_SKEW_SEC: 300,                        // Â±5 min replay window
};

// =============================================================================
// APP SETUP
// =============================================================================
// Redis is the shared process-wide client from redis-client.mjs; the
// connection is opened once at server boot via connectRedis().

const app = express();

// ── Body size cap enforced HERE ──────────────────────────────────────────────
// Express rejects bodies > 16KB with 413 before our handler runs.
// For defense-in-depth, also set at nginx/ALB: client_max_body_size 16k;
app.use('/shopify/proxy', express.json({
  limit: CONFIG.BODY_SIZE_LIMIT,
  strict: true,    // only objects and arrays at top level
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

// =============================================================================
// ROUTE
// =============================================================================

app.post('/shopify/proxy/recommendations', async (req, res) => {
  const requestId = generateRequestId();
  const start = performance.now();

  try {
    if (!req.is('application/json')) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Content-Type must be application/json.', requestId);
    }

    // ── 1. APP PROXY SIGNATURE VERIFICATION ────────────────────────────────
    // Signed query params are the source of truth. The header is ignored.
    const signatureResult = verifyAppProxySignature({
      secret: CONFIG.APP_SECRET,
      query: req.query,
    });
    if (!signatureResult.ok) {
      return sendError(res, 401, 'UNAUTHORIZED', signatureResult.error, requestId);
    }

    // ── 1b. TIMESTAMP REPLAY GUARD ─────────────────────────────────────────
    const tsRaw = req.query.timestamp;
    const ts = Number.parseInt(Array.isArray(tsRaw) ? tsRaw[0] : tsRaw, 10);
    if (!Number.isFinite(ts)) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Missing or invalid timestamp.', requestId);
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > CONFIG.PROXY_TIMESTAMP_SKEW_SEC) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Request timestamp outside allowed skew.', requestId);
    }

    // ── 2. SHOP DOMAIN VALIDATION (from signed query) ──────────────────────
    const shopRaw = req.query.shop;
    const shop = typeof shopRaw === 'string' ? shopRaw.toLowerCase() : null;
    const shopError = await validateShopDomain(shop);
    if (shopError) {
      return sendError(res, 403, 'SHOP_MISMATCH', shopError, requestId);
    }

    // ── 3. RATE LIMIT ──────────────────────────────────────────────────────
    const rateLimited = await checkRateLimit(shop);
    if (rateLimited) {
      res.set('Retry-After', String(CONFIG.RATE_LIMIT_WINDOW_SEC));
      return sendError(res, 429, 'RATE_LIMITED', 'Too many requests.', requestId);
    }

    // ── 4. BODY VALIDATION ─────────────────────────────────────────────────
    const { data, error: validationError } = validateBody(req.body);
    if (validationError) {
      return sendError(res, 400, validationError.code, validationError.message, requestId);
    }

    const { cartItems, limit, excludeIds, locale } = data;

    // ── 5. CACHE CHECK (TIER 2 — result cache) ────────────────────────────
    const cacheKey = buildCacheKey(shop, cartItems, limit);
    const cached = await redis.get(cacheKey);

    if (cached) {
      const parsed = safeJsonParse(cached);
      if (parsed) {
        const ttl = await redis.ttl(cacheKey);
        logRequest(requestId, shop, cartItems.length, 'cache', performance.now() - start, 200);
        recordImpressions(shop, parsed.map((r) => r.product_id)).catch(() => {});
        return res.status(200).json({
          recommendations: parsed,
          meta: { request_id: requestId, served_from: 'cache', ttl_seconds: ttl, generated_at: new Date().toISOString() },
        });
      }
    }

    // ── 6. COLD-PATH RATE LIMIT (tighter, protects Shopify API quota) ─────
    const coldLimited = await checkColdRateLimit(shop);
    if (coldLimited) {
      res.set('Retry-After', String(CONFIG.RATE_LIMIT_WINDOW_SEC));
      return sendError(res, 429, 'RATE_LIMITED', 'Origin rate limit exceeded.', requestId);
    }

    try {
      // ── 7. RESOLVE PRODUCTS (TIER 1 — product cache) ──────────────────────
      const { products } = await resolveProducts(shop, cartItems, requestId);

      if (products.length === 0) {
        return sendError(res, 404, 'PRODUCTS_NOT_FOUND', 'None of the submitted product IDs exist.', requestId);
      }

      // ── 8. RUN RECOMMENDATION ENGINE ─────────────────────────────────────
      const scored = await runRecommendationEngine(redis, shop, products, limit, excludeIds, locale);

      // ── 9. APPLY DISCOUNT RULES ──────────────────────────────────────────
      const withDiscounts = await applyDiscountRules(shop, scored);

      // ── 10. FORMAT RESPONSE ──────────────────────────────────────────────
      const currency = await getShopCurrency(shop);
      const responseItems = withDiscounts.map((rec) => formatRecommendation(rec, currency));

      // ── 11. CACHE WRITE (TIER 2) ─────────────────────────────────────────
      await redis.setEx(cacheKey, CONFIG.CACHE_RESULT_TTL, JSON.stringify(responseItems));

      // ── 12. RESPOND ──────────────────────────────────────────────────────
      logRequest(requestId, shop, cartItems.length, 'origin', performance.now() - start, 200);
      recordImpressions(shop, responseItems.map((r) => r.product_id)).catch(() => {});

      return res.status(200).json({
        recommendations: responseItems,
        meta: {
          request_id: requestId,
          served_from: 'origin',
          ttl_seconds: CONFIG.CACHE_RESULT_TTL,
          generated_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      logError(requestId, shop, 'recommendations_failed', err);
      return sendEmpty(res, requestId, 'degraded');
    }

  } catch (err) {
    // Never leak stack traces or internals
    const fallbackShop = typeof req.query?.shop === 'string' ? req.query.shop.toLowerCase() : 'unknown';
    logError(requestId, fallbackShop, 'unhandled', err);
    return sendEmpty(res, requestId, 'degraded');
  }
});


// =============================================================================
// ROUTE: POST /shopify/proxy/events — analytics beacon
// =============================================================================
// The storefront posts impression/click events here. Same App Proxy auth as
// the recommendations route. Responds fast (202) and records async — a failed
// beacon must never degrade the shopper experience.
//
// Body:
//   { "event": "click",      "product_id": 123 }
//   { "event": "impression", "product_ids": [123, 456] }

app.post('/shopify/proxy/events', async (req, res) => {
  const requestId = generateRequestId();

  try {
    if (!req.is('application/json')) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Content-Type must be application/json.', requestId);
    }

    const signatureResult = verifyAppProxySignature({ secret: CONFIG.APP_SECRET, query: req.query });
    if (!signatureResult.ok) {
      return sendError(res, 401, 'UNAUTHORIZED', signatureResult.error, requestId);
    }

    const tsRaw = req.query.timestamp;
    const ts = Number.parseInt(Array.isArray(tsRaw) ? tsRaw[0] : tsRaw, 10);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > CONFIG.PROXY_TIMESTAMP_SKEW_SEC) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Missing or stale timestamp.', requestId);
    }

    const shopRaw = req.query.shop;
    const shop = typeof shopRaw === 'string' ? shopRaw.toLowerCase() : null;
    const shopError = await validateShopDomain(shop);
    if (shopError) {
      return sendError(res, 403, 'SHOP_MISMATCH', shopError, requestId);
    }

    if (await checkRateLimit(shop)) {
      res.set('Retry-After', String(CONFIG.RATE_LIMIT_WINDOW_SEC));
      return sendError(res, 429, 'RATE_LIMITED', 'Too many requests.', requestId);
    }

    const { data, error } = validateEventBody(req.body);
    if (error) {
      return sendError(res, 400, error.code, error.message, requestId);
    }

    // Respond before recording — the beacon is fire-and-forget for the client.
    res.status(202).json({ accepted: true, request_id: requestId });

    if (data.event === 'click') {
      recordClick(shop, data.productId).catch(() => {});
    } else {
      recordImpressions(shop, data.productIds).catch(() => {});
    }
  } catch (err) {
    logError(requestId, 'unknown', 'events_unhandled', err);
    if (!res.headersSent) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to record event.', requestId);
    }
  }
});

function validateEventBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, error: { code: 'VALIDATION_ERROR', message: 'Request body must be a JSON object.' } };
  }
  if (body.event === 'click') {
    if (!isPositiveInteger(body.product_id)) {
      return { data: null, error: { code: 'VALIDATION_ERROR', message: 'click event requires a positive integer product_id.' } };
    }
    return { data: { event: 'click', productId: body.product_id }, error: null };
  }
  if (body.event === 'impression') {
    if (!Array.isArray(body.product_ids) || body.product_ids.length === 0 || body.product_ids.length > 50) {
      return { data: null, error: { code: 'VALIDATION_ERROR', message: 'impression event requires product_ids (1–50 items).' } };
    }
    for (const id of body.product_ids) {
      if (!isPositiveInteger(id)) {
        return { data: null, error: { code: 'VALIDATION_ERROR', message: 'product_ids entries must be positive integers.' } };
      }
    }
    return { data: { event: 'impression', productIds: body.product_ids }, error: null };
  }
  return { data: null, error: { code: 'VALIDATION_ERROR', message: 'event must be "click" or "impression".' } };
}


// =============================================================================
// HELPER: HMAC VERIFICATION
// =============================================================================
// Raw body capture is wired in the express.json() verify callback above.


// =============================================================================
// HELPER: SHOP DOMAIN VALIDATION
// =============================================================================

const SHOP_DOMAIN_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

async function validateShopDomain(shop) {
  if (!shop || typeof shop !== 'string') {
    return 'Missing shop parameter.';
  }

  if (!SHOP_DOMAIN_REGEX.test(shop)) {
    return 'Invalid shop domain format.';
  }

  // ┌─────────────────────────────────────────────────────────────────────┐
  // │ PLUG-IN POINT: installed shops lookup                              │
  // │                                                                     │
  // │ Replace with your data store query:                                │
  // │   const exists = await db.shops.exists({ domain: shop });          │
  // │                                                                     │
  // │ This table is populated on app install (auth callback) and         │
  // │ cleaned up on app/uninstalled webhook.                             │
  // └─────────────────────────────────────────────────────────────────────┘
  const installed = await isShopInstalled(shop);
  if (!installed) {
    return 'App is not installed on this shop.';
  }

  return null; // valid
}

const INSTALLED_FLAG_TTL = 3600; // re-warm window for the Redis fast-path key

async function isShopInstalled(shop) {
  // Fast path: Redis flag set during OAuth install.
  const exists = await redis.exists(`hybrid:shop:installed:${shop}`);
  if (exists === 1) return true;

  // Slow path: Redis was flushed/evicted but the shop is still installed.
  // Postgres is the source of truth — fall back to it and re-warm the flag.
  try {
    const token = await getShopAccessToken(shop);
    if (token) {
      await redis.set(`hybrid:shop:installed:${shop}`, '1', { EX: INSTALLED_FLAG_TTL });
      return true;
    }
  } catch (err) {
    console.error(JSON.stringify({
      component: 'proxy',
      event: 'install_check_db_failed',
      shop,
      message: err.message,
    }));
  }
  return false;
}


// =============================================================================
// HELPER: BODY VALIDATION
// =============================================================================

function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, error: { code: 'VALIDATION_ERROR', message: 'Request body must be a JSON object.' } };
  }

  // ── cart_items ────────────────────────────────────────────────────────────
  const cartItems = body.cart_items;

  if (!Array.isArray(cartItems)) {
    return { data: null, error: { code: 'VALIDATION_ERROR', message: 'cart_items must be an array.' } };
  }
  if (cartItems.length === 0) {
    return { data: null, error: { code: 'EMPTY_CART', message: 'cart_items must contain at least 1 item.' } };
  }
  if (cartItems.length > CONFIG.MAX_CART_ITEMS) {
    return { data: null, error: { code: 'VALIDATION_ERROR', message: `cart_items must contain at most ${CONFIG.MAX_CART_ITEMS} items.` } };
  }

  for (let i = 0; i < cartItems.length; i++) {
    const item = cartItems[i];
    if (!item || typeof item !== 'object') {
      return { data: null, error: { code: 'VALIDATION_ERROR', message: `cart_items[${i}] must be an object.` } };
    }
    if (!isPositiveInteger(item.product_id)) {
      return { data: null, error: { code: 'VALIDATION_ERROR', message: `cart_items[${i}].product_id must be a positive integer.` } };
    }
    // variant_id is informational only (engine scores on product_id), but
    // when present it must be a positive integer. Product-page sections
    // don't always know the variant, so allow it to be omitted.
    if (item.variant_id != null && !isPositiveInteger(item.variant_id)) {
      return { data: null, error: { code: 'VALIDATION_ERROR', message: `cart_items[${i}].variant_id must be a positive integer when provided.` } };
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
      return { data: null, error: { code: 'VALIDATION_ERROR', message: `cart_items[${i}].quantity must be 1–99.` } };
    }
  }

  // ── limit ─────────────────────────────────────────────────────────────────
  let limit = CONFIG.DEFAULT_LIMIT;
  if (body.limit !== undefined) {
    if (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > CONFIG.MAX_LIMIT) {
      return { data: null, error: { code: 'VALIDATION_ERROR', message: `limit must be 1–${CONFIG.MAX_LIMIT}.` } };
    }
    limit = body.limit;
  }

  // ── exclude_product_ids ───────────────────────────────────────────────────
  let excludeIds = cartItems.map((i) => i.product_id);
  if (body.exclude_product_ids !== undefined) {
    if (!Array.isArray(body.exclude_product_ids)) {
      return { data: null, error: { code: 'VALIDATION_ERROR', message: 'exclude_product_ids must be an array.' } };
    }
    if (body.exclude_product_ids.length > CONFIG.MAX_EXCLUDE_IDS) {
      return { data: null, error: { code: 'VALIDATION_ERROR', message: `exclude_product_ids max ${CONFIG.MAX_EXCLUDE_IDS}.` } };
    }
    for (const id of body.exclude_product_ids) {
      if (!isPositiveInteger(id)) {
        return { data: null, error: { code: 'VALIDATION_ERROR', message: 'exclude_product_ids entries must be positive integers.' } };
      }
    }
    excludeIds = body.exclude_product_ids;
  }

  // ── locale ────────────────────────────────────────────────────────────────
  let locale = 'en';
  if (body.locale !== undefined) {
    if (typeof body.locale !== 'string' || !/^[a-z]{2}(-[A-Z]{2})?$/.test(body.locale)) {
      return { data: null, error: { code: 'VALIDATION_ERROR', message: 'locale must be ISO 639-1 format.' } };
    }
    locale = body.locale;
  }

  return {
    data: { cartItems, limit, excludeIds, locale },
    error: null,
  };
}

function isPositiveInteger(val) {
  return Number.isInteger(val) && val > 0;
}


// =============================================================================
// HELPER: CACHE KEY BUILDER
// =============================================================================

function buildCacheKey(shop, cartItems, limit) {
  // Sort product IDs for deterministic key regardless of cart item order.
  // Variant IDs are excluded — recommendations are product-level, not variant-level.
  const sortedIds = cartItems
    .map((i) => i.product_id)
    .sort((a, b) => a - b)
    .join(',');

  const hash = crypto
    .createHash('sha256')
    .update(`${sortedIds}:${limit}`)
    .digest('hex')
    .slice(0, 16); // 16 hex chars = 64 bits, collision-safe for this use case

  return `hybrid:reco:${shop}:${hash}`;
}


// =============================================================================
// HELPER: RATE LIMITER
// =============================================================================

async function checkRateLimit(shop) {
  const key = `hybrid:rl:${shop}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, CONFIG.RATE_LIMIT_WINDOW_SEC);
  }
  return count > CONFIG.RATE_LIMIT_MAX;
}

async function checkColdRateLimit(shop) {
  const key = `hybrid:rl:cold:${shop}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, CONFIG.RATE_LIMIT_WINDOW_SEC);
  }
  return count > CONFIG.RATE_LIMIT_COLD_MAX;
}


// =============================================================================
// PLUG-IN: PRODUCT RESOLUTION (TIER 1 CACHE)
// =============================================================================
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ This function checks Redis (tier 1) first, then falls back to the     │
// │ Shopify Admin API for cache misses. Replace the Shopify API call with  │
// │ your actual authenticated client.                                     │
// │                                                                       │
// │ Cache invalidation: wire up products/update and products/delete        │
// │ webhooks to delete the corresponding Redis keys:                      │
// │   await redis.del(`prod:${shop}:${productId}`);                      │
// │                                                                       │
// │ On inventory_levels/update webhook, update the available flag:        │
// │   await redis.hSet(`prod:${shop}:${pid}`, 'available', newValue);    │
// └─────────────────────────────────────────────────────────────────────────┘

async function resolveProducts(shop, cartItems, requestId) {
  const productIds = [...new Set(cartItems.map((i) => i.product_id))];
  const products = [];
  const missingIds = [];

  // Tier 1: Redis product cache
  for (const pid of productIds) {
    const cached = await redis.get(`hybrid:prod:${shop}:${pid}`);
    if (cached) {
      products.push(JSON.parse(cached));
    } else {
      missingIds.push(pid);
    }
  }

  // Tier 1 miss: fetch from Shopify Admin API
  if (missingIds.length > 0) {
    const fetched = await fetchProductsFromShopify(shop, missingIds, requestId);
    for (const product of fetched) {
      await redis.setEx(
        `hybrid:prod:${shop}:${product.id}`,
        CONFIG.CACHE_PRODUCT_TTL,
        JSON.stringify(product),
      );
      products.push(product);
    }
  }

  return {
    products,
    notFound: missingIds.filter((id) => !products.some((p) => p.id === id)),
  };
}

// =============================================================================
// PLUG-IN: DISCOUNT RULES
// =============================================================================
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Discount rules are set in the app admin and cached in Redis.          │
// │ They attach optional discount objects to recommendations.             │
// │                                                                       │
// │ Key: discount:rule:{shop}:{product_id}                               │
// │ Value: { type, value, label, active }                                │
// │                                                                       │
// │ These are NOT Shopify discount codes — they're display-only hints    │
// │ for the cart drawer UI. Actual discounting runs through Shopify      │
// │ Functions at checkout.                                                │
// └─────────────────────────────────────────────────────────────────────────┘

async function applyDiscountRules(shop, recommendations) {
  return Promise.all(
    recommendations.map(async (rec) => {
      const raw = await redis.get(`hybrid:discount:rule:${shop}:${rec.id}`);
      if (raw) {
        const rule = JSON.parse(raw);
        if (rule.active) {
          rec.discount = {
            type: rule.type,           // "percentage" | "fixed_amount"
            value: rule.value,          // e.g. 10
            label: rule.label,          // e.g. "Bundle & save 10%"
            discount_code: null,        // codes are never exposed to storefront
          };
        }
      }
      if (!rec.discount) rec.discount = null;
      return rec;
    }),
  );
}


// =============================================================================
// HELPER: RESPONSE FORMATTER
// =============================================================================

function formatRecommendation(rec, currency) {
  return {
    product_id: rec.id,
    variant_id: rec.default_variant_id,
    handle: rec.handle,
    title: rec.title,
    image_url: rec.featured_image ? `${rec.featured_image}?width=400` : null,
    price_cents: rec.price_cents,
    compare_at_price_cents: rec.compare_at_price_cents || null,
    currency,
    available: rec.available,
    discount: rec.discount,
    score: rec.score,
    reason: rec.reason,
  };
}


// =============================================================================
// HELPER: SHOP CURRENCY
// =============================================================================

async function getShopCurrency(shop) {
  // Cached on app install, updated on shop/update webhook
  const currency = await redis.get(`hybrid:shop:currency:${shop}`);
  return currency || 'USD';
}


// =============================================================================
// HELPER: ERROR ENVELOPE
// =============================================================================

function sendError(res, status, code, message, requestId) {
  return res.status(status).json({
    error: {
      code,
      message,
      request_id: requestId,
    },
  });
}

function sendEmpty(res, requestId, servedFrom) {
  return res.status(200).json({
    recommendations: [],
    meta: {
      request_id: requestId,
      served_from: servedFrom,
      ttl_seconds: 0,
      generated_at: new Date().toISOString(),
    },
  });
}


// =============================================================================
// HELPER: REQUEST ID
// =============================================================================

function generateRequestId() {
  return `req_${crypto.randomBytes(8).toString('hex')}`;
}

function safeJsonParse(payload) {
  try {
    return JSON.parse(payload);
  } catch (error) {
    return null;
  }
}


// =============================================================================
// HELPER: LOGGING (NO PII)
// =============================================================================
// Logs request metadata only. Never logs:
//   - Cart contents (product titles, prices)
//   - Customer data (email, IP, name)
//   - Request/response bodies
//   - Discount codes or amounts

function logRequest(requestId, shop, cartSize, source, durationMs, status) {
  console.log(JSON.stringify({
    request_id: requestId,
    shop,                           // shop domain is operational, not PII
    cart_size: cartSize,            // count only, no product details
    served_from: source,
    duration_ms: Math.round(durationMs),
    status,
    ts: new Date().toISOString(),
  }));
}

function logError(requestId, shop, code, err) {
  console.error(JSON.stringify({
    request_id: requestId,
    shop,
    code,
    message: err?.message || 'unknown_error',
    ts: new Date().toISOString(),
  }));

  reportError({
    source: 'proxy',
    message: err?.message || 'unknown_error',
    details: { request_id: requestId, shop, code },
  });
}


// =============================================================================
// EXPORTS & SERVER START
// =============================================================================

export { app };

// Direct run:
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log(`[hybrid] listening on ${PORT}`));
