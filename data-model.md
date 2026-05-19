# Data Model (Phase 1)

## 1) Normalized Product (Redis: hybrid:prod:{shop}:{product_id})

```json
{
  "id": 8172640100,
  "title": "Premium Leather Belt",
  "handle": "premium-leather-belt",
  "vendor": "Apex",
  "tags": ["belt", "accessories"],
  "collection_ids": ["123"],
  "featured_image": "https://cdn.shopify.com/s/files/1/0001/products/belt.webp",
  "price_cents": 4500,
  "compare_at_price_cents": 6000,
  "default_variant_id": 44219877001,
  "inventory_quantity": 42,
  "available": true
}
```

## 2) Discount Rule (Redis: hybrid:discount:rule:{shop}:{product_id})

```json
{
  "type": "percentage",
  "value": 10,
  "label": "Bundle & save 10%",
  "active": true
}
```

## 3) Tag Affinity Map (Redis: hybrid:tag:affinity:{shop})

```json
{
  "shirt": ["belt", "tie"],
  "shoes": ["socks", "insoles"]
}
```
