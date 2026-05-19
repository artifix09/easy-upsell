# Easy Upsell — Hybrid Recommendations + Discount Rules

Embedded Shopify app that surfaces recommended products on the storefront,
applies merchant-defined discount rules at the recommendation slot, and
attributes the resulting clicks / conversions / revenue back to the
recommendation source.

Built to ship paired with a theme: storefront integration goes through
Shopify App Proxy, admin UI runs as a standard embedded app, all auth
flows through Shopify's modern Token Exchange.

## Architecture

```
                    ┌──────────────┐
   Shopify Admin ───▶  /admin (UI) │   Embedded admin (App Bridge + JWT)
                    └──────┬───────┘
                           │
                    ┌──────▼──────────────┐
   Storefront ─────▶ /shopify/proxy/...   │   App Proxy (HMAC-verified)
                    │ /admin/api/...      │   Admin (session-token-verified)
                    │ /webhooks/...       │   Webhooks (HMAC-verified)
                    │ /auth/...           │   OAuth fallback
                    └──────┬──────────────┘
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
       ┌────────┐    ┌─────────┐   ┌──────────────┐
       │ Redis  │    │Postgres │   │ Shopify API  │
       │  hot   │    │ truth   │   │ (GraphQL)    │
       └────────┘    └─────────┘   └──────────────┘
```

- **Redis** — hot path: recommendation responses, daily analytics counters,
  session tokens, discount-rule cache, seed-job state
- **Postgres** — durable: shops + offline access tokens, discount rules,
  daily analytics rollups, billing
- **Shopify Admin API** — fetched lazily for product details, orders
  (seed/best-sellers rebuild), billing, webhook registration

## Requirements

- Node.js 20+
- Postgres 14+
- Redis 6+
- Shopify Partner account with the app installed in a dev store
- Shopify CLI (`@shopify/cli@latest`)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Provide environment variables

```bash
cp .env.example .env
# then edit .env with your real values
```

Required keys:

| Key | Source |
|---|---|
| `SHOPIFY_API_KEY` | Partner Dashboard → App → Client ID |
| `SHOPIFY_API_SECRET` | Partner Dashboard → App → Client secret |
| `REDIS_URL` | e.g. `redis://localhost:6379` |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | Postgres connection |

Optional:

| Key | Default | Purpose |
|---|---|---|
| `APP_URL` | (set by Shopify CLI) | Public origin; CLI overrides via `HOST` |
| `PORT` | 3000 | Server port (CLI assigns its own in dev) |
| `BILLING_TEST` | `false` | Use Shopify test charges in dev |

### 3. Install the Shopify CLI

```bash
npm install -g @shopify/cli@latest
shopify version
```

### 4. (Optional) Install a tunnel binary for non-CLI dev

Shopify CLI bundles its own tunnel, so this is only needed if you want to
run `node server.mjs` standalone. Pick one:

- **Cloudflare quick tunnel** (free, ephemeral URL):
  ```bash
  # Windows
  winget install --id Cloudflare.cloudflared
  # macOS
  brew install cloudflared
  ```
- **Ngrok** (free with a stable reserved subdomain on the paid tier):
  ```bash
  # Windows
  winget install --id Ngrok.Ngrok
  # macOS
  brew install ngrok
  ```

The previous repo state shipped these binaries inside the project; we
removed them because they exceed GitHub's 100 MB file limit. They are
installable in seconds and don't need to be vendored.

### 5. Link the app to your Partner Dashboard

From the project root:

```bash
shopify app config link
```

Select the existing `Easy Upsell` app. This writes `shopify.app.toml`
with `client_id`, `application_url`, and webhook config.

### 6. Run dev

```bash
shopify app dev
```

The CLI:
1. Spawns a Cloudflare quick tunnel
2. Updates `application_url` and `redirect_urls` in Partner Dashboard
3. Starts `node ../server.mjs` from `web/` with `HOST=<tunnel-url>`
4. Prints a Preview URL — open it to land in the embedded admin

Boot lines you should see:

```
hybrid-web │ [boot] redis connected
hybrid-web │ [boot] postgres schema ready
hybrid-web │ [hybrid] server listening on <port>
```

## Tests

```bash
node --test
```

## Surface area

| Path | Auth | Purpose |
|---|---|---|
| `GET  /` and `/admin` | none (serves HTML) | Embedded admin UI |
| `GET  /admin/static/*` | none | Static admin assets |
| `POST /admin/api/auth/exchange` | session token | Mint server-signed 1h JWT + run Shopify Token Exchange |
| `GET  /admin/api/setup` | internal | Tells the UI whether Shopify Token Exchange succeeded; returns OAuth fallback URL if not |
| `GET  /admin/api/status` | internal | Install / billing / DB health |
| `GET  /admin/api/analytics/summary` | internal | 30-day metrics rollup |
| `GET  /admin/api/discount-rules` | internal | List rules with product metadata |
| `PUT  /admin/api/discount-rules/:id` | internal | Upsert one rule |
| `DELETE /admin/api/discount-rules/:id` | internal | Remove a rule |
| `GET  /admin/api/products?q=&after=` | internal | Searchable, paginated product picker |
| `POST /admin/api/seed` | internal | Cold-start backfill (catalog + bestsellers + co-purchase) |
| `GET  /admin/api/seed/status` | internal | Poll backfill state |
| `POST /admin/api/billing/subscribe` | internal | Start Shopify Billing flow (Public apps only) |
| `GET  /billing/callback` | shop query param | Shopify return URL post-approval |
| `POST /shopify/proxy/recommendations` | App Proxy HMAC | Storefront read path |
| `POST /shopify/proxy/events` | App Proxy HMAC | Storefront event ingestion |
| `POST /webhooks/*` | webhook HMAC | Orders, uninstall |
| `POST /compliance/*` | webhook HMAC | GDPR data/redact webhooks |
| `GET  /auth` and `/auth/callback` | HMAC | OAuth fallback when Token Exchange unavailable |
| `GET  /health` | none | Liveness probe |

## Auth model

- **Storefront** — App Proxy HMAC on every request (validated against `SHOPIFY_API_SECRET`).
- **Admin UI** — three-tier:
  1. **Internal session JWT** (server-signed, HS256, 1h, audience `internal:admin`) — cached in `sessionStorage`. Refreshes proactively at the 55-min mark.
  2. **Shopify session JWT** (App Bridge runtime token, ~60s lifetime) — used as the seed when no internal token exists.
  3. **Launch-URL `id_token`** (Shopify includes one on every embedded launch) — used when App Bridge's `idToken()` is unreliable (Shopify CLI quick-tunnels exhibit this).
- **Shopify Admin API** — offline access token acquired via Token Exchange and persisted in `shops.access_token`. Falls back to legacy OAuth (`/auth`) if Token Exchange fails for any reason. The admin UI surfaces an Authorize banner with the fallback link.

## Data model

```
shops
  domain TEXT PRIMARY KEY,
  access_token TEXT,
  scope TEXT,
  installed_at, updated_at, uninstalled_at TIMESTAMPTZ,
  plan, subscription_id, billing_status TEXT

discount_rules
  shop TEXT, product_id TEXT,
  type TEXT ('percentage' | 'fixed_amount'),
  value NUMERIC, label TEXT, active BOOLEAN,
  product_title TEXT, product_image_url TEXT,
  PRIMARY KEY (shop, product_id)

analytics_daily
  shop TEXT, day DATE,
  impressions, clicks, conversions, revenue_cents BIGINT,
  PRIMARY KEY (shop, day)
```

Live-day analytics counters live in Redis hashes:
`hybrid:analytics:daily:{shop}:{yyyy-mm-dd}` — flushed to Postgres hourly.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Invalid path /?...` in the iframe | Shopify CLI proxy not routing to backend. Check `web/shopify.web.toml` has `roles = ["backend", "frontend"]` |
| All requests hang for 4s then fail | App Bridge `idToken()` postMessage handshake broken (common on CLI quick-tunnels). Internal token kicks in after the timeout |
| "Authorize" banner appears | Token Exchange failed; click the button to run legacy OAuth |
| `Custom apps cannot use the Billing API` | Partner Dashboard distribution is set to "Custom app". Change to "Public app" to enable billing |
| Dashboard cards blank after navigation | Internal token expired (>1h session). Reload the embedded admin to mint a fresh one |

Append `?debug=1` to the admin URL to enable the in-page diagnostic panel.

## License

Proprietary — all rights reserved.
