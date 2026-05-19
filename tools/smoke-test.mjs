// =============================================================================
// Local smoke test
// =============================================================================
// Exercises the public surfaces with valid Shopify-style signatures:
//   - App Proxy:       query-string HMAC (hex), header X-Shopify-Shop-Domain
//                      is informational only.
//   - Webhooks:        raw-body HMAC (base64), header X-Shopify-Hmac-Sha256.
//
// Requires:
//   SMOKE_RUN=1
//   SMOKE_SHOP=<your-shop>.myshopify.com
//   SHOPIFY_API_SECRET=<app secret>  (used as SMOKE_SECRET fallback)
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { signAppProxyQuery } from '../hmac-validators.mjs';

// Load .env directly so shell env vars cannot silently shadow real values
// (PowerShell sessions sometimes carry stale SMOKE_SHOP / SMOKE_SECRET).
// Values from .env always win here â the smoke test should match the
// server's actual configuration, not a leftover shell var.
(function loadDotenv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
})();

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const SHOP = process.env.SMOKE_SHOP || 'example.myshopify.com';
// Prefer SHOPIFY_API_SECRET (single source of truth). SMOKE_SECRET is only
// honored when explicitly set to a real-looking value â a stray placeholder
// in the shell will not silently override the real secret.
function pickSecret() {
  const real = process.env.SHOPIFY_API_SECRET;
  const override = process.env.SMOKE_SECRET;
  const isPlaceholder = (v) =>
    !v || /^(your_|replace_|changeme|placeholder)/i.test(v);
  if (override && !isPlaceholder(override)) return override;
  return real;
}
const SECRET = pickSecret();
const RUN_SMOKE = process.env.SMOKE_RUN === '1';

if (!RUN_SMOKE) {
  console.log('Smoke test skipped. Set SMOKE_RUN=1 to enable.');
  process.exit(0);
}

if (!SECRET) {
  console.error('Set SMOKE_SECRET or SHOPIFY_API_SECRET to the Shopify app secret.');
  process.exit(1);
}

function signWebhookBody(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('base64');
}

function buildProxyUrl(path) {
  const query = {
    shop: SHOP,
    timestamp: String(Math.floor(Date.now() / 1000)),
    path_prefix: '/apps/hybrid',
  };
  query.signature = signAppProxyQuery(SECRET, query);

  const qs = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  return `${BASE_URL}${path}?${qs}`;
}

async function callProxy(path, payloadPath) {
  const body = fs.readFileSync(payloadPath);
  try {
    const response = await fetch(buildProxyUrl(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Shop-Domain': SHOP,
      },
      body,
    });
    const text = await response.text();
    return { status: response.status, body: text };
  } catch (error) {
    return { status: 0, body: error.message };
  }
}

async function callWebhook(path, payloadPath, topic) {
  const body = fs.readFileSync(payloadPath);
  const signature = signWebhookBody(body);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Shop-Domain': SHOP,
        'X-Shopify-Hmac-Sha256': signature,
        'X-Shopify-Topic': topic,
        'X-Shopify-Webhook-Id': crypto.randomUUID(),
      },
      body,
    });
    const text = await response.text();
    return { status: response.status, body: text };
  } catch (error) {
    return { status: 0, body: error.message };
  }
}

async function main() {
  const proxy = await callProxy('/shopify/proxy/recommendations', 'proxy-request.json');
  if (proxy.status === 0) {
    console.log(`[proxy] skipped (server not reachable at ${BASE_URL})`);
    process.exit(0);
  }
  console.log('[proxy]', proxy.status, proxy.body);

  const create = await callWebhook('/webhooks/products/create', 'webhook-payloads/products-create.json', 'products/create');
  console.log('[webhook products/create]', create.status);

  const update = await callWebhook('/webhooks/products/update', 'webhook-payloads/products-update.json', 'products/update');
  console.log('[webhook products/update]', update.status);

  const inventory = await callWebhook('/webhooks/inventory/update', 'webhook-payloads/inventory-update.json', 'inventory_levels/update');
  console.log('[webhook inventory/update]', inventory.status);

  const orderCreate = await callWebhook('/webhooks/orders/create', 'webhook-payloads/orders-create.json', 'orders/create');
  console.log('[webhook orders/create]', orderCreate.status);

  const orderCancelled = await callWebhook('/webhooks/orders/cancelled', 'webhook-payloads/orders-cancelled.json', 'orders/cancelled');
  console.log('[webhook orders/cancelled]', orderCancelled.status);

  const del = await callWebhook('/webhooks/products/delete', 'webhook-payloads/products-delete.json', 'products/delete');
  console.log('[webhook products/delete]', del.status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
