// =============================================================================
// Shared Redis client
// =============================================================================
// One client for the whole process, connected lazily. Importing this module
// has NO side effect — the connection is opened only when connectRedis() is
// called (server boot, the standalone scheduler, or a CLI script).
//
// Why this exists:
//   - Previously every module created its own client and ran a top-level
//     `await redis.connect()`. That meant the app could not be imported (or
//     unit-tested) without a live Redis, and opened N connections instead of 1.
//   - node-redis multiplexes commands and pipelines over a single connection,
//     so one shared client is both correct and cheaper.
// =============================================================================

import { createClient } from 'redis';

const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (err) => console.error('[redis]', err.message));

let connectPromise = null;

// Idempotent: every caller awaits the same underlying connect(). Safe to call
// from multiple boot paths; only the first call actually dials Redis.
export function connectRedis() {
  if (!connectPromise) {
    connectPromise = redis.connect();
  }
  return connectPromise;
}

export async function disconnectRedis() {
  if (connectPromise) {
    try {
      await redis.quit();
    } catch {
      // already closing/closed — ignore
    }
    connectPromise = null;
  }
}

export { redis };
