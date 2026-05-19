// =============================================================================
// Compliance Webhooks â GDPR + app/uninstalled
// =============================================================================
// Required by the Shopify Partner Program. Every app must implement:
//
//   POST /webhooks/customers/data_request   â merchant requests customer data
//   POST /webhooks/customers/redact         â delete customer-specific data
//   POST /webhooks/shop/redact              â delete shop-wide data (48h after
//                                              uninstall)
//   POST /webhooks/app/uninstalled          â cleanup on uninstall
//
// All requests are HMAC-verified using the app secret. All handlers
// respond 200 quickly and process side effects async. Idempotency is
// enforced via X-Shopify-Webhook-Id dedup keys.
//
// This app does NOT store customer PII (we cache product data only), so the
// GDPR handlers mostly act as compliance acknowledgements. The shop redact
// flow purges all hybrid:* keys for the shop.
// =============================================================================

import express from 'express';
import { redis } from './redis-client.mjs';
import { verifyWebhookHmac } from './hmac-validators.mjs';
import { markShopUninstalled, deleteShop } from './postgres-store.mjs';

const CONFIG = {
  APP_SECRET: process.env.SHOPIFY_API_SECRET,
  WEBHOOK_DEDUP_TTL: 300,
};

const SHOP_DOMAIN_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const app = express();
app.use('/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));

function logCompliance(event, data = {}) {
  console.log(JSON.stringify({
    component: 'compliance',
    event,
    ts: new Date().toISOString(),
    ...data,
  }));
}

async function gate(req, res) {
  const verdict = verifyWebhookHmac({
    secret: CONFIG.APP_SECRET,
    rawBody: req.body,
    signature: req.headers['x-shopify-hmac-sha256'],
  });
  if (!verdict.ok) {
    logCompliance('rejected', { reason: 'invalid_hmac' });
    res.status(401).end();
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf-8'));
  } catch {
    logCompliance('rejected', { reason: 'malformed_json' });
    res.status(400).end();
    return null;
  }

  const shop = req.headers['x-shopify-shop-domain'];
  if (!shop || !SHOP_DOMAIN_REGEX.test(shop)) {
    logCompliance('rejected', { reason: 'invalid_shop' });
    res.status(400).end();
    return null;
  }

  const webhookId = req.headers['x-shopify-webhook-id'];
  if (webhookId) {
    const dedupKey = `hybrid:webhook:seen:${webhookId}`;
    const set = await redis.set(dedupKey, '1', { NX: true, EX: CONFIG.WEBHOOK_DEDUP_TTL });
    if (!set) {
      logCompliance('duplicate_skipped', { shop, webhook_id: webhookId });
      res.status(200).end();
      return null;
    }
  }

  return { payload, shop };
}

// --------------------------------------------------------------------------
// customers/data_request
// --------------------------------------------------------------------------
// The merchant must, within 30 days, deliver any stored customer data to
// the customer. This app stores no customer PII â we acknowledge and log.

app.post('/webhooks/customers/data_request', async (req, res) => {
  const ctx = await gate(req, res);
  if (!ctx) return;
  res.status(200).end();

  logCompliance('customers_data_request', {
    shop: ctx.shop,
    customer_id: ctx.payload?.customer?.id || null,
    orders_requested: Array.isArray(ctx.payload?.orders_requested)
      ? ctx.payload.orders_requested.length
      : 0,
    note: 'no_customer_pii_stored',
  });
});

// --------------------------------------------------------------------------
// customers/redact
// --------------------------------------------------------------------------
// Delete all stored data for the named customer. We store none; ack only.

app.post('/webhooks/customers/redact', async (req, res) => {
  const ctx = await gate(req, res);
  if (!ctx) return;
  res.status(200).end();

  logCompliance('customers_redact', {
    shop: ctx.shop,
    customer_id: ctx.payload?.customer?.id || null,
    note: 'no_customer_pii_stored',
  });
});

// --------------------------------------------------------------------------
// shop/redact
// --------------------------------------------------------------------------
// Delivered 48h after app uninstall. Delete all shop data. We purge every
// hybrid:* key namespaced to the shop.

app.post('/webhooks/shop/redact', async (req, res) => {
  const ctx = await gate(req, res);
  if (!ctx) return;
  res.status(200).end();

  try {
    const deleted = await purgeShopKeys(ctx.shop);
    await deleteShop(ctx.shop);
    logCompliance('shop_redact', { shop: ctx.shop, keys_deleted: deleted });
  } catch (err) {
    logCompliance('shop_redact_error', { shop: ctx.shop, message: err.message });
  }
});

// --------------------------------------------------------------------------
// app/uninstalled
// --------------------------------------------------------------------------
// Mark the shop uninstalled. Stop honoring proxy/webhook traffic from it.
// Full data purge happens on shop/redact (48h later).

app.post('/webhooks/app/uninstalled', async (req, res) => {
  const ctx = await gate(req, res);
  if (!ctx) return;
  res.status(200).end();

  try {
    await redis.del(`hybrid:shop:installed:${ctx.shop}`);
    await markShopUninstalled(ctx.shop);
    logCompliance('app_uninstalled', { shop: ctx.shop });
  } catch (err) {
    logCompliance('app_uninstalled_error', { shop: ctx.shop, message: err.message });
  }
});

// --------------------------------------------------------------------------
// Helper: purge every key under hybrid:*:{shop}:*
// --------------------------------------------------------------------------
// Uses SCAN so it does not block the event loop on large keyspaces.

async function purgeShopKeys(shop) {
  const patterns = [
    `hybrid:prod:${shop}:*`,
    `hybrid:reco:${shop}:*`,
    `hybrid:idx:coll:${shop}:*`,
    `hybrid:idx:tag:${shop}:*`,
    `hybrid:idx:vendor:${shop}:*`,
    `hybrid:idx:bestsellers:${shop}`,
    `hybrid:inv:map:${shop}:*`,
    `hybrid:discount:rule:${shop}:*`,
    `hybrid:shop:installed:${shop}`,
    `hybrid:shop:currency:${shop}`,
    `hybrid:rl:${shop}`,
    `hybrid:rl:cold:${shop}`,
    `hybrid:tag:affinity:${shop}`,
    `hybrid:oauth:nonce:${shop}:*`,
    `hybrid:webhook:order:seen:${shop}:*`,
  ];

  let total = 0;
  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 });
      cursor = String(result.cursor);
      if (result.keys.length > 0) {
        await redis.del(result.keys);
        total += result.keys.length;
      }
    } while (cursor !== '0');
  }
  return total;
}

export { app };
