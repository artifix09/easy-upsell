import crypto from 'node:crypto';

// =============================================================================
// Shopify HMAC verifiers
// =============================================================================
// Three distinct algorithms, one per surface. Do not mix them.
//
//   verifyWebhookHmac        â raw body bytes, HMAC-SHA256, base64 digest
//                              Header: X-Shopify-Hmac-Sha256
//
//   verifyAppProxySignature  â sorted query params, concatenated key=value
//                              with NO separator, HMAC-SHA256, hex digest
//                              Query param: signature
//
//   verifyOAuthHmac          â sorted query params, key=value joined by "&",
//                              HMAC-SHA256, hex digest
//                              Query param: hmac
//
// All comparisons use timing-safe equality.
// =============================================================================

function timingSafeHexEqual(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  if (aHex.length !== bHex.length) return false;
  let aBuf;
  let bBuf;
  try {
    aBuf = Buffer.from(aHex, 'hex');
    bBuf = Buffer.from(bHex, 'hex');
  } catch {
    return false;
  }
  if (aBuf.length === 0 || aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function timingSafeBase64Equal(aB64, bB64) {
  if (typeof aB64 !== 'string' || typeof bB64 !== 'string') return false;
  let aBuf;
  let bBuf;
  try {
    aBuf = Buffer.from(aB64, 'base64');
    bBuf = Buffer.from(bB64, 'base64');
  } catch {
    return false;
  }
  if (aBuf.length === 0 || aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// --------------------------------------------------------------------------
// Webhook HMAC (raw body, base64)
// --------------------------------------------------------------------------

export function verifyWebhookHmac({ secret, rawBody, signature }) {
  if (!secret) return { ok: false, error: 'Server misconfigured.' };
  if (!signature) return { ok: false, error: 'Missing HMAC signature header.' };
  if (!rawBody || rawBody.length === 0) {
    return { ok: false, error: 'Missing request body for signature verification.' };
  }

  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  return timingSafeBase64Equal(signature, computed)
    ? { ok: true, error: null }
    : { ok: false, error: 'Invalid signature.' };
}

// Backward-compat alias. New code should use verifyAppProxySignature for
// App Proxy requests. This is kept only because tests/smoke import it.
export function verifyProxyHmac({ secret, rawBody, signature }) {
  return verifyWebhookHmac({ secret, rawBody, signature });
}

// --------------------------------------------------------------------------
// App Proxy signature (query params, hex, no separator)
// --------------------------------------------------------------------------
// Shopify App Proxy signs the URL, not the body. Every forwarded request
// includes shop, path_prefix, timestamp, and signature query params.

export function verifyAppProxySignature({ secret, query }) {
  if (!secret) return { ok: false, error: 'Server misconfigured.' };
  if (!query || typeof query !== 'object') {
    return { ok: false, error: 'Missing query parameters.' };
  }

  const signature = query.signature;
  if (!signature || typeof signature !== 'string') {
    return { ok: false, error: 'Missing proxy signature.' };
  }

  const message = Object.keys(query)
    .filter((k) => k !== 'signature')
    .sort()
    .map((key) => {
      const value = query[key];
      const serialized = Array.isArray(value) ? value.join(',') : String(value);
      return `${key}=${serialized}`;
    })
    .join('');

  const computed = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  return timingSafeHexEqual(signature, computed)
    ? { ok: true, error: null }
    : { ok: false, error: 'Invalid proxy signature.' };
}

// Helper that mirrors the proxy signing algorithm. Used by tests and the
// smoke harness to produce valid signatures locally.
export function signAppProxyQuery(secret, query) {
  const message = Object.keys(query)
    .filter((k) => k !== 'signature')
    .sort()
    .map((key) => {
      const value = query[key];
      const serialized = Array.isArray(value) ? value.join(',') : String(value);
      return `${key}=${serialized}`;
    })
    .join('');
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

// --------------------------------------------------------------------------
// OAuth HMAC (query params, hex, "&"-joined, URL-encoded)
// --------------------------------------------------------------------------
// Used on /auth and /auth/callback. Shopify URL-encodes special characters
// in keys and values before joining.

function encodeKey(s) {
  return String(s)
    .replace(/%/g, '%25')
    .replace(/&/g, '%26')
    .replace(/=/g, '%3D');
}

function encodeValue(s) {
  return String(s)
    .replace(/%/g, '%25')
    .replace(/&/g, '%26');
}

export function verifyOAuthHmac({ secret, query }) {
  if (!secret) return { ok: false, error: 'Server misconfigured.' };
  if (!query || typeof query !== 'object') {
    return { ok: false, error: 'Missing query parameters.' };
  }

  const hmac = query.hmac;
  if (!hmac || typeof hmac !== 'string') {
    return { ok: false, error: 'Missing hmac parameter.' };
  }

  const message = Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((key) => {
      const value = query[key];
      const serialized = Array.isArray(value) ? value.join(',') : String(value);
      return `${encodeKey(key)}=${encodeValue(serialized)}`;
    })
    .join('&');

  const computed = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  return timingSafeHexEqual(hmac, computed)
    ? { ok: true, error: null }
    : { ok: false, error: 'Invalid hmac.' };
}
