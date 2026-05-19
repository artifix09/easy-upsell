// =============================================================================
// fetchProductsFromShopify — Production Implementation
// =============================================================================
// Fetches products from Shopify Admin GraphQL API and normalizes them to
// our Redis cache schema. Handles batching, retries, rate-limit backoff,
// partial results, and missing products.
//
// Runtime:     Node.js 20+ (native fetch)
// Auth:        Offline access token loaded from server storage
// Rate limit:  Shopify GraphQL uses a cost-based bucket (2000 points,
//              restores 100/sec). Each product node costs ~7 points.
//              A 50-product batch costs ~350 points — safe headroom.
// Logging:     Structured JSON. Never logs: access tokens, product titles,
//              customer data, image URLs, tag values.
// =============================================================================

// =============================================================================
// CONFIG
// =============================================================================

const FETCH_CONFIG = {
  API_VERSION: '2025-04',
  BATCH_SIZE: 50,                  // max product IDs per GraphQL query
  MAX_RETRIES: 3,                  // per batch
  RETRY_BASE_MS: 500,             // exponential backoff base
  RETRY_MAX_MS: 10_000,           // backoff ceiling
  RATE_LIMIT_BUFFER_POINTS: 400,  // pause if remaining cost drops below this
  REQUEST_TIMEOUT_MS: 8_000,      // per-request abort timeout
  COLLECTIONS_PER_PRODUCT: 50,    // max collections to fetch per product
};


// =============================================================================
// ACCESS TOKEN STORAGE
// =============================================================================
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ PLUG-IN POINT: Token storage                                          │
// │                                                                       │
// │ Replace with your actual data store. The token was persisted during   │
// │ the OAuth install flow and must never leave the server.               │
// │                                                                       │
// │ Example implementations:                                              │
// │   PostgreSQL: SELECT access_token FROM shops WHERE domain = $1       │
// │   Redis:      await redis.get(`shop:token:${shop}`)                  │
// │   Prisma:     await prisma.shop.findUnique({ where: { domain } })    │
// └─────────────────────────────────────────────────────────────────────────┘

import { getShopAccessToken } from './postgres-store.mjs';

async function getAccessToken(shop) {
  return getShopAccessToken(shop);
}


// =============================================================================
// GRAPHQL QUERY
// =============================================================================
// Uses `nodes()` to fetch multiple products by GID in a single call.
// Each product pulls: core fields, first variant (for price/inventory),
// and collection membership (up to 50).
//
// Cost estimate per product node: ~7 points
// 50 products × 7 = ~350 points per batch (well within 2000 bucket)

const PRODUCTS_QUERY = `
  query FetchProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        handle
        vendor
        tags
        status
        featuredImage {
          url
        }
        variants(first: 1, sortKey: POSITION) {
          edges {
            node {
              id
              price
              compareAtPrice
              inventoryQuantity
              inventoryPolicy
              inventoryItem {
                id
              }
            }
          }
        }
        collections(first: ${FETCH_CONFIG.COLLECTIONS_PER_PRODUCT}) {
          edges {
            node {
              id
            }
          }
        }
      }
    }
  }
`;


// =============================================================================
// ENTRY POINT
// =============================================================================

async function fetchProductsFromShopify(shop, productIds, requestId = 'unknown') {
  if (!productIds || productIds.length === 0) return [];

  const dedupedIds = [...new Set(productIds)];

  // Split into batches of BATCH_SIZE
  const batches = [];
  for (let i = 0; i < dedupedIds.length; i += FETCH_CONFIG.BATCH_SIZE) {
    batches.push(dedupedIds.slice(i, i + FETCH_CONFIG.BATCH_SIZE));
  }

  const allProducts = [];
  let availableCost = null; // track rate limit across batches

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    // ── Rate limit gate ────────────────────────────────────────────────────
    // If the previous batch response told us we're running low on points,
    // pause before firing the next request.
    if (availableCost !== null && availableCost < FETCH_CONFIG.RATE_LIMIT_BUFFER_POINTS) {
      const waitMs = estimateRefillWait(availableCost);
      logFetch('rate_limit_pause', { shop, requestId, batch: batchIndex, wait_ms: waitMs });
      await sleep(waitMs);
    }

    // ── Execute batch with retry ───────────────────────────────────────────
    const result = await executeBatchWithRetry(shop, batch, batchIndex, requestId);

    if (result.products.length > 0) {
      allProducts.push(...result.products);
    }

    // Update cost tracker from the throttle extension
    if (result.availableCost !== null) {
      availableCost = result.availableCost;
    }
  }

  return allProducts;
}


// =============================================================================
// BATCH EXECUTION WITH RETRY
// =============================================================================

async function executeBatchWithRetry(shop, numericIds, batchIndex, requestId) {
  const gids = numericIds.map((id) => `gid://shopify/Product/${id}`);

  let lastError = null;

  for (let attempt = 0; attempt < FETCH_CONFIG.MAX_RETRIES; attempt++) {
    try {
      const result = await executeGraphQL(shop, gids, requestId);

      // ── Handle throttled response ────────────────────────────────────────
      if (result.throttled) {
        const backoff = calculateBackoff(attempt);
        logFetch('throttled', {
          shop, requestId, batch: batchIndex, attempt,
          backoff_ms: backoff, available_cost: result.availableCost,
        });
        await sleep(backoff);
        continue; // retry
      }

      // ── Handle partial errors (some nodes null, some valid) ──────────────
      const products = normalizeNodes(result.nodes, numericIds, shop, requestId);

      return { products, availableCost: result.availableCost };

    } catch (err) {
      lastError = err;

      if (isRetryable(err)) {
        const backoff = calculateBackoff(attempt);
        logFetch('retryable_error', {
          shop, requestId, batch: batchIndex, attempt,
          error: err.message, backoff_ms: backoff,
        });
        await sleep(backoff);
        continue;
      }

      // Non-retryable error — stop immediately
      logFetch('non_retryable_error', {
        shop, requestId, batch: batchIndex,
        error: err.message,
      });
      break;
    }
  }

  // All retries exhausted
  logFetch('batch_failed', {
    shop, requestId, batch: batchIndex,
    ids_count: numericIds.length,
    error: lastError?.message || 'unknown',
  });

  return { products: [], availableCost: null };
}


// =============================================================================
// GRAPHQL EXECUTOR
// =============================================================================

async function executeGraphQL(shop, gids, requestId) {
  const accessToken = await getAccessToken(shop);
  if (!accessToken) {
    throw new NonRetryableError(`No access token for shop ${shop}`);
  }

  const url = `https://${shop}/admin/api/${FETCH_CONFIG.API_VERSION}/graphql.json`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_CONFIG.REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
        // Never log this header — it's the offline token
      },
      body: JSON.stringify({
        query: PRODUCTS_QUERY,
        variables: { ids: gids },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new RetryableError(`Request timed out after ${FETCH_CONFIG.REQUEST_TIMEOUT_MS}ms`);
    }
    throw new RetryableError(`Network error: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  // ── HTTP-level error handling ────────────────────────────────────────────
  if (response.status === 429) {
    const retryAfter = parseFloat(response.headers.get('Retry-After') || '2');
    throw new ThrottledError(retryAfter);
  }

  if (response.status === 401 || response.status === 403) {
    throw new NonRetryableError(`Auth failed: ${response.status}`);
  }

  if (response.status === 404) {
    throw new NonRetryableError(`Shop not found or API version invalid: ${response.status}`);
  }

  if (response.status >= 500) {
    throw new RetryableError(`Shopify server error: ${response.status}`);
  }

  if (!response.ok) {
    throw new NonRetryableError(`Unexpected HTTP ${response.status}`);
  }

  // ── Parse body ───────────────────────────────────────────────────────────
  let body;
  try {
    body = await response.json();
  } catch {
    throw new RetryableError('Failed to parse response JSON');
  }

  // ── GraphQL-level errors ─────────────────────────────────────────────────
  if (body.errors && body.errors.length > 0) {
    const isThrottled = body.errors.some((e) =>
      e.extensions?.code === 'THROTTLED'
      || e.message?.includes('Throttled')
    );

    if (isThrottled) {
      const available = body.extensions?.cost?.throttleStatus?.currentlyAvailable ?? 0;
      return { nodes: [], throttled: true, availableCost: available };
    }

    // Other GraphQL errors (bad query, internal) — log first error
    const firstError = body.errors[0];
    logFetch('graphql_error', {
      shop, requestId,
      error_code: firstError.extensions?.code || 'UNKNOWN',
      error_message: firstError.message,
    });

    // If we also got partial data, use it
    if (!body.data?.nodes) {
      throw new NonRetryableError(`GraphQL error: ${firstError.message}`);
    }
  }

  // ── Extract throttle status for caller ───────────────────────────────────
  const availableCost = body.extensions?.cost?.throttleStatus?.currentlyAvailable ?? null;

  return {
    nodes: body.data?.nodes || [],
    throttled: false,
    availableCost,
  };
}


// =============================================================================
// NODE NORMALIZATION
// =============================================================================
// Converts raw GraphQL product nodes into our cache schema.
// Handles:
//   - null nodes (product doesn't exist or was deleted between request batches)
//   - products with no variants (shouldn't happen but defensive)
//   - products with no image
//   - missing collection edges

function normalizeNodes(nodes, requestedNumericIds, shop, requestId) {
  const products = [];
  let nullCount = 0;

  for (const node of nodes) {
    if (node == null) {
      nullCount++;
      continue;
    }

    // node.id is a GID like "gid://shopify/Product/123"
    const numericId = extractNumericId(node.id);
    if (numericId === null) {
      nullCount++;
      continue;
    }

    const firstVariant = node.variants?.edges?.[0]?.node || null;

    const product = {
      id: numericId,
      handle: node.handle || '',
      vendor: node.vendor || '',
      tags: Array.isArray(node.tags) ? node.tags.map((t) => t.trim().toLowerCase()) : [],
      featured_image: node.featuredImage?.url || null,
      price_cents: toCents(firstVariant?.price),
      compare_at_price_cents: toCents(firstVariant?.compareAtPrice),
      default_variant_id: extractNumericId(firstVariant?.id),
      inventory_quantity: firstVariant?.inventoryQuantity ?? 0,
      inventory_item_id: extractNumericId(firstVariant?.inventoryItem?.id),
      available: node.status === 'ACTIVE'
        && (
          (firstVariant?.inventoryQuantity > 0)
          || firstVariant?.inventoryPolicy === 'CONTINUE'
        ),
      collection_ids: extractCollectionIds(node.collections),
    };

    products.push(product);
  }

  if (nullCount > 0) {
    logFetch('null_nodes', {
      shop, requestId,
      null_count: nullCount,
      requested_count: requestedNumericIds.length,
    });
  }

  return products;
}


// =============================================================================
// UTILITY: GID → NUMERIC ID
// =============================================================================

function extractNumericId(gid) {
  if (!gid || typeof gid !== 'string') return null;
  const match = gid.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}


// =============================================================================
// UTILITY: COLLECTION EDGES → NUMERIC IDS
// =============================================================================

function extractCollectionIds(collections) {
  if (!collections?.edges) return [];
  const ids = [];
  for (const edge of collections.edges) {
    const numId = extractNumericId(edge.node?.id);
    if (numId !== null) ids.push(numId);
  }
  return ids;
}


// =============================================================================
// UTILITY: PRICE STRING → CENTS
// =============================================================================

function toCents(priceStr) {
  if (priceStr == null) return null;
  const num = parseFloat(priceStr);
  if (Number.isNaN(num)) return null;
  return Math.round(num * 100);
}


// =============================================================================
// BACKOFF + RETRY CLASSIFICATION
// =============================================================================

function calculateBackoff(attempt) {
  // Exponential backoff with jitter: base * 2^attempt + random(0..base)
  const exponential = FETCH_CONFIG.RETRY_BASE_MS * Math.pow(2, attempt);
  const jitter = Math.random() * FETCH_CONFIG.RETRY_BASE_MS;
  return Math.min(exponential + jitter, FETCH_CONFIG.RETRY_MAX_MS);
}

function estimateRefillWait(currentPoints) {
  // Shopify restores 100 points/sec. Wait until we're above the buffer.
  const deficit = FETCH_CONFIG.RATE_LIMIT_BUFFER_POINTS - currentPoints;
  if (deficit <= 0) return 0;
  return Math.ceil((deficit / 100) * 1000); // ms
}

function isRetryable(err) {
  return err instanceof RetryableError || err instanceof ThrottledError;
}

class RetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RetryableError';
  }
}

class ThrottledError extends RetryableError {
  constructor(retryAfterSec) {
    super(`Throttled, retry after ${retryAfterSec}s`);
    this.name = 'ThrottledError';
    this.retryAfterMs = retryAfterSec * 1000;
  }
}

class NonRetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NonRetryableError';
  }
}


// =============================================================================
// UTILITY: SLEEP
// =============================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// =============================================================================
// LOGGING (NO PII, NO TOKENS)
// =============================================================================
// Logs:     shop domain, product IDs (numeric), counts, durations, error codes
// Never:   access tokens, product titles, image URLs, tag values, prices

function logFetch(event, data = {}) {
  console.log(JSON.stringify({
    component: 'shopify_fetch',
    event,
    ts: new Date().toISOString(),
    ...data,
  }));
}


// =============================================================================
// EXPORTS
// =============================================================================

export {
  fetchProductsFromShopify,
  // Exported for unit testing:
  normalizeNodes,
  extractNumericId,
  extractCollectionIds,
  toCents,
  calculateBackoff,
  // Exported for DI / mocking:
  getAccessToken,
  FETCH_CONFIG,
};
