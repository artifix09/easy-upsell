# Quickstart — run the app against a Shopify dev store

## 0) One-time prerequisites

**Windows**
- Node 20.6 or newer (`node -v` to check)
- WSL2 with Ubuntu (`wsl --install` if missing)

**Inside WSL (Ubuntu) — run once**
```bash
sudo apt update
sudo apt install -y redis-server postgresql cloudflared
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'admin@627';"
sudo -u postgres createdb shopify
```

**In this folder — run once**
```cmd
npm install
```

## 1) Configure the Shopify Partner Dashboard

In Partners → Apps → *your app* → **App setup**:

| Field | Value |
| --- | --- |
| App URL | `https://<your-tunnel>.trycloudflare.com/admin` |
| Allowed redirection URL(s) | `https://<your-tunnel>.trycloudflare.com/auth/callback` |
| Embedded in Shopify admin | **Yes** |

In **App proxy** (same page, scroll down):

| Field | Value |
| --- | --- |
| Subpath prefix | `apps` |
| Subpath | `hybrid` |
| Proxy URL | `https://<your-tunnel>.trycloudflare.com/shopify/proxy` |

In **Client credentials**, copy:
- *Client ID* → `.env` `SHOPIFY_API_KEY`
- *Client secret* → `.env` `SHOPIFY_API_SECRET`

> The client secret starts with a random hex string — it is NOT the `shpss_...`
> token. If your current `.env` has `shpss_`, you copied the Storefront token
> by mistake. Replace it before installing.

## 2) Start everything

```cmd
start.bat
```

That:
1. Boots Redis in WSL
2. Boots Postgres in WSL
3. Opens a Cloudflare tunnel in a new window
4. Runs `node server.mjs` in this window

Copy the `*.trycloudflare.com` URL printed by `cloudflared` into:
- `.env` → `APP_URL`
- Partner Dashboard → App URL + redirect URL + App Proxy URL (above)

Then restart `start.bat` so the new `APP_URL` is picked up.

To skip the tunnel (e.g. you already have one):
```cmd
start.bat --no-tunnel
```

To stop the WSL services:
```cmd
start.bat --stop
```

## 3) Install on the dev store

Open in a browser:
```
https://<your-tunnel>.trycloudflare.com/auth?shop=aditor-dev-store.myshopify.com
```

Shopify will prompt for scope approval and redirect back. After install:
- Open the app from the dev store admin → app loads at `/admin`
- Run the smoke test to verify storefront/proxy paths:

  ```cmd
  npm run smoke
  ```

## 4) Drop the theme into the dev store

Three Liquid sections + one shared JS asset. Pick the placements you want
in the theme editor — they all use the same `<apex-upsell>` component, so
no code duplication.

### 4.1 Upload assets

In dev store admin → **Online Store → Themes → Edit code**:

| Source file | Goes to |
|---|---|
| `assets/apex-upsell.js` | **Assets** (required by all three placements) |
| `assets/apex-cart-drawer.js` | **Assets** (drawer only) |
| `assets/apex-cart-drawer.css` | **Assets** (drawer only) |
| `sections/apex-upsell-cart.liquid` | **Sections** |
| `sections/apex-upsell-product.liquid` | **Sections** |
| `sections/apex-cart-drawer.liquid` | **Sections** (only if using the drawer) |

### 4.2 Add the sections via the customizer

In dev store admin → **Online Store → Themes → Customize**:

| Page in customizer | Action |
|---|---|
| **Product pages** | Add section *Apex Upsell — Product* below the buy box |
| **Cart** | Add section *Apex Upsell — Cart* below cart items |
| Any page (optional) | Include the *Apex Cart Drawer* section for a slide-in drawer |

Each section exposes a small settings panel — heading, subheading,
max products, top margin — defaults are sensible.

### 4.3 First-run: seed the recommendations

Open the app in admin → **Dashboard → Seed from history → Seed now**.

This pulls your last 90 days of orders and rebuilds best-sellers +
co-purchase signals. For a brand-new dev store with no orders, this
is a no-op — but it primes the engine the moment real orders come in.

## 5) Verify it's working

| Check | Expected |
| --- | --- |
| `curl https://<tunnel>/health` | `{"ok":true,...}` |
| Server log on boot | `[boot] redis connected`, `[boot] postgres schema ready` |
| Admin UI at `/admin` (in Shopify admin) | Dashboard renders, metrics show zeros, status all green |
| Add an upsell to cart on storefront | Line item carries `_hybrid_rec` property (hidden); orders/create webhook fires; conversions counter increments |
| `curl -X POST https://<tunnel>/admin/api/status` without bearer | `401 UNAUTHORIZED` |

## 6) Common gotchas

- **401 on every admin call** — wrong `SHOPIFY_API_SECRET`, or App URL mismatch in Partner Dashboard.
- **App Proxy returns 401** — secret wrong, OR Subpath/Proxy URL in Partner Dashboard doesn't match.
- **`ECONNREFUSED 127.0.0.1:6379` on boot** — `wsl -e bash -lc "redis-cli ping"` should print `PONG`. If not, `sudo service redis-server start`.
- **`role "postgres" does not exist`** — re-run the `ALTER USER postgres PASSWORD …` step in WSL.
- **Tunnel URL changes every restart** — that's `trycloudflare.com`. For stable URLs use a named Cloudflare tunnel or `ngrok`.
- **Webhook deliveries to localhost** — Shopify only delivers webhooks to the publicly reachable URL (your tunnel). They won't reach `localhost` directly.
