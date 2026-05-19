// =============================================================================
// Shopify Session Token (JWT) verification — embedded admin auth
// =============================================================================
// Embedded apps (the merchant-facing admin UI) authenticate API calls with a
// session token: a JWT issued by Shopify App Bridge, signed HS256 with the
// app's API secret. This module verifies it without any JWT library — it is
// just HMAC-SHA256 over base64url segments.
//
// Checks performed (per Shopify's spec):
//   - signature matches HMAC-SHA256(header.payload, API_SECRET)
//   - exp is in the future, nbf is in the past (with small clock skew)
//   - aud === our API key
//   - dest / iss point at the same shop, and dest is a *.myshopify.com URL
//
// On success returns { ok: true, shop, payload }. The `shop` is extracted
// from `dest` and is the value downstream code must trust — never a header
// or query param.
// =============================================================================

import crypto from 'node:crypto';

const CONFIG = {
  API_KEY: process.env.SHOPIFY_API_KEY,
  API_SECRET: process.env.SHOPIFY_API_SECRET,
  CLOCK_SKEW_SEC: 10,
};

const SHOP_DOMAIN_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function base64UrlDecode(segment) {
  const pad = segment.length % 4 === 0 ? '' : '='.repeat(4 - (segment.length % 4));
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Pull the shop domain out of a Shopify dest/iss URL: "https://x.myshopify.com"
function shopFromUrl(url) {
  try {
    const host = new URL(url).host.toLowerCase();
    return SHOP_DOMAIN_REGEX.test(host) ? host : null;
  } catch {
    return null;
  }
}

export function verifySessionToken(token) {
  if (!CONFIG.API_SECRET || !CONFIG.API_KEY) {
    return { ok: false, error: 'Server misconfigured.' };
  }
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'Missing session token.' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, error: 'Malformed session token.' };
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  // ── Signature ────────────────────────────────────────────────────────────
  const expected = crypto
    .createHmac('sha256', CONFIG.API_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  if (!timingSafeEqualStr(signatureB64, expected)) {
    return { ok: false, error: 'Invalid session token signature.' };
  }

  // ── Payload claims ───────────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf-8'));
  } catch {
    return { ok: false, error: 'Unreadable session token payload.' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now - CONFIG.CLOCK_SKEW_SEC) {
    return { ok: false, error: 'Session token expired.' };
  }
  if (typeof payload.nbf === 'number' && payload.nbf > now + CONFIG.CLOCK_SKEW_SEC) {
    return { ok: false, error: 'Session token not yet valid.' };
  }
  // Two valid audiences:
  //   1. CONFIG.API_KEY — Shopify-signed token (App Bridge runtime + launch URL)
  //   2. "internal:admin" — our own session JWT issued by /admin/api/auth/exchange
  // Both are HMAC-SHA256 with API_SECRET so signature verification above is
  // identical. Only the audience claim differs.
  const isShopifyToken = payload.aud === CONFIG.API_KEY;
  const isInternalToken = payload.aud === 'internal:admin';
  if (!isShopifyToken && !isInternalToken) {
    return { ok: false, error: 'Session token audience mismatch.' };
  }

  const destShop = shopFromUrl(payload.dest);
  const issShop = shopFromUrl(payload.iss);
  if (!destShop || !issShop || destShop !== issShop) {
    return { ok: false, error: 'Session token shop mismatch.' };
  }

  return { ok: true, shop: destShop, payload, kind: isInternalToken ? 'internal' : 'shopify' };
}

// Express middleware: pulls the bearer token from Authorization, verifies it,
// and attaches req.shop. Used to guard every /admin/api/* route.
export function requireSessionToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  const result = verifySessionToken(token);
  if (!result.ok) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: result.error } });
  }

  req.shop = result.shop;
  req.sessionPayload = result.payload;
  return next();
}

export { CONFIG as SESSION_TOKEN_CONFIG };
