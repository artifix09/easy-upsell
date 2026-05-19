// =============================================================================
// Catalog Sync — full product catalog import
// =============================================================================
// Pulls a shop's entire product catalog from the Admin API and warms every
// Redis tier the recommendation engine depends on:
//
//   tier 1   hybrid:prod:{shop}:{id}            — normalized product cache
//   tier 3   hybrid:idx:coll|tag|vendor:{shop}:* — candidate indexes
//            hybrid:inv:map:{shop}:{inv_item}   — inventory_item → product map
//
// Run triggers:
//   1. Once, right after OAuth install (auth-handler kicks this off async).
//   2. Periodically from scheduler.mjs as a consistency backstop against
//      missed product webhooks.
//
// This is a background job — no latency budget. It paginates at 250
// products/page with a small inter-page delay to stay under the GraphQL
// cost bucket.
// =============================================================================

import { redis } from './redis-client.mjs';
import { adminGraphQL } from './shopify-admin-graphql.mjs';
import { normalizeNodes } from './shopify-product-fetcher.mjs';

const CONFIG = {
  PRODUCT_TTL: 600,
  INDEX_TTL: 3600,
  INV_MAP_TTL: 86_400,
  PAGE_SIZE: 250,
  PAGE_DELAY_MS: 200,
};

const CATALOG_QUERY = `
  query CatalogPage($first: Int!, $cursor: String) {
    products(first: $first, after: $cursor) {
      edges {
        node {
          id
          handle
          vendor
          tags
          status
          featuredImage { url }
          variants(first: 1, sortKey: POSITION) {
            edges {
              node {
                id
                price
                compareAtPrice
                inventoryQuantity
                inventoryPolicy
                inventoryItem { id }
              }
            }
          }
          collections(first: 50) {
            edges { node { id } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function logSync(event, data = {}) {
  console.log(JSON.stringify({
    component: 'catalog_sync',
    event,
    ts: new Date().toISOString(),
    ...data,
  }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Mirrors webhook-handlers.updateIndexes — kept local so catalog-sync has no
// dependency on the webhook module's Express app (importing it would connect
// a second Redis client and register routes we don't want here).
function pipeIndexWrites(pipeline, shop, product) {
  const pid = String(product.id);

  for (const collId of product.collection_ids || []) {
    const key = `hybrid:idx:coll:${shop}:${collId}`;
    pipeline.sAdd(key, pid);
    pipeline.expire(key, CONFIG.INDEX_TTL);
  }
  for (const tag of product.tags || []) {
    const key = `hybrid:idx:tag:${shop}:${tag}`;
    pipeline.sAdd(key, pid);
    pipeline.expire(key, CONFIG.INDEX_TTL);
  }
  if (product.vendor) {
    const key = `hybrid:idx:vendor:${shop}:${product.vendor}`;
    pipeline.sAdd(key, pid);
    pipeline.expire(key, CONFIG.INDEX_TTL);
  }
  if (product.inventory_item_id) {
    pipeline.setEx(
      `hybrid:inv:map:${shop}:${product.inventory_item_id}`,
      CONFIG.INV_MAP_TTL,
      JSON.stringify({ productId: product.id, variantId: product.default_variant_id }),
    );
  }
}

// Reshape a products(...).edges node into the nodes(...) shape that
// normalizeNodes() expects (it reads node.variants.edges + node.collections).
function toNodeShape(edge) {
  return edge.node;
}

export async function syncFullCatalog(shop) {
  const start = Date.now();
  let cursor = null;
  let hasNext = true;
  let pages = 0;
  let indexed = 0;

  try {
    while (hasNext) {
      const data = await adminGraphQL(shop, CATALOG_QUERY, {
        first: CONFIG.PAGE_SIZE,
        cursor,
      });
      const connection = data?.products;
      if (!connection) break;

      const nodes = (connection.edges || []).map(toNodeShape);
      const products = normalizeNodes(nodes, [], shop, 'catalog_sync');

      if (products.length > 0) {
        const pipeline = redis.multi();
        for (const product of products) {
          pipeline.setEx(
            `hybrid:prod:${shop}:${product.id}`,
            CONFIG.PRODUCT_TTL,
            JSON.stringify(product),
          );
          pipeIndexWrites(pipeline, shop, product);
        }
        await pipeline.exec();
        indexed += products.length;
      }

      hasNext = Boolean(connection.pageInfo?.hasNextPage);
      cursor = connection.pageInfo?.endCursor || null;
      pages++;
      if (hasNext) await sleep(CONFIG.PAGE_DELAY_MS);
    }

    logSync('sync_complete', {
      shop,
      pages,
      products_indexed: indexed,
      duration_ms: Date.now() - start,
    });
    return { ok: true, products_indexed: indexed };
  } catch (err) {
    logSync('sync_error', {
      shop,
      pages,
      products_indexed: indexed,
      message: err.message,
      duration_ms: Date.now() - start,
    });
    return { ok: false, products_indexed: indexed, error: err.message };
  }
}

export { CONFIG as CATALOG_SYNC_CONFIG };
