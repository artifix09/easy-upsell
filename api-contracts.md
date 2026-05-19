# API Contracts (Phase 1)

## 1) POST /shopify/proxy/recommendations

### Request

```json
{
  "cart_items": [
    { "product_id": 8172639401, "variant_id": 44219876301, "quantity": 1 }
  ],
  "limit": 3,
  "exclude_product_ids": [8172639401],
  "locale": "en"
}
```

### Success Response

```json
{
  "recommendations": [
    {
      "product_id": 8172640100,
      "variant_id": 44219877001,
      "handle": "premium-leather-belt",
      "title": "Premium Leather Belt",
      "image_url": "https://cdn.shopify.com/.../belt.webp?width=400",
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

### Error Response

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "cart_items must contain between 1 and 50 items.",
    "request_id": "req_a1b2c3d4"
  }
}
```
