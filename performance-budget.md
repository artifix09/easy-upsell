# Performance Budget (Phase 1)

## Target Latency

- p95 < 200ms
- Cache hit path: ~35ms
- Cache miss path: ~100ms
- Cold miss path: ~180ms

## Budget Breakdown

- Proxy hop: 10ms
- TLS + TCP: 5ms
- HMAC verification: 1ms
- Validation: 1ms
- Redis GET: 2–5ms
- Scoring: 8–12ms
- Serialize: 2–5ms

## Enforced Limits

- Cache TTLs: 300s (results), 600s (products), 3600s (indexes)
- Result cache invalidation on product change

## Monitoring

- Track request_id, shop, cache_hit, response_time, status
- Alert if p99 > 500ms or error rate > 5%
