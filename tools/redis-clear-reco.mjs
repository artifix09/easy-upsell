import { createClient } from 'redis';

const shop = process.argv[2];
if (!shop) {
  console.error('Usage: node tools/redis-clear-reco.mjs <shop.myshopify.com>');
  process.exit(1);
}

const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (err) => console.error('[redis]', err.message));
await redis.connect();

let cursor = '0';
let deleted = 0;
const pattern = `hybrid:reco:${shop}:*`;

do {
  const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
  cursor = result.cursor;
  if (result.keys.length > 0) {
    await redis.del(result.keys);
    deleted += result.keys.length;
  }
} while (cursor !== '0');

console.log(`[hybrid] cleared ${deleted} recommendation cache keys for ${shop}`);
await redis.quit();
