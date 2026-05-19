// =============================================================================
// Shared Shopify Admin GraphQL client
// =============================================================================
// One authenticated GraphQL caller used by every module that needs the Admin
// API beyond the product-fetch hot path (collections, orders, shop metadata).
//
// The product-fetch hot path keeps its own tuned executor in
// shopify-product-fetcher.mjs — that code is latency-sensitive and already
// battle-tested, so it is intentionally NOT routed through here.
//
// Responsibilities:
//   - Resolve the offline access token from Postgres.
//   - Cost-based throttle handling (retry on THROTTLED / HTTP 429).
//   - Exponential backoff with jitter on transient 5xx / network errors.
//   - Never logs tokens or PII.
// =============================================================================

import { getShopAccessToken } from './postgres-store.mjs';

const CONFIG = {
  API_VERSION: '2025-04',
  MAX_RETRIES: 4,
  RETRY_BASE_MS: 500,
  RETRY_MAX_MS: 10_000,
  REQUEST_TIMEOUT_MS: 12_000,
};

class AdminApiError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'AdminApiError';
    this.retryable = retryable;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt) {
  const exp = CONFIG.RETRY_BASE_MS * 2 ** attempt;
  const jitter = Math.random() * CONFIG.RETRY_BASE_MS;
  return Math.min(exp + jitter, CONFIG.RETRY_MAX_MS);
}

function logAdmin(event, data = {}) {
  console.log(JSON.stringify({
    component: 'admin_graphql',
    event,
    ts: new Date().toISOString(),
    ...data,
  }));
}

// --------------------------------------------------------------------------
// Single GraphQL call (no retry) — returns { data, throttled }
// --------------------------------------------------------------------------

async function executeOnce(shop, accessToken, query, variables) {
  const url = `https://${shop}/admin/api/${CONFIG.API_VERSION}/graphql.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new AdminApiError(`Request timed out after ${CONFIG.REQUEST_TIMEOUT_MS}ms`, { retryable: true });
    }
    throw new AdminApiError(`Network error: ${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    return { data: null, throttled: true };
  }
  if (response.status === 401 || response.status === 403) {
    throw new AdminApiError(`Auth failed: ${response.status}`, { retryable: false });
  }
  if (response.status >= 500) {
    throw new AdminApiError(`Shopify server error: ${response.status}`, { retryable: true });
  }
  if (!response.ok) {
    throw new AdminApiError(`Unexpected HTTP ${response.status}`, { retryable: false });
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new AdminApiError('Failed to parse response JSON', { retryable: true });
  }

  if (body.errors && body.errors.length > 0) {
    const throttled = body.errors.some((e) =>
      e.extensions?.code === 'THROTTLED' || /throttled/i.test(e.message || ''));
    if (throttled) {
      return { data: null, throttled: true };
    }
    if (!body.data) {
      throw new AdminApiError(`GraphQL error: ${body.errors[0].message}`, { retryable: false });
    }
  }

  return { data: body.data, throttled: false };
}

// --------------------------------------------------------------------------
// Public: adminGraphQL(shop, query, variables) -> data
// --------------------------------------------------------------------------

export async function adminGraphQL(shop, query, variables = {}) {
  const accessToken = await getShopAccessToken(shop);
  if (!accessToken) {
    throw new AdminApiError(`No access token for shop ${shop}`, { retryable: false });
  }

  let lastError = null;
  for (let attempt = 0; attempt < CONFIG.MAX_RETRIES; attempt++) {
    try {
      const { data, throttled } = await executeOnce(shop, accessToken, query, variables);
      if (throttled) {
        const wait = backoff(attempt);
        logAdmin('throttled', { shop, attempt, backoff_ms: wait });
        await sleep(wait);
        continue;
      }
      return data;
    } catch (err) {
      lastError = err;
      if (err instanceof AdminApiError && err.retryable) {
        const wait = backoff(attempt);
        logAdmin('retryable_error', { shop, attempt, error: err.message, backoff_ms: wait });
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new AdminApiError('Admin GraphQL retries exhausted', { retryable: false });
}

export { AdminApiError, CONFIG as ADMIN_CONFIG };
