// =============================================================================
// Hybrid App â Server Entrypoint
// =============================================================================
// Load environment FIRST (before any module touches process.env). Node 20.6+
// supports --env-file=.env natively; we also gracefully load .env here when
// available so `node server.mjs` works without flags. Production deploys
// should rely on the platform's secret manager rather than .env.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

(function loadDotenv() {
  // Load .env from where server.mjs lives, not from cwd, so the process
  // works whether started directly (`node server.mjs`), via Shopify CLI
  // (which cd's into web/ first), or via any other tooling.
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    console.error('[env] failed to load .env:', err.message);
  }
})();

function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[boot] missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// Shopify CLI exports the tunnel URL as HOST when it spawns the dev process.
// Prefer it over a stale APP_URL baked into .env so the OAuth redirect_uri
// and billing return URLs always match the active tunnel.
if (process.env.HOST) {
  process.env.APP_URL = process.env.HOST.replace(/\/+$/, '');
  console.log(`[boot] APP_URL overridden by HOST=${process.env.APP_URL}`);
}

requireEnv([
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'REDIS_URL',
]);

// Imports MUST come after env load. Each module connects to Redis at import.
const { app } = await import('./recommendations-handler.mjs');
const { app: webhookApp } = await import('./webhook-handlers.mjs');
const { app: bestsellersApp } = await import('./bestsellers-index.mjs');
const { app: authApp } = await import('./auth-handler.mjs');
const { app: complianceApp } = await import('./compliance-webhooks.mjs');
const { app: adminApp } = await import('./admin-api.mjs');
const { captureProcessErrors } = await import('./error-monitor.mjs');
const { ensureSchema } = await import('./postgres-store.mjs');
const { connectRedis, disconnectRedis } = await import('./redis-client.mjs');
const { startScheduler, stopScheduler } = await import('./scheduler.mjs');

const PORT = Number(process.env.PORT || 3000);

// Open the single shared Redis connection before serving traffic. Every route
// module imports the client from redis-client.mjs but none of them connect on
// import — the connection is owned here.
try {
  await connectRedis();
  console.log('[boot] redis connected');
} catch (err) {
  console.error('[boot] redis connection failed:', err.message);
  process.exit(1);
}

// Best-effort Postgres bootstrap. We log and continue if it fails; OAuth
// install will surface the error to the merchant.
try {
  await ensureSchema();
  console.log('[boot] postgres schema ready');
} catch (err) {
  console.error('[boot] postgres bootstrap failed:', err.message);
}

// ──────────────────────────────────────────────────────────────────────────
// Mount sub-apps. Order matters: specific routes first, 404 last.
// ──────────────────────────────────────────────────────────────────────────
app.use(webhookApp);
app.use(bestsellersApp);
app.use(complianceApp);
app.use(authApp);
app.use(adminApp);

captureProcessErrors();

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
});

// 404 handler â MUST be registered after every other route.
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Final error handler. Hides stack traces from clients; logs them server-side.
app.use((err, _req, res, _next) => {
  console.error(JSON.stringify({
    component: 'express',
    event: 'unhandled_error',
    message: err?.message || 'unknown',
    ts: new Date().toISOString(),
  }));
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(PORT, () => {
  console.log(`[hybrid] server listening on ${PORT}`);
  startScheduler();
});

function shutdown(signal) {
  console.log(`[hybrid] ${signal} received, shutting down`);
  stopScheduler();
  server.close(async () => {
    await disconnectRedis();
    process.exit(0);
  });
  // Force exit after 10s if a connection hangs.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
