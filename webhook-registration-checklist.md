# Webhook Registration Checklist (Phase 1)

Use this to register backend webhooks for cache/index updates.

## 1) Required Topics

- `products/create`
- `products/update`
- `products/delete`
- `inventory_levels/update`
- `orders/create`
- `orders/cancelled` (optional)

## 2) Target URLs

- `POST https://YOUR_DOMAIN.com/webhooks/products/create`
- `POST https://YOUR_DOMAIN.com/webhooks/products/update`
- `POST https://YOUR_DOMAIN.com/webhooks/products/delete`
- `POST https://YOUR_DOMAIN.com/webhooks/inventory/update`
- `POST https://YOUR_DOMAIN.com/webhooks/orders/create`
- `POST https://YOUR_DOMAIN.com/webhooks/orders/cancelled` (optional)

## 3) Payload Format

- Content-Type: `application/json`
- Shopify sends `X-Shopify-Hmac-Sha256` header

## 4) Notes

- Verify HMAC for every webhook.
- Respond with 200 quickly; process async.
- Idempotent by design; no duplicate side effects.
