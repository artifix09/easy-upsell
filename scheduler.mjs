// =============================================================================
// Scheduler — periodic background jobs (multi-instance safe)
// =============================================================================
// Every job tick acquires a Redis lock (SET NX EX) before running. When the
// app is deployed as N instances, all N start the scheduler but only the
// lock holder executes a given tick — so jobs run exactly once cluster-wide.
//
// Deployment options:
//   A. In-process (default): every server instance calls startScheduler();
//      the lock guarantees single execution. Zero extra infra.
//   B. Dedicated worker: set SCHEDULER_ENABLED=false on web instances and
//      run `node scheduler.mjs` as its own process.
//
// Jobs:
//   bestsellers_sync  — daily    — rebuild best-sellers index from orders
//   catalog_resync    — 6-hourly — re-import catalogs (missed-webhook backstop)
//   analytics_flush   — hourly   — flush Redis analytics counters to Postgres
// =============================================================================

import crypto from 'node:crypto';
import { redis, connectRedis } from './redis-client.mjs';
import { runBestsellersSyncJob } from './bestsellers-index.mjs';
import { syncFullCatalog } from './catalog-sync.mjs';
import { listInstalledShops } from './postgres-store.mjs';
import { flushAnalyticsToPostgres } from './analytics.mjs';

const HOUR_MS = 3_600_000;
const INSTANCE_ID = crypto.randomBytes(6).toString('hex');

// lockTtlMs must comfortably exceed the job's worst-case runtime so the lock
// is not released (by expiry) while the job is still running on another tick.
const JOBS = {
  bestsellers_sync: { intervalMs: 24 * HOUR_MS, lockTtlMs: 2 * HOUR_MS, running: false },
  catalog_resync: { intervalMs: 6 * HOUR_MS, lockTtlMs: 2 * HOUR_MS, running: false },
  analytics_flush: { intervalMs: 1 * HOUR_MS, lockTtlMs: 10 * 60_000, running: false },
};

function logSched(event, data = {}) {
  console.log(JSON.stringify({
    component: 'scheduler',
    event,
    instance: INSTANCE_ID,
    ts: new Date().toISOString(),
    ...data,
  }));
}

// Release the lock only if we still own it (value match) — avoids deleting a
// lock a slower predecessor's expiry already handed to another instance.
async function releaseLock(lockKey) {
  try {
    const current = await redis.get(lockKey);
    if (current === INSTANCE_ID) {
      await redis.del(lockKey);
    }
  } catch (err) {
    logSched('lock_release_failed', { lock: lockKey, message: err.message });
  }
}

async function guarded(name, fn) {
  const job = JOBS[name];
  if (job.running) {
    logSched('skipped_local_overlap', { job: name });
    return;
  }

  const lockKey = `hybrid:lock:job:${name}`;
  let acquired = false;
  try {
    acquired = Boolean(await redis.set(lockKey, INSTANCE_ID, {
      NX: true,
      PX: job.lockTtlMs,
    }));
  } catch (err) {
    logSched('lock_acquire_failed', { job: name, message: err.message });
    return;
  }

  if (!acquired) {
    logSched('skipped_lock_held', { job: name });
    return;
  }

  job.running = true;
  const start = Date.now();
  try {
    await fn();
    logSched('job_complete', { job: name, duration_ms: Date.now() - start });
  } catch (err) {
    logSched('job_error', { job: name, message: err.message, duration_ms: Date.now() - start });
  } finally {
    job.running = false;
    await releaseLock(lockKey);
  }
}

async function catalogResync() {
  const shops = await listInstalledShops();
  for (const shop of shops) {
    await syncFullCatalog(shop);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

let timers = [];

export function startScheduler() {
  if (process.env.SCHEDULER_ENABLED === 'false') {
    logSched('disabled', { reason: 'SCHEDULER_ENABLED=false' });
    return;
  }
  if (timers.length > 0) return; // already started

  timers = [
    setInterval(() => guarded('bestsellers_sync', runBestsellersSyncJob), JOBS.bestsellers_sync.intervalMs),
    setInterval(() => guarded('catalog_resync', catalogResync), JOBS.catalog_resync.intervalMs),
    setInterval(() => guarded('analytics_flush', flushAnalyticsToPostgres), JOBS.analytics_flush.intervalMs),
  ];
  for (const t of timers) t.unref(); // don't keep the web process alive on these alone

  logSched('started', {
    bestsellers_interval_ms: JOBS.bestsellers_sync.intervalMs,
    catalog_interval_ms: JOBS.catalog_resync.intervalMs,
    analytics_interval_ms: JOBS.analytics_flush.intervalMs,
  });
}

export function stopScheduler() {
  for (const t of timers) clearInterval(t);
  timers = [];
  logSched('stopped');
}

// ── Standalone worker mode ─────────────────────────────────────────────────
// `node scheduler.mjs` runs the scheduler as a dedicated process. The timers
// are re-armed without unref() here so the process stays alive.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('scheduler.mjs')) {
  logSched('worker_mode_start', {});
  await connectRedis();
  timers = [
    setInterval(() => guarded('bestsellers_sync', runBestsellersSyncJob), JOBS.bestsellers_sync.intervalMs),
    setInterval(() => guarded('catalog_resync', catalogResync), JOBS.catalog_resync.intervalMs),
    setInterval(() => guarded('analytics_flush', flushAnalyticsToPostgres), JOBS.analytics_flush.intervalMs),
  ];
  process.on('SIGINT', () => { stopScheduler(); process.exit(0); });
  process.on('SIGTERM', () => { stopScheduler(); process.exit(0); });
}
