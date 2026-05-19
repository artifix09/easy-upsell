// =============================================================================
// Admin API — endpoints called by the embedded admin UI
// =============================================================================
// All routes live under /admin/api/* and are guarded by requireSessionToken.
// The verified `req.shop` from the session token JWT is the ONLY trusted
// source of the shop domain — never read it from a header or body.
//
// Surface area:
//   GET    /admin/api/status                       — install/billing/health
//   GET    /admin/api/analytics/summary?days=30    — rollup + daily breakdown
//   GET    /admin/api/discount-rules               — list rules for this shop
//   GET    /admin/api/discount-rules/:productId    — fetch one
//   PUT    /admin/api/discount-rules/:productId    — upsert
//   DELETE /admin/api/discount-rules/:productId    — remove
//   POST   /admin/api/billing/subscribe            — start subscription flow
//   GET    /billing/callback?shop=...              — Shopify return URL
//
// Discount-rule storage matches the storefront read path used by
// recommendations-handler.mjs: `hybrid:discount:rule:{shop}:{product_id}`
// with a 1h TTL. Writes here refresh the TTL so the cache stays warm.
// =============================================================================

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redis } from './redis-client.mjs';
import { requireSessionToken } from './session-token.mjs';
import { getAnalyticsSummary } from './analytics.mjs';
import {
  createSubscription,
  handleBillingCallback,
  getBillingStatus,
} from './billing.mjs';
import {
  getShopAccessToken,
  pingDatabase,
  upsertDiscountRule,
  getDiscountRule,
  listDiscountRules,
  deleteDiscountRule,
} from './postgres-store.mjs';
import { rebuildBestsellersIndex } from './bestsellers-index.mjs';
import { syncFullCatalog } from './catalog-sync.mjs';
import { ensureAccessToken, getLastExchangeOutcome } from './token-exchange.mjs';
import { adminGraphQL } from './shopify-admin-graphql.mjs';

const CONFIG = {
  DISCOUNT_RULE_TTL: 3600,                 // matches redis-schema-webhooks.md
  DISCOUNT_RULE_SCAN_COUNT: 200,
  DISCOUNT_RULE_MAX_LIST: 500,             // safety cap on list responses
  ANALYTICS_MAX_DAYS: 365,
  ANALYTICS_DEFAULT_DAYS: 30,
};

const SHOP_DOMAIN_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const PRODUCT_ID_REGEX = /^[0-9]+$/;
const DISCOUNT_TYPES = new Set(['percentage', 'fixed_amount']);

function logAdmin(event, data = {}) {
  console.log(JSON.stringify({
    component: 'admin-api',
    event,
    ts: new Date().toISOString(),
    ...data,
  }));
}

function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function ruleKey(shop, productId) {
  return `hybrid:discount:rule:${shop}:${productId}`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Static admin UI assets. Served BEFORE the session-token gate because
// loading the bundle itself must not require a token (App Bridge mints
// tokens client-side after the bundle loads).
app.use('/admin/static', express.static(path.join(__dirname, 'admin-ui'), {
  // Dev: no cache so hot edits to app.js / styles.css land on next reload.
  // Tighten to a real maxAge when shipping to production.
  maxAge: 0,
  etag: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store, must-revalidate'),
  fallthrough: true,
}));

// Embedded admin entrypoint. Shopify loads the configured application_url
// with `?host=...&shop=...`. We mount the SAME handler at both `/` and
// `/admin` so the app loads regardless of whether shopify.app.toml's
// application_url ends with /admin or not — `shopify app dev` sometimes
// rewrites the path on tunnel restart.
import fs from 'node:fs';
const ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'admin-ui', 'index.html'), 'utf-8');
function serveAdminHtml(_req, res) {
  const apiKey = process.env.SHOPIFY_API_KEY || '';
  const withMeta = ADMIN_HTML.replace(
    '</head>',
    `  <meta name="shopify-api-key" content="${apiKey}" />\n</head>`,
  );
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Content-Security-Policy', "frame-ancestors https://*.myshopify.com https://admin.shopify.com");
  res.send(withMeta);
}
app.get('/admin', serveAdminHtml);
app.get('/', serveAdminHtml);

// ----------------------------------------------------------------------------
// DEV ONLY — mint a session JWT outside the App Bridge flow.
// Lets a developer open /admin?dev=1&shop=foo.myshopify.com in any browser
// and use the admin UI without Shopify embedding. Gated by BILLING_TEST=true
// (which is the dev/test gate already used elsewhere) so it's auto-off in
// production. Never call this from real merchant flows.
// ----------------------------------------------------------------------------
app.get('/admin/dev/mint-token', (req, res) => {
  if (process.env.BILLING_TEST === 'false') {
    return sendError(res, 403, 'DEV_DISABLED', 'Dev token minting is disabled (BILLING_TEST=false).');
  }
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) {
    return sendError(res, 500, 'CONFIG', 'Server is missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET.');
  }
  const shop = String(req.query.shop || '').toLowerCase();
  if (!SHOP_DOMAIN_REGEX.test(shop)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid shop parameter.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: `https://${shop}/admin`,
    dest: `https://${shop}`,
    aud: apiKey,
    sub: 'dev',
    exp: now + 60 * 60,           // 1h — generous for dev
    nbf: now - 5,
    iat: now,
    jti: crypto.randomUUID(),
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const h = b64(header);
  const p = b64(payload);
  const sig = crypto.createHmac('sha256', apiSecret).update(`${h}.${p}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const token = `${h}.${p}.${sig}`;

  logAdmin('dev_token_minted', { shop, expires_in_sec: 3600 });
  res.json({ token, shop, expires_at: new Date(payload.exp * 1000).toISOString() });
});

app.use('/admin/api', express.json({ limit: '32kb', strict: true }));

// Force no-store on every /admin/api/* response. Admin UI data must always
// be fresh — without this, the browser caches 200/304s and stale lists
// linger after edits (we observed 304s on /discount-rules even after a
// successful PUT). API responses are JSON, not static, so caching has no
// upside here.
app.use('/admin/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  next();
});

// Per-request access log for /admin/api/* — temporary diagnostic so the CLI
// stream shows which endpoints are being hit, with status + duration. Logs
// BEFORE the session-token guard so 401s are visible.
app.use('/admin/api', (req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    logAdmin('http', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      duration_ms: Date.now() - t0,
      auth_present: Boolean(req.headers.authorization),
    });
  });
  next();
});

// All /admin/api routes require a verified Shopify session token. The
// billing callback is intentionally OUTSIDE this guard — Shopify redirects
// the merchant's browser there with only a `shop` query param.
app.use('/admin/api', requireSessionToken);

// --------------------------------------------------------------------------
// POST /admin/api/auth/exchange
// --------------------------------------------------------------------------
// Takes any token the requireSessionToken middleware already accepted
// (Shopify-signed App Bridge JWT, launch URL id_token, OR a previously
// issued internal session) and mints a fresh INTERNAL session JWT signed
// with API_SECRET, audience = "internal:admin", 1h lifetime.
//
// Why: App Bridge's runtime idToken() handshake is unreliable on Shopify
// CLI quick-tunnels (postMessage origin mismatch hangs the call). The
// launch-URL id_token works for the first request but expires in ~60s.
// By exchanging once on boot we get a stable, refresh-able session that
// is independent of App Bridge for the rest of the session.

const INTERNAL_SESSION_TTL_SEC = 60 * 60;        // 1h
const INTERNAL_SESSION_AUD = 'internal:admin';

function signInternalSession(shop) {
  const secret = process.env.SHOPIFY_API_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: `https://${shop}/admin`,
    dest: `https://${shop}`,
    aud: INTERNAL_SESSION_AUD,
    sub: shop,
    exp: now + INTERNAL_SESSION_TTL_SEC,
    nbf: now - 5,
    iat: now,
    jti: crypto.randomUUID(),
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const h = b64(header);
  const p = b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { token: `${h}.${p}.${sig}`, expires_at: new Date(payload.exp * 1000).toISOString() };
}

app.post('/admin/api/auth/exchange', async (req, res) => {
  const shop = req.shop;

  // Always mint the internal session FIRST so the client is unblocked even
  // if Token Exchange fails — the merchant can still use rules/analytics
  // (which need no Shopify access token). Token Exchange runs in the
  // background; its outcome is queryable via /admin/api/setup.
  const { token, expires_at } = signInternalSession(shop);
  logAdmin('internal_session_issued', { shop, expires_at });
  res.json({ token, expires_at, shop });

  // Only re-attempt exchange when the seed was a Shopify-signed token.
  // Internal tokens cannot be exchanged (they're our HMAC, not Shopify's).
  const incomingAud = req.sessionPayload?.aud;
  if (incomingAud !== process.env.SHOPIFY_API_KEY) return;

  const auth = req.headers.authorization || '';
  const rawSeed = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!rawSeed) return;

  // Fire-and-forget. ensureAccessToken records its own outcome to Redis,
  // so we don't need to await or log here.
  ensureAccessToken(shop, rawSeed).catch(() => { /* recorded by token-exchange */ });
});

// --------------------------------------------------------------------------
// GET /admin/api/setup — single source of truth for "what does the UI need
// to ask the merchant to do right now?"
// --------------------------------------------------------------------------
// Returns:
//   { authorized: bool, reason?: string, code?: string, oauth_url?: string }
// `authorized=false` means we have no offline access token; the UI should
// show a "Reauthorize" CTA pointing at oauth_url (legacy OAuth flow that
// hits our /auth endpoint — guaranteed to work where Token Exchange did
// not).

app.get('/admin/api/setup', async (req, res) => {
  const shop = req.shop;
  try {
    const token = await getShopAccessToken(shop);
    if (token) {
      return res.json({ authorized: true });
    }
    const outcome = await getLastExchangeOutcome(shop);
    const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
    res.json({
      authorized: false,
      reason: outcome?.reason || 'No access token yet — exchange may still be in progress.',
      code: outcome?.code || 'PENDING',
      // Provide the legacy OAuth URL so the UI can offer a fallback button.
      // /auth verifies the shop and redirects through Shopify's standard
      // consent screen; the callback persists the access token reliably.
      oauth_url: appUrl ? `${appUrl}/auth?shop=${encodeURIComponent(shop)}` : null,
      last_attempt_at: outcome?.ts || null,
    });
  } catch (err) {
    logAdmin('setup_failed', { shop, message: err.message });
    sendError(res, 500, 'SETUP_FAILED', 'Failed to read setup state.');
  }
});

// --------------------------------------------------------------------------
// GET /admin/api/status — quick health view for the admin UI dashboard
// --------------------------------------------------------------------------

app.get('/admin/api/status', async (req, res) => {
  const shop = req.shop;
  try {
    const [token, billing, dbOk] = await Promise.all([
      getShopAccessToken(shop),
      getBillingStatus(shop),
      pingDatabase().catch(() => false),
    ]);
    res.json({
      shop,
      installed: Boolean(token),
      billing,
      db_ok: Boolean(dbOk),
      ts: new Date().toISOString(),
    });
  } catch (err) {
    logAdmin('status_failed', { shop, message: err.message });
    sendError(res, 500, 'STATUS_FAILED', 'Failed to load status.');
  }
});

// --------------------------------------------------------------------------
// GET /admin/api/analytics/summary?days=N
// --------------------------------------------------------------------------

app.get('/admin/api/analytics/summary', async (req, res) => {
  const shop = req.shop;
  let days = parseInt(req.query.days, 10);
  if (!Number.isFinite(days) || days <= 0) days = CONFIG.ANALYTICS_DEFAULT_DAYS;
  if (days > CONFIG.ANALYTICS_MAX_DAYS) days = CONFIG.ANALYTICS_MAX_DAYS;

  try {
    const summary = await getAnalyticsSummary(shop, days);
    res.json(summary);
  } catch (err) {
    logAdmin('analytics_failed', { shop, message: err.message });
    sendError(res, 500, 'ANALYTICS_FAILED', 'Failed to load analytics.');
  }
});

// --------------------------------------------------------------------------
// Discount rule CRUD
// --------------------------------------------------------------------------
// Storage: hybrid:discount:rule:{shop}:{product_id} → JSON { type, value,
// label, active }. The storefront read path in recommendations-handler.mjs
// expects this exact shape, so validate strictly.

function validateRule(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Body must be a JSON object.' };
  }
  const { type, value, label, active, product_title, product_image_url } = body;
  if (!DISCOUNT_TYPES.has(type)) {
    return { ok: false, error: `type must be one of: ${[...DISCOUNT_TYPES].join(', ')}.` };
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return { ok: false, error: 'value must be a positive number.' };
  }
  if (type === 'percentage' && numericValue > 100) {
    return { ok: false, error: 'percentage value must be between 0 and 100.' };
  }
  if (label != null && (typeof label !== 'string' || label.length > 120)) {
    return { ok: false, error: 'label must be a string up to 120 chars.' };
  }
  if (product_title != null && (typeof product_title !== 'string' || product_title.length > 300)) {
    return { ok: false, error: 'product_title must be a string up to 300 chars.' };
  }
  if (product_image_url != null && (typeof product_image_url !== 'string' || product_image_url.length > 1024)) {
    return { ok: false, error: 'product_image_url must be a string up to 1024 chars.' };
  }
  return {
    ok: true,
    rule: {
      type,
      value: numericValue,
      label: label || null,
      active: active !== false,
      product_title: product_title || null,
      product_image_url: product_image_url || null,
    },
  };
}

// Postgres is the source of truth; Redis is a 1h read-through cache for the
// storefront proxy. Writes go to Postgres first, then refresh the cache.

app.get('/admin/api/discount-rules', async (req, res) => {
  const shop = req.shop;
  const limit = Math.min(parseInt(req.query.limit, 10) || CONFIG.DISCOUNT_RULE_MAX_LIST, CONFIG.DISCOUNT_RULE_MAX_LIST);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    const rules = await listDiscountRules(shop, { limit, offset });
    res.json({ shop, count: rules.length, limit, offset, rules });
  } catch (err) {
    logAdmin('rules_list_failed', { shop, message: err.message });
    sendError(res, 500, 'RULES_LIST_FAILED', 'Failed to list discount rules.');
  }
});

app.get('/admin/api/discount-rules/:productId', async (req, res) => {
  const shop = req.shop;
  const { productId } = req.params;
  if (!PRODUCT_ID_REGEX.test(productId)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'productId must be numeric.');
  }
  try {
    const rule = await getDiscountRule(shop, productId);
    if (!rule) return sendError(res, 404, 'NOT_FOUND', 'No rule for this product.');
    res.json({ product_id: productId, rule });
  } catch (err) {
    logAdmin('rule_get_failed', { shop, message: err.message });
    sendError(res, 500, 'RULE_GET_FAILED', 'Failed to load rule.');
  }
});

app.put('/admin/api/discount-rules/:productId', async (req, res) => {
  const shop = req.shop;
  const { productId } = req.params;
  if (!PRODUCT_ID_REGEX.test(productId)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'productId must be numeric.');
  }
  const v = validateRule(req.body);
  if (!v.ok) {
    // Log a sanitized snapshot of the rejected body so we can diagnose what
    // a merchant sent without flooding logs with PII (URLs are clipped).
    const safeBody = req.body && typeof req.body === 'object' ? {
      type: req.body.type,
      value: req.body.value,
      value_typeof: typeof req.body.value,
      label_len: typeof req.body.label === 'string' ? req.body.label.length : null,
      product_title_len: typeof req.body.product_title === 'string' ? req.body.product_title.length : null,
      product_image_url_len: typeof req.body.product_image_url === 'string' ? req.body.product_image_url.length : null,
      active: req.body.active,
      keys: Object.keys(req.body),
    } : { _bad: typeof req.body };
    logAdmin('rule_validation_rejected', { shop, product_id: productId, reason: v.error, body: safeBody });
    return sendError(res, 400, 'VALIDATION_ERROR', v.error);
  }

  try {
    await upsertDiscountRule(shop, productId, v.rule);
    // Best-effort cache refresh — storefront will fall back to a cache miss
    // on the next read if this fails, which is still correct.
    try {
      await redis.set(ruleKey(shop, productId), JSON.stringify(v.rule), {
        EX: CONFIG.DISCOUNT_RULE_TTL,
      });
    } catch (cacheErr) {
      logAdmin('rule_cache_refresh_failed', { shop, product_id: productId, message: cacheErr.message });
    }
    logAdmin('rule_upserted', { shop, product_id: productId, type: v.rule.type });
    res.json({ product_id: productId, rule: v.rule });
  } catch (err) {
    logAdmin('rule_put_failed', { shop, message: err.message });
    sendError(res, 500, 'RULE_PUT_FAILED', 'Failed to save rule.');
  }
});

app.delete('/admin/api/discount-rules/:productId', async (req, res) => {
  const shop = req.shop;
  const { productId } = req.params;
  if (!PRODUCT_ID_REGEX.test(productId)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'productId must be numeric.');
  }
  try {
    const removed = await deleteDiscountRule(shop, productId);
    if (!removed) return sendError(res, 404, 'NOT_FOUND', 'No rule for this product.');
    await redis.del(ruleKey(shop, productId)).catch(() => {});
    logAdmin('rule_deleted', { shop, product_id: productId });
    res.json({ product_id: productId, deleted: true });
  } catch (err) {
    logAdmin('rule_delete_failed', { shop, message: err.message });
    sendError(res, 500, 'RULE_DELETE_FAILED', 'Failed to delete rule.');
  }
});

// --------------------------------------------------------------------------
// GET /admin/api/products?q=<query>&limit=20
// --------------------------------------------------------------------------
// Searchable product list used by the rule editor's product picker. Backs
// onto Shopify's Admin GraphQL `products` connection with a `title:*foo*`
// search filter. Requires the offline access token, which is acquired
// lazily on first auth/exchange — surfaces a clean 503 if it's missing
// so the picker can prompt the merchant to reload the app.

const PRODUCT_PICKER_QUERY = `
  query ($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          status
          featuredImage { url altText }
          variants(first: 1) { edges { node { price } } }
        }
      }
    }
  }
`;

// Per-request limit bounds. We deliberately allow up to 100 (Shopify's max
// per page) so a store with 50-100 products gets the whole catalog in one
// call. Larger catalogs paginate via `after`.
const PRODUCT_PICKER_MIN = 1;
const PRODUCT_PICKER_MAX = 100;
const PRODUCT_PICKER_DEFAULT = 50;

app.get('/admin/api/products', async (req, res) => {
  const shop = req.shop;
  const q = String(req.query.q || '').trim().slice(0, 80);
  const after = typeof req.query.after === 'string' && req.query.after ? req.query.after : null;
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit)) limit = PRODUCT_PICKER_DEFAULT;
  limit = Math.min(Math.max(limit, PRODUCT_PICKER_MIN), PRODUCT_PICKER_MAX);

  // Shopify search syntax: bare term does a fuzzy match across title/sku.
  // Empty query returns the first N products by Shopify's default order.
  const searchQuery = q ? `title:*${q}* OR sku:*${q}*` : null;

  try {
    const data = await adminGraphQL(shop, PRODUCT_PICKER_QUERY, {
      first: limit,
      after,
      query: searchQuery,
    });
    const conn = data?.products || {};
    const products = (conn.edges || []).map(({ node }) => ({
      // Strip the gid://shopify/Product/ prefix so the picker can store
      // the bare numeric id the discount-rule schema expects.
      id: String(node.id).split('/').pop(),
      title: node.title,
      handle: node.handle,
      status: node.status,
      image: node.featuredImage?.url || null,
      price: node.variants?.edges?.[0]?.node?.price ?? null,
    }));
    res.json({
      shop,
      query: q,
      count: products.length,
      products,
      has_more: Boolean(conn.pageInfo?.hasNextPage),
      next_cursor: conn.pageInfo?.endCursor || null,
    });
  } catch (err) {
    logAdmin('products_search_failed', { shop, message: err.message });
    // No-token case bubbles up from adminGraphQL as "No access token for shop X".
    if (/no access token/i.test(err.message)) {
      return sendError(res, 503, 'NO_ACCESS_TOKEN',
        'Shopify access token not yet provisioned. Reload the app to complete authorization.');
    }
    sendError(res, 500, 'PRODUCTS_SEARCH_FAILED', 'Failed to search products.');
  }
});

// --------------------------------------------------------------------------
// Cold-start seed — fires off historical backfill of catalog + bestsellers +
// co-purchase indexes. Returns 202 immediately so the admin UI doesn't hang
// for the (potentially minutes-long) job; clients poll status via the seed
// state key in Redis.
// --------------------------------------------------------------------------

const SEED_STATE_KEY = (shop) => `hybrid:seed:state:${shop}`;
const SEED_TTL = 3600;

app.get('/admin/api/seed/status', async (req, res) => {
  try {
    const raw = await redis.get(SEED_STATE_KEY(req.shop));
    res.json(raw ? JSON.parse(raw) : { state: 'idle' });
  } catch (err) {
    sendError(res, 500, 'SEED_STATUS_FAILED', 'Failed to read seed status.');
  }
});

app.post('/admin/api/seed', async (req, res) => {
  const shop = req.shop;
  try {
    const existing = await redis.get(SEED_STATE_KEY(shop));
    if (existing) {
      const parsed = JSON.parse(existing);
      if (parsed.state === 'running') {
        return res.status(409).json({ error: { code: 'SEED_ALREADY_RUNNING', message: 'A seed job is already running.' }, state: parsed });
      }
    }

    const startState = { state: 'running', started_at: new Date().toISOString() };
    await redis.set(SEED_STATE_KEY(shop), JSON.stringify(startState), { EX: SEED_TTL });

    // Fire-and-forget. Errors are written to the state key so the UI surfaces
    // them; we don't await because the orders page-paginate can take minutes.
    runSeed(shop).catch(() => { /* runSeed handles its own logging */ });

    res.status(202).json({ accepted: true, state: startState });
  } catch (err) {
    logAdmin('seed_kickoff_failed', { shop, message: err.message });
    sendError(res, 500, 'SEED_FAILED', 'Failed to start seed.');
  }
});

async function runSeed(shop) {
  const t0 = Date.now();
  const result = { catalog: null, bestsellers: null };
  try {
    // Catalog first so the recommendation engine has product data to score
    // against; then bestsellers (which also rebuilds the co-purchase matrix
    // from the same order list).
    result.catalog = await syncFullCatalog(shop);
    result.bestsellers = await rebuildBestsellersIndex(shop);

    const finalState = {
      state: 'complete',
      started_at: new Date(t0).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      result,
    };
    await redis.set(SEED_STATE_KEY(shop), JSON.stringify(finalState), { EX: SEED_TTL });
    logAdmin('seed_complete', { shop, duration_ms: finalState.duration_ms });
  } catch (err) {
    const failState = {
      state: 'failed',
      started_at: new Date(t0).toISOString(),
      finished_at: new Date().toISOString(),
      error: err.message,
    };
    await redis.set(SEED_STATE_KEY(shop), JSON.stringify(failState), { EX: SEED_TTL }).catch(() => {});
    logAdmin('seed_failed', { shop, message: err.message });
  }
}

// --------------------------------------------------------------------------
// Billing — subscribe + callback
// --------------------------------------------------------------------------

app.post('/admin/api/billing/subscribe', async (req, res) => {
  const shop = req.shop;
  const planKey = (req.body && req.body.plan) || 'standard';
  try {
    const result = await createSubscription(shop, planKey);
    if (!result.ok) {
      return sendError(res, 400, result.code || 'BILLING_CREATE_FAILED', result.error);
    }
    res.json({
      confirmation_url: result.confirmationUrl,
      plan: result.plan,
    });
  } catch (err) {
    logAdmin('subscribe_failed', { shop, message: err.message });
    sendError(res, 500, 'BILLING_CREATE_FAILED', 'Failed to start subscription.');
  }
});

// Public — Shopify redirects the merchant's browser here after they approve
// the charge. We re-query Shopify (source of truth), persist, and redirect
// back into the embedded admin UI. Never read `shop` from anywhere but the
// query param here — and validate it against the shop-domain regex before
// using it.
app.get('/billing/callback', async (req, res) => {
  const shop = String(req.query.shop || '').toLowerCase();
  if (!SHOP_DOMAIN_REGEX.test(shop)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid shop parameter.');
  }
  try {
    const status = await handleBillingCallback(shop);
    const apiKey = process.env.SHOPIFY_API_KEY;
    if (apiKey) {
      // Bounce back into the embedded admin so the merchant lands on the app.
      const target = `https://${shop}/admin/apps/${apiKey}?billing=${status.active ? 'active' : 'pending'}`;
      return res.redirect(302, target);
    }
    res.json(status);
  } catch (err) {
    logAdmin('callback_failed', { shop, message: err.message });
    sendError(res, 500, 'BILLING_CALLBACK_FAILED', 'Failed to process callback.');
  }
});

export { app, CONFIG as ADMIN_API_CONFIG, validateRule as _validateRule };
