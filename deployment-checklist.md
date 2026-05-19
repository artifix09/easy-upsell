# Deployment Checklist (Phase 1)

## 1) Environment

- `SHOPIFY_API_SECRET` set
- `REDIS_URL` reachable
- `PORT` set (if required)

## 2) Shopify App Setup

- App Proxy configured (see [app-proxy-checklist.md](app-proxy-checklist.md))
- Webhooks registered (see [webhook-registration-checklist.md](webhook-registration-checklist.md))

## 3) Backend

- `/shopify/proxy/recommendations` responding
- `/webhooks/*` responding
- `/health` returns 200
- 404 handler enabled

## 4) Redis

- `hybrid:shop:installed:{shop}` set for installed shops
- Index caches warm or can be built from webhooks

## 5) Observability

- Logging in JSON format
- Alerting configured for >5% error rate or p99 > 500ms
