// =============================================================================
// OAuth Install Handler
// =============================================================================
// Routes:
//   GET /auth            â start OAuth (HMAC-verified install request)
//   GET /auth/callback   â exchange code for access token, persist shop
//
// Security:
//   - HMAC on both endpoints (verifyOAuthHmac, timing-safe).
//   - State (nonce) stored in Redis with TTL; deleted after consumption.
//   - Access token never logged. Never sent to the storefront.
//   - Shop domain validated against ^[a-z0-9][a-z0-9-]*\.myshopify\.com$.
//   - HTTPS enforced for APP_URL (Shopify rejects non-https redirect_uri).
// =============================================================================

import crypto from 'node:crypto';
import express from 'express';
import { redis } from './redis-client.mjs';
import { verifyOAuthHmac } from './hmac-validators.mjs';
import { setShopAccessToken } from './postgres-store.mjs';
import { adminGraphQL } from './shopify-admin-graphql.mjs';
import { registerWebhooks } from './webhook-registration.mjs';
import { syncFullCatalog } from './catalog-sync.mjs';

const app = express();

const CONFIG = {
  API_KEY: process.env.SHOPIFY_API_KEY,
  API_SECRET: process.env.SHOPIFY_API_SECRET,
  SCOPES: process.env.SHOPIFY_SCOPES || 'read_products,read_orders',
  APP_URL: process.env.APP_URL,
  NONCE_TTL_SEC: 600,
};

const SHOP_DOMAIN_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function configured() {
  return Boolean(CONFIG.API_KEY && CONFIG.API_SECRET && CONFIG.APP_URL);
}

function requireHttps(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// =============================================================================
// GET /auth â initiate install
// =============================================================================
// Shopify sends an HMAC-signed install request. We verify it (when present),
// mint a CSRF nonce, and redirect the merchant to the authorize URL.

app.get('/auth', async (req, res) => {
  if (!configured()) {
    return res.status(500).send('Server misconfigured.');
  }
  if (!requireHttps(CONFIG.APP_URL)) {
    return res.status(500).send('APP_URL must be https.');
  }

  const shop = typeof req.query.shop === 'string' ? req.query.shop.toLowerCase() : '';
  if (!SHOP_DOMAIN_REGEX.test(shop)) {
    return res.status(400).send('Invalid shop parameter.');
  }

  // If Shopify routed the install (hmac present), verify it. Manual install
  // URLs typed by a merchant do not include hmac and remain accepted.
  if (req.query.hmac !== undefined) {
    const verdict = verifyOAuthHmac({ secret: CONFIG.API_SECRET, query: req.query });
    if (!verdict.ok) {
      return res.status(401).send('Invalid hmac.');
    }
  }

  const state = crypto.randomBytes(32).toString('hex');
  await redis.set(`hybrid:oauth:nonce:${shop}:${state}`, '1', { EX: CONFIG.NONCE_TTL_SEC });

  const redirectUri = `${CONFIG.APP_URL.replace(/\/+$/, '')}/auth/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize`
    + `?client_id=${encodeURIComponent(CONFIG.API_KEY)}`
    + `&scope=${encodeURIComponent(CONFIG.SCOPES)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state)}`;

  return res.redirect(installUrl);
});

// =============================================================================
// GET /auth/callback â complete OAuth
// =============================================================================

app.get('/auth/callback', async (req, res) => {
  if (!configured()) {
    return res.status(500).send('Server misconfigured.');
  }

  const shop = typeof req.query.shop === 'string' ? req.query.shop.toLowerCase() : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';

  if (!SHOP_DOMAIN_REGEX.test(shop) || !code || !state) {
    return res.status(400).send('Missing or invalid OAuth parameters.');
  }

  const verdict = verifyOAuthHmac({ secret: CONFIG.API_SECRET, query: req.query });
  if (!verdict.ok) {
    return res.status(401).send('Invalid hmac.');
  }

  const nonceKey = `hybrid:oauth:nonce:${shop}:${state}`;
  const nonceExists = await redis.get(nonceKey);
  if (!nonceExists) {
    return res.status(401).send('Invalid OAuth state.');
  }
  await redis.del(nonceKey);

  let tokenResponse;
  try {
    tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        client_id: CONFIG.API_KEY,
        client_secret: CONFIG.API_SECRET,
        code,
      }),
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'oauth_token_network', shop, message: err.message }));
    return res.status(502).send('Failed to reach Shopify.');
  }

  if (!tokenResponse.ok) {
    console.error(JSON.stringify({ event: 'oauth_token_status', shop, status: tokenResponse.status }));
    return res.status(502).send('Failed to exchange access token.');
  }

  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenData.access_token) {
    return res.status(502).send('Access token missing.');
  }

  try {
    await setShopAccessToken(shop, tokenData.access_token);
  } catch (err) {
    console.error(JSON.stringify({ event: 'oauth_persist_failed', shop, message: err.message }));
    return res.status(500).send('Failed to persist installation.');
  }

  await redis.set(`hybrid:shop:installed:${shop}`, '1');

  console.log(JSON.stringify({
    event: 'oauth_install_completed',
    shop,
    scope: tokenData.scope || CONFIG.SCOPES,
    ts: new Date().toISOString(),
  }));

  // ── Post-install provisioning ────────────────────────────────────────────
  // Currency + webhook registration are quick and worth awaiting so a failure
  // is logged against the install. The full catalog import can take minutes
  // on large stores, so it runs fire-and-forget — the storefront degrades to
  // the best-sellers fallback until indexes are warm.
  await provisionShop(shop).catch((err) => {
    console.error(JSON.stringify({ event: 'post_install_provision_failed', shop, message: err.message }));
  });

  syncFullCatalog(shop).catch((err) => {
    console.error(JSON.stringify({ event: 'catalog_sync_failed', shop, message: err.message }));
  });

  return res.status(200).send('App installed. You can close this window.');
});

const SHOP_CURRENCY_QUERY = `query { shop { currencyCode } }`;

async function provisionShop(shop) {
  // Cache shop currency for the recommendations response formatter.
  try {
    const data = await adminGraphQL(shop, SHOP_CURRENCY_QUERY);
    const currency = data?.shop?.currencyCode;
    if (currency) {
      await redis.set(`hybrid:shop:currency:${shop}`, currency);
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'shop_currency_fetch_failed', shop, message: err.message }));
  }

  // Register operational webhook subscriptions (idempotent).
  await registerWebhooks(shop);
}

app.get('/auth/health', (_req, res) => {
  res.status(200).json({ ok: true, configured: configured() });
});

export { app };
