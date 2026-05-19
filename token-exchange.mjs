// =============================================================================
// Shopify Token Exchange — session JWT → offline access token
// =============================================================================
// Modern Shopify embedded apps with managed install (use_legacy_install_flow
// = false) never receive an OAuth callback. The merchant approves scopes
// through Shopify's chrome and our server is expected to acquire an access
// token via Token Exchange:
//
//   POST https://{shop}/admin/oauth/access_token
//     grant_type=urn:ietf:params:oauth:grant-type:token-exchange
//     subject_token=<App Bridge session JWT>
//     subject_token_type=urn:ietf:params:oauth:token-type:id_token
//     requested_token_type=urn:shopify:params:oauth:token-type:offline-access-token
//
// Reference: https://shopify.dev/docs/apps/auth/get-access-tokens/token-exchange
//
// Stores the resulting offline access token via setShopAccessToken so every
// downstream Shopify Admin GraphQL call (recommendations, seed, billing,
// product picker) works without a manual OAuth dance.
// =============================================================================

import { setShopAccessToken, getShopAccessToken } from './postgres-store.mjs';
import { registerWebhooks } from './webhook-registration.mjs';
import { redis } from './redis-client.mjs';

const CONFIG = {
  GRANT_TYPE: 'urn:ietf:params:oauth:grant-type:token-exchange',
  SUBJECT_TOKEN_TYPE: 'urn:ietf:params:oauth:token-type:id_token',
  REQUESTED_TOKEN_TYPE_OFFLINE: 'urn:shopify:params:oauth:token-type:offline-access-token',
  REQUEST_TIMEOUT_MS: 10_000,
  // After a failed exchange we don't want to thrash Shopify on every refresh,
  // and we want the admin UI to see the failure reason. Cache the last
  // outcome in Redis for 5 minutes per shop.
  LAST_OUTCOME_TTL_SEC: 300,
};

const lastOutcomeKey = (shop) => `hybrid:token_exchange:last:${shop}`;

async function recordOutcome(shop, outcome) {
  try {
    await redis.set(lastOutcomeKey(shop), JSON.stringify({
      ...outcome,
      ts: new Date().toISOString(),
    }), { EX: CONFIG.LAST_OUTCOME_TTL_SEC });
  } catch {
    // Best-effort — Redis being unreachable shouldn't break the exchange flow.
  }
}

export async function getLastExchangeOutcome(shop) {
  try {
    const raw = await redis.get(lastOutcomeKey(shop));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function logExchange(event, data = {}) {
  console.log(JSON.stringify({
    component: 'token-exchange',
    event,
    ts: new Date().toISOString(),
    ...data,
  }));
}

// Single in-flight promise per shop so concurrent requests share one exchange.
const inflight = new Map();

export async function ensureAccessToken(shop, sessionToken) {
  const existing = await getShopAccessToken(shop);
  if (existing) return existing;

  if (inflight.has(shop)) return inflight.get(shop);

  const promise = exchangeAndStore(shop, sessionToken)
    .finally(() => inflight.delete(shop));
  inflight.set(shop, promise);
  return promise;
}

async function exchangeAndStore(shop, sessionToken) {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) {
    const reason = 'Server missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET.';
    await recordOutcome(shop, { ok: false, reason, code: 'CONFIG' });
    throw new Error(reason);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        client_id: apiKey,
        client_secret: apiSecret,
        grant_type: CONFIG.GRANT_TYPE,
        subject_token: sessionToken,
        subject_token_type: CONFIG.SUBJECT_TOKEN_TYPE,
        requested_token_type: CONFIG.REQUESTED_TOKEN_TYPE_OFFLINE,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const reason = `Network error: ${err.message}`;
    logExchange('network_failed', { shop, message: err.message });
    await recordOutcome(shop, { ok: false, reason, code: 'NETWORK' });
    throw new Error(reason);
  }
  clearTimeout(timer);

  if (!response.ok) {
    let bodyText = '';
    try { bodyText = (await response.text()).slice(0, 400); } catch {}
    logExchange('http_failed', { shop, status: response.status, body: bodyText });
    // Map common Shopify failure modes to actionable codes so the admin UI
    // can show "Reauthorize" vs "Server config" vs "Try again later".
    let code = 'EXCHANGE_FAILED';
    if (response.status === 400) code = 'INVALID_REQUEST';
    if (response.status === 401) code = 'INVALID_SUBJECT_TOKEN';
    if (response.status === 404) code = 'NOT_FOUND';
    if (response.status === 422) code = 'UNAUTHORIZED_CLIENT';
    await recordOutcome(shop, {
      ok: false,
      reason: `Shopify rejected token exchange: HTTP ${response.status}`,
      code,
      shopify_status: response.status,
      shopify_body: bodyText,
    });
    throw new Error(`Token exchange HTTP ${response.status}: ${bodyText}`);
  }

  let data;
  try { data = await response.json(); }
  catch {
    logExchange('parse_failed', { shop });
    await recordOutcome(shop, { ok: false, reason: 'Invalid JSON from Shopify.', code: 'PARSE' });
    throw new Error('Token exchange returned invalid JSON.');
  }

  if (!data.access_token) {
    logExchange('missing_token', { shop, keys: Object.keys(data) });
    await recordOutcome(shop, { ok: false, reason: 'Response missing access_token.', code: 'MISSING_TOKEN' });
    throw new Error('Token exchange response missing access_token.');
  }

  await setShopAccessToken(shop, data.access_token, data.scope || null);
  logExchange('stored', { shop, scope: data.scope });
  await recordOutcome(shop, { ok: true, scope: data.scope });

  // Best-effort webhook registration so uninstall/orders webhooks fire even
  // though OAuth callback never ran in the managed-install path.
  registerWebhooks(shop).catch((err) => {
    logExchange('webhook_register_failed', { shop, message: err.message });
  });

  return data.access_token;
}

export { CONFIG as TOKEN_EXCHANGE_CONFIG };
