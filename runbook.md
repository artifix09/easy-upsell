# Hybrid App Runbook (Phase 1)

This runbook lists required env vars, routes, and webhook endpoints.

## 1) Environment Variables

- `SHOPIFY_API_SECRET` — App secret (required)
- `REDIS_URL` — Redis connection string (required)
- `PORT` — Server port (optional, default 3000)

Example: see [.env.example](.env.example)

## 2) Routes

### 2.1 App Proxy Route

- `POST /shopify/proxy/recommendations`
- Called via Shopify App Proxy:
  - Storefront calls `/apps/hybrid/recommendations`
  - Shopify proxies to `/shopify/proxy/recommendations`

### 2.2 Health

- `GET /health` → `200 ok`

### 2.3 Fallback

- All other routes → `404 { "error": "not_found" }`

## 3) Webhooks (Backend)

All webhook routes accept `application/json` and require HMAC verification.

- `POST /webhooks/products/create`
- `POST /webhooks/products/update`
- `POST /webhooks/products/delete`
- `POST /webhooks/inventory/update`

## 4) Redis Key Namespace

All keys are prefixed with `hybrid:`. See [redis-schema-webhooks.md](redis-schema-webhooks.md) for details.

## 5) Notes

- App Proxy requests require raw body HMAC verification.
- Webhooks use raw body HMAC verification.
- Do not log request bodies or PII.
- See [api-contracts.md](api-contracts.md) and [data-model.md](data-model.md) for schema details.
- See [security-checklist.md](security-checklist.md) and [performance-budget.md](performance-budget.md) for ops targets.
- See [logging-schema.md](logging-schema.md) and [deployment-checklist.md](deployment-checklist.md) for production setup.

## 6) Phase 2 Roadmap (Bundle Engine)

Milestone A: Discount Function + Validation Function
- Build `hybrid-bundle-discount` and `hybrid-bundle-validate` functions.
- Enforce stacking policy and double-discount rules.

Milestone B: Bundle Admin UI (App)
- CRUD bundle configs.
- Write `hybrid.bundle_config` metafields.

Milestone C: Theme Integration
- Bundle UI blocks read metafields only.
- No client-side price logic; rely on Functions.

Milestone D: QA + Release
- Function unit tests (100+ discount/code permutations).
- Performance regression checks for storefront.

## 7) Threat Model (Summary)

Attack surfaces:
- App Proxy endpoint (unauthenticated storefront calls).
- Webhooks (spoofed or replayed payloads).
- Redis cache poisoning (malformed product data).

Mitigations:
- Enforce HMAC verification and raw body checks.
- Validate shop domain and installation status.
- Tight request limits and body size caps.
- Safe logging and no PII retention.

## 8) Bundle Config Schema (Summary)

Stored in `product.metafields.hybrid.bundle_config`:

```json
{
  "bundle_id": "bundle_abc123",
  "strategy": "fixed",
  "components": [
    {
      "product_id": "gid://shopify/Product/123",
      "variant_id": "gid://shopify/ProductVariant/456",
      "quantity_min": 1,
      "quantity_max": 3,
      "is_required": true
    }
  ],
  "pricing": {
    "discount_type": "percentage",
    "discount_value": 15,
    "applies_to": "bundle_total",
    "stacking_policy": "exclusive"
  }
}
```

## 9) Function Test Matrix (Summary)

Minimum test coverage:
- Bundles: fixed, mix_and_match, volume_tiered
- Discounts: percentage, fixed_amount, fixed_price
- Stacking: exclusive, best_price, stackable
- Codes: no code, allowed code, excluded code, wildcard excluded
- Inventory: full stock, partial stock, out of stock
- Edge: zero quantity, invalid component, duplicate lines

## 10) Bundle Function IO (Summary)

Discount Function input:
- Cart lines, active discount codes, `product.metafields.hybrid.bundle_config`

Discount Function output:
- `discountApplicationStrategy: "MAXIMUM"`
- Per-line discount targets with message `"Bundle savings applied"`

Validation Function output (when conflict):
- Error on `$.cart.discountCodes` with a localized message

## 11) Bundle UI Data Flow (Summary)

1) Merchant configures bundle in app admin.
2) App writes `hybrid.bundle_config` metafield to products.
3) Theme reads metafield and renders bundle UI.
4) Checkout applies Function discounts (no client-side pricing).

## 12) Phase 2 Prerequisites

- Shopify Functions runtime configured and deployable.
- App admin UI can write `hybrid.bundle_config` metafields.
- Webhook cache/index system stable (Phase 1).
- Test store with representative catalog.

## 13) Phase 2 Risks

- Discount stacking conflicts with existing codes.
- Edge cases in bundle validation (partial stock).
- Theme UI drift if metafield schema changes.
- Performance regressions if Functions logic grows.

## 14) Phase 2 Acceptance Criteria

- Bundle discounts apply correctly across all stacking policies.
- Validation Function blocks invalid bundle states.
- No client-side price calculation in theme.
- Checkout totals match expected discounts.
- No regressions to Phase 1 upsell flow.

## 15) Phase 2 Rollback Plan

- Disable Function deployment (revert to last stable version).
- Hide bundle UI blocks in theme settings.
- Preserve metafields for reactivation.

## 16) Phase 1 Acceptance Criteria

- App Proxy endpoint passes HMAC verification.
- Cache hit path returns < 200ms p95.
- Webhooks update Redis indexes correctly.
- Upsell component hides when product already in cart.
- No PII in logs.

## 17) Phase 1 Rollback Plan

- Disable app proxy route (return 503).
- Remove cart drawer section from theme.
- Stop webhook processing (keep Redis intact).

## 18) Phase 1 Monitoring Checklist

- Error rate < 5% (proxy + webhooks).
- p95 latency < 200ms.
- Cache hit ratio > 60%.
- Redis memory stable, no key explosion.

## 19) Phase 1 Go-Live Checklist

- App Proxy configured in Partner dashboard.
- Webhooks registered and verified.
- Redis reachable from backend.
- Logs emitting JSON format.
- Manual test flow completed.

## 20) Phase 1 Post-Launch Checklist

- Review error logs daily for 7 days.
- Verify cache hit ratio trend.
- Confirm no unexpected Redis key growth.
- Gather first merchant feedback.

## 21) Phase 1 Incident Response

- If proxy errors spike: return 503 from proxy route.
- If webhooks fail: pause webhook processing and re-register.
- If Redis issues: disable cache writes and return safe empty recommendations.

## 22) Phase 1 Metrics to Track

- Requests per minute (proxy).
- Cache hit ratio.
- p95 latency.
- Error rate by code.
- Upsell add-to-cart rate.

## 23) Phase 1 Support SOP

- Confirm shop is installed (`hybrid:shop:installed:{shop}`).
- Verify app proxy endpoint reachable.
- Check HMAC verification logs for failures.
- Validate webhook delivery in Shopify admin.

## 24) Phase 1 Data Retention

- Redis cache TTLs: 300s (results), 600s (products), 3600s (indexes).
- No long-term storage of storefront request data.
- Clear cache keys on uninstall if required.

## 25) Phase 1 SLA Assumptions

- Proxy endpoint availability: 99.9%.
- p95 latency target: < 200ms.
- Error rate target: < 1%.

## 26) Phase 1 Dependencies

- Shopify App Proxy configured.
- Redis available and stable.
- Shopify webhooks enabled and delivering.
- Shopify Admin API access for product fetches.

## 27) Phase 1 Ownership/Contacts

- Backend owner: TBD
- Theme owner: TBD
- Ops contact: TBD

## 28) Phase 1 Change Management

- Use versioned deploy tags.
- Roll out in staging first, then production.
- Record proxy/webhook config changes.

## 29) Phase 1 Audit Checklist

- Verify HMAC verification enabled.
- Confirm raw body capture on proxy/webhooks.
- Validate Redis key prefixes are `hybrid:`.
- Ensure 404 handler is active.

## 30) Phase 1 Dependency Health Checks

- Redis ping returns OK.
- Shopify Admin API credentials valid.
- App Proxy responding.

## 31) Phase 1 Backup/Restore

- Redis is cache-only; no backup required.
- If persistence enabled, snapshot at least daily.

## 32) Phase 1 Deprecation Policy

- Provide 30 days notice for breaking API changes.
- Keep backward compatibility for one version window.

## 33) Phase 1 Onboarding Checklist

- Verify shop installation in Redis.
- Configure app proxy and webhooks.
- Run manual test flow.
- Enable cart drawer in theme.

## 34) Phase 1 Data Quality Checks

- Ensure normalized product cache has `price_cents`, `available`, `default_variant_id`.
- Ensure index sets contain only numeric product IDs.
- Ensure tag affinity map is valid JSON.

## 35) Phase 1 Release Notes Template

- Summary
- Impacted endpoints
- Breaking changes (if any)
- Rollback plan

## 36) Phase 1 Disaster Recovery

- If Redis is down, return empty recommendations.
- If backend is down, disable app proxy route.
- Restore from last known good deploy.

## 37) Phase 1 Capacity Planning

- Redis memory sized for product cache + indexes.
- Rate limit protects upstream API quota.
- Scale backend statelessly; Redis is shared.

## 38) Phase 1 Change Log Checklist

- Record deployment time and version.
- Note any schema changes.
- Include rollback procedure.

## 39) Phase 1 Compliance Notes

- No customer PII stored.
- Cache-only data, short TTLs.
- HMAC verification required for all inbound calls.

## 40) Phase 1 Versioning Policy

- Use semantic versioning for backend releases.
- Tag deployments in source control.

## 41) Phase 1 Feature Flags

- Proxy endpoint can return empty list when disabled.
- Webhook processing can be toggled off per environment.

## 42) Phase 1 Rate Limit Policy

- 60 requests/min per shop (proxy).
- 30 requests/min per shop (cold path).
- Return `429` with `Retry-After` header.

## 43) Phase 1 Cache Invalidation Strategy

- Product webhooks invalidate result cache for the shop.
- Product cache TTL handles stale reads.
- Index sets updated by product webhooks (incremental diff).

## 44) Phase 1 Error Code Map

- `400` `VALIDATION_ERROR` — malformed payload.
- `400` `EMPTY_CART` — no cart items.
- `401` `UNAUTHORIZED` — HMAC invalid.
- `403` `SHOP_MISMATCH` — shop not installed.
- `404` `PRODUCTS_NOT_FOUND` — catalog mismatch.
- `429` `RATE_LIMITED` — limit exceeded.
- `500` `INTERNAL_ERROR` — unexpected error.
- `503` `UPSTREAM_TIMEOUT` — Admin API timeout.

## 45) Phase 1 Troubleshooting

- Proxy returning 401: verify raw body capture and secret.
- Proxy returning 403: ensure shop is installed in Redis.
- No recommendations: verify index warmup and product cache.
- Inventory updates not reflected: check `inv:map` keys and inventory webhook.

## 46) Phase 1 Alerting Thresholds

- Error rate > 5% (5 min window).
- p99 latency > 500ms (5 min window).
- Redis memory > 80% capacity.

## 47) Phase 1 Safe Degradation

- On failure, return empty `recommendations: []` with `200`.
- Never block cart updates due to recommendation failure.

## 48) Phase 1 Documentation Index

- [runbook.md](runbook.md)
- [api-contracts.md](api-contracts.md)
- [data-model.md](data-model.md)
- [security-checklist.md](security-checklist.md)
- [performance-budget.md](performance-budget.md)
