// =============================================================================
// k6 load test — POST /shopify/proxy/recommendations
// =============================================================================
// Usage:
//   k6 run \
//     -e BASE_URL=https://staging.example.com \
//     -e SHOP=demo.myshopify.com \
//     -e APP_SECRET=$SHOPIFY_API_SECRET \
//     tools/loadtest-proxy.js
//
// Profile (default scenario):
//   - 60s ramp 0 → 200 VUs   (warm caches)
//   - 5m  hold 200 VUs       (sustained)
//   - 30s ramp-down
//
// SLO checks (matches perf-budget docs):
//   - p95 < 250ms  for cache-hot requests
//   - error rate < 1%
//
// The request signs the App Proxy query the same way Shopify does
// (HMAC-SHA256 over sorted query string, hex digest).
// =============================================================================

import http from 'k6/http';
import crypto from 'k6/crypto';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SHOP = __ENV.SHOP || 'demo.myshopify.com';
const APP_SECRET = __ENV.APP_SECRET || 'shpss_test';
const PATH = '/shopify/proxy/recommendations';

const proxyLatency = new Trend('proxy_latency_ms', true);
const proxyErrors = new Rate('proxy_error_rate');

export const options = {
  scenarios: {
    sustained: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '60s', target: 200 },
        { duration: '5m',  target: 200 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    'proxy_latency_ms': ['p(95)<250', 'p(99)<500'],
    'proxy_error_rate': ['rate<0.01'],
    'http_req_failed':  ['rate<0.01'],
  },
};

// A small pool of plausible product IDs. In a real run, seed these from
// the target shop's catalog.
const PRODUCT_IDS = ['111', '222', '333', '444', '555', '666', '777', '888'];

function signedQuery() {
  const params = {
    shop: SHOP,
    path_prefix: '/apps/hybrid',
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: '',
  };
  const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
  const signature = crypto.hmac('sha256', APP_SECRET, sorted, 'hex');
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${qs}&signature=${signature}`;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function () {
  const cart = [{ product_id: pick(PRODUCT_IDS), quantity: 1 }];
  const body = JSON.stringify({
    cart,
    current_product_id: pick(PRODUCT_IDS),
    limit: 3,
  });

  const res = http.post(`${BASE_URL}${PATH}?${signedQuery()}`, body, {
    headers: { 'Content-Type': 'application/json' },
    tags: { route: 'proxy_recommendations' },
  });

  proxyLatency.add(res.timings.duration);
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has recommendations array': (r) => {
      try { return Array.isArray(r.json('recommendations')); } catch { return false; }
    },
  });
  proxyErrors.add(!ok);

  // Mimic shopper think-time so we measure throughput at a realistic shape.
  sleep(0.2 + Math.random() * 0.4);
}
