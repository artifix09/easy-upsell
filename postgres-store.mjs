import pg from 'pg';

const { Pool } = pg;

// Schema bootstrapped by ensureSchema() on first call. Caller is responsible
// for invoking ensureSchema() once at startup (server.mjs does this) so that
// fresh deploys do not 500 on first install.
//
// CREATE TABLE IF NOT EXISTS shops (
//   domain        TEXT PRIMARY KEY,
//   access_token  TEXT NOT NULL,
//   scope         TEXT,
//   installed_at  TIMESTAMPTZ DEFAULT now(),
//   updated_at    TIMESTAMPTZ DEFAULT now(),
//   uninstalled_at TIMESTAMPTZ
// );

const CONFIG = {
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

const pool = new Pool(CONFIG);

// Surface pool errors but never crash the process. Individual queries can
// still fail; callers should handle their own errors.
pool.on('error', (err) => {
  console.error(JSON.stringify({
    component: 'postgres',
    event: 'pool_error',
    message: err.message,
    ts: new Date().toISOString(),
  }));
});

export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      domain          TEXT PRIMARY KEY,
      access_token    TEXT NOT NULL,
      scope           TEXT,
      installed_at    TIMESTAMPTZ DEFAULT now(),
      updated_at      TIMESTAMPTZ DEFAULT now(),
      uninstalled_at  TIMESTAMPTZ
    );
  `);
  // Idempotent migrations for older deployments that pre-date columns.
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS scope TEXT`);
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`);
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS uninstalled_at TIMESTAMPTZ`);
  // Billing state — populated by the Billing API flow (billing.mjs).
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS plan TEXT`);
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS subscription_id TEXT`);
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS billing_status TEXT`);

  // Durable discount rules. Redis holds a 1h cache for the storefront hot
  // path; this table is the source of truth so rules survive a Redis flush.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discount_rules (
      shop        TEXT NOT NULL,
      product_id  TEXT NOT NULL,
      type        TEXT NOT NULL,
      value       NUMERIC NOT NULL,
      label       TEXT,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at  TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (shop, product_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS discount_rules_shop_idx ON discount_rules (shop)`);
  // Snapshot of product title + image at the moment the rule was created/edited.
  // Used by the admin UI to render the rules list and re-open the edit dialog
  // without an extra Shopify GraphQL call. Stale by design — products renamed
  // in Shopify won't reflect here until the merchant re-saves the rule.
  await pool.query(`ALTER TABLE discount_rules ADD COLUMN IF NOT EXISTS product_title TEXT`);
  await pool.query(`ALTER TABLE discount_rules ADD COLUMN IF NOT EXISTS product_image_url TEXT`);

  // Durable daily rollup of recommendation analytics. Redis holds the live
  // per-day counters; the scheduler flushes them here hourly via UPSERT.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_daily (
      shop          TEXT NOT NULL,
      day           DATE NOT NULL,
      impressions   BIGINT DEFAULT 0,
      clicks        BIGINT DEFAULT 0,
      conversions   BIGINT DEFAULT 0,
      revenue_cents BIGINT DEFAULT 0,
      updated_at    TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (shop, day)
    );
  `);
}

// Idempotent UPSERT of one shop-day analytics row. Called by the flush job;
// safe to run repeatedly because the Redis hash holds the cumulative daily
// total, so we SET (not add) the columns.
export async function upsertAnalyticsDaily(shop, day, totals) {
  await pool.query(
    `INSERT INTO analytics_daily (shop, day, impressions, clicks, conversions, revenue_cents, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (shop, day)
     DO UPDATE SET impressions = EXCLUDED.impressions,
                   clicks = EXCLUDED.clicks,
                   conversions = EXCLUDED.conversions,
                   revenue_cents = EXCLUDED.revenue_cents,
                   updated_at = now()`,
    [
      shop,
      day,
      totals.impressions || 0,
      totals.clicks || 0,
      totals.conversions || 0,
      totals.revenue_cents || 0,
    ],
  );
}

export async function setBilling(shop, { plan, subscriptionId, status }) {
  await pool.query(
    `UPDATE shops
        SET plan = $2, subscription_id = $3, billing_status = $4, updated_at = now()
      WHERE domain = $1`,
    [shop, plan ?? null, subscriptionId ?? null, status ?? null],
  );
}

export async function getBilling(shop) {
  const result = await pool.query(
    `SELECT plan, subscription_id, billing_status FROM shops WHERE domain = $1 LIMIT 1`,
    [shop],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    plan: row.plan,
    subscriptionId: row.subscription_id,
    status: row.billing_status,
  };
}

export async function getAnalyticsDaily(shop, sinceDays = 30) {
  const result = await pool.query(
    `SELECT day, impressions, clicks, conversions, revenue_cents
     FROM analytics_daily
     WHERE shop = $1 AND day >= (CURRENT_DATE - $2::int)
     ORDER BY day DESC`,
    [shop, sinceDays],
  );
  return result.rows;
}

// --------------------------------------------------------------------------
// Discount rules — durable storage. Admin API is the only writer; the
// storefront read path uses the Redis cache populated from these rows.
// --------------------------------------------------------------------------

export async function upsertDiscountRule(shop, productId, rule) {
  await pool.query(
    `INSERT INTO discount_rules
       (shop, product_id, type, value, label, active, product_title, product_image_url, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (shop, product_id)
     DO UPDATE SET type = EXCLUDED.type,
                   value = EXCLUDED.value,
                   label = EXCLUDED.label,
                   active = EXCLUDED.active,
                   product_title = COALESCE(EXCLUDED.product_title, discount_rules.product_title),
                   product_image_url = COALESCE(EXCLUDED.product_image_url, discount_rules.product_image_url),
                   updated_at = now()`,
    [
      shop,
      productId,
      rule.type,
      rule.value,
      rule.label ?? null,
      rule.active !== false,
      rule.product_title ?? null,
      rule.product_image_url ?? null,
    ],
  );
}

export async function getDiscountRule(shop, productId) {
  const result = await pool.query(
    `SELECT type, value, label, active, product_title, product_image_url FROM discount_rules
      WHERE shop = $1 AND product_id = $2 LIMIT 1`,
    [shop, productId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    type: row.type,
    value: Number(row.value),
    label: row.label,
    active: row.active,
    product_title: row.product_title,
    product_image_url: row.product_image_url,
  };
}

export async function listDiscountRules(shop, { limit = 500, offset = 0 } = {}) {
  const result = await pool.query(
    `SELECT product_id, type, value, label, active, product_title, product_image_url, updated_at
       FROM discount_rules
      WHERE shop = $1
      ORDER BY updated_at DESC
      LIMIT $2 OFFSET $3`,
    [shop, limit, offset],
  );
  return result.rows.map((r) => ({
    product_id: r.product_id,
    rule: {
      type: r.type,
      value: Number(r.value),
      label: r.label,
      active: r.active,
      product_title: r.product_title,
      product_image_url: r.product_image_url,
    },
    updated_at: r.updated_at,
  }));
}

export async function deleteDiscountRule(shop, productId) {
  const result = await pool.query(
    `DELETE FROM discount_rules WHERE shop = $1 AND product_id = $2`,
    [shop, productId],
  );
  return result.rowCount > 0;
}

export async function pingDatabase() {
  const result = await pool.query('SELECT 1 AS ok');
  return result.rows[0]?.ok === 1;
}

export async function getShopAccessToken(shop) {
  const result = await pool.query(
    'SELECT access_token FROM shops WHERE domain = $1 AND uninstalled_at IS NULL LIMIT 1',
    [shop],
  );
  return result.rows[0]?.access_token ?? null;
}

export async function setShopAccessToken(shop, accessToken, scope = null) {
  await pool.query(
    `INSERT INTO shops (domain, access_token, scope, updated_at, uninstalled_at)
     VALUES ($1, $2, $3, now(), NULL)
     ON CONFLICT (domain)
     DO UPDATE SET access_token = EXCLUDED.access_token,
                   scope = COALESCE(EXCLUDED.scope, shops.scope),
                   updated_at = now(),
                   uninstalled_at = NULL`,
    [shop, accessToken, scope],
  );
}

export async function markShopUninstalled(shop) {
  await pool.query(
    `UPDATE shops SET uninstalled_at = now() WHERE domain = $1`,
    [shop],
  );
}

// Returns the domains of every shop with an active (non-uninstalled)
// installation. Used by periodic jobs (best-sellers sync, catalog re-sync)
// to iterate the tenant list.
export async function listInstalledShops() {
  const result = await pool.query(
    `SELECT domain FROM shops WHERE uninstalled_at IS NULL ORDER BY domain`,
  );
  return result.rows.map((r) => r.domain);
}

// Hard-delete a shop row. Called from the shop/redact compliance webhook,
// which fires 48h after uninstall and requires full data erasure.
export async function deleteShop(shop) {
  await pool.query(`DELETE FROM shops WHERE domain = $1`, [shop]);
}

export { pool };
