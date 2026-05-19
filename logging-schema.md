# Logging Schema (Phase 1)

Log JSON only. No PII.

## 1) Proxy Request Log

```json
{
  "request_id": "req_a1b2c3d4",
  "shop": "example.myshopify.com",
  "cart_size": 3,
  "served_from": "cache",
  "duration_ms": 28,
  "status": 200,
  "ts": "2026-05-02T10:30:00Z"
}
```

## 2) Webhook Log

```json
{
  "event": "product_updated",
  "status": "processed",
  "topic": "products/update",
  "webhook_id": "3c3f...",
  "shop": "example.myshopify.com",
  "product_id": 8172640100,
  "ts": "2026-05-02T10:30:00Z"
}
```

## 3) Rules

- Do not log request/response bodies.
- Do not log titles, tags, prices, customer data, or IPs.
- Always include `request_id` or `webhook_id`.
