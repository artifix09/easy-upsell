# Local Test Payloads (Phase 1)

Use these JSON payloads for manual testing.

## 1) App Proxy — /shopify/proxy/recommendations

```json
{
  "cart_items": [
    {
      "product_id": 8172639401,
      "variant_id": 44219876301,
      "quantity": 1
    }
  ],
  "limit": 1,
  "exclude_product_ids": [8172639401],
  "locale": "en"
}
```

## 2) Webhook — products/create

```json
{
  "id": 8172640100,
  "handle": "premium-leather-belt",
  "vendor": "Apex",
  "tags": "belt,accessories",
  "status": "active",
  "image": { "src": "https://cdn.shopify.com/s/files/1/0001/products/belt.webp" },
  "variants": [
    {
      "id": 44219877001,
      "price": "45.00",
      "compare_at_price": "60.00",
      "inventory_quantity": 42,
      "inventory_policy": "deny",
      "inventory_item_id": 900001
    }
  ]
}
```

## 3) Webhook — products/update

```json
{
  "id": 8172640100,
  "handle": "premium-leather-belt",
  "vendor": "Apex",
  "tags": "belt,accessories,leather",
  "status": "active",
  "image": { "src": "https://cdn.shopify.com/s/files/1/0001/products/belt.webp" },
  "variants": [
    {
      "id": 44219877001,
      "price": "49.00",
      "compare_at_price": "60.00",
      "inventory_quantity": 12,
      "inventory_policy": "deny",
      "inventory_item_id": 900001
    }
  ]
}
```

## 4) Webhook — products/delete

```json
{
  "id": 8172640100
}
```

## 5) Webhook — inventory_levels/update

```json
{
  "inventory_item_id": 900001,
  "location_id": 905684977,
  "available": 0,
  "updated_at": "2026-05-02T10:30:00Z"
}
```
