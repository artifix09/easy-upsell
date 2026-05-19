import { createClient } from 'redis';

const shop = process.argv[2];
if (!shop) {
  console.error('Usage: node tools/redis-set-affinity.mjs <shop.myshopify.com> [json]');
  process.exit(1);
}

const raw = process.argv[3] || '{"dev":["dev"]}';
let payload;
try {
  payload = JSON.parse(raw);
} catch {
  console.error('Invalid JSON payload. Example: "{\"dev\":[\"dev\"]}"');
  process.exit(1);
}

const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (err) => console.error('[redis]', err.message));
await redis.connect();

await redis.set(`hybrid:tag:affinity:${shop}`, JSON.stringify(payload));
console.log(`[hybrid] set tag affinity for ${shop}`);

await redis.quit();
