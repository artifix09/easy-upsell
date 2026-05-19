// =============================================================================
// Analytics — recommendation impression / click / conversion tracking
// =============================================================================
// Without this, neither you nor the merchant can prove the upsell engine
// makes money. This module records three events:
//
//   impression  — a recommendation was rendered to a shopper
//   click       — a shopper clicked a recommended product
//   conversion  — an order contained a product we recently recommended
//
// Storage model:
//   Live counters live in Redis (fast, atomic HINCRBY) keyed by shop + day:
//     hybrid:analytics:{shop}:{YYYY-MM-DD}        hash: impressions/clicks/
//                                                 conversions/revenue_cents
//     hybrid:analytics:prod:{shop}:{day}          hash: {pid}:imp / {pid}:clk
//     hybrid:analytics:recommended:{shop}         set, short TTL — product IDs
//                                                 recently recommended, used
//                                                 for approximate conversion
//                                                 attribution on orders/create
//
//   The scheduler flushes the shop-day hashes into Postgres (analytics_daily)
//   hourly via idempotent UPSERT. Redis keys carry a ~35-day TTL so they
//   self-clean; Postgres is the durable record.
//
// Attribution caveat (v1): orders/create webhooks carry no storefront session,
// so conversions are attributed by "was this product recommended in this shop
// within ATTRIBUTION_TTL". Once the theme extension tags recommended line
// items with a property, switch to exact per-order attribution.
// =============================================================================

import { redis } from './redis-client.mjs';
import { upsertAnalyticsDaily, getAnalyticsDaily } from './postgres-store.mjs';

const CONFIG = {
  DAILY_TTL: 35 * 86_400,        // shop-day + per-product hashes self-expire
  ATTRIBUTION_TTL: 1800,         // 30 min recommended→purchase attribution window
  RECOMMENDED_SET_MAX: 5000,     // cap the recommended-set size per shop
};

function logAnalytics(event, data = {}) {
  console.log(JSON.stringify({
    component: 'analytics',
    event,
    ts: new Date().toISOString(),
    ...data,
  }));
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function dailyKey(shop, day = today()) {
  return `hybrid:analytics:${shop}:${day}`;
}

function prodKey(shop, day = today()) {
  return `hybrid:analytics:prod:${shop}:${day}`;
}

function recommendedKey(shop) {
  return `hybrid:analytics:recommended:${shop}`;
}

// --------------------------------------------------------------------------
// WRITE: impressions
// --------------------------------------------------------------------------
// Called by the recommendations handler each time it serves a result set.
// Also seeds the recommended-set so a later order can be attributed.

export async function recordImpressions(shop, productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) return;
  const day = today();
  const ids = productIds.map(String);

  try {
    const pipeline = redis.multi();
    const dk = dailyKey(shop, day);
    const pk = prodKey(shop, day);

    pipeline.hIncrBy(dk, 'impressions', ids.length);
    pipeline.expire(dk, CONFIG.DAILY_TTL);

    for (const pid of ids) {
      pipeline.hIncrBy(pk, `${pid}:imp`, 1);
    }
    pipeline.expire(pk, CONFIG.DAILY_TTL);

    const rk = recommendedKey(shop);
    pipeline.sAdd(rk, ids);
    pipeline.expire(rk, CONFIG.ATTRIBUTION_TTL);

    await pipeline.exec();

    // Opportunistic trim — keep the attribution set bounded on busy shops.
    const size = await redis.sCard(rk);
    if (size > CONFIG.RECOMMENDED_SET_MAX) {
      const overflow = await redis.sRandMemberCount(rk, size - CONFIG.RECOMMENDED_SET_MAX);
      if (overflow.length > 0) await redis.sRem(rk, overflow);
    }
  } catch (err) {
    logAnalytics('record_impressions_failed', { shop, message: err.message });
  }
}

// --------------------------------------------------------------------------
// WRITE: click
// --------------------------------------------------------------------------

export async function recordClick(shop, productId) {
  if (productId == null) return;
  const day = today();
  const pid = String(productId);

  try {
    const pipeline = redis.multi();
    const dk = dailyKey(shop, day);
    const pk = prodKey(shop, day);

    pipeline.hIncrBy(dk, 'clicks', 1);
    pipeline.expire(dk, CONFIG.DAILY_TTL);
    pipeline.hIncrBy(pk, `${pid}:clk`, 1);
    pipeline.expire(pk, CONFIG.DAILY_TTL);

    await pipeline.exec();
  } catch (err) {
    logAnalytics('record_click_failed', { shop, message: err.message });
  }
}

// --------------------------------------------------------------------------
// WRITE: conversion (called from the orders/create webhook)
// --------------------------------------------------------------------------
// Given an order's line items, count how many products were in the shop's
// recommended-set and record them as attributed conversions + revenue.

export async function attributeOrderConversion(shop, lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return { attributed: 0 };

  try {
    const rk = recommendedKey(shop);
    let attributed = 0;
    let exact = 0;
    let revenueCents = 0;

    for (const line of lineItems) {
      if (line.product_id == null) continue;

      // ── Exact path ─────────────────────────────────────────────────────
      // Theme extension tags upsell line items with `_hybrid_rec`. This is
      // authoritative — count it without touching Redis.
      const exactRec = extractRecAttribution(line);
      let recommended = false;
      if (exactRec) {
        recommended = true;
        exact += 1;
      } else {
        // ── Approximate path ─────────────────────────────────────────────
        // Fallback for shoppers who added the product through their own
        // browsing within ATTRIBUTION_TTL of seeing a recommendation.
        recommended = await redis.sIsMember(rk, String(line.product_id));
      }
      if (!recommended) continue;

      const qty = Math.max(0, parseInt(line.quantity, 10) || 0);
      const priceCents = toCents(line.price);
      attributed += 1;
      if (priceCents != null) revenueCents += priceCents * qty;
    }

    if (attributed === 0) return { attributed: 0 };

    const day = today();
    const dk = dailyKey(shop, day);
    const pipeline = redis.multi();
    pipeline.hIncrBy(dk, 'conversions', attributed);
    pipeline.hIncrBy(dk, 'revenue_cents', revenueCents);
    pipeline.expire(dk, CONFIG.DAILY_TTL);
    await pipeline.exec();

    logAnalytics('conversion_attributed', { shop, attributed, exact, approximate: attributed - exact, revenue_cents: revenueCents });
    return { attributed, exact, revenueCents };
  } catch (err) {
    logAnalytics('attribute_conversion_failed', { shop, message: err.message });
    return { attributed: 0 };
  }
}

// --------------------------------------------------------------------------
// READ: summary (for a future admin API)
// --------------------------------------------------------------------------

export async function getAnalyticsSummary(shop, sinceDays = 30) {
  const rows = await getAnalyticsDaily(shop, sinceDays);

  // Postgres rollups lag by up to an hour. For TODAY, prefer the live Redis
  // hash so the dashboard reflects activity immediately after an event fires.
  const todayStr = today();
  let liveToday = null;
  try {
    const liveHash = await redis.hGetAll(dailyKey(shop, todayStr));
    if (liveHash && Object.keys(liveHash).length > 0) {
      liveToday = {
        day: todayStr,
        impressions: Number(liveHash.impressions || 0),
        clicks: Number(liveHash.clicks || 0),
        conversions: Number(liveHash.conversions || 0),
        revenue_cents: Number(liveHash.revenue_cents || 0),
      };
    }
  } catch (err) {
    logAnalytics('summary_live_read_failed', { shop, message: err.message });
  }

  // Build a daily list: live today (if any) + postgres rows for older days.
  const olderRows = rows.filter((r) => String(r.day).slice(0, 10) !== todayStr);
  const daily = liveToday ? [liveToday, ...olderRows] : olderRows;

  const totals = daily.reduce(
    (acc, r) => ({
      impressions: acc.impressions + Number(r.impressions),
      clicks: acc.clicks + Number(r.clicks),
      conversions: acc.conversions + Number(r.conversions),
      revenue_cents: acc.revenue_cents + Number(r.revenue_cents),
    }),
    { impressions: 0, clicks: 0, conversions: 0, revenue_cents: 0 },
  );
  const ctr = totals.impressions > 0 ? totals.clicks / totals.impressions : 0;
  const cvr = totals.clicks > 0 ? totals.conversions / totals.clicks : 0;
  return { shop, since_days: sinceDays, totals, ctr, cvr, daily };
}

// --------------------------------------------------------------------------
// FLUSH: Redis shop-day hashes → Postgres (run hourly by the scheduler)
// --------------------------------------------------------------------------

export async function flushAnalyticsToPostgres() {
  let cursor = '0';
  let flushed = 0;

  do {
    const result = await redis.scan(cursor, {
      MATCH: 'hybrid:analytics:*:[0-9]*-[0-9]*-[0-9]*',
      COUNT: 200,
    });
    cursor = String(result.cursor);

    for (const key of result.keys) {
      // Key shape: hybrid:analytics:{shop}:{YYYY-MM-DD}
      // Skip the per-product variant (hybrid:analytics:prod:...).
      if (key.startsWith('hybrid:analytics:prod:')) continue;

      const parts = key.split(':');
      const day = parts[parts.length - 1];
      const shop = parts.slice(2, parts.length - 1).join(':');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !shop) continue;

      try {
        const hash = await redis.hGetAll(key);
        await upsertAnalyticsDaily(shop, day, {
          impressions: Number(hash.impressions || 0),
          clicks: Number(hash.clicks || 0),
          conversions: Number(hash.conversions || 0),
          revenue_cents: Number(hash.revenue_cents || 0),
        });
        flushed += 1;
      } catch (err) {
        logAnalytics('flush_row_failed', { shop, day, message: err.message });
      }
    }
  } while (cursor !== '0');

  logAnalytics('flush_complete', { rows_flushed: flushed });
  return { rows_flushed: flushed };
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

// Pull a `_hybrid_rec` recommendation tag out of a Shopify line item.
// Properties arrive as either an array of {name,value} (orders/* webhook)
// or a plain object (cart.js / draft orders), so handle both.
export function extractRecAttribution(line) {
  if (!line || typeof line !== 'object') return null;
  const props = line.properties;
  if (Array.isArray(props)) {
    const hit = props.find((p) => p && p.name === '_hybrid_rec');
    return hit && hit.value != null ? String(hit.value) : null;
  }
  if (props && typeof props === 'object') {
    return props._hybrid_rec != null ? String(props._hybrid_rec) : null;
  }
  return null;
}

function toCents(priceStr) {
  if (priceStr == null) return null;
  const num = parseFloat(priceStr);
  if (Number.isNaN(num)) return null;
  return Math.round(num * 100);
}

export { CONFIG as ANALYTICS_CONFIG, toCents as _toCents };
