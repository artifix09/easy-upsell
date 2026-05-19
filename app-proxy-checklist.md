# App Proxy Checklist (Phase 1)

Use this to configure the Shopify App Proxy so storefront JS can call the backend safely.

## 1) Partner Dashboard Setup

- App setup → App proxy
- Subpath prefix: `apps`
- Subpath: `hybrid`
- Proxy URL: `https://YOUR_DOMAIN.com/shopify/proxy`

Resulting storefront URL:
- `https://{shop}.myshopify.com/apps/hybrid/recommendations`

## 2) Backend Route Mapping

- Shopify forwards to:
  - `POST /shopify/proxy/recommendations`
- Your server must accept JSON and verify `X-Shopify-Hmac-Sha256`.

## 3) Required Headers (Injected by Shopify)

- `X-Shopify-Shop-Domain`
- `X-Shopify-Hmac-Sha256`

## 4) Common Failure Points

- Missing raw body capture for HMAC
- Proxy URL mis-typed (no `/shopify/proxy`)
- Using a custom domain without HTTPS
- Shopify app not installed on the shop

## 5) Test Call (Manual)

From storefront console (theme JS):

```js
fetch('/apps/hybrid/recommendations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    cart_items: [{ product_id: 1, variant_id: 1, quantity: 1 }],
    limit: 1
  })
});
```
