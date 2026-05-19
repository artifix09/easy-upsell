# Phase 1: POST /recommendations — Endpoint Specification

**Version:** 1.0 | **Date:** May 2, 2026 | **Status:** Implementation-Ready

---

## 1. Request / Response Contract

### 1.1 Request

```
POST /apps/hybrid/recommendations
Content-Type: application/json
```

Routed via Shopify App Proxy (see §3). Shopify injects authentication headers automatically.

**Request Body:**

```json
{
  "cart_items": [
    {
      "product_id": 8172639401,
      "variant_id": 44219876301,
      "quantity": 1
    },
    {
      "product_id": 8172639522,
      "variant_id": 44219876455,
      "quantity": 2
    }
  ],
  "limit": 3,
  "exclude_product_ids": [8172639401, 8172639522],
  "locale": "en"
}
```

**Field Definitions:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `cart_items` | array | yes | 1–50 items |
| `cart_items[].product_id` | integer | yes | valid Shopify GID numeric |
| `cart_items[].variant_id` | integer | yes | valid Shopify GID numeric |
| `cart_items[].quantity` | integer | yes | 1–99 |
| `limit` | integer | no | 1–10, default 3 |
| `exclude_product_ids` | integer[] | no | 0–100 items, default = cart product IDs |
| `locale` | string | no | ISO 639-1, default "en" |

### 1.2 Success Response — 200

```json
{
  "recommendations": [
    {
      "product_id": 8172640100,
      "variant_id": 44219877001,
      "handle": "premium-leather-belt",
      "title": "Premium Leather Belt",
      "image_url": "https://cdn.shopify.com/s/files/1/0001/shop/products/belt.webp?v=1717000000&width=400",
      "price_cents": 4500,
      "compare_at_price_cents": 6000,
      "currency": "USD",
      "available": true,
      "discount": {
        "type": "percentage",
        "value": 10,
        "label": "Bundle & save 10%",
        "discount_code": null
      },
      "score": 0.85,
      "reason": "frequently_bought_together"
    },
    {
      "product_id": 8172640200,
      "variant_id": 44219877055,
      "handle": "matching-socks-3-pack",
      "title": "Matching Socks — 3 Pack",
      "image_url": "https://cdn.shopify.com/s/files/1/0001/shop/products/socks.webp?v=1717000001&width=400",
      "price_cents": 1800,
      "compare_at_price_cents": null,
      "currency": "USD",
      "available": true,
      "discount": null,
      "score": 0.72,
      "reason": "same_collection"
    }
  ],
  "meta": {
    "request_id": "req_a1b2c3d4",
    "served_from": "cache",
    "ttl_seconds": 300,
    "generated_at": "2026-05-02T10:30:00Z"
  }
}
```

### 1.3 Error Response

All errors follow the same envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "cart_items must contain between 1 and 50 items.",
    "request_id": "req_a1b2c3d4"
  }
}
```

**Error Code Table:**

| HTTP | Code | Cause |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed body, missing required fields, constraint violation |
| 400 | `EMPTY_CART` | `cart_items` is empty array |
| 401 | `UNAUTHORIZED` | Missing or invalid app proxy signature |
| 403 | `SHOP_MISMATCH` | `X-Shopify-Shop-Domain` doesn't match installed shop |
| 404 | `PRODUCTS_NOT_FOUND` | None of the submitted product IDs exist in the shop |
| 429 | `RATE_LIMITED` | Exceeded 60 req/min per shop |
| 500 | `INTERNAL_ERROR` | Unhandled server error |
| 503 | `UPSTREAM_TIMEOUT` | Shopify Admin API call exceeded deadline |

---

## 2. Validation Rules

```
VALIDATION PIPELINE (executed in order, fail-fast)
──────────────────────────────────────────────────

1. SIGNATURE CHECK
   IF request lacks X-Shopify-Signature header:
       RETURN 401 UNAUTHORIZED
   IF HMAC-SHA256(raw_body, APP_SECRET) != X-Shopify-Signature:
       RETURN 401 UNAUTHORIZED

2. SHOP DOMAIN CHECK
   shop_domain = request.header("X-Shopify-Shop-Domain")
   IF shop_domain NOT IN installed_shops_table:
       RETURN 403 SHOP_MISMATCH

3. CONTENT TYPE
   IF Content-Type != "application/json":
       RETURN 400 VALIDATION_ERROR "Content-Type must be application/json"

4. BODY PARSE
   TRY parse JSON body
   CATCH: RETURN 400 VALIDATION_ERROR "Malformed JSON"

5. FIELD VALIDATION
   IF cart_items is missing OR not array:
       RETURN 400 VALIDATION_ERROR
   IF cart_items.length == 0:
       RETURN 400 EMPTY_CART
   IF cart_items.length > 50:
       RETURN 400 VALIDATION_ERROR "cart_items max 50"
   
   FOR each item IN cart_items:
       IF item.product_id is not positive integer:  FAIL
       IF item.variant_id is not positive integer:  FAIL
       IF item.quantity < 1 OR item.quantity > 99:  FAIL
   
   IF limit is present AND (limit < 1 OR limit > 10):
       RETURN 400 VALIDATION_ERROR "limit must be 1-10"
   
   IF exclude_product_ids is present AND length > 100:
       RETURN 400 VALIDATION_ERROR "exclude_product_ids max 100"

6. RATE LIMIT
   key = "reco:" + shop_domain
   IF redis.INCR(key) > 60:  // 60/min per shop
       RETURN 429 RATE_LIMITED
   redis.EXPIRE(key, 60)
```

---

## 3. App Proxy Setup

### Why App Proxy, Not Direct Backend

| Factor | App Proxy | Direct Backend |
|---|---|---|
| CORS | Handled by Shopify — same origin | You manage CORS headers |
| Auth | Shopify injects HMAC signature | You build your own token system |
| Token leakage | Impossible — no API keys in JS | Risk of exposing secrets |
| SSL | Shopify's cert | Your cert |
| Latency | +5-15ms hop through Shopify | Direct, but CORS preflight adds ~50ms |
| Verdict | **Use this** | Only if proxy latency is unacceptable |

### Shopify App Proxy Configuration

```
In Partner Dashboard → App Setup → App Proxy:

  Subpath prefix:  apps
  Subpath:         hybrid
  Proxy URL:       https://api.yourdomain.com/shopify/proxy

Result:
  https://your-store.myshopify.com/apps/hybrid/recommendations
  → proxied to →
  https://api.yourdomain.com/shopify/proxy/recommendations
```

**What Shopify sends to your backend:**

```
POST https://api.yourdomain.com/shopify/proxy/recommendations

Headers injected by Shopify:
  X-Shopify-Shop-Domain: your-store.myshopify.com
  X-Shopify-Signature: <HMAC of query params>
  X-Shopify-Topic: proxy
  X-Shopify-Hmac-Sha256: <body HMAC>

The original request body is forwarded as-is.
```

### Theme JS Caller (for reference, not deliverable)

```javascript
// Theme calls same-origin — no CORS, no tokens
const res = await fetch('/apps/hybrid/recommendations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    cart_items: cartItems,
    limit: 3
  })
});
```

---

## 4. Recommendation Algorithm (MVP — Deterministic)

No ML. No external service. Pure database lookups with a scoring function.

```
ALGORITHM: DETERMINISTIC RECOMMENDATION ENGINE
───────────────────────────────────────────────

INPUT:  cart_product_ids[], shop_domain, limit, exclude_ids[]
OUTPUT: scored_recommendations[]

STEP 1: RESOLVE CART CONTEXT
────────────────────────────
  cart_collections = []
  cart_tags        = []
  cart_vendor      = []
  cart_price_range = { min: Infinity, max: 0 }
  
  FOR each pid IN cart_product_ids:
      product = product_cache.GET(shop_domain, pid)
      cart_collections.APPEND(product.collection_ids)
      cart_tags.APPEND(product.tags)
      cart_vendor.APPEND(product.vendor)
      cart_price_range.min = MIN(cart_price_range.min, product.price)
      cart_price_range.max = MAX(cart_price_range.max, product.price)

STEP 2: BUILD CANDIDATE POOL
─────────────────────────────
  candidates = []

  // Source A: Same collections (strongest signal)
  FOR each collection_id IN UNIQUE(cart_collections):
      products = collection_product_index.GET(shop_domain, collection_id)
      candidates.APPEND(products)

  // Source B: Same vendor
  FOR each vendor IN UNIQUE(cart_vendor):
      products = vendor_product_index.GET(shop_domain, vendor)
      candidates.APPEND(products)

  // Source C: Overlapping tags (complementary items)
  complementary_tags = TAG_AFFINITY_MAP.GET(cart_tags)
  // TAG_AFFINITY_MAP is a static config per shop, e.g.:
  //   "shirt" → ["belt", "tie", "cufflinks"]
  //   "shoes" → ["socks", "shoe-care", "insoles"]
  FOR each tag IN complementary_tags:
      products = tag_product_index.GET(shop_domain, tag)
      candidates.APPEND(products)

  // Deduplicate and exclude
  candidates = UNIQUE(candidates)
  candidates = candidates.FILTER(p => p.id NOT IN exclude_ids)
  candidates = candidates.FILTER(p => p.available == true)

STEP 3: SCORE CANDIDATES
─────────────────────────
  FOR each candidate IN candidates:
      score = 0.0
      reasons = []

      // Signal 1: Collection overlap (0–0.40)
      shared_collections = INTERSECT(candidate.collection_ids, cart_collections)
      score += MIN(shared_collections.length * 0.20, 0.40)
      IF shared_collections.length > 0: reasons.APPEND("same_collection")

      // Signal 2: Tag affinity (0–0.30)
      IF candidate sourced from complementary_tags:
          score += 0.30
          reasons.APPEND("frequently_bought_together")

      // Signal 3: Price proximity (0–0.15)
      // Prefer items within 50% of cart avg price
      cart_avg = (cart_price_range.min + cart_price_range.max) / 2
      price_delta = ABS(candidate.price - cart_avg) / cart_avg
      IF price_delta <= 0.5:
          score += 0.15 * (1 - price_delta / 0.5)

      // Signal 4: Same vendor (0.10)
      IF candidate.vendor IN cart_vendor:
          score += 0.10

      // Signal 5: Inventory boost (0.05)
      // Slight preference for well-stocked items (fewer OOS risks)
      IF candidate.inventory_quantity > 20:
          score += 0.05

      candidate.score  = ROUND(score, 2)
      candidate.reason = reasons[0] OR "related_product"

STEP 4: RANK AND RETURN
────────────────────────
  candidates.SORT_DESC_BY(score)

  // Diversity filter: max 2 from same collection
  final = []
  collection_count = {}
  FOR each candidate IN candidates:
      dominant_collection = candidate.collection_ids[0]
      IF collection_count.GET(dominant_collection, 0) >= 2:
          CONTINUE
      collection_count[dominant_collection] += 1
      final.APPEND(candidate)
      IF final.length >= limit:
          BREAK

  RETURN final
```

---

## 5. Caching Strategy

```
THREE-TIER CACHE
────────────────

TIER 1: PRODUCT DATA CACHE (Redis)
───────────────────────────────────
  Purpose:  Avoid Shopify Admin API calls on every request
  Key:      prod:{shop_domain}:{product_id}
  Value:    { title, handle, image_url, price, tags, collections, vendor,
              inventory_quantity, available, variants[] }
  TTL:      600 seconds (10 min)
  Warm:     Webhook-driven invalidation:
              products/update → DELETE prod:{shop}:{pid}
              products/delete → DELETE prod:{shop}:{pid}
              inventory_levels/update → UPDATE available + qty fields
  Size:     ~2KB per product, ~2MB per 1000-product shop

TIER 2: RECOMMENDATION RESULT CACHE (Redis)
────────────────────────────────────────────
  Purpose:  Cache identical recommendation requests
  Key:      reco:{shop_domain}:{hash(sorted_product_ids + limit)}
  Value:    Full response JSON
  TTL:      300 seconds (5 min)
  Hit rate: High — most carts share similar compositions
  
  CACHE KEY GENERATION:
    input_ids = cart_items.MAP(i => i.product_id).SORT()
    cache_key = "reco:" + shop + ":" + SHA256(input_ids.JOIN(",") + ":" + limit)

TIER 3: COLLECTION/TAG INDEX CACHE (Redis)
──────────────────────────────────────────
  Purpose:  Pre-computed lookup tables for the algorithm
  Key:      idx:coll:{shop}:{collection_id} → [product_ids]
            idx:tag:{shop}:{tag} → [product_ids]
            idx:vendor:{shop}:{vendor} → [product_ids]
  TTL:      3600 seconds (1 hour)
  Warm:     Full rebuild on app install, incremental on product webhooks

CACHE FLOW IN REQUEST:
  1. Check TIER 2 (result cache) → HIT? Return immediately
  2. MISS → Check TIER 1 (product cache) for each cart item
  3. Any TIER 1 MISS → Batch fetch from Shopify Admin API
  4. Run algorithm using TIER 3 indexes
  5. Write result to TIER 2
  6. Return

LATENCY BUDGET:
  Cache hit path:    Redis GET → deserialize → respond        ~15ms
  Cache miss path:   Validate → Redis lookups → score → write ~80ms
  Cold miss path:    + Shopify API call                       ~180ms (within budget)
```

---

## 6. Handler Pseudocode

```
FUNCTION handle_recommendations(request):
    request_id = generate_uuid()
    start_time = NOW()

    // ── AUTH ──
    IF NOT verify_shopify_proxy_signature(request):
        RETURN 401 { error: { code: "UNAUTHORIZED", request_id } }
    
    shop = request.header("X-Shopify-Shop-Domain")
    IF shop NOT IN installed_shops:
        RETURN 403 { error: { code: "SHOP_MISMATCH", request_id } }

    // ── RATE LIMIT ──
    IF rate_limiter.is_exceeded(shop, limit=60, window=60s):
        RETURN 429 { error: { code: "RATE_LIMITED", request_id } }

    // ── VALIDATE ──
    body = TRY parse_json(request.body)
          CATCH: RETURN 400 VALIDATION_ERROR
    
    errors = validate_schema(body)
    IF errors: RETURN 400 { error: { code: "VALIDATION_ERROR", message: errors[0], request_id } }

    // ── CACHE CHECK ──
    cart_ids = body.cart_items.MAP(i => i.product_id).SORT()
    limit    = body.limit OR 3
    exclude  = body.exclude_product_ids OR cart_ids
    
    cache_key = build_cache_key(shop, cart_ids, limit)
    cached = redis.GET(cache_key)
    IF cached:
        RETURN 200 {
            recommendations: cached,
            meta: { request_id, served_from: "cache", ttl_seconds: redis.TTL(cache_key) }
        }

    // ── RESOLVE PRODUCTS ──
    products = []
    missing_ids = []
    FOR each pid IN cart_ids:
        p = redis.GET("prod:" + shop + ":" + pid)
        IF p: products.APPEND(p)
        ELSE: missing_ids.APPEND(pid)
    
    IF missing_ids.LENGTH > 0:
        fetched = shopify_admin_api.batch_get_products(shop, missing_ids)
        IF fetched.LENGTH == 0 AND products.LENGTH == 0:
            RETURN 404 { error: { code: "PRODUCTS_NOT_FOUND", request_id } }
        FOR each p IN fetched:
            redis.SETEX("prod:" + shop + ":" + p.id, 600, p)
            products.APPEND(p)

    // ── RUN ALGORITHM ──
    recommendations = recommendation_engine.score(
        shop       = shop,
        cart       = products,
        limit      = limit,
        exclude    = exclude,
        locale     = body.locale OR "en"
    )

    // ── APPLY DISCOUNTS ──
    FOR each rec IN recommendations:
        discount_rule = discount_rules_cache.GET(shop, rec.product_id)
        IF discount_rule AND discount_rule.active:
            rec.discount = {
                type:  discount_rule.type,
                value: discount_rule.value,
                label: discount_rule.label,
                discount_code: null
            }

    // ── FORMAT RESPONSE ──
    response_items = recommendations.MAP(rec => {
        product_id:              rec.id,
        variant_id:              rec.default_variant_id,
        handle:                  rec.handle,
        title:                   rec.title,
        image_url:               rec.featured_image + "?width=400",
        price_cents:             rec.price_cents,
        compare_at_price_cents:  rec.compare_at_price_cents,
        currency:                shop_currency(shop),
        available:               rec.available,
        discount:                rec.discount OR null,
        score:                   rec.score,
        reason:                  rec.reason
    })

    // ── CACHE WRITE ──
    redis.SETEX(cache_key, 300, response_items)

    // ── RETURN ──
    elapsed = NOW() - start_time
    log.info({ request_id, shop, cart_size: cart_ids.LENGTH, results: response_items.LENGTH, ms: elapsed })

    RETURN 200 {
        recommendations: response_items,
        meta: {
            request_id,
            served_from: "origin",
            ttl_seconds: 300,
            generated_at: NOW().toISO()
        }
    }
```

---

## 7. Security Checklist

```
SECURITY REQUIREMENTS — ALL MANDATORY BEFORE DEPLOY
────────────────────────────────────────────────────

[1] NO ADMIN TOKENS ON STOREFRONT
    ✓ App proxy handles auth — theme JS sends zero credentials
    ✓ No API key, secret, or access token in theme Liquid or JS
    ✓ No X-Shopify-Access-Token header in frontend code
    ✓ Grep entire theme codebase for "shpat_", "shpca_", "shpss_" — zero hits

[2] HMAC SIGNATURE VERIFICATION
    ✓ Every request verified against APP_SECRET
    ✓ HMAC computed over raw body bytes, not parsed JSON
    ✓ Timing-safe comparison (crypto.timingSafeEqual or equivalent)
    ✓ Reject before any database or cache access

[3] SHOP DOMAIN VALIDATION
    ✓ X-Shopify-Shop-Domain checked against installed_shops table
    ✓ Domain must match regex: ^[a-z0-9-]+\.myshopify\.com$
    ✓ Prevents cross-shop data leakage (shop A can't query shop B products)

[4] INPUT SANITIZATION
    ✓ All IDs validated as positive integers (no string injection)
    ✓ Body size capped at 16KB (nginx/load balancer level)
    ✓ JSON depth limited to 2 levels
    ✓ No user-supplied strings echoed in response without encoding

[5] RATE LIMITING
    ✓ 60 requests/minute per shop domain
    ✓ Redis-backed sliding window counter
    ✓ 429 response includes Retry-After header
    ✓ Separate limit for cache-miss paths (30/min) to protect Shopify API quota

[6] NO DATA LEAKAGE IN RESPONSES
    ✓ Response never includes: inventory_quantity, cost, metafields, tags
    ✓ Error messages are generic — no stack traces, no internal IDs
    ✓ request_id is opaque UUID, not sequential
    ✓ Product images served from Shopify CDN only (cdn.shopify.com)

[7] TRANSPORT SECURITY
    ✓ App proxy forces HTTPS (Shopify-managed)
    ✓ Backend enforces TLS 1.2+ on proxy URL
    ✓ HSTS enabled on backend domain
    ✓ No HTTP redirect — reject plaintext outright

[8] DEPENDENCY HYGIENE
    ✓ Zero client-side dependencies (no npm packages in storefront)
    ✓ Server dependencies audited (npm audit / cargo audit in CI)
    ✓ No eval(), no dynamic require(), no template string interpolation in queries

[9] LOGGING AND MONITORING
    ✓ Log: request_id, shop, cart_size, response_time, cache_hit, status_code
    ✓ Never log: full cart contents, customer data, IP addresses
    ✓ Alert on: >5% error rate, p99 latency >500ms, rate limit spike

[10] WEBHOOK SECURITY (for cache invalidation)
    ✓ All incoming webhooks verified via X-Shopify-Hmac-Sha256
    ✓ Webhook endpoint is separate from proxy endpoint
    ✓ Idempotent processing (duplicate webhook delivery is safe)
```

---

## 8. Latency Breakdown Target

```
REQUEST LIFECYCLE — TARGET <200ms (p95)
───────────────────────────────────────

  Shopify proxy hop .............. 10ms
  TLS + TCP to backend ........... 5ms
  Signature verification ......... 1ms
  Validation ..................... 1ms
  ┌─ CACHE HIT PATH ──────────── 15ms ─┐
  │  Redis GET ................... 2ms  │
  │  Deserialize ................. 1ms  │
  │  Serialize response .......... 2ms  │
  │  TOTAL .................... ~35ms   │
  └─────────────────────────────────────┘
  ┌─ CACHE MISS PATH ─────────── 80ms ─┐
  │  Redis multi-GET (products) .. 5ms  │
  │  Algorithm scoring ........... 8ms  │
  │  Redis multi-GET (indexes) ... 5ms  │
  │  Discount rule lookup ........ 2ms  │
  │  Serialize + cache write ..... 5ms  │
  │  TOTAL ................... ~100ms   │
  └─────────────────────────────────────┘
  ┌─ COLD MISS PATH ─────────── 160ms ─┐
  │  Shopify Admin API batch ..... 80ms │
  │  + Cache miss path ........... 80ms │
  │  TOTAL ................... ~180ms   │
  └─────────────────────────────────────┘
```

---

*Implementation-ready. No ambiguity. Ship it.*
