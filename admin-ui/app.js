// =============================================================================
// Admin UI controller
// -----------------------------------------------------------------------------
// Auth: uses the NEW App Bridge (window.shopify.idToken()) loaded from
// https://cdn.shopify.com/shopifycloud/app-bridge.js, initialised via the
// <meta name="shopify-api-key"> tag we inject server-side. Outside the embed
// (a developer pointing a browser straight at /admin), it falls back to a
// ?token= query param or sessionStorage 'dev_token' so the page is still
// debuggable.
//
// Every api() call has a 15s timeout and surfaces failures both as a banner
// and a console.error so the page never silently hangs on "Loading…".
// =============================================================================

const DEFAULT_TIMEOUT_MS = 15000;

const params = new URLSearchParams(location.search);
const DEV_MODE = params.get('dev') === '1';
const DEV_SHOP = params.get('shop');
// Debug panel is opt-in via ?debug=1 (or dev mode). Off by default so
// merchants don't see the orange diagnostic box. Persists across reloads
// inside the same tab via sessionStorage so you don't lose it on refresh.
const DEBUG_ENABLED = (() => {
  if (DEV_MODE) return true;
  if (params.get('debug') === '1') { sessionStorage.setItem('apex_debug', '1'); return true; }
  if (params.get('debug') === '0') { sessionStorage.removeItem('apex_debug'); return false; }
  return sessionStorage.getItem('apex_debug') === '1';
})();
// Shopify includes a fresh, signed id_token on every embedded launch URL.
// Cache it as a fallback for environments where App Bridge's postMessage
// handshake is unreliable (Shopify CLI quick-tunnels in particular).
const LAUNCH_ID_TOKEN = params.get('id_token') || null;
let launchTokenExp = 0;
if (LAUNCH_ID_TOKEN) {
  try {
    const payload = JSON.parse(atob(LAUNCH_ID_TOKEN.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    launchTokenExp = (payload.exp || 0) * 1000;
  } catch { /* leave at 0; the helper will treat it as expired */ }
}

console.log('[apex-admin] boot', {
  dev_mode: DEV_MODE,
  shop_param: DEV_SHOP,
  shopify_global: typeof window.shopify,
  has_idToken: typeof window.shopify?.idToken === 'function',
});

let devTokenCache = null;
let devTokenExpiresAt = 0;

async function getDevToken() {
  // Refresh ~5 min before expiry.
  const now = Date.now();
  if (devTokenCache && now < devTokenExpiresAt - 5 * 60 * 1000) return devTokenCache;
  if (!DEV_SHOP) {
    throw new Error('Dev mode requires ?shop=foo.myshopify.com in the URL.');
  }
  const res = await fetch(`/admin/dev/mint-token?shop=${encodeURIComponent(DEV_SHOP)}`, {
    headers: { 'ngrok-skip-browser-warning': 'true' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dev token mint failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  devTokenCache = json.token;
  devTokenExpiresAt = new Date(json.expires_at).getTime();
  console.log('[apex-admin] dev token minted, expires at', json.expires_at);
  return devTokenCache;
}

// ── auth ────────────────────────────────────────────────────────────────
// Three-tier strategy:
//   1. INTERNAL session token (server-signed, 1h) — preferred for all calls
//      once obtained. Cached in sessionStorage so it survives reloads in
//      the same browser tab.
//   2. App Bridge runtime token — used only when no internal token exists
//      yet. Bounded by a 4s timeout because its postMessage handshake
//      hangs silently on Shopify CLI quick-tunnels. Once we observe one
//      timeout, we cache "broken" for the rest of the session and skip it.
//   3. Launch-URL id_token — used as the seed when both above are
//      unavailable. Lives ~60s, just long enough to call /auth/exchange
//      and get the internal token.

const INTERNAL_TOKEN_KEY = 'apex_internal_token';
const INTERNAL_TOKEN_EXP_KEY = 'apex_internal_token_exp';
let appBridgeBroken = false; // session-scoped cache; flips to true after first timeout

function readInternalToken() {
  const t = sessionStorage.getItem(INTERNAL_TOKEN_KEY);
  const exp = Number(sessionStorage.getItem(INTERNAL_TOKEN_EXP_KEY) || 0);
  // Refresh ~60s before expiry to avoid mid-flight expiration.
  if (t && exp - Date.now() > 60_000) return t;
  return null;
}

function storeInternalToken(token, expiresAt) {
  sessionStorage.setItem(INTERNAL_TOKEN_KEY, token);
  sessionStorage.setItem(INTERNAL_TOKEN_EXP_KEY, String(new Date(expiresAt).getTime()));
}

function clearInternalToken() {
  sessionStorage.removeItem(INTERNAL_TOKEN_KEY);
  sessionStorage.removeItem(INTERNAL_TOKEN_EXP_KEY);
}

function launchTokenStillValid(minLifeMs = 5_000) {
  return LAUNCH_ID_TOKEN && launchTokenExp - Date.now() > minLifeMs;
}

async function withTimeout(promise, ms, label) {
  return await Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function getShopifyToken() {
  if (DEV_MODE) return await getDevToken();
  const shopify = window.shopify;
  if (!appBridgeBroken && shopify && typeof shopify.idToken === 'function') {
    try {
      const t = await withTimeout(shopify.idToken(), 4000, 'App Bridge idToken()');
      if (t) return t;
    } catch (err) {
      appBridgeBroken = true;
      debugLog?.(`⚠ App Bridge idToken() failed: ${err.message} — caching as broken`);
    }
  }
  if (launchTokenStillValid()) return LAUNCH_ID_TOKEN;
  const dev = params.get('token') || sessionStorage.getItem('dev_token');
  if (dev) return dev;
  return null;
}

// Share a single in-flight exchange across all concurrent api() callers so
// page boot doesn't fire 4 simultaneous exchanges (we saw exactly that in
// the logs).
let inflightExchange = null;

async function getAuthToken() {
  // Prefer the long-lived internal session if we still have one.
  const cached = readInternalToken();
  if (cached) return cached;

  // Otherwise seed with whatever Shopify-side token we can get and exchange
  // it for an internal session right now. Concurrent callers share one
  // exchange via inflightExchange.
  if (inflightExchange) return await inflightExchange;
  inflightExchange = (async () => {
    try {
      const seedToken = await getShopifyToken();
      if (!seedToken) {
        throw new Error('No Shopify session available. Reload the app from inside Shopify admin to obtain a fresh launch token.');
      }
      return await exchangeForInternalToken(seedToken);
    } finally {
      inflightExchange = null;
    }
  })();
  return await inflightExchange;
}

async function exchangeForInternalToken(seedToken) {
  debugLog?.('auth: exchanging seed token for internal 1h session');
  const res = await fetch('/admin/api/auth/exchange', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${seedToken}`,
      'ngrok-skip-browser-warning': 'true',
    },
    credentials: 'omit',
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch {}
    throw new Error(`Token exchange failed (${res.status}): ${detail}`);
  }
  const json = await res.json();
  storeInternalToken(json.token, json.expires_at);
  debugLog?.(`auth: stored internal token (expires ${json.expires_at})`);
  return json.token;
}

// Internal tokens are valid for an hour. Refresh ~5 min before expiry so
// long-lived sessions don't fall off the edge. The /auth/exchange endpoint
// happily accepts an internal token as the seed (it just re-issues with a
// new expiry), so this works even after the launch token is long gone.
async function maybeRefreshInternalToken() {
  const exp = Number(sessionStorage.getItem(INTERNAL_TOKEN_EXP_KEY) || 0);
  const current = sessionStorage.getItem(INTERNAL_TOKEN_KEY);
  if (!current || !exp) return;
  const remainingMs = exp - Date.now();
  // Refresh window: between 60s and 5 min from expiry. Outside that, do
  // nothing — too early or already expired (the next api() call mints fresh).
  if (remainingMs > 5 * 60_000 || remainingMs < 60_000) return;
  try {
    await exchangeForInternalToken(current);
  } catch (err) {
    debugLog?.(`auth: proactive refresh failed: ${err.message}`);
    // Don't throw — next user-initiated request will fall back to whatever
    // path getAuthToken() can find.
  }
}
// Check every minute. Cheap and safe.
setInterval(maybeRefreshInternalToken, 60_000);

// ── on-screen diagnostic log ─────────────────────────────────────────────
// Renders every api() call + result into a panel at the bottom of the page
// so failures are visible without DevTools. Toggle by pressing the "Debug"
// button in the top bar (added below).
function ensureDebugPanel() {
  if (!DEBUG_ENABLED) return null;
  let el = document.getElementById('apex-debug');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'apex-debug';
  el.style.cssText = 'margin:24px auto 40px;max-width:1100px;max-height:40vh;overflow:auto;background:#0b0b0b;color:#cde;border:2px solid #f60;border-radius:6px;font:12px/1.5 ui-monospace,Menlo,monospace;padding:12px 16px;';
  el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><strong style="color:#fff;font-size:13px;">🛠 Apex debug log (paste this if something breaks)</strong><span><button id="apex-debug-copy" style="margin-right:8px;font:inherit;cursor:pointer;">Copy</button><button id="apex-debug-clear" style="font:inherit;cursor:pointer;">Clear</button></span></div><pre id="apex-debug-body" style="margin:0;white-space:pre-wrap;color:inherit;"></pre>';
  // Insert at the very top of <main> so it's visible without scrolling.
  const main = document.querySelector('main');
  if (main) main.prepend(el);
  else document.body.appendChild(el);
  document.getElementById('apex-debug-clear').addEventListener('click', () => {
    document.getElementById('apex-debug-body').textContent = '';
  });
  document.getElementById('apex-debug-copy').addEventListener('click', () => {
    const txt = document.getElementById('apex-debug-body').textContent;
    navigator.clipboard.writeText(txt).then(() => toast('Debug log copied'));
  });
  return el;
}
function debugLog(line) {
  if (!DEBUG_ENABLED) return;
  const panel = ensureDebugPanel();
  if (!panel) return;
  const body = document.getElementById('apex-debug-body');
  const ts = new Date().toISOString().slice(11, 23);
  body.textContent += `[${ts}] ${line}\n`;
  body.parentElement.scrollTop = body.parentElement.scrollHeight;
}

// ── api ─────────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', body, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeout);
  debugLog(`→ ${method} ${path}${body ? ' body=' + JSON.stringify(body).slice(0, 120) : ''}`);

  let token;
  try {
    token = await getAuthToken();
  } catch (err) {
    clearTimeout(tid);
    debugLog(`✗ token error: ${err.message}`);
    showBanner(err.message);
    throw err;
  }

  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        // ngrok free tier shows an interstitial warning page to browser
        // requests unless this header is present. Server-to-server callers
        // (Shopify App Proxy) bypass via their non-browser User-Agent.
        'ngrok-skip-browser-warning': 'true',
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'omit',
    });
  } catch (err) {
    clearTimeout(tid);
    const msg = err.name === 'AbortError'
      ? `Request timed out after ${Math.round(timeout / 1000)}s: ${method} ${path}`
      : `Network error on ${method} ${path}: ${err.message}`;
    console.error(`[apex-admin]`, msg, err);
    debugLog(`✗ ${msg}`);
    showBanner(msg);
    throw new Error(msg);
  }
  clearTimeout(tid);

  let json = null;
  try { json = await res.json(); } catch { /* not json */ }

  if (!res.ok) {
    const msg = json?.error?.message || `Request failed (${res.status}): ${method} ${path}`;
    console.error(`[apex-admin] ${method} ${path} → ${res.status}`, json);
    debugLog(`✗ ${method} ${path} → ${res.status} ${json?.error?.code || ''} ${msg}`);
    const err = new Error(msg);
    err.code = json?.error?.code;
    err.status = res.status;
    if (res.status >= 500 || res.status === 401) showBanner(msg);
    throw err;
  }
  debugLog(`✓ ${method} ${path} → ${res.status}`);
  return json;
}

// --------------------------------------------------------------------------
// Toast
// --------------------------------------------------------------------------

const toastEl = document.getElementById('toast');
let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

// --------------------------------------------------------------------------
// Persistent error banner (top of main) — used for auth / network failures
// where a toast would auto-hide and the user might miss the cause.
// --------------------------------------------------------------------------

function ensureBannerEl() {
  let el = document.getElementById('apex-banner');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'apex-banner';
  el.className = 'banner';
  el.hidden = true;
  el.setAttribute('role', 'alert');
  el.innerHTML = `
    <span class="banner__msg"></span>
    <button class="banner__close" type="button" aria-label="Dismiss">&times;</button>
  `;
  el.querySelector('.banner__close').addEventListener('click', hideBanner);
  document.querySelector('main')?.prepend(el);
  return el;
}

function showBanner(message) {
  const el = ensureBannerEl();
  el.querySelector('.banner__msg').textContent = message;
  el.hidden = false;
}

function hideBanner() {
  const el = document.getElementById('apex-banner');
  if (el) el.hidden = true;
}

// --------------------------------------------------------------------------
// Tabs
// --------------------------------------------------------------------------

const tabs = document.querySelectorAll('.tab');
const panels = {
  dashboard: document.getElementById('dashboard'),
  rules: document.getElementById('rules'),
  billing: document.getElementById('billing'),
};

function showTab(name) {
  for (const tab of tabs) {
    tab.setAttribute('aria-selected', tab.dataset.tab === name ? 'true' : 'false');
  }
  for (const [key, el] of Object.entries(panels)) {
    el.hidden = key !== name;
  }
  if (name === 'rules') loadRules();
  if (name === 'billing') loadBilling();
}

tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

// --------------------------------------------------------------------------
// Dashboard
// --------------------------------------------------------------------------

function formatCents(c) {
  if (!Number.isFinite(c)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format(c / 100);
}

function formatPct(n) {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

function formatInt(n) {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US').format(n);
}

// ── Setup banner ────────────────────────────────────────────────────────
// Shown when the server reports we have no Shopify access token (Token
// Exchange failed, never ran, or scopes were revoked). Provides a one-click
// path back to the legacy OAuth flow which is guaranteed to grant a token.

async function checkSetupAndPrompt() {
  try {
    const setup = await api('/admin/api/setup');
    if (setup.authorized) {
      hideSetupBanner();
      return true;
    }
    showSetupBanner(setup);
    return false;
  } catch (err) {
    debugLog(`setup check failed: ${err.message}`);
    return false; // don't block the rest of the UI
  }
}

function showSetupBanner(setup) {
  let el = document.getElementById('apex-setup-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'apex-setup-banner';
    el.className = 'banner banner--setup';
    el.setAttribute('role', 'alert');
    el.innerHTML = `
      <span class="banner__msg"></span>
      <button class="btn primary" id="apex-setup-authorize" type="button">Authorize</button>
    `;
    document.querySelector('main')?.prepend(el);
  }
  const reason = setup.reason || 'This app needs to authorize with your Shopify store before it can sync products, orders, and run seeding.';
  el.querySelector('.banner__msg').textContent = reason;
  const btn = el.querySelector('#apex-setup-authorize');
  btn.onclick = () => {
    if (!setup.oauth_url) {
      toast('OAuth URL is unavailable on this server.');
      return;
    }
    // Must be a top-level navigation — Shopify rejects OAuth inside an iframe.
    if (window.shopify && typeof window.shopify.redirect === 'function') {
      window.shopify.redirect(setup.oauth_url);
    } else if (window.top !== window.self) {
      window.top.location.href = setup.oauth_url;
    } else {
      window.location.href = setup.oauth_url;
    }
  };
  el.hidden = false;
}

function hideSetupBanner() {
  const el = document.getElementById('apex-setup-banner');
  if (el) el.hidden = true;
}

async function loadDashboard() {
  hideBanner();
  console.log('[apex-admin] loadDashboard start');
  // Run setup check in parallel — doesn't block dashboard rendering.
  checkSetupAndPrompt();
  // Resolve each call independently so one failure does not blank every card.
  const [summaryRes, statusRes, seedRes] = await Promise.allSettled([
    api('/admin/api/analytics/summary?days=30'),
    api('/admin/api/status'),
    api('/admin/api/seed/status'),
  ]);
  console.log('[apex-admin] loadDashboard results', {
    summary: summaryRes.status,
    status: statusRes.status,
    seed: seedRes.status,
    summary_err: summaryRes.reason?.message,
    status_err: statusRes.reason?.message,
    seed_err: seedRes.reason?.message,
  });

  if (seedRes.status === 'fulfilled') {
    renderSeed(seedRes.value);
  } else {
    renderSeed({ state: 'idle' });
    console.warn('[apex-admin] seed status fetch failed:', seedRes.reason);
  }

  if (summaryRes.status === 'rejected' && statusRes.status === 'rejected') {
    // Both failed — likely an auth or network issue. The api() helper already
    // surfaced a banner; nothing further to render.
    return;
  }

  try {
    const summary = summaryRes.status === 'fulfilled' ? summaryRes.value : null;
    const status = statusRes.status === 'fulfilled' ? statusRes.value : null;
    if (summary) renderMetrics(summary);
    if (status) renderStatusCards(status);
  } catch (err) {
    console.error('[apex-admin] dashboard render failed:', err);
    showBanner(`Failed to render dashboard: ${err.message}`);
  }
}

function renderMetrics(summary) {

  const metrics = document.getElementById('metrics');
  metrics.innerHTML = '';
  const t = summary.totals || {};
  const cards = [
    ['Impressions', formatInt(t.impressions)],
    ['Clicks',      formatInt(t.clicks)],
    ['CTR',         formatPct(summary.ctr)],
    ['Conversions', formatInt(t.conversions)],
    ['CVR',         formatPct(summary.cvr)],
    ['Revenue',     formatCents(t.revenue_cents)],
  ];
  for (const [label, value] of cards) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<span class="label">${label}</span><span class="value">${value}</span>`;
    metrics.appendChild(card);
  }
}

function renderStatusCards(status) {
  setStatusCard('status-installed', 'Install', status.installed ? 'Installed' : 'Not installed', status.installed ? 'ok' : 'error');
  setStatusCard('status-billing',   'Billing',
    status.billing?.active ? (status.billing.plan || 'Active') : 'Inactive',
    status.billing?.active ? 'ok' : 'warn');
  setStatusCard('status-db',        'Database', status.db_ok ? 'Connected' : 'Down', status.db_ok ? 'ok' : 'error');
}

function setStatusCard(id, label, value, state) {
  const el = document.getElementById(id);
  el.innerHTML = `<span class="label">${label}</span><span class="value ${state}">${value}</span>`;
}

// --------------------------------------------------------------------------
// Seed (cold-start backfill)
// --------------------------------------------------------------------------

const seedBtn = document.getElementById('seed-run');
const seedStatusEl = document.getElementById('seed-status');
let seedPollTimer = null;

function renderSeed(state) {
  if (!state || state.state === 'idle') {
    seedBtn.disabled = false;
    seedBtn.textContent = 'Seed now';
    return;
  }
  if (state.state === 'running') {
    seedBtn.disabled = true;
    seedBtn.textContent = 'Seeding…';
    seedStatusEl.textContent = `Running since ${new Date(state.started_at).toLocaleTimeString()}. Safe to leave this page.`;
    startSeedPolling();
    return;
  }
  if (state.state === 'complete') {
    seedBtn.disabled = false;
    seedBtn.textContent = 'Re-seed';
    const r = state.result || {};
    const products = r.bestsellers?.products ?? 0;
    const indexed = r.catalog?.products_indexed ?? 0;
    seedStatusEl.textContent = `Last seed: ${indexed} products synced, ${products} products with co-purchase signals. (${Math.round(state.duration_ms / 1000)}s)`;
    stopSeedPolling();
    return;
  }
  if (state.state === 'failed') {
    seedBtn.disabled = false;
    seedBtn.textContent = 'Retry seed';
    seedStatusEl.textContent = `Last seed failed: ${state.error || 'unknown error'}`;
    stopSeedPolling();
  }
}

function startSeedPolling() {
  if (seedPollTimer) return;
  seedPollTimer = setInterval(async () => {
    try {
      const state = await api('/admin/api/seed/status');
      renderSeed(state);
    } catch (_) { /* keep trying */ }
  }, 4000);
}

function stopSeedPolling() {
  if (seedPollTimer) { clearInterval(seedPollTimer); seedPollTimer = null; }
}

seedBtn.addEventListener('click', async () => {
  seedBtn.disabled = true;
  seedBtn.textContent = 'Starting…';
  try {
    const res = await api('/admin/api/seed', { method: 'POST' });
    renderSeed(res.state || { state: 'running', started_at: new Date().toISOString() });
    toast('Seed started');
  } catch (err) {
    seedBtn.disabled = false;
    seedBtn.textContent = 'Seed now';
    toast(err.message);
  }
});

// --------------------------------------------------------------------------
// Rules
// --------------------------------------------------------------------------

const rulesBody = document.getElementById('rules-body');
const dialog = document.getElementById('rule-dialog');
const form = document.getElementById('rule-form');

document.getElementById('rule-new').addEventListener('click', () => openDialog());
document.getElementById('rule-cancel').addEventListener('click', () => dialog.close());

// Capture the currently-selected product so we can persist title/image
// alongside the rule. Reset whenever the dialog opens.
let pickerSelection = null;

const ruleFormError = document.getElementById('rule-form-error');
function showRuleError(msg) {
  ruleFormError.textContent = msg;
  ruleFormError.hidden = false;
}
function clearRuleError() {
  ruleFormError.hidden = true;
  ruleFormError.textContent = '';
}

// Image URL guard — the server caps product_image_url at 1024 chars. We
// clip on the client too so a long CDN query string never reaches the
// server. Drop entirely if it isn't a valid http(s) URL.
function sanitizeImageUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.length > 1024) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return raw;
  } catch {
    return null;
  }
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  clearRuleError();
  const fd = new FormData(form);
  const productId = String(fd.get('product_id') || '').trim();
  if (!/^[0-9]+$/.test(productId)) {
    showRuleError('Pick a product from the list before saving.');
    return;
  }

  // Client-side validation — same rules the server enforces, but with
  // friendlier inline feedback. Catches every shape that has produced a
  // mystery 400 in the past.
  const type = String(fd.get('type') || '');
  if (type !== 'percentage' && type !== 'fixed_amount') {
    showRuleError('Select a discount type.');
    return;
  }
  const rawValue = String(fd.get('value') ?? '').trim();
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    showRuleError('Enter a positive discount value.');
    return;
  }
  if (type === 'percentage' && value > 100) {
    showRuleError('Percentage discounts cannot exceed 100.');
    return;
  }
  const label = String(fd.get('label') || '');
  if (label.length > 120) {
    showRuleError('Label is too long (max 120 characters).');
    return;
  }

  const title = pickerSelection?.title ? String(pickerSelection.title).slice(0, 300) : null;
  const imageUrl = sanitizeImageUrl(pickerSelection?.image);

  const body = {
    type,
    value,
    label: label || null,
    active: fd.get('active') === 'on',
    product_title: title,
    product_image_url: imageUrl,
  };
  try {
    await api(`/admin/api/discount-rules/${encodeURIComponent(productId)}`, { method: 'PUT', body });
    dialog.close();
    toast('Rule saved');
    loadRules();
  } catch (err) {
    showRuleError(err.message || 'Failed to save rule.');
  }
});

// ── Product picker ─────────────────────────────────────────────────────
// Live-search the merchant's catalog by title/SKU and let them click a
// row to populate the hidden product_id field. Selecting a product hides
// the search input and shows a confirmation chip with a clear button.

const pickerSearch = document.getElementById('product-search');
const pickerIdInput = document.getElementById('product-id');
const pickerResults = document.getElementById('picker-results');
const pickerSelected = document.getElementById('picker-selected');
let pickerSearchTimer = null;
let pickerCurrent = [];        // accumulated products (across "load more")
let pickerNextCursor = null;   // Shopify pagination cursor
let pickerHasMore = false;
let pickerCurrentQuery = '';   // active search string for this listing

function renderPickerResults({ products, hasMore, append }) {
  if (!append) {
    pickerCurrent = [];
    pickerResults.innerHTML = '';
  }
  if (!products.length && !append) {
    pickerResults.innerHTML = '<div class="picker-result empty">No products match. Try a different search.</div>';
    pickerResults.hidden = false;
    return;
  }
  // Drop the "Load more" footer if it's there — we'll re-add at the bottom.
  const oldFooter = pickerResults.querySelector('.picker-footer');
  if (oldFooter) oldFooter.remove();

  for (const p of products) {
    pickerCurrent.push(p);
    const row = document.createElement('div');
    row.className = 'picker-result';
    row.setAttribute('role', 'option');
    row.dataset.id = p.id;
    const img = p.image
      ? `<img src="${p.image}" alt="${escapeHtml(p.title)}" />`
      : `<div class="no-image"></div>`;
    const status = p.status && p.status !== 'ACTIVE' ? ` · ${p.status.toLowerCase()}` : '';
    row.innerHTML = `
      ${img}
      <div>
        <div class="title">${escapeHtml(p.title)}</div>
        <div class="meta">${escapeHtml(p.id)}${status}${p.price ? ' · $' + escapeHtml(String(p.price)) : ''}</div>
      </div>
    `;
    row.addEventListener('click', () => selectProduct(p));
    pickerResults.appendChild(row);
  }

  // Footer: either a Load-more button or a "Showing all N" hint.
  const footer = document.createElement('div');
  footer.className = 'picker-footer';
  if (hasMore) {
    footer.innerHTML = `<button type="button" class="btn ghost picker-load-more">Load more (${pickerCurrent.length} loaded)</button>`;
    footer.querySelector('button').addEventListener('click', () => loadMoreProducts());
  } else {
    footer.textContent = `Showing all ${pickerCurrent.length} product${pickerCurrent.length === 1 ? '' : 's'}.`;
  }
  pickerResults.appendChild(footer);
  pickerResults.hidden = false;
}

function selectProduct(p) {
  pickerSelection = { id: p.id, title: p.title, image: p.image || null };
  pickerIdInput.value = p.id;
  pickerSearch.value = '';
  pickerSearch.hidden = true;
  pickerResults.hidden = true;
  const img = p.image
    ? `<img src="${p.image}" alt="${escapeHtml(p.title)}" />`
    : `<div class="no-image"></div>`;
  pickerSelected.innerHTML = `
    ${img}
    <div>
      <div class="title">${escapeHtml(p.title)}</div>
      <div class="meta">${escapeHtml(p.id)}</div>
    </div>
    <button type="button" class="clear" aria-label="Change product">×</button>
  `;
  pickerSelected.querySelector('.clear').addEventListener('click', () => clearPickerSelection());
  pickerSelected.hidden = false;
}

function clearPickerSelection() {
  pickerSelection = null;
  pickerIdInput.value = '';
  pickerSelected.hidden = true;
  pickerSelected.innerHTML = '';
  pickerSearch.hidden = false;
  pickerSearch.value = '';
}

async function searchProducts(q) {
  pickerCurrentQuery = q;
  pickerNextCursor = null;
  pickerHasMore = false;
  pickerResults.innerHTML = '<div class="picker-result empty">Loading…</div>';
  pickerResults.hidden = false;
  try {
    const json = await api(`/admin/api/products?q=${encodeURIComponent(q)}&limit=50`);
    pickerHasMore = Boolean(json.has_more);
    pickerNextCursor = json.next_cursor || null;
    renderPickerResults({ products: json.products || [], hasMore: pickerHasMore, append: false });
  } catch (err) {
    pickerResults.innerHTML = `<div class="picker-result empty">${escapeHtml(err.message)}</div>`;
    pickerResults.hidden = false;
  }
}

async function loadMoreProducts() {
  if (!pickerHasMore || !pickerNextCursor) return;
  try {
    const url = `/admin/api/products?q=${encodeURIComponent(pickerCurrentQuery)}&limit=50&after=${encodeURIComponent(pickerNextCursor)}`;
    const json = await api(url);
    pickerHasMore = Boolean(json.has_more);
    pickerNextCursor = json.next_cursor || null;
    renderPickerResults({ products: json.products || [], hasMore: pickerHasMore, append: true });
  } catch (err) {
    toast(err.message);
  }
}

pickerSearch.addEventListener('input', () => {
  const q = pickerSearch.value.trim();
  clearTimeout(pickerSearchTimer);
  // Debounce 250ms so we don't fire on every keystroke.
  pickerSearchTimer = setTimeout(() => searchProducts(q), 250);
});

pickerSearch.addEventListener('focus', () => {
  if (!pickerSearch.value.trim()) searchProducts('');
});

document.addEventListener('click', (ev) => {
  if (!pickerResults.hidden && !ev.target.closest('.product-picker')) {
    pickerResults.hidden = true;
  }
});

function openDialog(existing) {
  form.reset();
  clearRuleError();
  clearPickerSelection();
  if (existing) {
    // Pre-fill the picker chip from stored product metadata. Falls back to
    // "Product <id>" only when the rule predates the metadata columns or
    // was created via API without title/image.
    selectProduct({
      id: existing.product_id,
      title: existing.rule.product_title || `Product ${existing.product_id}`,
      image: existing.rule.product_image_url || null,
    });
    form.elements.type.value = existing.rule.type;
    form.elements.value.value = existing.rule.value;
    form.elements.label.value = existing.rule.label || '';
    form.elements.active.checked = existing.rule.active !== false;
  } else {
    form.elements.active.checked = true;
  }
  dialog.showModal();
}

async function loadRules() {
  rulesBody.innerHTML = `<tr><td colspan="6" class="empty">Loading…</td></tr>`;
  try {
    const { rules } = await api('/admin/api/discount-rules');
    if (!rules.length) {
      rulesBody.innerHTML = `<tr><td colspan="6" class="empty">No rules yet. Create one to attach a discount to a recommended product.</td></tr>`;
      return;
    }
    rulesBody.innerHTML = '';
    for (const item of rules) {
      const tr = document.createElement('tr');
      const valueStr = item.rule.type === 'percentage'
        ? `${item.rule.value}%`
        : formatCents(Math.round(item.rule.value * 100));
      const img = item.rule.product_image_url
        ? `<img src="${escapeHtml(item.rule.product_image_url)}" alt="" class="rule-thumb" />`
        : `<div class="rule-thumb no-image"></div>`;
      const title = item.rule.product_title
        ? `<div class="title">${escapeHtml(item.rule.product_title)}</div><div class="meta">${escapeHtml(item.product_id)}</div>`
        : `<div class="title meta">${escapeHtml(item.product_id)}</div>`;
      tr.innerHTML = `
        <td><div class="rule-product">${img}<div>${title}</div></div></td>
        <td>${item.rule.type === 'percentage' ? 'Percentage' : 'Fixed amount'}</td>
        <td>${valueStr}</td>
        <td>${escapeHtml(item.rule.label || '')}</td>
        <td><span class="badge ${item.rule.active ? '' : 'off'}">${item.rule.active ? 'Active' : 'Paused'}</span></td>
        <td>
          <div class="row-actions">
            <button class="btn ghost" data-edit>Edit</button>
            <button class="btn ghost" data-delete>Delete</button>
          </div>
        </td>
      `;
      tr.querySelector('[data-edit]').addEventListener('click', () => openDialog(item));
      tr.querySelector('[data-delete]').addEventListener('click', () => deleteRule(item.product_id));
      rulesBody.appendChild(tr);
    }
  } catch (err) {
    rulesBody.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function deleteRule(productId) {
  if (!confirm(`Delete rule for product ${productId}?`)) return;
  try {
    await api(`/admin/api/discount-rules/${encodeURIComponent(productId)}`, { method: 'DELETE' });
    toast('Rule deleted');
    loadRules();
  } catch (err) {
    toast(err.message);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// --------------------------------------------------------------------------
// Billing
// --------------------------------------------------------------------------

async function loadBilling() {
  try {
    const status = await api('/admin/api/status');
    const planEl = document.getElementById('billing-plan');
    const statusEl = document.getElementById('billing-status');
    const btn = document.getElementById('billing-subscribe');
    if (status.billing?.active) {
      planEl.textContent = status.billing.plan || 'Active';
      statusEl.textContent = `Status: ${status.billing.status}`;
      btn.textContent = 'Change plan';
    } else {
      planEl.textContent = 'No plan';
      statusEl.textContent = 'Start a subscription to enable recommendations.';
      btn.textContent = 'Start subscription';
    }
  } catch (err) {
    toast(err.message);
  }
}

document.getElementById('billing-subscribe').addEventListener('click', async () => {
  hideBillingNotice();
  try {
    const { confirmation_url } = await api('/admin/api/billing/subscribe', {
      method: 'POST',
      body: { plan: 'standard' },
    });
    // Inside admin iframe, use the new App Bridge to redirect to Shopify's
    // approval screen (it must be top-level, not inside the iframe). Outside
    // the embed, fall back to a top-level browser navigation.
    if (window.shopify && typeof window.shopify.redirect === 'function') {
      window.shopify.redirect(confirmation_url);
    } else if (window.top !== window.self) {
      window.top.location.href = confirmation_url;
    } else {
      window.location.href = confirmation_url;
    }
  } catch (err) {
    // Custom-app limitation is a known, non-fixable-in-code Shopify policy.
    // Persistent banner explaining what to change in Partner Dashboard.
    if (err.code === 'CUSTOM_APP_BILLING_BLOCKED') {
      showBillingNotice(err.message);
    } else {
      toast(err.message);
    }
  }
});

function showBillingNotice(msg) {
  const card = document.getElementById('billing-card');
  let el = document.getElementById('billing-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'billing-notice';
    el.className = 'form-error';
    el.setAttribute('role', 'alert');
    card.parentElement.insertBefore(el, card);
  }
  el.textContent = msg;
  el.hidden = false;
}

function hideBillingNotice() {
  const el = document.getElementById('billing-notice');
  if (el) el.hidden = true;
}

// --------------------------------------------------------------------------
// Global error handlers — never let an unhandled promise silently break the UI
// --------------------------------------------------------------------------

window.addEventListener('unhandledrejection', (ev) => {
  console.error('[apex-admin] unhandled rejection:', ev.reason);
  debugLog(`⚠ unhandled rejection: ${ev.reason?.message || ev.reason}`);
});
window.addEventListener('error', (ev) => {
  console.error('[apex-admin] window error:', ev.error || ev.message);
  debugLog(`⚠ window error: ${ev.error?.message || ev.message}`);
});

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

ensureDebugPanel();
debugLog(`boot: dev_mode=${DEV_MODE} shop=${DEV_SHOP || '(from App Bridge)'} appBridge=${typeof window.shopify?.idToken === 'function'}`);

showTab('dashboard');
loadDashboard();
