# Manual Test Flow (Phase 1)

This is a manual sequence to validate the proxy + webhook logic locally.

## 1) Prepare

- Ensure Redis is running
- Set env vars (`SHOPIFY_API_SECRET`, `REDIS_URL`)
- Start server: `node server.mjs`
- Mark installed shop: `node set-installed-shop.mjs your-shop.myshopify.com`

## 2) Warm indexes (optional)

- `node warm-indexes.mjs your-shop.myshopify.com catalog-example.json`

## 3) App Proxy Test (Local)

- Compute HMAC for the request body:
  - `node hmac-generate.mjs YOUR_SECRET proxy-request.json`
- Send POST to `/shopify/proxy/recommendations` with:
  - `Content-Type: application/json`
  - `X-Shopify-Shop-Domain: your-shop.myshopify.com`
  - `X-Shopify-Hmac-Sha256: <signature>`

## 4) Webhook Test (Local)

- Compute HMAC for webhook payload body
- Send POST to each webhook route with:
  - `Content-Type: application/json`
  - `X-Shopify-Shop-Domain: your-shop.myshopify.com`
  - `X-Shopify-Hmac-Sha256: <signature>`

## 5) Verify

- Confirm Redis keys exist:
  - `hybrid:prod:*`
  - `hybrid:idx:*`
  - `hybrid:reco:*`
- Check server logs for `processed` events
