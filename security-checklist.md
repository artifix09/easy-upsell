# Security Checklist (Phase 1)

## 1) HMAC Verification

- Verify `X-Shopify-Hmac-Sha256` on every proxy request and webhook.
- Use raw body bytes (do not parse before verifying).
- Use timing-safe comparison.

## 2) Shop Domain Validation

- Require `X-Shopify-Shop-Domain` on proxy route.
- Validate with regex: `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`
- Reject if shop not installed (`hybrid:shop:installed:{shop}` missing).

## 3) Input Limits

- Body size cap: 16KB
- cart_items max: 50
- rate limit: 60/min per shop
- cold path rate limit: 30/min per shop

## 4) Logging Rules

- Never log request bodies, product titles, customer data, or IPs.
- Only log request_id, shop domain, counts, durations, and status.

## 5) Secrets

- Never expose API secrets on the storefront.
- Keep `SHOPIFY_API_SECRET` server-only.

## 6) Error Hygiene

- Return generic errors, no stack traces.
- Use the standard error envelope.
