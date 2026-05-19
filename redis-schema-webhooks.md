# Redis Schema + Webhook Invalidation Plan (Phase 1)

This document defines Redis keys, TTLs, and webhook-driven invalidation rules for the recommendations engine.

## 1) Keyspace Overview

Prefix all keys with a single namespace to avoid collisions.

- Namespace: `hybrid:`

### 1.1 Result Cache (Tier 2)

- Key: `hybrid:reco:{shop}:{hash}`
- Value: JSON array of recommendation items
- TTL: 300s
- Write: after scoring
- Invalidate: TTL only (no webhook invalidation)

### 1.2 Product Cache (Tier 1)

- Key: `hybrid:prod:{shop}:{product_id}`
- Value: normalized product JSON
- TTL: 600s
- Write: after Admin API fetch
- Invalidate: on product webhooks

### 1.3 Index Cache (Tier 3)

- Collection index:
  - Key: `hybrid:idx:coll:{shop}:{collection_id}` (SET)
  - Members: product_id
  - TTL: 3600s
- Tag index:
  - Key: `hybrid:idx:tag:{shop}:{tag}` (SET)
  - Members: product_id
  - TTL: 3600s
- Vendor index:
  - Key: `hybrid:idx:vendor:{shop}:{vendor}` (SET)
  - Members: product_id
  - TTL: 3600s
- Invalidate: update on product webhooks (incremental)

### 1.4 Shop Metadata

- Installed shops:
  - Key: `hybrid:shop:installed:{shop}`
  - Value: 1
  - TTL: none
- Shop currency:
  - Key: `hybrid:shop:currency:{shop}`
  - Value: ISO currency code
  - TTL: none

### 1.5 Discount Rules (Display Only)

- Key: `hybrid:discount:rule:{shop}:{product_id}`
- Value: { type, value, label, active }
- TTL: 3600s (refresh on admin update)

### 1.6 Tag Affinity Map

- Key: `hybrid:tag:affinity:{shop}`
- Value: JSON map { "shirt": ["belt","tie"] }
- TTL: 3600s (refresh on admin update)

### 1.7 Rate Limits

- Key: `hybrid:rl:{shop}`
- Value: integer counter
- TTL: 60s
- Key: `hybrid:rl:cold:{shop}`
- Value: integer counter
- TTL: 60s

---

## 2) Normalized Product JSON (Stored in `hybrid:prod:*`)

```json
{
  "id": 8172640100,
  "title": "Premium Leather Belt",
  "handle": "premium-leather-belt",
  "vendor": "Apex",
  "tags": ["belt", "accessories"],
  "collection_ids": ["gid://shopify/Collection/123"],
  "featured_image": "https://cdn.shopify.com/.../belt.webp",
  "price_cents": 4500,
  "compare_at_price_cents": 6000,
  "default_variant_id": 44219877001,
  "inventory_quantity": 42,
  "available": true
}
```

---

## 3) Webhook Invalidation Rules

### 3.1 products/create

- Add product to indexes
- Set `hybrid:prod:{shop}:{product_id}`

Steps:
1) Normalize payload → product cache
2) Add product_id to:
   - `hybrid:idx:vendor:{shop}:{vendor}`
   - `hybrid:idx:tag:{shop}:{tag}` for each tag
   - `hybrid:idx:coll:{shop}:{collection_id}` for each collection

### 3.2 products/update

- Replace product cache
- Reconcile indexes

Steps:
1) Load existing product cache (if any) to find old tags/vendor/collections
2) Update `hybrid:prod:{shop}:{product_id}`
3) Diff old vs new tags/collections/vendor
4) Remove from old sets, add to new sets

### 3.3 products/delete

- Delete product cache
- Remove from all indexes

Steps:
1) Load product cache (if available)
2) Remove product_id from old tag/vendor/collection sets
3) Delete `hybrid:prod:{shop}:{product_id}`

### 3.4 inventory_levels/update

- Update availability and inventory_quantity

Steps:
1) Load product cache
2) Update `inventory_quantity` + `available`
3) Write back to `hybrid:prod:{shop}:{product_id}` with original TTL

### 3.5 collections/update (optional)

If collection membership is not included in product webhooks, refresh indexes by:
- Pulling collection products via Admin API
- Rebuild `hybrid:idx:coll:{shop}:{collection_id}`

---

## 4) Operational Notes

- Use pipelined Redis writes for batch updates on webhook floods.
- All webhooks must validate `X-Shopify-Hmac-Sha256`.
- Do not log product titles, tags, or customer data.
- On app uninstall:
  - Delete `hybrid:shop:installed:{shop}`
  - Optionally purge all `hybrid:*:{shop}:*` keys
